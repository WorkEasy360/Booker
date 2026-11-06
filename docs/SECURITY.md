# Security model and production checklist

This page describes how WorkEasy360 protects accounts, business data and customers' bookings, and what must be in
place before going live. The server enforces everything described here. The web app only hides what a role
cannot use.

## Sign-in and sessions

- Passwords are hashed with bcrypt (cost 12). A failed sign-in takes the same time whether or not the account exists.
- A sign-in creates a server-side session (`user_sessions`). The session cookie is `HttpOnly`, `SameSite=Lax`,
  `Path=/`, lasts 7 days by default (`JWT_EXPIRES_IN`), and is never returned in a response body. In production it is
  also `Secure` and named `__Host-we360_session`, so it cannot be set by a subdomain.
- On every request the server re-reads the session, the user's role, organization and active state from the database.
  Changes take effect on the next request:
  - **Logout** ends the session on the server, so a copied cookie stops working.
  - **Changing the password** ends every other session of that user.
  - **Resetting the password** from an emailed link ends every session of that user, on every device.
  - **Deactivating** a user, or a staff member with a sign-in, signs them out everywhere.
  - Tokens from before server-side sessions, tokens signed with another key, and unsigned tokens are refused.
- Settings → Security lists your active sessions and can sign out all the others.

## Sign-up confirmation and password reset

- **Sign-up confirms the email address first.** Signing up stores a pending request (`signup_requests`) and emails a
  confirmation link. The business and its administrator are created only when the link is confirmed (the page asks for
  a click on "Confirm my email"; opening the link changes nothing), and the person then signs in normally.
- **Password reset** ("Forgot password?" on the sign-in page) emails a link for choosing a new password. Owners,
  managers and staff use the same flow. Only an account that can sign in gets the email: an active user and, for a
  staff sign-in, an active staff member.
- **Nothing in either flow signs anyone in.** Both end on a page that links to the sign-in page.
- **Links.** Each link carries 32 random bytes from the operating system's CSPRNG (`crypto.randomBytes`),
  base64url-encoded, after `#` in the URL. Browsers never send that part to a server, so it stays out of access logs
  and `Referer` headers. The page reads it and removes it from the address bar. Only its SHA-256 hash is stored.

  | | Confirmation link | Password-reset link |
  |---|---|---|
  | Lifetime | 24 hours | 60 minutes |
  | Uses | one | one |
  | Requesting a newer link for the same address or account | replaces the older ones | replaces the older ones |
  | Also ended by | — | a password change in Settings, and a completed reset |

- **One winner.** A link is consumed by a conditional update inside an immediate (write-locked) transaction, so two
  simultaneous uses cannot both succeed. The tests run them concurrently (`server/src/tests/account-recovery.test.ts`).
- **After a reset** the new password follows the same policy (at least 8 characters, an uppercase letter and a number)
  and is hashed with bcrypt. Every session of the account ends, the account's failed sign-in count is cleared, and a
  "your password was changed" email goes to the account address.
- **No address discovery.** Sign-up, "Send a new link" and "Forgot password?" give the same status (`202`) and the
  same message for every address: "We’ll send an email with the next steps if the address can be used for this
  request." They do the same work for every address (sign-up always hashes the password), and emails are sent in the
  background, so the response time does not depend on the mail server. What happens next reaches only the mailbox:
  a confirmation link for a new address, a "you already have an account" email (with sign-in and reset links) for a
  registered one, and nothing for an address that cannot use the request. The tests compare status, body and timing
  for registered and unknown addresses.
- **Email is required.** Without email (`EMAIL_TRANSPORT=disabled`), sign-up, new links and password reset answer
  `503 EMAIL_NOT_CONFIGURED` for every address, never a pretend success. Existing accounts sign in as before.
- **Logs** never contain tokens, links, passwords or the addresses involved. Email failures are logged by kind only.
- **Queued account emails hold no secrets.** Retries of account emails (migration 009, `account_email_queue`) store
  the kind of email, a reference to the account, sign-up request or reset link, and status and times: never a token,
  link, message or email address. Each retry of a confirmation or reset email issues a new link with the original
  expiry, so the earlier link stops working; a used, replaced or expired link is never sent.
  Errors are stored with addresses removed, and the log lines
  name only the kind of email and the outcome. Finished rows are deleted after 7 days.
- **Stored data.** A pending sign-up keeps the bcrypt hash of the chosen password until it is confirmed (the copy is
  then cleared) or removed, 7 days after its link expired. Used and expired reset records are removed after 30 days.
- **Existing accounts** keep working unchanged and count as confirmed. Migration `008_account_tokens` adds two tables
  and changes no existing rows. A sign-in's email address cannot be changed afterwards (staff with a sign-in keep
  their address), so every account address was proven by sign-up confirmation or an invitation, or predates this
  release.
