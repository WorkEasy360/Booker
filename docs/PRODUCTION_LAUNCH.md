# Production launch: one client on one server

> **Status on 2026-10-27: not deployed.** No hosting account, server access, domain, DNS record, certificate, SMTP
> account or off-site backup storage has been provided, so nothing in this document has run on a real server and there
> is no production URL. Everything marked "verified" was verified on the development machine, in isolated test
> environments: fresh temporary databases, outgoing network blocked, email disabled or caught by a local test server.
> Section 3 lists what the owner must provide; section 4 is the install runbook to follow once it exists.

Railway (one service with a volume, Pro plan for SMTP) is the quicker route and needs no server administration: see
`RAILWAY.md`. This document describes the VM route and everything common to both (owner actions, onboarding,
feature status, risks).

Related: `RAILWAY.md`, `DEPLOYMENT.md` (reference: variables, proxy, upgrades, rollback, topology), `CLIENT_ONBOARDING.md` (the
client administrator's first day), `SECURITY.md`, `EMAIL.md`, `DATABASE_OPERATIONS.md`, `NOTIFICATIONS.md`.

## 1. Scope of the first release

A small release that works for real, and nothing switched on that only works against stand-ins:

- **On:** sign-in for the client's administrator; business settings; services, staff, workspaces and resources;
  working hours and booking rules; the public booking page; appointments (create, move, cancel, status, history);
  calendar; customers; dashboard and reports; booking emails **once SMTP is set up and tested** (section 4.8).
- **Closed:** public sign-up (`SIGNUP_MODE=closed`). The operator creates the client's business and administrator with
  `npm run org:create`. Nobody else can create a business on this server.
- **Not switched on:** SMS, WhatsApp and the Google/Outlook business calendar (built, verified against mock providers
  only; each needs provider accounts and a live test first), payment webhooks (no checkout exists), outgoing webhooks
  and account connections until the client asks for them. Section 6 classifies every feature.

## 2. Architecture

```
 customers' and staff browsers
        │  https://book.<client-domain>
        ▼
 ┌─────────────────────────── one Linux server (VM) ───────────────────────────┐
 │ nginx :443 (TLS, Let's Encrypt)                                              │
 │   /          → static web app  /srv/workeasy360/dist                         │
 │   /api/      → http://127.0.0.1:3001                                         │
 │                                                                              │
 │ systemd: workeasy360.service ── exactly one Node.js 24 process               │
 │   node /srv/workeasy360/server/dist/index.js                                 │
 │   settings: /etc/workeasy360/workeasy360.env (root:workeasy360, 0640)        │
 │   email worker, reminder planner, webhook worker: inside this process        │
 │                                                                              │
 │ persistent local disk  /var/lib/workeasy360/                                 │
 │   workeasy360.db (+ -wal, -shm)   SQLite, WAL mode                           │
 │   uploads/                        logos and staff photos                     │
 │ /var/backups/workeasy360/  nightly db:backup + uploads archive ──► off-site  │
 └──────────────────────────────────────────────────────────────────────────────┘
        │ SMTP 465 (TLS)                         ▲ external uptime monitor
        ▼                                        │ GET /api/health every 1–5 min
 transactional email provider (SPF, DKIM, DMARC on the sending domain)
```

This is the simplest shape the code supports, and the only one it supports today. Findings that decide it:

| Question | Finding (from the code and the tests) | Consequence for hosting |
|---|---|---|
| Database engine | SQLite through better-sqlite3, WAL mode: one file plus `-wal`/`-shm`. One writer at a time; bookings are checked and written under one write lock, and database triggers refuse overlapping bookings | Needs a **local persistent disk** (not NFS/SMB, not a container's writable layer). Plenty for one client. Serverless or static hosts (the repository's `vercel.json` is an SPA rewrite only) cannot run the API |
| Concurrency | Rate limits are counted in process memory; migrations and the knowledge indexer run at every start; the background workers run in the API process | **Exactly one API process.** Deploys stop the old process before starting the new one (a few seconds of downtime). No cluster mode, no second replica, no overlapping "zero-downtime" deploys |
| Uploaded files | Logos and staff photos are files in `UPLOAD_DIR` (default `uploads` next to `DB_PATH`), not in the database; `db:backup` does not include them | Put `UPLOAD_DIR` on the persistent disk **outside the release folder**, so restarts and redeploys keep it; back it up separately (section 4.9) |
| Background jobs | Emails, reminders and alerts are durable rows. A job is claimed with a conditional update and has a de-duplication key; a send cut off by a crash or restart is marked `unknown` and never resent blindly; a reminder found more than 15 minutes late is skipped, never sent late | Safe across restarts. A fresh production database has no jobs: nothing from development can be sent. Two processes would still not send twice, but would mislabel each other's sends, which is one more reason for one process |
| Tenant isolation | Every business-scoped query is filtered by the organization of the signed-in session. A scan of every route plus the tests (permissions, notifications, integrations, webhooks, uploads, the onboarding check's second business) found no cross-business read or write. Global by design: public booking-page addresses, and booking lookups that need the booking reference **and** the customer's email or the secret manage link | Nothing to configure. `SIGNUP_MODE=closed` keeps other businesses off this server in the first place |
| Startup, health, stop | Startup refuses unsafe settings (secret, origins, URLs, email, sign-up mode) naming the setting, never its value; applies pending migrations, each in a transaction, and logs them. `/api/health` checks the database and exposes nothing else. `SIGTERM` stops new connections and the workers, lets requests finish (10 s), closes the database | systemd with `Restart=on-failure` and `TimeoutStopSec=20`. Graceful stop is unit-tested; not yet exercised with a real signal on Linux (check it once in section 4.7) |

Railway meets these conditions on the Pro plan (`RAILWAY.md`, section 1). A managed platform can replace the VM only if it gives **one** instance, a **persistent volume** mounted at the
database folder, stop-then-start deploys and an https custom domain. Everything else in this document then applies
the same way; the systemd and nginx parts are replaced by the platform's own settings.

## 3. What the owner must provide (blocking)

Nothing here can be done for you: it needs your accounts, your billing or your decisions. **Never send a password,
key or token in chat, email, tickets or documents.** Type secrets only on the server (section 4.4).

| # | Item | Why it is needed | Status |
|---|---|---|---|
| O1 | **Either** a Railway account on the **Pro** plan (SMTP is blocked on Free, Trial and Hobby; `RAILWAY.md`) **or** a hosting account and a Linux VM (Ubuntu 24.04 LTS; 2 vCPU, 2–4 GB RAM, 25 GB+ SSD on a **local** disk; disk snapshots on) with SSH key access and sudo for the operator | Runs the app and holds the database | **Blocked: not provided** |
| O2 | The domain for the client's booking site (for example `book.<client-domain>`) and access to its DNS: an A (and AAAA if IPv6) record to the VM | Customers reach the site; the certificate is issued for it | **Blocked: not provided** |
| O3 | Ports 80 and 443 open to the internet on the VM (for Let's Encrypt and the site); 22 limited to the operator | HTTPS certificate and access | Blocked: needs O1 |
| O4 | A transactional email provider account (for example Amazon SES, Postmark, Mailgun, Brevo, SendGrid), the sending domain verified there with SPF, DKIM and DMARC, and **send-only** SMTP credentials | Booking confirmations, reminders by email, staff invitations, password reset | **Blocked: not provided** |
| O5 | Off-site backup storage (an encrypted bucket or a second server) and credentials for it that can write but not delete, if the provider allows | A lost server must not mean lost bookings | **Blocked: not provided** |
| O6 | An external uptime monitor (any provider) that checks `https://book.<client-domain>/api/health` and alerts you | You learn about an outage before the client does | Blocked: needs O2 |
| O7 | The client's details: company name, administrator's name and email, country or time zone | `org:create` (section 4.6) | Not provided |
| O8 | A test inbox you control, and your written approval for the first real emails (section 4.8) | Proves real delivery before customers depend on it | Not given |
| O9 | Decisions: keep sign-up closed (recommended); ask the administrator to turn on two-step verification (recommended); session length (default 7 days) | Security settings | Recommendation in this document |
| O10 | Privacy notice and terms on the client's side, and an agreement with the client on customer data (the app stores customers' names, emails and phone numbers; backups contain them too) | Legal responsibility for personal data | Owner and client |

## 4. Install runbook

Run as an administrator on the server unless a step says otherwise. Replace `<client-domain>` everywhere. Nothing
in this runbook copies data from the development machine: the release contains source code only, and the database is
created empty on the server.

### 4.1 Server

```bash
sudo apt update && sudo apt -y upgrade
# Node.js 24 LTS (NodeSource or your distribution's Node 24 package), then check:
node -v                                     # v24.x (22.13 or later also works)
sudo apt -y install nginx certbot python3-certbot-nginx sqlite3
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable     # 3001 stays closed
sudo adduser --system --group --home /home/workeasy360 workeasy360
sudo mkdir -p /srv/workeasy360 /srv/workeasy360-releases /var/lib/workeasy360/uploads /var/backups/workeasy360 /etc/workeasy360
sudo chown -R workeasy360:workeasy360 /srv/workeasy360 /var/lib/workeasy360 /var/backups/workeasy360
sudo chmod 700 /var/lib/workeasy360 /var/backups/workeasy360
```

### 4.2 Release

On the build machine (project root), run the checks that need the test suites, then pack the source from an explicit
list. The release never includes `server/.env`, a database, `server/data`, backups, uploads, `node_modules`, build
output or the test suites (so `npm run test:smoke`, which needs the test certificates, runs here and not on the
server), and the script refuses (deleting the archive) if anything like that got in:

```bash
(cd server && npm run build && npm run test:smoke)        # all PASS
node server/scripts/make-release.mjs --out <folder outside the project>
scp <folder>/workeasy360-release-<time>.tar.gz <folder>/workeasy360-release-<time>.tar.gz.sha256 <operator>@<server>:/tmp/
```

On the server:

```bash
cd /tmp && sha256sum -c workeasy360-release-<time>.tar.gz.sha256          # must print OK
sudo mv /tmp/workeasy360-release-<time>.tar.gz* /srv/workeasy360-releases/
sudo -u workeasy360 tar -xzf /srv/workeasy360-releases/workeasy360-release-<time>.tar.gz -C /srv/workeasy360
cd /srv/workeasy360 && sudo -u workeasy360 npm ci --ignore-scripts && sudo -u workeasy360 npm run build
cd server && sudo -u workeasy360 npm ci --ignore-scripts && sudo -u workeasy360 npm run build
sudo -u workeasy360 node -e "const D=require('better-sqlite3'); console.log('SQLite', new D(':memory:').prepare('select sqlite_version() v').get().v)"
```

Why `--ignore-scripts`: the database driver (better-sqlite3 13) ships ready-made binaries for Linux x64/arm64 (glibc
and musl), Windows and macOS, but npm 11 still tries to compile it with node-gyp, which fails without Python 3 and a
C++ compiler. The only other install scripts in the dependencies (esbuild, fsevents) are not needed. On 2026-10-27 a
release made this way was unpacked into an empty folder, installed with `--ignore-scripts`, built, and passed the
18-check production-like onboarding check on Windows; it has not been installed on Linux yet. If you prefer to
compile the driver instead: `sudo apt -y install build-essential python3` and plain `npm ci`.

### 4.3 Proxy and certificate

`/etc/nginx/sites-available/workeasy360`, as plain http first; certbot then adds https and the redirect:

```nginx
server {
  listen 80;
  server_name book.<client-domain>;
  root /srv/workeasy360/dist;
  client_max_body_size 3m;     # logo and staff photo uploads are up to 2 MB; nginx's default (1 MB) would refuse them
  location /api/ {             # the API sends its own security headers, HSTS included
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  # add_header inside a location replaces the server-level ones, so HSTS is repeated in each location
  location /assets/ { expires 1y; add_header Cache-Control "public, immutable";
                      add_header Strict-Transport-Security "max-age=31536000" always; }
  location / { try_files $uri /index.html; add_header Cache-Control "no-cache";
               add_header Strict-Transport-Security "max-age=31536000" always; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/workeasy360 /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d book.<client-domain> --redirect      # needs O2 and O3; adds the 443 block; renews automatically
```

This configuration has not been run on a real host yet; `staging-check.mjs` in 4.7 checks the result (https,
redirect, certificate, HSTS, headers, deep links).

### 4.4 Settings and secrets

One protected file, read by systemd and (through `DOTENV_CONFIG_PATH`) by the command-line scripts. There is no
`server/.env` on the server. The secrets are generated on the server and never shown:

```bash
sudo install -m 640 -o root -g workeasy360 /dev/null /etc/workeasy360/workeasy360.env
sudo tee -a /etc/workeasy360/workeasy360.env >/dev/null <<'EOF'
NODE_ENV=production
PORT=3001
DB_PATH=/var/lib/workeasy360/workeasy360.db
UPLOAD_DIR=/var/lib/workeasy360/uploads
CORS_ORIGIN=https://book.<client-domain>
PUBLIC_APP_URL=https://book.<client-domain>
TRUST_PROXY=1
SIGNUP_MODE=closed
EMAIL_TRANSPORT=disabled
EOF
printf 'JWT_SECRET=%s\nTWO_FACTOR_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 48)" "$(openssl rand -hex 32)" \
  | sudo tee -a /etc/workeasy360/workeasy360.env >/dev/null
```

Email starts `disabled`: the app runs, bookings are made, and each booking says no email was sent. Section 4.8 turns
it on. Leave these **unset** in production: `EMAIL_ALLOWED_RECIPIENTS` (except during section 4.8), `RATE_LIMITS`,
`NOTIFICATIONS_PROVIDER_MODE`, `WEBHOOKS_ALLOW_PRIVATE_NETWORK`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and every provider
key until that provider is deliberately set up (`DEPLOYMENT.md` lists them all). To check which names are set without
showing a value:

```bash
sudo -u workeasy360 node -e "require('fs').readFileSync('/etc/workeasy360/workeasy360.env','utf8').split('\n').filter(l=>/^[A-Z_]+=./.test(l)).forEach(l=>console.log(l.split('=')[0].padEnd(28),'set'))"
```

### 4.5 The service

`/etc/systemd/system/workeasy360.service`:

```ini
[Unit]
Description=WorkeasyBooking API
After=network.target

[Service]
User=workeasy360
Group=workeasy360
WorkingDirectory=/srv/workeasy360/server
EnvironmentFile=/etc/workeasy360/workeasy360.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Do not start it yet: section 4.6 creates the database first, so the API never starts on a database without its
client.

### 4.6 The client's business

As the service user, on the new (still missing) database file. The command creates the file with the full schema,
then only the business and its administrator:

```bash
cd /srv/workeasy360/server
sudo -u workeasy360 npm run org:create -- --db /var/lib/workeasy360/workeasy360.db \
  --company "<Company name>" --name "<Administrator's name>" --email <administrator's email> --country India
# asks for the administrator's password twice (hidden); at least 8 characters with an uppercase letter and a number
sudo -u workeasy360 npm run db:status -- --db /var/lib/workeasy360/workeasy360.db    # integrity ok, 17 migrations
```

Give the password to the administrator by phone or in person, not by email. Then start the API:

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now workeasy360
sudo journalctl -u workeasy360 -n 60 --no-pager
```

Expect `[migrations] 17/17 applied`, `Allowed app origins: https://book.<client-domain>`, and one `[security]`
warning only: email is disabled (until 4.8). Any other `[security]` line names a setting to fix.

### 4.7 Checks

```bash
curl -fsS https://book.<client-domain>/api/health            # {"status":"ok",...}
cd /srv/workeasy360/server && node scripts/staging-check.mjs --url https://book.<client-domain>    # every line PASS
sudo systemctl restart workeasy360 && sudo journalctl -u workeasy360 -n 5 --no-pager   # "[shutdown] SIGTERM ... stopped cleanly"
```

Then sign in as the administrator and walk through `CLIENT_ONBOARDING.md` with the client: create one service, one
staff member, a workspace and a published booking page, book once from a phone, cancel that booking. No test data is
created by the app itself; delete what you create during this walk-through or use it as the client's real setup.

### 4.8 Email (needs O4 and O8)

```bash
sudoedit /etc/workeasy360/workeasy360.env
#   EMAIL_TRANSPORT=smtp
#   EMAIL_FROM=<Company name> <bookings@<sending-domain>>
#   SMTP_HOST=<provider host>   SMTP_PORT=465   SMTP_SECURE=true   SMTP_USER=<...>   SMTP_PASS=<...>
#   EMAIL_ALLOWED_RECIPIENTS=<your test inbox>        # only for this step
cd /srv/workeasy360/server
sudo -u workeasy360 DOTENV_CONFIG_PATH=/etc/workeasy360/workeasy360.env npm run email:test -- --verify-only   # sign-in to the provider, sends nothing
sudo -u workeasy360 DOTENV_CONFIG_PATH=/etc/workeasy360/workeasy360.env npm run email:test -- --to <your test inbox>   # one real email (approval O8)
sudo systemctl restart workeasy360
```

Book once on the public page with your test inbox; check the confirmation arrives, is not in spam, links to
`https://book.<client-domain>`, and shows the right time and zone. Then remove `EMAIL_ALLOWED_RECIPIENTS` and restart.
DNS and deliverability details: `EMAIL.md`.

### 4.9 Backups and restore

```bash
# crontab -e   (as the workeasy360 user)
15 2 * * * cd /srv/workeasy360/server && npm run db:backup -- --db /var/lib/workeasy360/workeasy360.db --out /var/backups/workeasy360 >> /var/backups/workeasy360/backup.log 2>&1
30 2 * * * tar -czf /var/backups/workeasy360/uploads-$(date -u +\%Y\%m\%dT\%H\%MZ).tar.gz -C /var/lib/workeasy360 uploads >> /var/backups/workeasy360/backup.log 2>&1
45 3 * * * find /var/backups/workeasy360 -maxdepth 1 -type f \( -name '*.db' -o -name '*.db.json' -o -name 'uploads-*.tar.gz' \) -mtime +30 -delete
```

Then copy `/var/backups/workeasy360` off the server every night with the tool for your storage (O5), for example
`rclone copy` to an encrypted remote, after the backup has run. Backups contain customers' personal data: keep them
encrypted and access-restricted. Before each upgrade, also run the backup by hand.

**Restore drill** (monthly, and once before go-live), on a scratch file, never over the live database:

```bash
cd /srv/workeasy360/server
B=$(ls -t /var/backups/workeasy360/*.db | head -1)
sudo -u workeasy360 npm run db:restore -- --from "$B" --to /tmp/restore-drill.db
sudo -u workeasy360 npm run db:status -- --db /tmp/restore-drill.db      # integrity ok, 17 migrations
sudo rm /tmp/restore-drill.db*
```

**Real restore** (data damaged or server lost): stop the API; restore the newest verified backup with `db:restore
--force` to `DB_PATH` (the damaged file is moved aside, never deleted); unpack the latest uploads archive into
`/var/lib/workeasy360`; start the API; check `db:status`, sign in, check recent bookings. On a new server, do 4.1–4.5
first. Bookings made after the backup are lost. Details: `DATABASE_OPERATIONS.md`.

### 4.10 Monitoring and logs

- **Uptime:** the external monitor (O6) on `/api/health`, every 1–5 minutes, alerting you by email or phone.
- **Logs:** `journalctl -u workeasy360`. Set `SystemMaxUse=500M` in `/etc/systemd/journald.conf`. Logs name settings,
  never values; they contain no passwords or tokens.
- **Daily glance** (or a script that mails you): `[email] … FAILED` lines, `[security]` lines, `[shutdown]`
  without a matching start, the last line of `backup.log`, `df -h /var/lib/workeasy360` (alert at 80%).
- **Certificate:** certbot renews automatically; `staging-check.mjs` reports days left.
- **Updates:** `sudo apt upgrade` monthly; `npm audit --omit=dev` before each release.

### 4.11 Upgrades and rollback

Follow `DEPLOYMENT.md`, "Upgrade procedure": back up first, archive the running release, build the new release from
`make-release.mjs`, stop, swap, start, check the migration report and health. Roll back by restoring the previous
release archive; restore the backup only if the old version cannot run on the database. The database and uploads live
outside the release folder and are not touched by an upgrade.

## 5. Security settings in force

| Area | What the code does | What you set or do |
|---|---|---|
| Sign-in | Passwords hashed with bcrypt (cost 12); at least 8 characters with an uppercase letter and a number; sessions stored in the database and revocable (Settings → Security → Active Sessions → Sign out other sessions); session cookie `__Host-we360_session`, `Secure`, `HttpOnly` | Administrator turns on two-step verification (Settings → Security) |
| Sign-up | Closed with `SIGNUP_MODE=closed`: 403 for sign-up, confirmation and resend | Keep it closed |
| Cross-site requests | Requests from another site are refused (403); CORS allows only `CORS_ORIGIN` | Set `CORS_ORIGIN` and `PUBLIC_APP_URL` to the https site |
| Rate limits | Sign-in, sign-up, password reset, booking and token endpoints, per client address | `TRUST_PROXY=1` behind nginx, or everyone shares nginx's address |
| Business isolation | Every business-scoped query filtered by the session's organization (section 2) | Nothing |
| Secrets | Settings file mode 0640, no `.env` in releases or backups, startup refuses weak secrets, logs never print values | Keep the file root-owned; rotate `JWT_SECRET` only knowingly (signs everyone out) |
| Transport | HTTPS only, HSTS, http→https redirect | Section 4.3 |
| Data | One database file and an uploads folder on a private disk, nightly backups off-site | Sections 4.9 |

## 6. Feature status

Four categories. **Nothing is "Verified in production" yet, because nothing has been deployed.** After go-live,
move a row there only when it has been done on the production site (section 4.7 and 4.8 checks).

### Verified only in an isolated test environment

Automated, all with outgoing network blocked and `server/.env` not loaded. Full run of 2026-10-27, 15:52–16:16 IST,
19/19 steps: type checks, lint, 56 frontend unit tests, both production builds, 905 backend tests (38 suites), the
19-check production smoke test, 22 staging checks against a local production-mode server, migration rehearsals on
copies of archived backups (25/25, 22/22, 009 rollback), 83 live-API checks, 67 email-flow checks against a local mail
server, 85 real-browser checks, 14 isolated-instance checks, the release package check, and the 18-check
production-like onboarding check (compiled server, `NODE_ENV=production`, `SIGNUP_MODE=closed`, a fresh database,
email disabled). The onboarding check also passed against a release archive unpacked into an empty folder and
installed with `npm ci --ignore-scripts`.

| Feature | Notes |
|---|---|
| Creating the client's business and administrator (`org:create`) | Empty business, own time zone and currency; password never printed |
| Sign-in, sign-out, sessions, password change, two-step verification (authenticator app, recovery codes) | |
| Closed sign-up | 403 `SIGNUP_CLOSED` |
| Business settings: profile, branding and logo upload, working hours, booking rules, cancellation policy, language and region | Logo and photos stored in `UPLOAD_DIR` |
| Services, staff (with working hours and services), workspaces (with services and staff), resources | |
| Availability: working hours, buffers, minimum notice, advance window, time zones; time off, closures and breaks (API only) | |
| Public booking page and booking; manage link (reschedule, cancel) | Manage link reaches customers by email only once email works |
| Appointments: create, edit, move, cancel, status, history; calendar; customers with booking counts | |
| Dashboard and reports (summary, trend, status, by service, by staff, top customers) | |
| Roles and permissions (admin, manager, staff) | |
| Business isolation | Including a second business on the same server |
| Backup, restore, status, migrations, startup checks, health | |
| Production database location | The server refuses to start in production unless `DB_PATH` (and `UPLOAD_DIR`) is absolute and outside the application folder; no default or development database can be opened (unit tests, real server processes started in empty folders, mutation-checked) |
| One process serving the web app and the API (`WEB_DIST_DIR`, the `Dockerfile`) | Unit tests, a real server process, the full real-browser suite in that mode (no security-header violations), and a release folder built with the `Dockerfile`'s commands. The Docker image itself was **not built** (Docker was not running) |
| Graceful stop | Unit tests only; check once on the server (4.7) |
| Booking and account emails (confirmation, reschedule, cancellation, reminders by email, staff invitation, password reset): queueing, retries, no duplicates, restart recovery | Against local test mail servers only; real delivery is in the "Blocked" table |
| "Add to calendar" (.ics file and links) | Generated locally, no provider |
| Outgoing webhooks (signed booking events to a URL the client gives) | Verified against local receivers; not switched on |
| In-app assistant | Local help articles only; no external AI service |

### Incomplete (not built, or no screen)

| Feature | State |
|---|---|
| Online payment / checkout | Not built. Booking pages say to pay the business directly. Only payment-notification receivers exist. Design, tests and decisions needed: `proposals/018-online-payments.md` |
| Cancellation policy (Settings → Cancellation Policy: allow cancellation, deadlines, fee, policy text) | Saved, but **not enforced and not shown to customers**. With the manage link, customers can cancel or reschedule online any time before the appointment starts. The fee field is labelled in USD whatever the business currency, and no fee is charged |
| Time off, business closures, breaks | Enforced, but managed through the API only; the staff profile says "Not available yet". Workaround: switch the day off in the staff member's working hours |
| Report export | Placeholder button ("Export not yet configured") |
| Recurring and group bookings | Not built |
| Two-way calendar sync (importing busy times), meeting links (Zoom, Google Meet), Mailchimp list sync | Not built |
| Subscription billing | Not built |
| More than one server or process | Not supported (section 2) |

### Blocked by missing external credentials or provider setup

| Feature | What is missing |
|---|---|
| The production site itself (hosting, domain, HTTPS) | O1–O3 (on Railway: account, Pro plan, project, volume; `RAILWAY.md`) |
| Real email delivery: booking confirmations, reminders by email, staff invitations, password reset | O4, O8 (section 4.8). Until then: no customer or staff email; staff cannot be invited; a forgotten password cannot be reset (there is no operator command for it yet) |
| SMS (Twilio) | Twilio account, sender, for India DLT registration and approved templates; then a live test (`NOTIFICATIONS.md`). Verified against a mock provider only |
| WhatsApp (Meta Cloud API) | Business account, approved templates, `PUBLIC_API_URL`; live test. Mock only |
| Google Calendar / Outlook business calendar | OAuth app at Google or Microsoft (client ID and secret, redirect URI); live test with a test calendar. Mock only |
| Payment notifications (Stripe, Razorpay, PayPal) | Provider accounts and webhook secrets; and checkout is not built |
| Email on Railway | Railway allows outbound SMTP only on the Pro plan; on Free, Trial and Hobby no email can be sent |
| Off-site backups, uptime alerts | O5, O6 |

## 7. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The server's disk is lost | Data since the last backup is lost | Nightly off-site backups (4.9), disk snapshots (O1), restore drill before go-live |
| No email at launch | Customers get no confirmation; staff cannot be invited; no password reset | Do 4.8 before telling customers about the booking page |
| A second API process or replica | Rate limits weakened; email status mislabelled | systemd unit as above; never cluster mode |
| Graceful stop not yet seen on Linux | A restart could cut a request off | Check in 4.7; a hard stop is still safe for data and messages |
| Railway stops old deployments with **0 seconds** of grace by default | Requests in progress cut off at each deploy | Set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15` (`RAILWAY.md`, step 7) |
| Client addresses behind Railway's edge are not officially documented | Rate limits could count the wrong address | `TRUST_PROXY=1` with no CDN in front; check after deploy |
| Single administrator account | Lost password or second factor locks the business out until the operator helps | Save the recovery codes; add a second admin or manager once email works |
| Time off only through the API | Admin may book over a holiday | Use working hours to switch days off |
| Not yet run on a real server | Unknown host-specific problems | Follow 4.1–4.10 in order and keep the outputs as evidence |
| zod 3 advisory GHSA-mrhx-c7xc-m3w5 (high: memory use when validating oversized collections; fixed only in zod 4) | An attacker could make the API use more memory | Request bodies are capped before validation (JSON 100 kB, webhooks 256 kB, forms 32 kB), which bounds collection sizes. Upgrading to zod 4 changes every validation schema: plan it after launch, with approval and a full test run |
| New advisories appear after release | Known vulnerabilities in dependencies | `npm audit --omit=dev` in the project root and `server/` before each release and monthly |

## 8. Launch checklist

1. O1–O7 provided (section 3).
2. 4.1–4.6 done; `db:status` shows integrity ok and 17 migrations; the log shows no unexpected `[security]` line.
3. 4.7: health, `staging-check.mjs` all PASS, a restart logs a clean stop, the administrator signs in.
4. 4.8: real email verified with your test inbox, then the recipient restriction removed.
5. 4.9: first nightly backup present on the server **and** off-site; restore drill passed.
6. 4.10: uptime monitor alerting you.
7. The client's administrator has set up the business (`CLIENT_ONBOARDING.md`) and made one test booking.
8. Then, and only then, share `https://book.<client-domain>/book/<page address>` with customers.
