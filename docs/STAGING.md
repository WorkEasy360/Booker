# Staging verification

This is the procedure for putting WorkeasyBooking on a staging server and verifying what can only be verified
there: real HTTPS, the reverse proxy, real email delivery and DNS, scheduled backups, and the app on real devices.
Nothing here is production. Use a staging domain, a staging sending address, and your own test inboxes; never real
customer data.

Placeholders are written `<like-this>`. Never commit the values or paste them into tickets or logs.

## What is already verified locally (automated)

| Area | Command (from the project) | Covers |
|---|---|---|
| Types, lint, unit | `npx tsc --noEmit`, `npm run lint`, `npm run test:unit` | Web app compiles, lints clean (ESLint 10), unit tests |
| API test suites | `cd server && npm test` | Auth, sessions, roles, tenant isolation, invitations, SMTP TLS enforcement (no plaintext fallback, untrusted and wrong-host certificates refused, TLS 1.1 refused, credentials kept out of logs), the recipient allowlist (`EMAIL_ALLOWED_RECIPIENTS`), account-email retries from the queue (migration 009: across restarts, deadlines, cancellation, cleanup), sign-up confirmation, password reset, no address discovery, booking rules on every path, scheduling, time zones, email outbox and retries, migrations, backup/restore |
| Production smoke | `cd server && npm run build && npm run test:smoke` | Compiled server in production mode: refuses unsafe settings and SMTP without credentials, sends only over authenticated, certificate-verified STARTTLS, refuses sign-up clearly without email, confirms a sign-up from the emailed https link, secure cookies, origin refusal, no secret, token or password in output |
| API end to end | `cd server && npm run test:e2e` | Live API on a throw-away database with an SMTP server inside the script: sign-up confirmation, password reset, the db tools |
| Browser | `npm run test:browser` | Real Chrome, desktop and phone, against a local SMTP catcher, including sign-up confirmation and password reset |
| Staging checker trial | `server/scripts/staging-check.mjs`, run by a trial script on the development machine | The checker itself, against the compiled server in production mode behind a local HTTPS proxy with the test certificate: every check, including the http→https redirect, the certificate (trusted, host name, TLS version, days left) and HSTS. Negative controls (wrong app origin, untrusted certificate) fail as they should |
| Email flows, local inbox | `cd server && npm run test:email` | Every account and booking email flow through a real SMTP conversation with the local test inbox: sign-up confirmation, reset (all sessions end), password-changed notice, replacement links, no account discovery, staff and manager resets, refused (550), temporarily refused (451) and unreachable mail servers |
| SMTP test script | `cd server && npm run email:test -- --verify-only` / `-- --to …` | Tested only against local SMTP servers: production settings over STARTTLS with a test certificate, sign-in refused (credentials redacted), untrusted certificate, server without STARTTLS, unreachable server, nothing sent with `--verify-only` |

None of this proves real email delivery, HTTPS, DNS, backups on the host, or behaviour on real devices. The steps
below do. Until every row of the acceptance checklist (step 11) is PASS, treat those as unverified.

**Production: NO-GO.** It stays NO-GO until every row of step 11 is PASS on a real staging host and the owner has
approved in writing (S14). Local results, however complete, do not change this.

## 0. Handoff: what must be in place before anything runs on the host

Nothing below may start until every row of this table is done. Credentials are never sent in chat, tickets, commits or
documents: the operator types them only into the host's protected `server/.env` or the platform's secret store.

| # | Item | Provided or done by | Checked in | Status |
|---|---|---|---|---|
| H1 | Hosting platform: a VM with systemd, or which managed platform; whether the operator has root (step 8b needs a way to block outgoing SMTP for a while) | Owner | Step 1 | BLOCKED: not provided |
| H2 | Staging URL (`https://staging.<your-domain>`), its DNS record and a certificate | Owner, operator | Steps 5–6, S1–S5 | BLOCKED: not provided |
| H3 | SMTP provider, with credentials created for staging alone that can only send mail | Owner | Step 8.2, S7 | BLOCKED: not provided |
| H4 | Sending domain or subdomain that no real mail uses, with SPF, DKIM and DMARC as the provider documents | Owner | Step 8a, S10 | BLOCKED: not provided |
| H5 | Confirmation that a dedicated test inbox exists and is controlled by the owner (plus any other test inboxes). Confirm only; the addresses are typed on the host | Owner | Steps 3 and 8.3 | BLOCKED: not confirmed |
| H6 | Protected settings: `server/.env` (mode 600, owned by the service user) or the platform's secret store; secrets typed only on the host; the `set`/`MISSING` check (names only) shows every name `set`, `EMAIL_ALLOWED_RECIPIENTS` included | Operator | Steps 3–4, S6 | BLOCKED: needs the host |
| H7 | A dedicated staging database: `DB_PATH` is a new file, never a copy of the development database, a production backup or any data about real people | Operator | Step 3, S15 | BLOCKED: needs the host |
| H8 | Migrations: the first start logs `[migrations] 9/9 applied`; `npm run db:status` shows every migration applied and integrity ok | Operator | Steps 4 and 7, S16 | BLOCKED: needs the host |
| H9 | Backups: nightly `npm run db:backup` with copies off the host; a restore drill on a scratch file shows 9 migrations | Operator | Step 7, S12 | BLOCKED: needs the host |
| H10 | Recipient allowlist: `EMAIL_ALLOWED_RECIPIENTS` lists only test addresses; startup says `Email recipients: restricted …`; `email:test --verify-only` prints the `Recipients:` line; the step 8.4 recipient-guard booking fails with `Recipient not allowed …` and sends nothing | Operator | Steps 3, 4, 8.2, 8.4, S15 | BLOCKED: needs the host |
| H11 | **Approval A**: exactly one real email, `npm run email:test -- --to <dedicated-test-inbox>` | Owner, in writing | Before step 8.3 | NOT GIVEN |
| H12 | **Approval B**: the real emails of steps 8.4 and 9, all to listed test addresses (up to about 25) | Owner, in writing | Before step 8.4 | NOT GIVEN |
| H13 | **Approval C**: step 8b, a temporary SMTP outage on the host (a firewall rule that is removed afterwards) and about 3 real emails; the 70-minute deadline check is optional | Owner, in writing | Before step 8b | NOT GIVEN |
| H14 | The pre-009 release archive and its checksum file in durable, administrator-only storage (for S21) | Owner | `sha256sum -c` | PARTLY DONE (2026-10-24 17:06 IST): copied to a private archive folder on the development machine, outside the project and outside OneDrive, checksum OK; still to be copied to the staging host (`/srv/workeasy360-releases`) once it exists |