- **Staff invitations** are separate and unchanged: their own tokens, table and 72-hour lifetime.

## Cross-site request protection

- **Origin check.** Every state-changing request (POST, PUT, PATCH, DELETE) sent by a browser must come from an origin
  listed in `CORS_ORIGIN`, or from the origin of `PUBLIC_APP_URL`. Requests carrying another `Origin`, an opaque origin
  (`null`) or a foreign `Referer` are refused with `403 ORIGIN_NOT_ALLOWED`.
- **CSRF token.** A change authenticated by the session cookie must also carry an `X-CSRF-Token` header (sign-out is
  the exception: it only ends the session, and the origin check still applies). The token is an HMAC of the session
  id, returned by sign-in, invitation acceptance and `/api/auth/me`. Another site can neither read nor compute
  it.
  Requests that authenticate with an `Authorization: Bearer` header need no CSRF token, because browsers never add
  that header on their own.
- CORS grants access only to the configured origins, with credentials.

## Roles and permissions

| | Administrator | Manager | Staff |
|---|:-:|:-:|:-:|
| See services, staff, workspaces, settings | ✓ | ✓ | ✓ |
| See and change customers | ✓ | ✓ | — |
| See every appointment; book, change, cancel | ✓ | ✓ | — |
| See their own appointments only | | | ✓ |
| Resend booking emails, reports and dashboard | ✓ | ✓ | — |
| Add and edit services, resources, booking pages | ✓ | ✓ | — |
| Workspaces, staff and their sign-in access, business settings | ✓ | — | — |
| Time off, closures and weekly breaks: view | ✓ | ✓ | — |
| Time off, closures and weekly breaks: add and remove | ✓ | — | — |
| Assistant (searches business data) | ✓ | ✓ | — |
| Rebuild the assistant knowledge index | ✓ | — | — |

- The person who creates the business is its administrator.
- Staff members get a sign-in only through an **email invitation** from an administrator:
  - Each invitation is a random single-use token, stored only as a SHA-256 hash.
  - It expires after 72 hours, and a newer invitation replaces older ones.
  - It works only while the staff member is active and still has the invited address.
  - Accepting it proves the person controls that inbox and creates a sign-in tied to exactly one staff record and
    organization.
  - Invitations cannot be sent when email is not configured.
  - Sending an invitation reveals an existing sign-in only when it belongs to the same business. For an address
    that has a sign-in in another business the invitation is sent as usual and accepting it is refused, so admins
    cannot use invitations to find out which addresses have accounts elsewhere
    (`server/src/tests/invitations.test.ts`).
- An unknown role gets no permissions. Assistant proposals are re-checked against the role when confirmed.

## Organization isolation

Every query that reads or changes business data is scoped to the signed-in user's organization. This includes nested
resources (appointment email history and resend, staff invitations, booking page publishing) and the assistant's
conversations, proposals and workflows. Records cannot reference another organization's services, staff, customers,
workspaces or resources. Another organization's ids are treated as not found: 404 for the record itself, 400 when
used as a reference in a request. The test suite covers each resource (`server/src/tests/rbac.test.ts`,
`server/src/tests/invitations.test.ts`).

## Customers' bookings

- A booking reference **alone grants nothing**. A customer manages a booking:
  - right after booking, from the confirmation page (a signed link like the one in the email);
  - from the signed link in their booking email, which stays valid until 7 days after the appointment; or
  - by entering the reference together with the email address they booked with, which issues a link valid for
    60 minutes.
- Manage links are bound to the appointment and the customer's current email address, so links sent to an old address
  stop working when the business corrects the address. Expiry and tampering are detected (HMAC-SHA256). The token
  travels in the URL fragment and in a request header, never in a query string.
- The manage page shows the booking, the business name, phone and website, and a masked email. It never shows the customer's
  name, phone, notes, answers or the business's internal notes.
- Only services listed on a published booking page can be viewed or booked publicly. A customer holding a valid
  manage link can still see times for, and reschedule, their own existing booking after the page is unpublished.

## Rate limits (per network address unless noted)

| What | Limit |
|---|---|
| Failed sign-ins, same account and address | 5 per 15 minutes |
| Failed sign-ins, same address | 30 per 15 minutes |
| Failed sign-ins, same account (any address), from browsers that have never signed in to it | 20 per hour |
| Sign-ups | 10 per hour; 3 per hour per email address, from any network |
| New confirmation links | 10 per 15 minutes; 3 per hour per email address |
| Password-reset requests | 10 per 15 minutes; 3 per hour per email address |
| Failed confirmation and reset link checks | 10 per 15 minutes |
| Public bookings | 30 per 10 minutes; 5 per hour per customer email |
| Failed booking lookups | 10 per 15 minutes per address; 5 per 15 minutes per booking reference |
| Self-service changes | 20 per 15 minutes per address; 6 per hour per booking |
| Email resends | 3 per 10 minutes per appointment; 30 per hour per business |
| Staff invitations | 20 per hour per business; 10 failed token checks per 15 minutes per address |
| Public page and availability reads | 600 per 5 minutes |
| Failed password changes | 5 per 15 minutes per user |
| Rebuilding the assistant knowledge index | 3 per 10 minutes per business |

