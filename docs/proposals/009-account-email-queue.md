# Migration 009: account emails that survive a restart

**Status: approved and implemented on 2026-10-24; verified on the development machine only.** It has not been deployed
or run on staging or production, and no real email was sent. Production remains **NO-GO** until the staging checklist
(`STAGING.md`) passes on a real host and the owner approves.

## Problem

Account emails (sign-up confirmation, new confirmation link, sign-in help, password reset, password changed) are
sent in the background straight after the request. Before this change, a temporary failure was retried with in-memory
timers (after 1, 5 and 15 minutes), so **a restart dropped every pending retry**. This was checked on 2026-10-24: the
first attempt was refused with 451, the API was restarted before the retry, and the email never arrived.

They cannot simply go into the existing booking outbox, because the confirmation and reset emails carry a link
whose token is stored only as a SHA-256 hash. After a restart the raw token no longer exists, so the same email
cannot be rebuilt.

## Decisions (approved 2026-10-24)

1. **Maximum retry age: one hour** after the original request, for the sign-up confirmation, "Send a new link",
   sign-in help and password-reset emails. Rows past it are never sent. This is a limit on sending, not a link-expiry
   extension: the link's own expiry stays authoritative, so a reset email's deadline is its link's 60 minutes.
2. **Interrupted send: retried with a new link.** A row found in `sending` after a restart is retried with a newly
   generated link. A duplicate email is possible; the earlier link then stops working (newest link wins).
3. **Password-changed notice: up to 24 hours.** It has no action link. This exception never extends any confirmation
   or reset link's expiry, and applies to no other email.
4. **Retention: 7 days** for finished rows, then only finished rows (`sent`, `failed`, `superseded`, `expired`) are
   deleted. `pending` and `sending` rows are never deleted for age. Foreign keys and `ON DELETE CASCADE` are kept.

## Design, as implemented

1. **A queue row is recorded in the same transaction that creates the request** (`queueAccountEmail` in
   `server/src/services/email/notify.ts`, called from `server/src/services/account-tokens.ts`).
   It holds the kind, a reference to the request (`signup_requests` or
   `password_resets` row, or the user), the attempt count, the deadline, timing and the redacted last error. It never
   holds the token, the link, the message or the recipient's address (the address is read through the reference at
   send time). The row starts as `sending` with `attempts = 1`, because the first attempt starts at once, so no worker
   can claim it meanwhile.
2. **The first attempt is unchanged.** It is sent at once in the background, with the token still in memory. Success
   marks the row `sent`; a permanent failure `failed`; a temporary failure `pending` with `next_attempt_at`, or
   `expired` when that retry would fall on or after the deadline.
3. **Every retry issues a new link.** The existing email worker (every `EMAIL_WORKER_INTERVAL_MS`, default 30 s)
   claims due rows with a conditional update. For a confirmation or reset email, `prepareAccountEmailRetry` checks in
   one write-locked transaction that the request is still current (not used, not replaced, not expired, and for a
   reset, that the account can still sign in), mints a new token, stores only its hash in a new
   `signup_requests`/`password_resets` row with the **original expiry**, marks the old row replaced, and points the
   queue row at the new row. The check and the new row use the same clock value, so a link at the edge of its expiry
   is reported `expired`, never an error. Tokens stay hash-only.
4. **Deadline (`expires_at`).** `min(request + 1 hour, link expiry)`; for the password-changed notice, request + 24
   hours. The exact deadline counts as expired. Waiting rows past it are marked `expired` by the worker and never sent.
5. **Interrupted sends.** A row still `sending` 5 minutes after its last change goes back to `pending` and is retried
   with a new link. The 5-minute wait (well above the SMTP timeouts of 10–15 s) keeps a second process from retrying
   an attempt that is still running; within one process, a running attempt is also tracked in memory and never
   recovered. An outcome is recorded only for the attempt number that was claimed, so a late result from an abandoned
   attempt cannot overwrite a newer one.
6. **Cleanup.** The worker deletes finished rows 7 days after their last change.

Statuses: `sending` → `sent` | `pending` (a retry is due, or the attempt was interrupted) | `failed` | `expired` |
`superseded` (a claimed retry whose link is no longer valid); `pending` → `sending` (claimed) | `expired` (deadline
reached) | `superseded` (a newer request, or the link was used).

## Migration (as in `server/src/db/migrations.ts`)

