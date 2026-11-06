# Deploying WorkeasyBooking

WorkeasyBooking is two parts:
- **The web app**: static files built by Vite into `dist/`. It calls the API at the relative path `/api`.
- **The API**: a Node.js/Express server in `server/` that keeps all data in one SQLite file.

Serve both from **one https origin**: the web server (nginx, Caddy, IIS, a load balancer) serves `dist/` and forwards
`/api/` to the API. Hosting the web app alone (for example on Vercel with only `vercel.json`) does not work: the app
would have no API.

Related: `RAILWAY.md` (one Railway service with a volume: fit, steps, backups), `PRODUCTION_LAUNCH.md` (launching for one client: architecture, owner actions, install runbook, feature
status), `CLIENT_ONBOARDING.md` (the client administrator's first day), `STAGING.md` (step-by-step staging
verification with exact commands), `SECURITY.md` (production checklist), `EMAIL.md` (SMTP and DNS),
`DATABASE_OPERATIONS.md` (backup, restore, migrations), `SCHEDULING.md`, `INTEGRATIONS.md` (what is not built).

## Requirements

- Node.js 24 LTS, or 22.13 or later (tested with Node 24.19). The database driver, `better-sqlite3` 13, needs Node 22
  or later; both `package.json` files declare the supported range. `better-sqlite3` is a native module: install on
  the target OS and CPU (or build the image there), do not copy `node_modules` from a developer machine. It ships
  ready-made binaries for Linux, Windows and macOS, but npm 11 still tries to compile it with node-gyp (which needs
  Python 3 and a C++ compiler): install with `npm ci --ignore-scripts` (the only other install scripts, esbuild's and
  fsevents', are not needed), or install the compiler tools.
- A persistent disk for the database (see "Data and persistence").
- A domain with https, and an SMTP provider with SPF, DKIM and DMARC set up for the sending domain.

## Environment variables (`server/.env` or the service manager)

| Variable | Required in production | Meaning |
|---|---|---|
| `NODE_ENV` | yes, `production` | Turns on the startup safety checks and secure cookies |
| `JWT_SECRET` | yes | At least 32 random characters, not a placeholder. Changing it signs everyone out and breaks manage links in emails already sent |
| `JWT_EXPIRES_IN` | no (default `7d`) | Session lifetime, 5m to 30d |
| `CORS_ORIGIN` | yes | The https origin of the web app, for example `https://book.example.com`; several comma-separated; no `*` |
| `PUBLIC_APP_URL` | yes | https URL of the web app, used for links in emails (manage-booking, invitation, sign-up confirmation and password-reset links) |
| `TRUST_PROXY` | yes behind a proxy | Usually `1` (one proxy hop), so rate limits see real client addresses |
| `PORT` | no (default `3001`) | Port the API listens on. It listens on all network interfaces, so use a firewall or a private network so only the proxy can reach it |
| `DB_PATH` | yes | Database file. In production it must be an absolute path outside the application folder, on the persistent disk or volume (for example `/var/lib/workeasy360/workeasy360.db`, or `/data/workeasy360.db` on Railway): otherwise the server **refuses to start** before opening anything (`server/src/db/location.ts`); there is no fallback database. Outside production the default is `./data/workeasy360.db`, relative to the directory the server starts in |
| `SIGNUP_MODE` | recommended, `closed` for a server run for one client | `open` (default): anyone can create a new business at `/signup`. `closed`: sign-up, its email confirmation and resend answer 403 `SIGNUP_CLOSED`; the operator creates the business and its administrator with `npm run org:create` (see "First production start"). Any other value stops the server from starting |
| `EMAIL_TRANSPORT` | yes, `smtp` | `disabled` sends nothing (the server warns), and then sign-up and password reset are unavailable: they answer "Email is not set up on this server" |
| `EMAIL_FROM` | with smtp | For example `WorkeasyBooking <bookings@example.com>`; the domain must match the SPF/DKIM setup |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | with smtp | Provider settings. Prefer port 465 with `SMTP_SECURE=true` (TLS from the start); with `SMTP_SECURE=false` STARTTLS is required (see "TLS" in `EMAIL.md`). `SMTP_USER`/`SMTP_PASS` are required in production and are secrets (see step 3 of `STAGING.md`). Startup checks them but does not connect: test with `npm run email:test` |
| `EMAIL_RETRY_DELAYS_MS`, `EMAIL_WORKER_INTERVAL_MS` | no | Retry timing; the defaults suit production |
| `EMAIL_ALLOWED_RECIPIENTS` | staging: yes; production: leave unset | Comma-separated exact addresses and `@domain` entries; every other recipient is refused before the mail server is contacted. A malformed value stops the server from starting. Set in production, every other customer would get no email (see "Restricting recipients" in `EMAIL.md`) |
| `RATE_LIMITS` | never set | `off` exists for automated tests only |
| `TWO_FACTOR_ENCRYPTION_KEY` | recommended | 32 random bytes (64 hex characters) that encrypt authenticator secrets. Without it a key derived from `JWT_SECRET` is used, and changing `JWT_SECRET` would then stop existing authenticator apps from working (recovery codes keep working; the server warns at startup) |
| `UPLOAD_DIR` | recommended | Folder for uploaded logos and staff photos (default `uploads` next to `DB_PATH`). Put it on the persistent volume and back it up with the database. In production, a relative path or one inside the application folder refuses startup |
| `WEB_DIST_DIR` | no | Absolute path of the built web app (`dist/`). When set, the API also serves the web app on the same origin, so no separate web server is needed (the `Dockerfile` sets `/app/dist`; see `RAILWAY.md`). Unset: API only, and a reverse proxy serves `dist/` |
| `GEMINI_API_KEY` | no (secret) | Google Gemini API key (from Google AI Studio). When set, the in-app assistant answers with Gemini: only about WorkeasyBooking and the business's own data, using the same tools and Confirm step as before (`server/src/services/ai-agent.ts`). Server side only: never sent to browsers or logged. Sent to Google with each question: the question, the conversation's recent messages, help-article excerpts and the records the assistant looks up. Use a Google project with billing enabled, so Google's paid-service data terms apply. Unset: the local knowledge-search assistant. If Google fails, the local assistant answers. Each user may get 30 model answers per 10 minutes, each business 300 per hour |
| `GEMINI_MODEL` | no | Gemini model name (default `gemini-2.5-flash`). An invalid name stops the server from starting |
| `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `PAYPAL_WEBHOOK_ID` + `PAYPAL_CLIENT_ID` + `PAYPAL_CLIENT_SECRET` (+ `PAYPAL_API_BASE`) | no | Payment notifications at `/api/webhooks/payments/{stripe,razorpay,paypal}`; without them those endpoints answer 503. Online checkout itself is not built |
| `GOOGLE_CLIENT_ID`/`_SECRET`, `MICROSOFT_CLIENT_ID`/`_SECRET`, `ZOOM_CLIENT_ID`/`_SECRET`, `MAILCHIMP_CLIENT_ID`/`_SECRET` | no | Lets businesses connect those accounts (OAuth, redirect URI `<PUBLIC_APP_URL>/api/integrations/<provider>/callback`). A connected Google or Outlook calendar can be the business calendar that bookings are synced to (`NOTIFICATIONS.md`); meeting links and list sync are not built yet |
| `PUBLIC_API_URL` | with SMS or WhatsApp | Public https address of the API (for example `https://api.example.com`). Twilio delivery reports and their signature checks need it; the Integrations page shows the webhook addresses built from it. Without it Twilio callbacks are refused |
| `NOTIFICATIONS_PROVIDER_MODE` | leave unset | `mock` sends SMS, WhatsApp and calendar calls to an in-process stand-in (the default outside production); `live` calls the providers (the default in production). Never set `live` on development or staging machines. SMS and WhatsApp credentials are entered per business in the app and stored encrypted, not in `.env` (see `NOTIFICATIONS.md`) |
| `WEBHOOKS_ALLOW_PRIVATE_NETWORK` | never set | `1` lets webhooks reach private network addresses; for local tests only, ignored in production |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | leave out | Read only by `npm run seed` (development demo data), which refuses to run in production. They are commented out in `server/.env.example`; do not set them on a production server |

The web app build needs no variables. Sign-up confirmation and password reset add no variables: they use the email
settings and `PUBLIC_APP_URL` above. Their link lifetimes (24 hours and 60 minutes) are fixed in
`server/src/services/account-tokens.ts`.

The API **refuses to start** in production when `JWT_SECRET`, `JWT_EXPIRES_IN`, `CORS_ORIGIN`, `PUBLIC_APP_URL` or
the email settings are unsafe or invalid, including `EMAIL_TRANSPORT=memory` (a test transport that records emails as
sent without delivering them). Invalid values (a missing secret, a malformed origin or lifetime, incomplete SMTP
settings, an unknown `SIGNUP_MODE`) refuse startup in development too; outside production, weak but valid values only
warn. The message names the setting, never its value. In production it also warns (but starts) when email is
disabled, `TRUST_PROXY` is missing, `DB_PATH` is missing or relative, or `NOTIFICATIONS_PROVIDER_MODE=mock`, and in
any environment when `TRUST_PROXY=true`.

Keep `server/.env` out of version control and readable only by the service account. Do not print it in deployment
logs.

## Build and install

```bash
# Web app (project root)
npm ci --ignore-scripts
npm run build                 # type-checks and writes dist/

# API (server/)
cd server
npm ci --ignore-scripts       # include dev dependencies: the build and the db:* scripts use TypeScript and tsx
npm run build                 # writes server/dist/ (tsconfig.build.json: the test suites and their test-only certificates are left out)
npm run test:smoke            # starts the compiled server in production mode on a throw-away database and checks it
```

To move the source to the server, pack it on the build machine with `node server/scripts/make-release.mjs --out
<folder outside the project>`. It packs an explicit list of what the builds need (never `server/.env`, a database,
`server/data`, backups, uploads, `node_modules`, build output or the test suites), lists the archive and deletes it if
anything like that got in, and writes a `.sha256` file for `sha256sum -c` on the server. The release has no test
suites, so run `npm run test:smoke` on the build machine before packing; on the server, use `npm ci --ignore-scripts`
and the checks in `PRODUCTION_LAUNCH.md` section 4.

## Run

```bash
cd server
NODE_ENV=production node dist/index.js      # or: npm start, with the variables set
```

- Run **exactly one API process**. Rate limits and the email retry worker live in that process. Two processes on one
  database would each run a retry worker and keep their own rate-limit counters, so clients could make up to twice
  the allowed attempts. Use a service manager (systemd, a container restart policy, Windows service, pm2 in fork mode)
  to restart it on failure.
- At startup it applies pending database migrations, prints which were applied or skipped and why, resumes due email
  retries, and indexes the assistant's knowledge articles.
- Account emails (sign-up confirmation, sign-in help, password reset and its notice) are queued in the database
  (migration 009) and retried by the same worker, also after a restart, for up to an hour (the password-changed notice:
  24 hours). Booking emails are kept in the outbox.
- **Never run `npm run seed` on a production database.** It creates a demo business and an admin with a known
  password; it now refuses with `NODE_ENV=production`, but do not rely on that alone.
- Health check: `GET /api/health` returns 200 `{"status":"ok","ts":"<time>"}` while the database answers and 503
  `{"status":"unavailable","ts":"<time>"}` otherwise. No other details are exposed.
- Stopping: on `SIGTERM` (systemd stop, a redeploy) or `SIGINT` the API stops accepting connections and stops its
  background workers, lets requests in progress finish for up to 10 seconds, closes the database and exits
  (`src/shutdown.ts`; logged as `[shutdown] …`). Give the service manager at least 15 seconds before it kills the
  process (systemd's default is 90). This is covered by unit tests; it has not been exercised with a real signal on a
  Linux host yet (Windows, where the tests ran, has no `SIGTERM`). A hard kill is still safe: an email or message cut
  off mid-send is marked "unknown" at the next start and never resent blindly.

## Reverse proxy

- Terminate https at the proxy; redirect http to https. Serve `dist/` with a fallback to `index.html` for unknown
  paths (the app uses client-side routes such as `/book/<slug>`).
- Forward `/api/` to `http://127.0.0.1:3001` and pass `X-Forwarded-For` and `X-Forwarded-Proto`.
- Do not cache `/api/` responses. Static files under `dist/assets/` have hashed names and can be cached long-term;
  `index.html` should not be cached.
- Keep request bodies small: the API itself refuses JSON bodies over 100 kB. Logo and staff photo uploads are up to
  2 MB, so allow 3 MB at the proxy (nginx's default of 1 MB would refuse larger images).

Example for nginx:

```nginx
server {
  listen 443 ssl;
  server_name book.example.com;
  # ssl_certificate ... ;
  root /srv/workeasy360/dist;
  client_max_body_size 3m;
  location /api/ { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host;
                   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https; }
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
  location / { try_files $uri /index.html; add_header Cache-Control "no-cache"; }
}
```

## Data and persistence

- The database is the file at `DB_PATH` **plus** its `-wal` and `-shm` files in the same folder. Put the folder on a
  persistent volume (not a container's writable layer, not a network share such as NFS/SMB: SQLite's locking is
  unreliable there) with regular disk snapshots if the platform offers them.
- Back up with `npm run db:backup` (safe while running), at least nightly and before each upgrade, and copy backups
  off the server. Test a restore regularly on a separate file. Details: `DATABASE_OPERATIONS.md`.
- Backups contain customer names, emails and phone numbers. Restrict and encrypt them like the database.
- Uploaded logos and staff photos are files in `UPLOAD_DIR`, not in the database: back that folder up too.

## Scheduled jobs

| Job | How | Notes |
|---|---|---|
| Email retries | Built in (worker inside the API process) | Nothing to schedule |
| Reminders, SMS, WhatsApp, staff and business alerts, calendar sync | Built in (the same worker; durable jobs in the database) | Nothing to schedule. Jobs survive restarts; a job cut off by a restart is marked "unknown", not resent |
| Database backup | cron / Task Scheduler: `cd server && npm run db:backup -- --out /secure/backups` | Nightly, plus before upgrades; prune old generations |
| Restore test | Monthly: restore the latest backup to a scratch file and run `npm run db:status -- --db <file>` | Never restore over the live file while the API runs |
| Dependency audit | Before each release: `npm audit --omit=dev` in the project root and in `server/` | 2026-10-27: root clean; `server/` had body-parser GHSA-27r3-jxmh-p828 (fixed: 1.20.8 → 1.20.9 with `npm audit fix`, lockfile only) and has zod 3 GHSA-mrhx-c7xc-m3w5 open (fix needs zod 4; see `PRODUCTION_LAUNCH.md`, Risks). Never run `npm audit fix --omit=dev`: it uninstalls the dev dependencies the build needs |

Reminders are planned as database jobs and sent by the built-in worker: no cron job is needed (see `NOTIFICATIONS.md`).

## Upgrade procedure

1. Back up (`npm run db:backup`), and archive the release that is running now. The project is not under version
   control, so this archive is the only way back to the previous code. It keeps the built `dist/` and `server/dist/`,
   and must never contain a `.env` file (`.env.example` is left out too; it stays in the source), databases or
   backups:
   ```bash
   sudo mkdir -p /srv/workeasy360-releases
   A=/srv/workeasy360-releases/workeasy360-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
   sudo tar -czf "$A" -C /srv/workeasy360 \
     --exclude=./node_modules --exclude=./server/node_modules --exclude=./server/data --exclude=./server/backups \
     --exclude=./.acceptance --exclude='.env' --exclude='.env.*' \
     --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.db-journal' --exclude='*.db.json' .
   sudo sh -c "cd /srv/workeasy360-releases && sha256sum $(basename "$A") > $(basename "$A").sha256"
   tar -tzf "$A" | grep -E '(^|/)\.env($|\.)|\.db(-wal|-shm|-journal|\.json)?$|/data/|/backups/' && echo 'STOP: secrets or data in the archive'
   ```
   The last command must print nothing. Keep several archives, readable only by administrators.
2. Build the new web app and API.
3. Stop the API, replace `dist/` and `server/dist/`, start the API.
4. Check the startup log for the migration report (`[migrations] N/N applied`, or skipped migrations with reasons),
   then `GET /api/health`, sign in, and open a public booking page.
5. To roll back:
   ```bash
   sudo systemctl stop workeasy360
   cd /srv/workeasy360-releases && sha256sum -c <archive>.tar.gz.sha256      # must say OK
   sudo mv /srv/workeasy360 /srv/workeasy360.failed-$(date -u +%Y%m%dT%H%M%SZ)
   sudo mkdir /srv/workeasy360 && sudo tar -xzf <archive>.tar.gz -C /srv/workeasy360
   sudo mv /srv/workeasy360.failed-<time>/server/.env /srv/workeasy360/server/.env   # the secrets file stays out of archives
   sudo chown -R workeasy360: /srv/workeasy360 && cd /srv/workeasy360/server && sudo -u workeasy360 npm ci --ignore-scripts
   sudo systemctl start workeasy360
   ```
   Then step 4 again. The database lives at `DB_PATH` outside the release folder and is not touched. Restore the
   backup from step 1 only if the old version cannot run on the database (see below). On 2026-10-24 this was
   rehearsed on the development machine: the archive held no secrets file or database, its checksum verified, and
   the unpacked copy passed the production smoke test (19/19). It has not been rehearsed on a staging host yet: do it
   once there (STAGING.md, step 11) before relying on it.

**Upgrading to sign-up confirmation and password reset (migration `008_account_tokens`).** The migration only adds
two tables (`password_resets`, `signup_requests`) and changes no existing rows. Existing accounts keep their passwords
and sessions and count as confirmed. Email must be configured first, otherwise new sign-ups and password reset are
unavailable. To roll back the code without restoring the backup: the older build ignores the two new tables, so
putting back the previous build is enough; links already emailed then stop working, and sign-ups that were waiting
for confirmation are not created (those people sign up again). Restoring the step-1 backup also works, but loses
everything written since. Do not drop the tables by hand: if the newer build is started again, the migration is already
recorded and would not recreate them.

**Upgrading to queued account emails (migration `009_account_email_queue`).** The migration only adds one table
(`account_email_queue`) and three indexes; it reads and changes no existing row, and the table starts empty. The queue
holds no token, link, message or email address (see `EMAIL.md`, "Account email retries"). On 2026-10-24 it was applied
to disposable copies of the five local databases (each twice, through the previous release first and directly) with
no row changed, integrity and foreign keys intact; this has not been done on staging. To roll back the code without
restoring the backup: the older build ignores the table and its migration record, so putting back the previous build
is enough (rehearsed locally with the pre-009 release archive: it started, and an account created after the upgrade
signed in). While the older build runs, account emails are retried in memory again, and retries waiting in the queue
are not sent; when the newer build is started again, waiting retries past their deadline are marked `expired`, never
sent late. Restoring the step-1 backup also works, but loses everything written since. Do not drop the table by hand:
if the newer build is started again, the migration is already recorded and would not recreate it.

**Upgrading to the notification platform (migration `017_notification_platform`).** The migration only adds ten tables
and four indexes (`notification_jobs`, `notification_attempts`, rules, reminder times, business recipients, staff
preferences, customer consent, SMS/WhatsApp connections, calendar event links, provider callback ids); it reads and
changes no existing row, and every table starts empty. The previous reminder and staff-alert queue
(`notification_queue`, migration 014) is no longer used: at the first start, its unsent entries are marked
superseded and the new worker plans reminders for upcoming bookings again; nothing is sent twice. Leave
`NOTIFICATIONS_PROVIDER_MODE` unset outside production. On 2026-10-24 the migration was applied to a verified backup
of the development database on disposable copies, with these results:
- every pre-existing table unchanged; the migration log gained only 017;
- idempotent; the API started on the result;
- recovery by `db:restore` and a schema rollback (dropping the ten tables and the 017 log row) each gave back exactly
  the pre-migration database.

It was then applied to the development database with the same results. This has not been done on staging. To roll
back the code, restore the previous release archive; the older build ignores the new tables. Restoring the step-1
backup also works but loses everything written since.

## When something goes wrong

First steps for the common failures. Check the log with `sudo journalctl -u workeasy360 --since "1 hour ago"` (or
the platform's log viewer). It names settings, never their values.

| Symptom | Check | Action |
|---|---|---|
| `GET /api/health` fails or answers 503 | Is the process running (`systemctl status workeasy360`)? Does the startup log show a refused setting or a failed migration? Is the disk full? | Fix the named setting and start again. A failed migration rolls back by itself and names the migration; restore only if the database is damaged (`npm run db:status` shows integrity not ok) |
| Emails failing (`[email] … FAILED` or `failed` lines) | `npm run email:test -- --verify-only` on the host: it names the setting at fault (host and port, TLS, sign-in) | Fix the setting and restart. Booking emails that failed can be resent from each appointment (Resend). Account emails are retried automatically for up to an hour; after that, or after a permanent failure, people request a new link. Check the provider's dashboard for suspended sending or bounces |
| `What to check: TLS failed` or a certificate error | The provider's host name and port; whether something on the network intercepts TLS | Never turn certificate checks off; use the provider's documented host and port 465 with `SMTP_SECURE=true` |
| The site's certificate is expiring or expired | `node scripts/staging-check.mjs --url https://<domain>` (the certificate lines) | Renew (for example `certbot renew`) and reload the proxy |
| SMTP password or `JWT_SECRET` may have leaked | Where it was exposed | Create a new SMTP credential at the provider and revoke the old one; generate a new `JWT_SECRET` (this signs everyone out and invalidates manage links in emails already sent); update the secret store; restart |
| Data lost or damaged | `npm run db:status` | Stop the API, restore the newest verified backup to a new file, check it with `db:status`, then put it in place (`DATABASE_OPERATIONS.md`). Data written after that backup is lost |
| Many sign-in or booking refusals (`429`) | Is `TRUST_PROXY` set (otherwise everyone shares the proxy's address)? | Set `TRUST_PROXY=1` behind one proxy; limits reset on restart |

## First production start

1. Start with an empty `DB_PATH`, never a copy of a development or staging database. The schema and all migrations
   are created.
2. Create the client's business and its first administrator. Either:
   - **Recommended for a server run for one client** (`SIGNUP_MODE=closed`; works before email is set up): on the
     server, as the service user,
     ```bash
     cd /srv/workeasy360/server
     npm run org:create -- --db /var/lib/workeasy360/workeasy360.db --company "<Company name>" \
       --name "<Administrator's name>" --email <administrator's email> --country India     # or --timezone Asia/Kolkata
     ```
     It asks for the administrator's password twice at a hidden prompt (or reads `ORG_ADMIN_PASSWORD` for automation),
     never prints it, refuses an email address that already has an account, and creates only the business and that
     one administrator: no services, staff, customers, workspaces, booking pages or bookings. `--db` has no default,
     so the wrong database cannot be picked by accident; `server/.env` is not read. Give the password to the
     administrator out of band; they can change it under Settings → Security.
   - Or, with `SIGNUP_MODE=open` and working email: sign up from the web app (`/signup`), open the confirmation link
     from the email, and sign in. The person who signs up becomes its administrator.
3. Settings: check the business time zone (India defaults to Asia/Kolkata, otherwise the browser's zone, or America/New_York if the browser reports none), currency
   and working hours, then create services, staff and a booking page (`CLIENT_ONBOARDING.md`).
4. Make a test booking with an address you own and confirm the email arrives, links to the https site, and shows the
   right time and zone.

## Supported topology

The current code supports exactly one shape:

- **One API process on one host**, with the SQLite file on that host's local persistent disk.
- A reverse proxy on the same host (or in front of it) serving `dist/` and forwarding `/api/`.
- Deploys that **stop the old process before starting the new one** (a few seconds of downtime).

What breaks with more than one API process on the same database file:

| Part | What happens | Where in the code |
|---|---|---|
| Rate limits | Each process counts on its own, so clients get up to N times the allowed attempts | `server/src/middleware/rate-limit.ts` (an in-memory `Map`) |
| Email status after a start | A starting process marks every email still "sending" as "unknown" (crash recovery); emails another running process is sending at that moment are wrongly marked, although they are not sent twice | `recoverInterruptedEmails` in `server/src/services/email/notify.ts` |
| Email retries | Each process runs its own retry worker. Rows are claimed with a conditional update, so nothing is sent twice | `processDueEmails` |
| Startup | Migrations and the assistant's article indexing run at every start and are not designed for two processes starting together | `server/src/db/migrations.ts`, `server/src/services/knowledge-indexer.ts` |
| Bookings | Dashboard and assistant bookings check and write under one write lock, so they stay correct. Public bookings check buffers just before their write; across processes a buffer could be squeezed, though plain overlaps are always refused by database triggers | `server/src/services/bookability.ts`, `server/src/routes/public.ts`, migration 003 |

What breaks with more than one host: each host would have its own database file (separate, diverging data), and
SQLite must not be shared over a network file system. Sessions live in the database, so they survive restarts;
rate-limit counters live in memory, so a restart resets them.

Recovery expectations: a crash is recovered by the supervisor restarting the process; due email retries resume and
interrupted sends are marked "unknown" (resend by hand if needed). Losing the disk means restoring the latest
backup, so data since that backup is lost: back up at least nightly and copy backups off the server.

Scaling beyond this needs a server database (for example PostgreSQL), a shared store for rate limits, and a single
leader for the email worker and startup tasks. That is an architecture change and needs a decision first.

**Rate limits and more than one process.** The limits (sign-in, sign-up, password reset, bookings) are counted in the
memory of the one API process. This is safe only with exactly one process: check that the service manager starts one
instance (systemd unit as in `STAGING.md`; no `pm2 -i`/cluster mode; one container replica), and that a deploy stops
the old process before starting the new one. Nothing in this repository starts more than one, and the staging
platform is not known yet. If more instances are ever needed, two options, neither built yet:
1. Several processes on **one host**: keep the counters in a table in the same SQLite file (small, no new service).
2. Several **hosts**: a shared store such as Redis, which is new infrastructure, needs credentials, and is part of the
   database move above.
Either changes production behaviour and needs approval first.

## Limits of the current design

- **SQLite, one server.** One writer at a time, one machine, no horizontal scaling or active-active failover. Fine for
  a single deployment serving many small businesses; moving beyond it means a server database (for example
  PostgreSQL) and a shared store for rate limits.
- Rate limits are per process and reset on restart.
- Sign-up, password reset and staff sign-in invitations need working email; without it, new businesses cannot sign
  up (use `npm run org:create`), nobody can reset a password and staff cannot be invited (see `SECURITY.md`,
  `EMAIL.md`). Staff invitations do not reveal accounts in other businesses.
- Time off, closures and breaks are enforced but managed through the API only until screens are approved
  (`SCHEDULING.md`).
- Reminders, SMS, WhatsApp and the Google/Outlook business calendar are built but verified against mock providers
  only (`NOTIFICATIONS.md`). Online checkout, report export, recurring and group bookings are not built
  (`INTEGRATIONS.md`, `PRODUCTION_LAUNCH.md`).