Order: H1–H10 first; approval A only after S7 passes; approval B only after S8 and S9 pass; approval C only after S17
passes. Production stays **NO-GO** throughout (S14).

## 1. Host

- One Linux VM or container with a **persistent local disk** (not NFS/SMB) for the database.
- **Node.js 24 LTS** (or 22.13 or later): `node -v`. The database driver (better-sqlite3 13) needs Node 22 or later.
- nginx or Caddy on the same host, a DNS name such as `staging.<your-domain>`, and ports 80 and 443 open.
- A service user, for example `workeasy360`, that owns the app folder and the database folder.

## 2. Clean install and build

Copy the source to the host from a development machine **without**:

- dependencies: `node_modules`, `server/node_modules` (installed below with `npm ci`);
- generated output: `dist`, `server/dist` (built below) and `.acceptance` (test screenshots);
- secrets: every `.env` and `.env.*` file;
- data: `server/data`, `server/backups`, and every SQLite file wherever it is (`*.db`, `*.db-wal`, `*.db-shm`,
  `*.db-journal`, and backup manifests `*.db.json`).

The release archive in `DEPLOYMENT.md` ("Upgrade procedure", step 1) is different: it keeps `dist` and `server/dist`,
because it is the built release that a rollback returns to. Both leave out secrets and data.

```bash
cd /srv/workeasy360
npm ci --ignore-scripts
npm run lint && npx tsc --noEmit && npm run test:unit
npm run build                                   # writes dist/ (the web app)

cd server
npm ci --ignore-scripts                         # dev dependencies are needed: build and db:* scripts use them
npx tsc --noEmit
npm run build                                   # writes server/dist/
npm run test:smoke                              # throw-away databases; must end "19/19 production smoke checks passed"
```

## 3. Environment (`/srv/workeasy360/server/.env` on the staging host)

Generate the secret on the host and paste it into the file (do not echo it into shell history or logs):

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

```env
NODE_ENV=production
PORT=3001
JWT_SECRET=<generated-64-byte-hex>
JWT_EXPIRES_IN=7d
CORS_ORIGIN=https://staging.<your-domain>
PUBLIC_APP_URL=https://staging.<your-domain>
TRUST_PROXY=1
DB_PATH=/var/lib/workeasy360/workeasy360.db
EMAIL_TRANSPORT=smtp
EMAIL_FROM="WorkeasyBooking <bookings@<staging-sending-domain>>"
SMTP_HOST=<provider-smtp-host>
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=<provider-user>
SMTP_PASS=<provider-password>
EMAIL_ALLOWED_RECIPIENTS=<dedicated-test-inbox>,<each other test address used in steps 8, 8b and 9>
```

- `CORS_ORIGIN` and `PUBLIC_APP_URL` are the exact https address people open, without a path or trailing slash.
  Every link in every email is built from `PUBLIC_APP_URL`.
- `DB_PATH` must be a **new database used only by staging**. Never copy the development database, a production
  backup or any other data about real people onto the staging host: the first start creates the database and all
  migrations (step 4), and staging data is created through the app with test addresses.
- Port 465 with `SMTP_SECURE=true` encrypts the SMTP connection from the start. Use 587 with `SMTP_SECURE=false` only
  if the provider does not offer 465: the server then requires STARTTLS and sends nothing without it. In production
  the server refuses to start without `SMTP_USER` and `SMTP_PASS`, and certificates are always verified (see "TLS"
  in `EMAIL.md`).
- Use SMTP credentials that can only send mail, created for staging alone, and a sending domain or subdomain that is
  not used by real customers' mail.