```sql
-- 009_account_email_queue: new table and indexes only; no existing row is read or changed.
CREATE TABLE IF NOT EXISTS account_email_queue (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'verify_again', 'existing_account', 'password_reset', 'password_changed')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  signup_request_id TEXT REFERENCES signup_requests(id) ON DELETE CASCADE,
  password_reset_id TEXT REFERENCES password_resets(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'superseded', 'expired')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  expires_at TEXT NOT NULL,               -- the send deadline (see Design, point 4)
  changed_at TEXT,                        -- password_changed only: when the password changed
  last_error TEXT,                        -- redacted (no addresses, no SMTP credentials), at most 300 characters
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (
       (kind IN ('verify', 'verify_again') AND signup_request_id IS NOT NULL AND password_reset_id IS NULL AND user_id IS NULL)
    OR (kind = 'password_reset' AND password_reset_id IS NOT NULL AND signup_request_id IS NULL)
    OR (kind IN ('existing_account', 'password_changed') AND user_id IS NOT NULL AND signup_request_id IS NULL AND password_reset_id IS NULL)
  ),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_account_email_queue_due ON account_email_queue(status, next_attempt_at);
-- At most one queue row per confirmation or reset request:
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_queue_signup ON account_email_queue(signup_request_id) WHERE signup_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_queue_reset ON account_email_queue(password_reset_id) WHERE password_reset_id IS NOT NULL;
```

It follows the conventions of migrations 006–008: one entry `{ id: '009_account_email_queue', description, apply }`,
run in its own transaction at startup and recorded in `schema_migrations`. Older builds ignore it.

## Cancellation: the five paths (plus one)

Each marks the matching `pending` rows `superseded` in the same transaction that replaces or uses the link, and logs
`[email] account <kind>: superseded, not sent (the link was replaced or used, or is no longer valid)`:

| Path | Where |
|---|---|
| 1. A new sign-up for the same address replaces the earlier confirmation request | `insertSignupRequest` → `supersedeQueuedSignupEmails` |
| 2. "Send a new link" | `resendVerification` → `insertSignupRequest` (same call) |
| 3. A new password-reset request | `requestPasswordReset` → `supersedePasswordResets` → `supersedeQueuedResetEmails` |
| 4. A password change in Settings | `PUT /api/auth/password` → `supersedePasswordResets` (now one transaction with the queue update) |
| 5. A completed password reset | `completePasswordReset` → `supersedeQueuedEmailForPasswordReset` (the used link) and `supersedePasswordResets` |
| Also: using the confirmation link | `verifySignup` → `supersedeQueuedEmailForSignupRequest` |

As a second line of defence, every retry re-checks its link (point 3 of the design).

## Security, privacy and account enumeration

- **No token material at rest.** Only hashes are stored, as before. A new link is minted for each retry instead of
  keeping the old token. Rejected alternatives: storing the token encrypted (key management, and token material at
  rest), and storing the rendered message (the link would be in the database in plaintext).
- **No email content or addresses in the queue.** The recipient is read through the reference when sending. The error
  is redacted with the same function as before (no addresses, no SMTP credentials). Log lines are fixed and name only
  the kind and the outcome.
- **Links stay as strict as before:** single use, the original expiry, newest link wins, verification on use unchanged.
- **Same answers.** The API's status, body and response time do not depend on delivery: the queue row is written in
  the transaction the request already runs (or, for the sign-in help email, in one insert), and sending stays in the
  background. The identical-answer and timing tests pass with the queue writes in place. (Pre-existing and unchanged:
  "Forgot password?" does a few database writes for a registered address and none for an unknown one, a
  sub-millisecond difference that network jitter and the rate limits make impractical to measure.)

## Files changed

| File | Change |
|---|---|
| `server/src/db/migrations.ts` | `009_account_email_queue` |
| `server/src/services/email/notify.ts` | Queue, claim, settle, recovery, deadline sweep, retry with the registered reissuer, 7-day cleanup, worker integration, fixed log lines; in-memory retry timers removed |
| `server/src/services/account-tokens.ts` | Queue rows in the request transactions; the cancellation paths; `prepareAccountEmailRetry` (new link, original expiry) |
| `server/src/tests/account-email-queue.test.ts` | New |
| `server/src/tests/account-recovery.test.ts` | Retry tests use the queue and an explicit clock |
| `server/src/tests/email-restart.test.ts` | Real process restarts for account emails |
| `server/src/tests/db-ops.test.ts`, `server/scripts/e2e-api.mjs`, `server/scripts/smoke-production.mjs` | Expect 9 migrations |
| `server/scripts/email-flows.mjs` | Waits for worker-run retries instead of a fixed sleep |
| Docs | `EMAIL.md`, `SECURITY.md`, `DEPLOYMENT.md`, `DATABASE_OPERATIONS.md`, `STAGING.md`, this file |

