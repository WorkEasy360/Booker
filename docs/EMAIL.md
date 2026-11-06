# Booking email: setup, delivery and troubleshooting

WorkeasyBooking emails customers when a booking is confirmed, moved or cancelled, emails staff members their
sign-in invitations, and sends account emails: sign-up confirmation and password reset. This page covers
configuration, the DNS records a sending domain needs, how delivery and retries work, and how to test without emailing
real people.

Every email opens with the business's own name under a small text "WorkeasyBooking" header. It ends with "Sent by
WorkeasyBooking on behalf of {business}" and "A WorkEasy360 Product" (see `BRANDING.md`). Account emails come
from the platform itself: the product name takes the business's place, and they end with "Sent by WorkEasy360
Booking."

## What is sent

| Email | When | Link inside |
|---|---|---|
| Booking confirmed | A booking is created (public booking page, dashboard, or assistant) | Manage-booking link, valid until 7 days after the appointment |
| Booking rescheduled | The date or time changes | Manage-booking link, valid until 7 days after the new date |
| Booking cancelled | The booking is cancelled | None |
| Staff invitation | An administrator invites a staff member | Sign-in setup link, single use, expires after 72 hours |
| Confirm your email for WorkeasyBooking | Someone signs up with an address that has no account | Confirmation link (`/verify-email`), single use, expires after 24 hours |
| Your new link to confirm your WorkeasyBooking account | "Send a new link" for a sign-up that is not confirmed yet | A new confirmation link; earlier ones stop working |
| Sign-in help for your WorkeasyBooking account | Someone signs up, or asks for a new confirmation link, with an address that already has an account | Sign-in and "Forgot password?" links; no token |
| Reset your WorkeasyBooking password | "Forgot password?" for an account that can sign in | Reset link (`/reset-password`), single use, expires after 60 minutes; earlier ones stop working |
| Your WorkeasyBooking password was changed | A password was reset from an emailed link | Sign-in and "Forgot password?" links; no token |

The links carry a token in the part of the URL after `#`, which browsers never send to servers, so tokens do not appear
in access logs: a signed token for booking links, a random single-use one for invitations and account emails. A
booking reference on its own never grants access to a booking. Sign-up, "Send a new link" and "Forgot password?"
answer the same for every address; only the mailbox learns whether it has an account (see `SECURITY.md`).

## Configuration (`server/.env`)

```env
EMAIL_TRANSPORT=smtp                         # disabled (default) | smtp
EMAIL_FROM="WorkeasyBooking <bookings@mail.yourdomain.com>"   # one sender for every business; each email names its business
PUBLIC_APP_URL=https://book.yourdomain.com  # the web app address used in links (https required in production)
SMTP_HOST=smtp.yourprovider.com              # host name or IP only: no smtp://, port or path
SMTP_PORT=465                                # 465 with SMTP_SECURE=true (preferred), or 587 with SMTP_SECURE=false
SMTP_SECURE=true
SMTP_USER=...                                # both or neither; required in production
SMTP_PASS=...
```

The server checks these values at startup and refuses to start with an incomplete or unsafe SMTP setup. Error
messages name the setting, never its value. With `EMAIL_TRANSPORT=disabled`, nothing is sent: each booking records
"not configured" and the app tells customers and staff that no email went out.