- `EMAIL_ALLOWED_RECIPIENTS` restricts staging to your test addresses: any other recipient is refused before the mail
  server is contacted (see "Restricting recipients" in `EMAIL.md`). List the dedicated test inbox and every other
  test address you will use, each plus-address separately (`staging-test+cust1@…`, `staging-test+staff1@…`), or one
  `@domain` that receives only test mail. Never a domain that real people use. A malformed value stops the server
  from starting. It is an extra barrier, not a replacement for a staging database without real customer records.

```bash
sudo mkdir -p /var/lib/workeasy360 && sudo chown workeasy360: /var/lib/workeasy360
sudo chown workeasy360: /srv/workeasy360/server/.env && sudo chmod 600 /srv/workeasy360/server/.env
```

Do not set `ADMIN_EMAIL`/`ADMIN_PASSWORD` and never run `npm run seed` (it refuses in production anyway).

**Where the secrets live.** `JWT_SECRET` and `SMTP_PASS` (and `SMTP_USER`) are secrets. Type them only into the
file above on the host, or into your hosting platform's secret store, never into chat, tickets, commits or command
lines. Variables already present in the process take precedence over `server/.env`, so a platform's secret store
works with the same names:

- **VM with systemd:** keep `server/.env` (mode 600, owned by the service user) as above. If you prefer a root-only
  file, put the secrets in `/etc/workeasy360/secrets.env` (mode 600, owned by root), add
  `EnvironmentFile=/etc/workeasy360/secrets.env` to the unit in step 4, and leave them out of `server/.env`.
- **Hosting platform** (container or app service): add each variable in the platform's secrets or environment
  settings. Do not ship a `server/.env` in the image.

The maintenance commands (`npm run db:*`, `npm run email:test`) read the same variables from their own process. When
the secrets are not in `server/.env`, run them where the variables are set (the platform's shell, or with the same
environment file), and pass `--db <path>` to the `db:*` commands if `DB_PATH` is not set there.

## 4. One supervised API process

Example systemd unit, `/etc/systemd/system/workeasy360.service`:

```ini
[Unit]
Description=WorkeasyBooking API
After=network.target

[Service]
User=workeasy360
WorkingDirectory=/srv/workeasy360/server
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now workeasy360
sudo journalctl -u workeasy360 -n 50 --no-pager
```

Expect in the log: `[migrations] 9/9 applied`, `Allowed app origins: https://staging.<your-domain>`,
`Email transport: smtp`, `Email recipients: restricted by EMAIL_ALLOWED_RECIPIENTS to N address(es) and M domain(s)`
(counts only), and no `[security]` warning. The server reads `server/.env` from its working directory.
Startup does not contact the mail server: step 8's `npm run email:test` is what proves the SMTP settings.

To confirm every required setting is present without showing any value (it prints each name with `set` or
`MISSING`; run it where the settings are, here from `server/.env`):

```bash
cd /srv/workeasy360/server
node -r dotenv/config -e "for (const k of ['NODE_ENV','JWT_SECRET','CORS_ORIGIN','PUBLIC_APP_URL','TRUST_PROXY','DB_PATH','EMAIL_TRANSPORT','EMAIL_FROM','SMTP_HOST','SMTP_PORT','SMTP_SECURE','SMTP_USER','SMTP_PASS','EMAIL_ALLOWED_RECIPIENTS']) console.log(k.padEnd(16), process.env[k] ? 'set' : 'MISSING')"
```

Every line must say `set`, apart from `SMTP_PORT`/`SMTP_SECURE` if you rely on the defaults (587, STARTTLS
required). The secrets among them are `JWT_SECRET`, `SMTP_USER` and `SMTP_PASS`.

**Migrations and rollback precautions.** On a fresh staging database the migrations simply run. When deploying a new
version onto an existing database (every later update):

```bash
cd /srv/workeasy360/server
npm run db:backup -- --out /var/backups/workeasy360     # 1. first; verified, safe while the old version runs
# 2. stop the API, copy the new release, npm ci, npm run build (as in step 2)
npm run db:status                                       # 3. reads the new code: what it will apply, anything blocked
# 4. start the API, then:
npm run db:status                                       # 5. every migration "applied", integrity ok
```

A migration that existing data blocks is skipped with its reason in the log and in `db:status`; the data is left as
it was. To roll back: stop the API and put back the previous build. Restore the backup from before the deploy only
if the old version cannot run on the database. Never restore over the live file while the API runs, and never drop
tables by hand (see "Upgrade procedure" in `DEPLOYMENT.md` and `DATABASE_OPERATIONS.md`).

**Deploy updates by stopping, replacing and starting** (`systemctl stop`, copy, build, `systemctl start`). Never run two
API processes at once, not even briefly during a deploy (see "Supported topology" in `DEPLOYMENT.md`).

## 5. HTTPS reverse proxy