API routes, response formats, email templates, the UI and booking emails do not change.

## Review points (2026-10-24) and how they were settled

1. **Status of the first attempt:** the row is written as `sending` with `attempts = 1` in the request's transaction;
   a test shows no worker can claim it, even past the 5-minute recovery threshold, while it runs.
2. **Every place that replaces links supersedes queue rows:** done for all five paths and confirmation use (table
   above), each in the same transaction; each has its own test.
3. **Retry at the edge of expiry:** the state check and the new row use one clock value, so this ends `expired`
   without an error; tested at the exact boundary.
4. **Maximum age:** decided, 1 hour (Decisions, 1).
5. **Restart duplicates:** decided, resend with a new link (Decisions, 2). Recovery waits 5 minutes after the last
   change rather than acting at startup, so a second process can never resend an attempt that is still running.
6. **Cleanup scope:** finished rows only, after 7 days (Decisions, 4); tested, including the exact 7-day boundary.
7. **Log lines:** fixed lines for superseded, expired, interrupted and cleanup; a test checks every account log line
   of the queue test file against the allowed list and for addresses, links and tokens.
8. **Real migration, foreign keys, backup, restore and rollback:** verified on disposable copies (below).

## Verification (2026-10-24, development machine only)

- **Tests.** `account-email-queue.test.ts` (27 tests: schema and rules, cascade, claiming and concurrency, schedule,
  deadlines and the exact boundaries, the 24-hour notice, the five paths plus confirmation use, link re-checks,
  interrupted sends, cleanup, the running worker, privacy, fixed log lines, email off). Real process restarts in
  `email-restart.test.ts` (3 new). Deterministic clocks (explicit `now`) and the in-memory or in-test SMTP transport;
  no real email.
- **Mutation check.** 12 deliberate defects (claim without its status condition, retry scheduled at the deadline,
  recovery of a running attempt, deadline sweep off by one, 24 hours for every kind, cleanup of pending rows, each
  cancellation path removed, link expiry extended, expired link sent): the queue tests failed for all 12.
- **Five database copies** (development database, `test.db`, `test-chat-agent.db`, `test-rag.db`, the 2026-10-22
  snapshot): byte copies only; each migrated through the pre-009 release and then this build twice, and directly;
  009 changed no row in any existing table and added only its table and three indexes; integrity ok, no foreign-key
  problems; the pre-009 build starts on the migrated copy and changes nothing; the originals' SHA-256 (database and
  WAL files) were identical before and after.
- **Backup, restore, `db:status`, rollback.** Rehearsed with the disposable pre-009 release archive (checksum and
  content check, unpacked into a fresh folder): backup and restore keep the queue rows; `db:status` lists 009; the
  previous release runs on the upgraded database and an account created after the upgrade signs in; rolling forward
  after a 2-hour window expires the waiting retry without sending it; restoring the pre-upgrade backup brings back
  eight migrations.
- **Full regression** (14:07–14:14 IST): all 15 steps passed, 0 failed, 0 skipped. Jest 722 tests in 24 suites, e2e
  83, email flows 67, smoke 19, browser 74, web app unit 17, `email:test` against local SMTP servers 14, staging
  checker in local mode 22; typechecks, lint and builds clean. Details: `STAGING.md`, "Local verification record".
  The release-archive rollback rehearsal of this release passed (smoke 19/19 from the unpacked archive).

## Risks that remain

- A delivered-but-unacknowledged attempt, or an interrupted one, leads to a second email; the first link then stops
  working (decided).
- Retries are paced by the worker interval (default 30 s) on top of the delays; an interrupted row waits 5 minutes.
- While a previous release runs after a rollback, queued retries are not sent; on rolling forward, rows past their
  deadline expire.
- The queue is per database: like rate limits and the booking worker, it assumes one API process (two processes
  claim safely but each runs a worker).
- Nothing here has run on a staging host, with a real mail provider, or against a real inbox.