Startup checks the settings but does **not** connect to the mail server. A wrong host, port or password shows up on
the first email (as a failure in the server log and in the appointment's Customer Emails card), so check the
connection with `npm run email:test` (see "Proving real delivery on staging") after every change.

### Restricting recipients (staging): `EMAIL_ALLOWED_RECIPIENTS`

Optional. When it is set, the server emails **only** the recipients it lists; every other recipient is refused before
the mail server is contacted. It applies to every email (booking confirmation, reschedule, cancellation and Resend;
staff invitations; sign-up confirmation, "Send a new link", sign-in help, password reset and password changed, with
their retries) and to `npm run email:test`. Use it on staging and on any other server that must never email real
people.

```env
EMAIL_ALLOWED_RECIPIENTS=staging-test@example.test,staging-test+cust1@example.test,@test-inbox.example.test
```

Entries are separated by commas. Each is an exact address or `@` followed by a domain, and matching is exact:

| Entry | Allows | Does not allow |
|---|---|---|
| `staging-test@example.test` | that address, in any letter case | `staging-test+cust1@example.test`, `staging.test@example.test`, the same name at another domain |
| `staging-test+cust1@example.test` | that plus-address only | the base `staging-test@example.test`, other tags such as `staging-test+cust2@example.test` |
| `@test-inbox.example.test` | any address at exactly that domain | `…@mail.test-inbox.example.test` (a subdomain), `…@test-inbox.example.test.attacker.test`, `…@other-test-inbox.example.test` |

- Spaces around entries and letter case are ignored, in the setting and in recipients. A plus-address is a separate
  address: list each one you use, or use a domain that receives only test mail.
- Addresses may contain only ASCII letters, digits and `. _ + -` before the `@`; a domain only letters, digits,
  hyphens and dots, with at least one dot. No wildcards, display names or IP addresses; at most 100 entries.
- A recipient must be one plain mailbox. Lists, display names, line breaks, or characters outside these rules (for
  example a look-alike letter from another alphabet) are refused, even when a listed address appears in them.

**When a recipient is not allowed**, nothing connects and nothing is sent. The attempt is a permanent failure with the
reason `Recipient not allowed on this server (EMAIL_ALLOWED_RECIPIENTS)` (it names no address) and is never retried:

- booking emails show as failed on the appointment's Customer Emails card, and Resend fails the same way;
- a staff invitation is reported as not sent, and no invitation stays open;
- an account email's queue row is `failed` after its one attempt; the person sees the same answer as always, so
  nothing reveals whether an account exists;
- `npm run email:test -- --to …` stops with exit code 2 before connecting.

The log line names the kind of email and that reason, never the address.

**When it is not set**, nothing is restricted, exactly as before. Production normally leaves it unset: set there, it
would withhold every other customer's email (each failure visible on the appointment and in the log).

**When it is malformed** (set but empty; an empty entry from a doubled or trailing comma; a wildcard; an entry that is
not an address or `@domain`), the server refuses to start and `email:test` stops with exit code 2. The message
names the entry's position, never its value. A malformed list never means "no restriction".

**Checking it without showing the addresses.** The startup log says `Email recipients: restricted by
EMAIL_ALLOWED_RECIPIENTS to N address(es) and M domain(s)` (or `not restricted (EMAIL_ALLOWED_RECIPIENTS is not set)`),
and `npm run email:test -- --verify-only` prints the same as its `Recipients:` line. To prove it on a server, book
once for an address that is not listed: the appointment shows the email as failed with the reason above, and
nothing arrives.

**What it does not replace:** a staging database without real customer records, test accounts that use the dedicated
test inbox, staging-only SMTP credentials and sending domain, and the provider's own controls (a sandbox mode or
recipient restriction, where offered). It is one more barrier for when those fail. Its tests
(`server/src/tests/email-allowlist.test.ts`) run on the development machine against an SMTP server inside the test;
they do not show that a particular server is configured correctly.

### TLS: how the connection to the mail server is protected

| Settings | Mode | What happens |
|---|---|---|
| `SMTP_SECURE=true` (port 465) | TLS from the start | The connection is encrypted before anything is said. |
| `SMTP_SECURE=false` (port 587, or any other) | STARTTLS required | The server must switch the connection to TLS before signing in or sending. If it does not offer STARTTLS, or the offer is removed on the way, nothing is sent: the email fails (`ETLS`). There is no fallback to plaintext. |
| `SMTP_SECURE=false`, `SMTP_HOST` is `localhost`, `127.x.x.x` or `::1`, and `NODE_ENV` is not `production` | Local mail catcher, plaintext | The only exception: for Mailpit or `npm run mail:catcher` on this computer. The connection never leaves the machine. STARTTLS is still used if the local server offers it. |