Use the nginx example in `DEPLOYMENT.md` with a certificate (for example from Let's Encrypt), and add:

```nginx
server { listen 80; server_name staging.<your-domain>; return 301 https://$host$request_uri; }
# inside the 443 server block, AND inside `location /assets/` and `location / { … }` (nginx drops server-level
# add_header lines in any location that has its own add_header, and both of those set Cache-Control):
add_header Strict-Transport-Security "max-age=31536000" always;
# inside `location /api/ { … }`: the API sends its own HSTS header (180 days); hide it so responses carry one header
proxy_hide_header Strict-Transport-Security;
```

The certificate must cover `staging.<your-domain>` and renew automatically (for example certbot's timer); step 6
checks that it is trusted, matches the host name, uses TLS 1.2 or newer, and has at least 14 days left.

Keep port 3001 closed to the outside (firewall); only the proxy talks to the API.

## 6. Automated staging check

From your workstation (or the host), with Node 22.13+:

```bash
cd server
node scripts/staging-check.mjs --url https://staging.<your-domain>
```

Every line must be PASS: https and the http→https redirect; the certificate is trusted, matches the host name, uses
TLS 1.2 or newer and has at least 14 days left; health; security headers including HSTS of at least 180 days on the
app and the API; deep links load the app; JSON 404 for unknown API paths; cross-site requests refused; CORS allows
only the app; malformed input gets a clean 400. Keep the output as evidence for the checklist in step 11 (it contains
no secrets). After step 8 has created (and confirmed) your staging account, run it again with that account to check
the cookie:

```bash
# bash: the password is typed at a hidden prompt, so it is not shown and not saved in the shell history
read -r -p 'Staging login: ' STAGING_EMAIL && export STAGING_EMAIL
read -r -s -p 'Its password: ' STAGING_PASSWORD && echo && export STAGING_PASSWORD
node scripts/staging-check.mjs --url https://staging.<your-domain>
unset STAGING_PASSWORD STAGING_EMAIL
```

```powershell
# Windows PowerShell 5.1 or later
$env:STAGING_EMAIL = Read-Host 'Staging login'
$env:STAGING_PASSWORD = [Net.NetworkCredential]::new('', (Read-Host 'Its password' -AsSecureString)).Password
node scripts/staging-check.mjs --url https://staging.<your-domain>
Remove-Item Env:STAGING_PASSWORD, Env:STAGING_EMAIL
```

It signs in once and signs out again; it creates no records and never prints the password. Never put the password
itself on a command line, in a script or in a ticket.

## 7. Backups and a restore drill

```bash
sudo mkdir -p /var/backups/workeasy360 && sudo chown workeasy360: /var/backups/workeasy360
# crontab -e   (as the workeasy360 user): nightly at 02:15
15 2 * * * cd /srv/workeasy360/server && npm run db:backup -- --out /var/backups/workeasy360 >> /var/log/workeasy360-backup.log 2>&1
```

Copy `/var/backups/workeasy360` off the server with the tool you already use (for example rclone or rsync to
encrypted storage), and keep several generations. Then, the next day, prove a restore on a **scratch file**:

```bash
cd /srv/workeasy360/server
ls -t /var/backups/workeasy360/*.db | head -1                       # newest backup
npm run db:restore -- --from /var/backups/workeasy360/<newest>.db --to /tmp/restore-drill.db
npm run db:status -- --db /tmp/restore-drill.db                       # integrity ok, 9 migrations applied
rm /tmp/restore-drill.db
```

Never restore over the live database while the API runs (see `DATABASE_OPERATIONS.md`).

## 8. Real email delivery

1. Publish SPF, DKIM and DMARC for the staging sending domain as your provider documents, and check them with
   step 8a.
2. **Check the connection without sending anything.** On the staging host, where the SMTP settings live in
   `server/.env` or the platform's secret store (never type them on the command line or paste them anywhere):
   ```bash
   cd /srv/workeasy360/server
   npm run email:test -- --verify-only
   ```
   Expect `Mail server <host>:<port> (TLS from the start)` (465) or `(STARTTLS required)` (587), `sign-in: yes`,
   `Recipients: restricted by EMAIL_ALLOWED_RECIPIENTS …`, then
   `Connection, TLS and sign-in: OK` and `No email was sent`. If it fails, the output says at which stage and
   `What to check:` names the setting (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) without its
   value. Fix the setting and repeat `--verify-only`; send nothing while it fails.
3. **Send exactly one test message**, only with the owner's written **approval A** (step 0, H11), to the dedicated
   test inbox (see the next item; never a customer's address). The address must be in `EMAIL_ALLOWED_RECIPIENTS`,
   or the command stops before connecting:
   ```bash
   npm run email:test -- --to <dedicated-test-inbox>
   ```
   Record `Accepted by the mail server: yes`, the `Message-ID` and the `Mail server reply` (it usually contains the
   provider's queue id). **Accepted is not delivered.** Then, in the test inbox: the message arrived (note the folder:
   inbox or spam); its headers show `spf=pass`, `dkim=pass` with `header.d=` your sending domain, `dmarc=pass`, and a
   `Received:` line with TLS (for example `with ESMTPS` or `version=TLS1_3`); the From matches `EMAIL_FROM`; the
   Message-ID matches. If nothing arrives within 15 minutes, search the provider's activity log for the Message-ID
   instead of sending again.
4. Only with the owner's written **approval B** (step 0, H12), and only after S8 and S9 pass. In the app, use a
   **dedicated test inbox** that you control, for example `staging-test@<your-domain>` with plus-addressing
   (`staging-test+cust1@…`, `staging-test+staff1@…`), every address listed in `EMAIL_ALLOWED_RECIPIENTS`. Never use
   a real customer's address:
   - Sign up a staging business with your address. The page says "Check your email" and nobody is signed in. The
     **confirmation** email arrives; its link opens `https://staging.<your-domain>/verify-email`, the token disappears
     from the address bar, and after **Confirm my email** you sign in normally. Opening the link again says the address
     is already confirmed. Set the time zone and working hours.
   - Sign up again with the same address: the page says exactly the same, and a **sign-in help** email arrives instead
     of a confirmation. No second business is created.
   - **Send a new link**: sign up a second staging business with another plus-address (`staging-test+verify2@…`). Do
     not open its email; on the "Check your email" page use **Send a new link**. A second confirmation arrives. The
     first link now says a newer link was sent; the second one works.
   - **Password reset**: sign in on a second browser or device. On the first, use **Forgot password?** on the sign-in
     page. The **reset** email's link opens `https://staging.<your-domain>/reset-password` and states it expires in 60
     minutes. Choose a new password: you are not signed in, the second browser is signed out on its next action, the
     old password fails, the new one works, and a **password changed** email arrives. Opening the reset link again
     says it was already used.
   - Ask for a reset for an address that has no account: the page says the same as before and no email arrives.
   - Add a service and a staff member (staff email: another of your inboxes), publish a booking page.
   - Book as a customer with your test inbox: the **confirmation** email shows the business name, the date, the time
     **with its time zone**, and a manage link that opens `https://staging.<your-domain>/…`.
   - From that link reschedule (**reschedule** email) and cancel (**cancellation** email).
   - From the dashboard, invite the staff member: the **invitation** email's link opens the accept page, works once,
     and states when it expires. Then reset that staff member's password through **Forgot password?** too: staff and
     managers use the same flow.
   - **Recipient guard**: book once for an address at a domain you own that is **not** in `EMAIL_ALLOWED_RECIPIENTS`.
     The appointment shows the email as failed with `Recipient not allowed on this server (EMAIL_ALLOWED_RECIPIENTS)`,
     the log line gives the same reason without the address, and nothing arrives anywhere.
   - Delivery errors: book once with an address at your own domain that has no mailbox (list it in
     `EMAIL_ALLOWED_RECIPIENTS` first). Depending on the provider,
     the appointment page shows the email as failed with a readable reason (refused at once, or after the retries,
     about 21 minutes), or as sent followed by a bounce in the provider's dashboard (accepted first, bounced later;
     the app cannot see those). Note which one your provider does.
5. Check the outbox did not send duplicates: each email above arrived exactly once.

### 8a. Sending-domain DNS checks (read-only)

Needs: the sending domain (the part after `@` in `EMAIL_FROM`), the provider's bounce (Return-Path) domain and DKIM
selector from the provider's documentation or dashboard, and someone who can read the domain's DNS. These are public
records, not secrets. Do not change DNS records during the check. Use the provider's own published values; never
copy example values from this document.

| Record | Command (PowerShell; or `dig +short TXT <name>` on Linux) | Expected |
|---|---|---|
| SPF | `Resolve-DnsName -Type TXT <return-path-domain>` | Exactly one record starting `v=spf1`. It authorizes the provider exactly as its documentation says (usually an `include:`), ends with `~all` or `-all` (never `+all`), and stays within 10 DNS lookups |
| DKIM | `Resolve-DnsName -Type TXT <selector>._domainkey.<sending-domain>` (some providers publish a CNAME that points to the key) | A `v=DKIM1` record with a non-empty `p=` key, and DKIM signing switched on at the provider |
| DMARC | `Resolve-DnsName -Type TXT _dmarc.<sending-domain>` | Exactly one record starting `v=DMARC1`, with `p=none` while monitoring (then `quarantine`, later `reject`) and a `rua=mailto:` address you read |

The records alone do not prove alignment. The headers of the step 8 test message must show `spf=pass`,
`dkim=pass header.d=<sending-domain>` and `dmarc=pass`. Record the date, the resolver used, each record's text and
those header lines as evidence.

### 8b. Account-email retries on the host (migration 009)

These checks need the owner's separate written **approval C** (step 0, H13): they change the host's firewall for a
while and send a few emails, all to listed test addresses. They also need a way to make outgoing SMTP fail for a while
**without touching the SMTP settings or credentials**. On a Linux VM that is
a firewall rule (root); on a hosting platform, use what its network controls allow, or mark the rows BLOCKED. Example
for a VM where the provider's port is 465 (use your `SMTP_PORT`):

```bash
sudo iptables -I OUTPUT -p tcp --dport 465 -j REJECT --reject-with tcp-reset   # outage on: refused at once
sudo iptables -D OUTPUT -p tcp --dport 465 -j REJECT --reject-with tcp-reset   # outage off: always remove it
```

**Forgot password?** accepts 3 requests per address per hour (a refused request answers 429 and sends nothing), so
use a different staging sign-in for each step below (for example the staff member's, or another plus-address, listed
in `EMAIL_ALLOWED_RECIPIENTS`), or wait an hour.

The queue holds no addresses, links or tokens, so its rows can be viewed as evidence (read-only):

```bash
cd /srv/workeasy360/server
node -r dotenv/config -e "const D=require('better-sqlite3');const d=new D(process.env.DB_PATH,{readonly:true,fileMustExist:true});console.table(d.prepare('SELECT kind,status,attempts,next_attempt_at,expires_at,updated_at FROM account_email_queue ORDER BY created_at DESC LIMIT 10').all())"
```

1. **A retry survives a restart.** Outage on. Use **Forgot password?** for the staging account. The log shows
   `[email] account password_reset: attempt 1 failed via smtp, retrying in 60s`; the queue row is `pending`. Restart
   the API (`sudo systemctl restart workeasy360`), then outage off, both within a minute of the request (otherwise the
   next retry comes 5 minutes later, then 15). Within about two minutes exactly one reset email arrives, the log
   shows `sent via smtp (attempt N)`, the row is `sent`, and the link works once.
2. **A newer request cancels the waiting one.** Outage on. Use **Forgot password?** twice. The log shows
   `superseded, not sent (the link was replaced or used, or is no longer valid)`. Outage off: exactly one reset email
   arrives, and its link works. Repeat with **Send a new link** for an unconfirmed sign-up if you want both paths.
3. **The retry limit.** Outage on. Use **Forgot password?** once and leave the outage on for 25 minutes. The log shows
   three `retrying` lines, then `FAILED via smtp after 4 attempt(s)`. Outage off: no email arrives.
4. **The one-hour deadline** (optional, about 70 minutes). Outage on, **Forgot password?**, and as soon as the
   `attempt 1 failed` line appears stop the API (`sudo systemctl stop workeasy360`) for more than an hour.
   Outage off, start the API: the log shows `EXPIRED, not
   sent`, and no email arrives.
5. **Not induced on the host:** a send interrupted after the provider accepted it (the possible duplicate email), and
   the 24-hour window of the password-changed notice. Killing the process at the right moment against a real
   provider is not reliable; these are covered by the local tests (L8) only.

Afterwards make sure the firewall rule is gone (`sudo iptables -S OUTPUT`), and record each step's time, the log
lines and the queue rows (they contain no personal data).

## 9. Desktop and phone walkthrough

Covered by approval B (it sends real emails to listed test addresses). On a desktop browser and on a real phone: sign
up (check your email, confirm), sign in and out, forgot and reset
password, Settings (working hours, time zone), services,
staff and invitation, booking page, public booking ("any available staff" and a named staff member), confirmation,
manage (reschedule, cancel), New Appointment, Reschedule page (offers only free times), calendar, reports. Nothing
should overflow the phone screen, and every error message should be readable without technical details.

## 10. Logs and secrets

```bash
sudo journalctl -u workeasy360 --since today --no-pager | grep -icE "jwt_secret|smtp_pass|password=|bearer [a-z0-9]|token="   # expect 0
```

Configure journald (or your log shipper) retention. Logs contain booking ids and email outcomes, never passwords,
tokens, links from account emails, or email bodies. Account email lines name only the kind and the outcome, for
example `[email] account password_reset: sent via smtp`.

**Email monitoring.** Check failed and retried emails at least daily on staging (and set an alert in production):

```bash
sudo journalctl -u workeasy360 --since "24 hours ago" --no-pager | grep -E '\[email\].*(FAILED|failed|unknown|not sent|EXPIRED|interrupted)'
```

The log lines are explained under "Monitoring delivery and failures" in `EMAIL.md`. Also set up the provider's
bounce and complaint notifications, and read the DMARC aggregate reports for the sending domain. Remember that
account emails (confirmation, reset) appear only in this log, not on any page. Their retries are queued in the database
(migration 009); waiting retries are visible with the read-only query in step 8b.

## 11. Staging acceptance checklist

Status: **PASS** (checked, with evidence), **FAIL** (checked and failed), **BLOCKED** (needs access, credentials,
approval or infrastructure that is not available yet; the last column says which), **NOT VERIFIED** (could be checked,
but has not been). A row is PASS only when it was actually run; documentation or an earlier report never counts. A
local check never stands in for the staging site. Evidence must not contain secrets: keep command output, DNS record
text and email header lines, never the contents of `server/.env`. Record the date and your name when you update a row.

Last update: 2026-10-24 17:10 IST, on the development machine. No staging URL, hosting platform, SMTP provider, test
inbox or DNS access was available (the repository names none, and `server/.env` is never read), so every check on
the staging environment is BLOCKED.

**Approvals the owner gives before the checks start** (in writing, each separately; see step 0):

- **A.** Exactly one real test email from `npm run email:test` to the dedicated test inbox (S8).
- **B.** The real emails of steps 8.4 and 9 (up to about 25), all to test addresses listed in
  `EMAIL_ALLOWED_RECIPIENTS` (S4, S15's recipient-guard booking, S17).
- **C.** Step 8b: a temporary SMTP outage on the host and about 3 real emails to listed test addresses (S18–S20).

Credentials are never sent in chat, tickets or documents: they go only into the host's protected `server/.env` or the
platform's secret store.

**Staging environment** (the operator, on the staging host; secrets only in `server/.env` or the platform's secret store)

| # | Check | Command or procedure | Expected | Actual | Status | Needs |
|---|---|---|---|---|---|---|
| S1 | Certificate trusted, host name, expiry, TLS version | Step 6: `node scripts/staging-check.mjs --url https://<staging-domain>` | Certificate trusted for the host, ≥ 14 days left, TLS ≥ 1.2 | Not run | BLOCKED | Staging domain and host |
| S2 | HTTP → HTTPS redirect | Step 6 | `http redirects to https` PASS | Not run | BLOCKED | Same |
| S3 | HSTS | Step 6 | ≥ 180 days on the app and the API, one header each | Not run | BLOCKED | Same |
| S4 | Health and critical workflows | Step 6, then steps 8.4 and 9 | Health 200; sign-up, sign-in, booking, reschedule, cancel, invitation work on desktop and phone | Not run | BLOCKED | Same, plus the dedicated test inbox and approval B |
| S5 | CORS and allowed origins | Step 6 (with `--origin` = the app's origin) | Only the app's origin allowed, with credentials; other sites refused | Not run | BLOCKED | Same |
| S6 | Production mode and required settings present | Step 4: startup log, and the `set`/`MISSING` command (names only) | `[migrations] 9/9 applied`, `Email transport: smtp (TLS from the start)` or `(STARTTLS required)`, no `[security]` warning, every setting `set` | Not run | BLOCKED | Staging host |
| S7 | SMTP connection, TLS and sign-in | Step 8.2: `npm run email:test -- --verify-only` | `Connection, TLS and sign-in: OK`, `No email was sent` | Not run | BLOCKED | Provider credentials on the host |
| S8 | One approved test email | Step 8.3: `npm run email:test -- --to <dedicated-test-inbox>`, once | `Accepted by the mail server: yes`, Message-ID and server reply recorded | Not run, and needs your approval first | BLOCKED | Approval A, plus a test inbox nobody else uses |
| S9 | Inbox receipt and headers | Step 8.3 | Message found (folder noted), timestamps, Message-ID matches, `spf=pass`, `dkim=pass`, `dmarc=pass`, Received with TLS | Not run | BLOCKED | Access to the test inbox |
| S10 | SPF, DKIM, DMARC | Step 8a (read-only DNS queries) | Records as the provider documents; aligned passes in S9's headers | Not queried: the sending domain is not confirmed | BLOCKED | The confirmed sending domain, provider documentation, DNS read access |
| S11 | Bounce/complaint handling and failure alerting | Step 10 and `EMAIL.md` "Monitoring delivery and failures" | Provider suppression list on; an alert reaches a person within a day | Not set up; the app logs failures but sends no alert, and has no provider webhook | BLOCKED | Provider account, host log system, alert channel |
| S12 | Backup schedule and restore on the host | Step 7 | Last night's verified backup exists and is copied off the host; restore drill to a scratch file OK | Not run | BLOCKED | Host, off-host storage |
| S13 | Rollback with a verified release archive | `DEPLOYMENT.md` "Upgrade procedure" steps 1 and 5 | Archive checksum OK, no secrets or databases in it; rollback brings the previous version back | No release archive exists on any host yet (the project is not under version control) | BLOCKED | Staging host, one deploy |
| S14 | Final production approval | All other rows PASS | Written approval by the owner | Not given | BLOCKED | The product owner, after every other row |
| S15 | Staging isolated from production | Step 3 and the host: `DB_PATH` is a new staging file; no production backup was restored; staging-only SMTP credentials and sending (sub)domain; `PUBLIC_APP_URL` and `CORS_ORIGIN` are the staging address; `EMAIL_ALLOWED_RECIPIENTS` lists only test addresses (startup line `Email recipients: restricted …`), and the step 8.4 recipient-guard booking fails with `Recipient not allowed on this server (EMAIL_ALLOWED_RECIPIENTS)` and sends nothing | All true; recorded by the operator | Not run | BLOCKED | Staging host |
| S16 | Migration status | Steps 4 and 7: startup log, `npm run db:status` | `[migrations] 9/9 applied`; every migration `applied`, integrity ok | Not run | BLOCKED | Staging host |
| S17 | Account email flows | Step 8.4: confirmation, sign-in help, **Send a new link**, password reset, password changed | Each email arrives once, links open the staging address and work once, older links say a newer one was sent | Not run | BLOCKED | Staging host, test inbox, approval B |
| S18 | Account-email retry survives a restart | Step 8b.1 | One reset email after the outage and restart; row `sent`; no address, link or token in the log | Not run | BLOCKED | Staging host, approval C, a way to cause the outage |
| S19 | Cancellation and retry limit | Steps 8b.2 and 8b.3 | Only the newest link is sent; `FAILED … after 4 attempt(s)` and no email after a 25-minute outage | Not run | BLOCKED | Same |
| S20 | One-hour deadline | Step 8b.4 (optional) | `EXPIRED, not sent`; no email | Not run | BLOCKED | Same |
| S21 | Previous-release compatibility | Deploy the pre-009 release first, upgrade to this one (`DEPLOYMENT.md` upgrade procedure), roll back to the pre-009 archive, then forward again | The previous release starts on the upgraded database and existing accounts sign in; after rolling forward, retries older than their deadline are `expired`, never sent | Not run | BLOCKED | Staging host, the pre-009 release archive kept in durable storage |

**On the development machine** (2026-10-24: full regression 16:00–16:08 IST; the release-archive rollback rehearsal,
the inbox self-test and four suites re-run 16:46–16:47 IST after the documentation changes; isolated databases;
nothing left the machine)

| # | Check | Actual | Status |
|---|---|---|---|
| L1 | Automated suites (record below) | All 15 steps passed: 0 failed, 0 skipped | PASS |
| L2 | SMTP TLS enforcement against local TLS servers: implicit TLS and required STARTTLS, untrusted and wrong-host certificates refused, TLS 1.1 refused, no plaintext fallback, production refuses SMTP without credentials | 31 tests in `smtp-tls.test.ts` passed; smoke 19/19 | PASS |
| L3 | `email:test --verify-only` sends nothing; failures name the setting, never its value | Script tests passed (local servers) | PASS |
| L4 | Staging checker, with its negative cases | 22/22 over a local HTTPS proxy with a test certificate; wrong origin and untrusted certificate both fail | PASS (does not prove S1–S5) |
| L5 | Restore drill on an isolated copy | Backup of a database with queued account emails restored identical in all tables (queue included), integrity ok, `db:status` lists 9 migrations | PASS (does not prove S12) |
| L6 | Rollback rehearsal with a release archive | This release (with migration 009 and the recipient allowlist; 16:47 IST): the archive held no `.env` or database, its checksum verified, and the unpacked copy passed the production smoke test 19/19 (`[migrations] 9/9 applied`). The pre-009 release archive was unpacked and ran on an upgraded database | PASS (does not prove S13) |
| L7 | Email failures logged and redacted | Refused, temporarily refused, unreachable and sign-in failures logged without addresses, links or credentials | PASS (alerting is S11) |
| L8 | Account-email retries (migration 009) | Queued retries survive a real process restart and are sent once with a new link; deadlines (1 hour, 24 hours for the password-changed notice) and the five cancellation paths tested; 12/12 deliberate defects caught; see `EMAIL.md` | PASS (local only) |
| L9 | Migration 009 on copies of the five local databases | Byte copies only; through the previous release and directly, each started twice: only the new table and indexes added, no existing row changed, integrity and foreign keys ok; the previous release runs on the migrated copy; originals byte-identical before and after | PASS (does not prove S6) |
| L10 | Recipient allowlist (`EMAIL_ALLOWED_RECIPIENTS`) | 22 tests: booking emails, Resend, invitations and every account email (with retries) refused before any connection to an SMTP server inside the test, which counted 0; `email:test` refused before connecting; exact matching (plus-addresses, subdomains, look-alike names and letters, lists and header injection); malformed values refuse to start; the documented examples checked against the code; 5/5 deliberate defects caught | PASS (local only; does not prove S15) |

## Local verification record (2026-10-24, 16:00–16:08 IST, except where a row gives another time)

| Group | Command (from the project) | Exit | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Web app typecheck | `npx tsc --noEmit -p .` | 0 | n/a | 0 | n/a |
| API typecheck (includes the tests) | `cd server && npx tsc --noEmit -p .` | 0 | n/a | 0 | n/a |
| Web app lint | `npm run lint` (ESLint 10, `--max-warnings 0`) | 0 | 0 problems | 0 | n/a |
| API lint | none: the API has no ESLint configuration or lint script | not run | — | — | — |
| Web app unit tests | `npm run test:unit` | 0 | 17 | 0 | 0 |
| Web app production build | `npm run build` | 0 | n/a | 0 | n/a |
| API production build | `cd server && npm run build` | 0 | n/a | 0 | n/a |
| Production smoke | `cd server && npm run test:smoke` | 0 | 19 | 0 | 0 |
| `email:test` script against local SMTP servers (incl. `--verify-only`) | scripted check on the development machine | 0 | 14 | 0 | 0 |
| Staging checker over local HTTPS, with negative controls | scripted check on the development machine | 0 | 22 (+2 negative controls failing as expected) | 0 | 0 |
| API tests (unit and integration) | `cd server && npm test` | 0 | 744 in 25 suites | 0 | 0 |
| Migration 009 on isolated copies of the five databases | scripted check (previous release, then this build twice; and directly) | 0 | 5 | 0 | 0 |
| API end to end | `cd server && npm run test:e2e` | 0 | 83 | 0 | 0 |
| Email flows through the local inbox | `cd server && npm run test:email` | 0 | 67 | 0 | 0 |
| Browser, desktop and phone, accessibility | `npm run test:browser` | 0 | 74 (0 exceptions, 0 accessibility findings) | 0 | 0 |
| Local inbox self-test | `npm run mail:catcher` and its self-test | 0 | 12 (16:47 IST) | 0 | 0 |
| Backup, restore and rollback with queued account emails | scripted rehearsal with the pre-009 release archive | 0 | all steps | 0 | — |
| Rollback rehearsal (this release) | archive → checksum → content check → unpack → smoke | 0 | 19/19 smoke from the archive (16:47 IST) | 0 | — |

Logs stayed on the development machine and are not part of the repository. A scan found no credentials, emailed
tokens or private keys in them.