**Known devices.** After a successful sign-in the browser keeps a signed, HttpOnly device cookie for that account.
The account-wide limit applies only to browsers without one. Someone guessing a password from elsewhere can slow
down sign-ins from new devices for an hour, but cannot lock the owner out of the browsers they already use. The
per-address limits still apply to every browser. The cookie only exempts a browser from that one limit; it never signs
anyone in.

Limits that protect secrets count **failures only**, so an office or school sharing one public address is not blocked
by its own successful sign-ins. Sign-up, new-link and reset requests count every request, the same way for registered
and unknown addresses. Refused requests get `429` with a `Retry-After` header. Limits are kept in memory: run
one API process, or move them to a shared store before scaling out. Behind a reverse proxy, set `TRUST_PROXY` (usually
`1`) so limits see real client addresses. Without it, `X-Forwarded-For` is ignored and cannot be spoofed.

## Servers that must not email real people (staging)

`EMAIL_ALLOWED_RECIPIENTS` limits a server to the listed addresses and `@domain` entries (exact matches only: no
subdomains, no wildcards, plus-addresses listed one by one). Every other recipient is refused before the mail server
is contacted, for every kind of email and for `npm run email:test`, and recorded without the address. A malformed
value stops the server from starting instead of lifting the restriction. It adds to, and does not replace, a staging
database without real customer records and staging-only SMTP credentials (see `EMAIL.md`).

## Production checklist

In production (`NODE_ENV=production`) the server refuses to start when the first three items are wrong (or when
`JWT_EXPIRES_IN` or the email settings are invalid), and warns about the next two. It names the setting, never its
value. The rest are not checked by the server.

- [ ] `JWT_SECRET`: at least 32 random characters with enough variety (at least 10 different characters), and none
      of the placeholder words such as "example", "changeme" or "placeholder". Generate one with
      `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`. Changing it signs everyone out and
      invalidates manage links in emails already sent.
- [ ] `CORS_ORIGIN`: the https origin of the web app (comma-separated if several, no `*`, no path; http is accepted
      only for localhost).
- [ ] `PUBLIC_APP_URL`: https; used in email links.
- [ ] Email configured and the sending domain's SPF, DKIM and DMARC records in place (see `EMAIL.md`). SMTP over TLS:
      port 465 with `SMTP_SECURE=true` (preferred), or 587 with `SMTP_SECURE=false`, where the server requires
      STARTTLS. Production refuses to start without `SMTP_USER`/`SMTP_PASS`, and certificates are always verified.
      SMTP credentials only in `server/.env` (mode 600) or the platform's secret store.
      The server warns if email is disabled.
- [ ] `EMAIL_ALLOWED_RECIPIENTS` unset, unless restricting recipients is intended; the startup log line `Email
      recipients:` shows which applies.
- [ ] `TRUST_PROXY` set when behind a proxy or load balancer (the server warns otherwise).
- [ ] Serve the app and the API over https only. Serving both from one origin (reverse proxy `/api` to the API) is
      simplest.
- [ ] Nightly backups with off-server copies (see `DATABASE_OPERATIONS.md`).
- [ ] Keep `server/.env` out of version control and readable only by the service account.
- [ ] `npm audit --omit=dev` reports no vulnerabilities in the project root and in `server/`. Both were clean on
      2026-10-22, after the web app moved to React Router 7.18 (6.x has an open-redirect advisory with no 6.x fix).
      Run it again before every release.

## Not covered yet

- Two-factor authentication.
- Inviting additional administrators (invitations create Staff or Manager sign-ins).
- Staff sign-ins can view their own appointments but cannot change their status.
- Rate limits are per process (single-instance deployments only).
- Development tools have known advisories that never reach users. Vite 5.4's dev server has Windows path-check and
  open-in-editor advisories that matter only while `npm run dev` runs on a developer machine (it listens on localhost
  only). Upgrading to Vite 6.4.4 or later is a separate toolchain change. Jest 29 pulls in `braces` and `sprintf-js`,
  which have denial-of-service advisories that affect test runs only.
- One email address belongs to one business. A sign-in is bound to a single organization, so isolation never depends on
  choosing the right business at sign-in. Someone who works for two businesses uses a different address for each.
  Supporting several memberships per sign-in would need a memberships table, an organization switcher, and sessions
  bound to a membership.