In every mode, certificates are verified with Node's normal rules (a self-signed or wrong certificate stops the
connection), TLS 1.2 is the minimum, and nothing can turn verification off. The server and `npm run email:test` use the
same options (`smtpTransportOptions` in `server/src/services/email/config.ts`). The startup log says which mode is in
use, for example `Email transport: smtp (STARTTLS required)`.

**Refused at startup:**

- In production (`NODE_ENV=production`), SMTP without `SMTP_USER` and `SMTP_PASS`. Production always signs in to the
  provider over TLS. The local exception above never applies in production, not even for `127.0.0.1`.
- In any environment:
  - only one of `SMTP_USER` and `SMTP_PASS`;
  - port 465 with `SMTP_SECURE=false`;
  - port 587 with `SMTP_SECURE=true`;
  - an `SMTP_HOST` with a scheme, port, path or spaces;
  - a port outside 1–65535.

**Examples** (fake values; `example.test` can never be a real domain):

```env
# Local development with a local mail catcher (no credentials, not production)
EMAIL_TRANSPORT=smtp
EMAIL_FROM="WorkeasyBooking <bookings@example.test>"
PUBLIC_APP_URL=http://localhost:5173
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false

# Production, port 465, TLS from the start (preferred)
EMAIL_TRANSPORT=smtp
EMAIL_FROM="WorkeasyBooking <bookings@mail.example.test>"
PUBLIC_APP_URL=https://book.example.test
SMTP_HOST=smtp.provider.example.test
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=fake-smtp-user
SMTP_PASS=fake-smtp-password

# Production, port 587, STARTTLS required (when the provider does not offer 465)
EMAIL_TRANSPORT=smtp
EMAIL_FROM="WorkeasyBooking <bookings@mail.example.test>"
PUBLIC_APP_URL=https://book.example.test
SMTP_HOST=smtp.provider.example.test
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=fake-smtp-user
SMTP_PASS=fake-smtp-password
```

**Settings that used to be accepted.** Before this check, `SMTP_SECURE=false` only used STARTTLS when the server
offered it, and sent the password in plaintext otherwise. Configurations that now behave differently:

| Was accepted | Now | What to change |
|---|---|---|
| Production without `SMTP_USER`/`SMTP_PASS` (a relay that trusts the server's IP address) | Refused at startup | Create SMTP credentials at the provider |
| A mail server on port 587/25 that does not offer STARTTLS | Every email fails with `ETLS` | Use the provider's port 465 with `SMTP_SECURE=true`, or a provider that supports STARTTLS |
| Port 465 with `SMTP_SECURE=false`, or 587 with `SMTP_SECURE=true` | Refused at startup (they could never connect) | 465 → `SMTP_SECURE=true`; 587 → `SMTP_SECURE=false` |
| `SMTP_HOST=smtp://…` or `host:port` | Refused at startup | Host name only; port in `SMTP_PORT` |
| Development with a mail catcher on another machine (for example `192.168.1.20`) without TLS | Emails fail (STARTTLS required) | Run the catcher on this computer (`127.0.0.1`), or forward its port to `127.0.0.1` |
| Production relaying through a local mail server (`127.0.0.1`) without TLS | Emails fail (STARTTLS required) | Send to the provider directly over TLS |

`SMTP_USER` and `SMTP_PASS` are secrets: keep them in `server/.env` (readable only by the service account) or the
hosting platform's secret store, never in the repository, tickets, chat or logs. The server never prints them.

**Sign-up and password reset need email.** While it is disabled they answer "Email is not set up on this server"
(`503 EMAIL_NOT_CONFIGURED`) for every address instead of pretending to send, and the server warns at startup. Accounts
that already exist sign in as usual. Links in every email are built from `PUBLIC_APP_URL`, which must be https in
production.

## Choosing a provider

Any SMTP relay works, for example Amazon SES (SMTP interface), Postmark, SendGrid, Mailgun, Brevo, Google Workspace
SMTP relay or Microsoft 365. Prefer a dedicated sending subdomain (for example `mail.yourdomain.com`), so booking mail
does not affect the reputation of your everyday mailboxes. Use credentials that can only send mail.

## DNS records: SPF, DKIM and DMARC

Without these, booking emails are likely to land in spam or be rejected. Your provider shows the exact values to use.

1. **SPF**: a TXT record on the domain used in the envelope sender (`Return-Path`), listing who may send for it, for
   example:
   ```
   mail.yourdomain.com.  TXT  "v=spf1 include:<provider-spf-domain> ~all"
   ```
   A domain must have only one SPF record; merge `include:` entries into it rather than adding a second record.
2. **DKIM**: the provider gives one or more CNAME or TXT records such as `<selector>._domainkey.mail.yourdomain.com`.
   Add them, then enable DKIM signing in the provider's console.
3. **DMARC**: a TXT record on `_dmarc.<your domain>`. Start in monitoring mode, read the reports for a couple of weeks,
   then tighten the policy:
   ```
   _dmarc.yourdomain.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc-reports@yourdomain.com; fo=1"
   ```
   Later move to `p=quarantine`, then `p=reject`.
4. **Alignment**: the domain in `EMAIL_FROM` must match (or be a parent of) the SPF domain or the DKIM `d=` domain.
5. **Check**: make a test booking to a Gmail or Outlook mailbox you own and open "Show original". You want
   `SPF: PASS`, `DKIM: PASS` and `DMARC: PASS`.

## Delivery, retries and duplicates

Every booking email goes through an outbox table (`email_outbox`) before any attempt:

- **One email per event.** Each email has a unique key: one confirmation per booking, and one email per reschedule or
  cancellation (keyed by the change). Asking twice for the same event does not send a second copy. A deliberate
  **Resend** from the appointment page is always a new email.
- **Retries.** A temporary failure (SMTP 4xx such as 451, connection refused or timed out, DNS hiccup) is retried after
  1, 5 and 15 minutes: four attempts over about 21 minutes (`EMAIL_RETRY_DELAYS_MS`; the retry worker checks every
  30 seconds, `EMAIL_WORKER_INTERVAL_MS`). A permanent failure (SMTP 5xx such as 550 "mailbox
  unavailable", wrong credentials, an invalid address) is not retried.
- **No duplicates after a restart.** If the server stops while an email is being handed to the provider, the outcome is
  unknown: the provider may already have it. Those emails are marked **Outcome unknown** and are **not** resent
  automatically. Check the provider's log for the Message-ID (`<out-…@your sending domain>`) and use **Resend** only if
  it was not delivered.
- **Concurrency.** Each attempt claims its row first, so two processes or timers cannot send the same email.
- **Stale emails are dropped.** If a booking was cancelled while its confirmation was waiting for a retry, the
  confirmation is skipped (status "superseded") instead of confirming a cancelled booking.
- **No backlog.** Emails recorded while email was switched off are not sent when it is switched on later.
- **"Sent" means accepted.** An email is reported as sent only after the SMTP server accepted it for the recipient.
  Acceptance is not the same as landing in the inbox; that depends on the DNS records above and the recipient's filters.

The appointment page's **Customer Emails** card shows every attempt, emails waiting for a retry (with the next try
time), and emails whose outcome is unknown.

Staff invitations are sent once, immediately: the administrator sees the result right away. If an invitation
cannot be delivered, it is closed, so a link that never arrived cannot be used; the administrator can send a new one.

Account emails (sign-up confirmation, sign-in help, password reset, password changed) are sent in the background
right after the request, so the response neither waits for nor reveals the mail server's answer. The server log names
only the kind of email and the outcome (`[email] account password_reset: sent via smtp`), never the recipient or the
link.

### Account email retries (migration 009; verified locally on 2026-10-24, not yet on staging)

- **Queued, so retries survive a restart.** Every account email is recorded in `account_email_queue` (migration
  `009_account_email_queue`) in the same transaction that creates the request (the sign-in help email, which has no
  request of its own, with a single insert); its first attempt starts at once in the background.
  A temporary failure (SMTP 4xx, connection problems) is retried by the email worker from that table,
  on the same schedule as booking emails (`EMAIL_RETRY_DELAYS_MS`, by default after 1, 5 and 15 minutes; the worker
  runs every `EMAIL_WORKER_INTERVAL_MS`, 30 seconds by default): at most four attempts, then
  `[email] account <kind>: FAILED via smtp after 4 attempt(s)`. A permanent failure (5xx, refused sign-in) is not
  retried. A successful attempt is never repeated. Checked on 2026-10-24: the first attempt was refused with 451, the
  API was stopped before the retry and started again, and the restarted API delivered the email.
- **No token, link, message or address in the queue.** A row holds the kind of email, a reference to the account, the
  sign-up request or the reset link, its status, the attempt count and times. The recipient is read through the
  reference when sending. Links are stored only as hashes, so **every retry of a confirmation or reset email carries a
  new link with the original expiry**, and the earlier link then says a newer one was sent (newest link wins). A retry
  never extends a link. The sign-in help and password-changed emails have no such link and are sent again as they were.
- **Deadline.** A queued email is sent only before its deadline: one hour after the request for the sign-up
  confirmation, "Send a new link", sign-in help and password-reset emails, and never later than the link's own expiry
  (a reset link lasts 60 minutes, so its email's deadline is the link's expiry). The password-changed notice has no
  link and may arrive up to 24 hours after the change; this exception applies to no other email. The deadline itself
  counts as too late: a retry that would fall on or after it is not scheduled, and a waiting retry is never sent once
  it has passed.
- **Cancelled when it is no longer wanted.** A waiting retry is cancelled (`superseded`) by a new sign-up for the same
  address, "Send a new link", a new password-reset request, a password change in Settings, a completed password reset,
  or using the confirmation link. Each retry also checks its link again first: a used, replaced or expired link is
  never sent, nor a reset link for an account that can no longer sign in.
- **An interrupted send is retried, so a duplicate is possible.** A row still `sending` five minutes after its last
  change was interrupted (the server stopped mid-attempt). The worker retries it with a new link; if the first email
  did arrive, the person has two, and only the newer link works. An attempt still running is never started a second
  time, and of several workers (or processes) only one can claim a row.
- **One more copy is also possible** when the mail server accepts a message but the connection drops before it
  confirms: the attempt counts as failed and is retried with a new link.
- **Cleanup.** Finished rows (`sent`, `failed`, `superseded`, `expired`) are deleted 7 days after their last change.
  Waiting (`pending`) and running (`sending`) rows are never deleted for age. Deleting an account, a sign-up request
  or a reset link deletes its rows (`ON DELETE CASCADE`).
- People are never told whether their email was sent, retried or given up: that answer would reveal whether an
  account exists. After a failure or the deadline they ask again.

| Status | Meaning | Finished |
|---|---|---|
| `sending` | An attempt is running (or the server stopped during one) | no |
| `pending` | A retry is due at `next_attempt_at` | no |
| `sent` | Accepted by the mail server | yes |
| `failed` | Permanent failure, retries used up, or email not configured | yes |
| `superseded` | Cancelled: the link was replaced or used, or is no longer valid | yes |
| `expired` | Not sent: its deadline or its link's expiry was reached | yes |

Tests: `server/src/tests/account-email-queue.test.ts`, "account email retries" in `account-recovery.test.ts`, and
real process restarts in `email-restart.test.ts` ("account emails across a real restart"). Design and decisions:
[`proposals/009-account-email-queue.md`](proposals/009-account-email-queue.md).

## Privacy

- The delivery log stores a SHA-256 hash of the recipient, not the address.
- Provider error messages are stored and logged with email addresses removed and are limited to 300 characters.
- Recipients must be a single plain mailbox. Addresses containing line breaks, several recipients or display names
  are refused before contacting the mail server.
- With `EMAIL_ALLOWED_RECIPIENTS` set, a refused recipient is recorded and logged with the reason only, never the
  address.

## Testing without emailing real people

- The automated test suites use an in-memory transport (`EMAIL_TRANSPORT=memory`, refused when `NODE_ENV=production`)
  or an SMTP server running inside the test process. Nothing
  leaves the machine.
- `npm run test:e2e` and `npm run test:smoke` (server) start an SMTP server inside the script on 127.0.0.1.
  `npm run test:browser` runs a local SMTP catcher on 127.0.0.1:2526. They sign up, confirm and reset passwords
  through those.
- `npm run test:email` (server) starts the local test inbox (`npm run mail:catcher`) and the API on free ports with a
  throw-away database, and checks every account and booking email flow through it, including refused, temporarily
  refused and unreachable mail servers. It does not read the email settings in `server/.env`.
- For manual testing, use a local test inbox (next section). Local development needs one for sign-up and "Forgot
  password?" too.
- Never point a test or staging environment that contains real customer records at a real provider.

## Local email testing (Windows)

A local test inbox receives every email the app sends and keeps it on your machine. Nothing is relayed, so test
addresses never reach anyone. Use addresses at `example.test`, a domain reserved for testing that can never be a real
mailbox (for example `owner1@example.test`).

**1. Start a local inbox.** Either one listens on SMTP port 1025 and shows messages at http://localhost:8025.

- **Mailpit in Docker.** Start Docker Desktop first. The first run downloads the `axllent/mailpit` image.
  ```powershell
  docker run -d --name we360-mailpit -p 127.0.0.1:1025:1025 -p 127.0.0.1:8025:8025 axllent/mailpit
  # stop it and delete its messages:
  docker rm -f we360-mailpit
  ```
  `127.0.0.1:` in the port mappings keeps the inbox reachable from this computer only.
- **Without installing anything.** The project includes a small inbox built on a package that is already installed:
  ```powershell
  cd server
  npm run mail:catcher
  ```
  It keeps messages in memory until you stop it (Ctrl+C), listens on 127.0.0.1 only, and prints one line per message
  (subject and recipients, never links). It can also simulate a mail server that refuses a message: addresses that
  start with `bounce` are refused with 550 (permanent, not retried) and addresses that start with `tempfail` with 451
  (temporary, retried). `npm run mail:catcher -- --smtp 2525 --http 8026` uses other ports.

**2. Point the API at it.** The API needs six settings, and no `SMTP_USER` or `SMTP_PASS`:

| Variable | Local value |
|---|---|
| `EMAIL_TRANSPORT` | `smtp` |
| `EMAIL_FROM` | `WorkeasyBooking <bookings@example.test>` |
| `PUBLIC_APP_URL` | `http://localhost:5173` (links in emails open the dev web app) |
| `SMTP_HOST` | `127.0.0.1` |
| `SMTP_PORT` | `1025` |
| `SMTP_SECURE` | `false` |

Either add them to `server/.env` (they then apply every time), or set them only in the PowerShell window that starts
the API. That changes no file: values already set in the window take precedence over `server/.env`. Stop the API that
is running first, then:

```powershell
cd server
$env:EMAIL_TRANSPORT = 'smtp'
$env:EMAIL_FROM      = 'WorkeasyBooking <bookings@example.test>'
$env:PUBLIC_APP_URL  = 'http://localhost:5173'
$env:SMTP_HOST       = '127.0.0.1'
$env:SMTP_PORT       = '1025'
$env:SMTP_SECURE     = 'false'
npm run dev                  # or, from the project root in this same window: npm run dev:all
```

The API's startup log must say `Email transport: smtp (plaintext to a local mail catcher on this machine; allowed
only outside production)`. Plaintext is allowed only because `SMTP_HOST` is a loopback address and `NODE_ENV` is not
`production` (see "TLS" above); no real credentials are needed or used. The settings last until that window is
closed.

**3. Try the flows** at http://localhost:5173 with `example.test` addresses, opening each email at
http://localhost:8025:

1. Sign up: the page says "Check your email". Open **Confirm your email**, click the link, then **Confirm my email**,
   and sign in.
2. Sign out, click **Forgot password?**, open **Reset your … password**, and choose a new password. Every signed-in
   browser is signed out, and **… password was changed** arrives.
3. Sign up with the same address again: the page looks the same, and **Sign-in help** arrives instead.
4. Use "Send a new link" on the "Check your email" page: the earlier link then says a newer one was sent.
5. Invite a staff member (Staff → open the person → **Sign-in access** → **Send invitation**), accept the invitation
   from the inbox in a private window, then reset that staff member's password the same way.
6. With `npm run mail:catcher`, book for a customer whose email starts with `bounce` or `tempfail`. The appointment's
   Customer Emails card shows the failure (or the retries), never "sent".

## Monitoring delivery and failures

What exists today (checked 2026-10-24): every attempt writes one line that starts with `[email]`. The line names the
kind and the outcome, and the provider's reply with addresses and SMTP credentials removed. The lines are plain text,
not JSON. Booking email failures are also stored, and shown on the appointment's Customer Emails card. Account email
failures appear only in the log. **No alert is set up**: someone must turn these lines into an alert in the host's
log system or a monitoring service (step 10 of `STAGING.md`). That needs access to the host and to an alert channel.

**What the provider's "accepted" means.** The `250` reply after the message ("Accepted by the mail server", status
`sent`) means the provider has taken responsibility for the message. It does **not** mean the mailbox exists, that the
message reached the inbox, that it was not filtered as spam, or that it was read. Most providers report bounces and
complaints afterwards, asynchronously. This app does not receive those reports (it has no provider webhook). Read them
in the provider's dashboard, and turn on its suppression list so it stops sending to addresses that bounced or
complained. Which notifications exist, and how to subscribe to them, depends on the provider; check its own
documentation once it is chosen.

Every attempt is logged on one line that starts with `[email]`. The log names the email kind, never the recipient's
address, the link or the message:

| Log line | Meaning |
|---|---|
| `[email] confirmation for <appointment>: sent via smtp (attempt 1)` | Accepted by the mail server |
| `[email] reschedule for <appointment>: attempt 1 failed via smtp, retrying at <time>: <reason>` | Temporary failure; it will be retried |
| `[email] cancellation for <appointment>: FAILED via smtp after 4 attempt(s): <reason>` | Gave up; the Customer Emails card shows it |
| `[email] staff invitation: FAILED via smtp: <reason>` | The administrator was told; no invitation is open |
| `[email] account password_reset: attempt 1 failed via smtp, retrying in 60s: <reason>` | Account email; the worker retries it from the queue, with a new link |
| `[email] account verify: FAILED via smtp after 1 attempt(s): <reason>` | The person did not get the email and can ask again |
| `[email] account verify: EXPIRED, not sent (past its age limit or its link expiry)` | A retry was still waiting at its deadline; the person can ask again |
| `[email] account password_reset: EXPIRED after attempt 2 failed via smtp: no retry fits before its age limit; …` | The next retry would have come too late; not sent |
| `[email] account password_reset: superseded, not sent (the link was replaced or used, or is no longer valid)` | A newer request, a password change or the use of the link cancelled a waiting retry |
| `[email] account password_reset: an interrupted attempt was found; it will be retried with a new link` | The server stopped mid-send; the person may get two emails |
| `[email] account queue: removed N finished row(s) older than 7 days` | Routine cleanup |
| `[email] account password_reset: FAILED while preparing the retry: <reason>` | The database refused the retry (for example, it was busy or full); not sent |
| `[email] confirmation for <appointment>: FAILED via smtp after 1 attempt(s): Recipient not allowed on this server (EMAIL_ALLOWED_RECIPIENTS)` | The recipient is not in `EMAIL_ALLOWED_RECIPIENTS`; nothing was sent (the same reason appears for invitations and account emails) |
| `[email] N email(s) were interrupted by a restart; marked "unknown" …` | Check the provider's log before using Resend |

On a Linux host with systemd, for example:

```bash
sudo journalctl -u workeasy360 --since "1 hour ago" --no-pager | grep -E '\[email\].*(FAILED|failed|unknown|not sent|EXPIRED|interrupted)'
```

Also watch the provider's dashboard for bounces, complaints and suppressed addresses, and read the DMARC aggregate
reports (the `rua` address in the DMARC record). Many `failed` lines with `EAUTH` or `ECONNREFUSED` mean the settings
or the provider are wrong, not the recipients.

## Proving real delivery on staging

The tests above never reach a real inbox. On a staging server with SMTP configured (settings in `server/.env` or the
platform's secret store, never on the command line):

```bash
cd server
npm run email:test -- --verify-only                  # connect, TLS, sign in; sends nothing
npm run email:test -- --to <dedicated-test-inbox>    # then exactly one message to an inbox you control
```

With `EMAIL_ALLOWED_RECIPIENTS` set (as on staging), the `--to` address must be on that list; otherwise the command
prints `Not sent: the --to address is not allowed …` and stops with exit code 2 before connecting. When it does
connect, it prints a `Recipients:` line with counts only.

The command uses the same settings, checks and TLS options as the server, sends at most one message, does not open
the database, and never prints credentials (a provider reply that repeats them shows `[redacted]`). It prints:

- the mail server, the TLS mode (`TLS from the start` or `STARTTLS required`) and whether it signs in;
- `Connection, TLS and sign-in: OK`, or the stage that failed and `What to check:` with the setting to look at
  (`SMTP_HOST`/`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`/`SMTP_PASS`, `EMAIL_FROM`), never its value. Exit code 1;
- after a send: `Accepted by the mail server`, the `Message-ID` and the mail server's reply (usually with the provider's
  queue id).

**Accepted is not delivered.** The provider can still bounce, delay or filter the message. Delivery is verified only
when the message is found in the test inbox and its headers show `spf=pass`, `dkim=pass` and `dmarc=pass`. A provider
whose certificate does not verify, or that does not offer STARTTLS on 587, fails here exactly as it would for real
emails. The full procedure, with the DNS checks and the booking, reschedule, cancellation, invitation, sign-up
confirmation and password-reset emails, is in `STAGING.md` (steps 8 and 8a). Real delivery stays unverified until
those messages have been received and checked.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| "Not sent — email off" | `EMAIL_TRANSPORT=disabled` | Configure SMTP and restart the server |
| Failed, `Invalid login` / EAUTH | Wrong SMTP user or password | Fix the credentials in `server/.env`, restart the server (SMTP settings are read at startup), then use Resend |
| Failed, 550 / "Recipient rejected" | The address does not exist or is blocked | Correct the customer's email, then Resend |
| Failed, `Recipient not allowed on this server (EMAIL_ALLOWED_RECIPIENTS)` | This server restricts recipients and the address is not listed | On staging, use a listed test address. To allow another one, add it (an exact address or `@domain`) and restart. Production normally leaves the setting unset |
| Retrying | The provider or network is temporarily unavailable | Nothing; check again in 20 minutes |
| Outcome unknown | The server stopped mid-send | Check the provider log for the Message-ID before resending |
| Delivered but in spam | SPF, DKIM or DMARC missing or failing | Fix the DNS records above |
| Sign-up or "Forgot password?" says "Email is not set up on this server" | `EMAIL_TRANSPORT=disabled` | Configure SMTP and restart the server |
| No confirmation or reset email | Spam filtering; a temporary failure being retried (for up to an hour); or, by design, nothing is sent (reset for an address without an active sign-in) | Check spam and the newest email; look for `[email] account …` lines in the server log; request a new link |
| "A newer confirmation link was sent" or "no longer valid" | A newer link was requested, or (reset) the password was changed since | Use the newest email or request a new link |
| Links open the wrong site or use http | `PUBLIC_APP_URL` | Set it to the https address of the web app and restart |
| Startup: `SMTP_USER and SMTP_PASS are required in production` | Production SMTP without credentials | Add the provider's SMTP credentials (production always signs in over TLS) |
| Failed, `Error upgrading connection with STARTTLS` (`ETLS`) | The mail server does not offer STARTTLS on that port, or something on the network removed the offer | Use the provider's port 465 with `SMTP_SECURE=true`; check the host and port in the provider's documentation |
| Failed, `self-signed certificate`, `unable to verify` or `does not match` | The certificate does not verify for `SMTP_HOST` (wrong host name, an interception proxy, or a local relay) | Use the exact host name the provider documents. Never turn verification off |
| Failed, greeting or connection timeout on 465 | Port 465 blocked by the hosting network | Ask the host to allow outgoing 465, or use 587 with `SMTP_SECURE=false` |
