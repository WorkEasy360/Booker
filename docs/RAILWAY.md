# Deploying on Railway

> **Status on 2026-10-27: prepared, not deployed.** No Railway account, CLI login or project is available to this
> workspace, so nothing below has run on Railway and there is no Railway URL. What was verified, on the development
> machine with outgoing network blocked: the server refuses to start in production without an explicit database path
> outside the application; the API serves the built web app on one origin with its security headers (unit tests, a
> real server process, and the full real-browser suite in that mode); a release folder made by `make-release.mjs`
> installs and builds with the same commands as the `Dockerfile` and passes the production-like onboarding check. Not
> verified: building the Docker image (Docker was not running), and anything Railway-specific (volume, domain,
> health check, proxy headers, SMTP from Railway).

Railway facts below are from Railway's documentation as read on 2026-10-27 (volumes, healthchecks, deployments,
outbound networking, backups, CLI `up`, `ssh`, `volume`, config as code). Check them again if much later.

## 1. Does the application fit Railway without changing its database?

Yes, on the **Pro plan**, as **one service with one volume**. No database change is needed: the app keeps SQLite on
the volume. Moving to PostgreSQL would mean rewriting every query (the code uses better-sqlite3's synchronous API in
all routes and services), the 17 migrations, the triggers that refuse overlapping bookings, and the backup tools; it
is not justified for one client and was not done.

| The application needs | Railway gives | Result |
|---|---|---|
| Exactly one API process (rate limits, workers and migrations live in it) | "Replicas cannot be used with volumes" | Fits: one instance is enforced |
| A persistent local disk for the SQLite file and uploads | A volume mounted at a path you choose; Hobby 5 GB, Pro 50 GB | Fits: mount at `/data` |
| Stop the old process before the new one starts | Railway never mounts a volume on two deployments at once: "a small amount of downtime when re-deploying" | Fits (a few seconds per deploy) |
| Time to finish requests on stop | SIGTERM, then SIGKILL after `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (**default 0**) | Set it to `15` |
| HTTPS | A generated `https://<name>.up.railway.app` domain; custom domains optional | Fits |
| Health check | `/api/health` is called **only at deploy time**, from host `healthcheck.railway.app`, on `PORT` | Fits; add an external uptime monitor for afterwards |
| Email over SMTP | "SMTP is only available on the Pro plan and above"; disabled on Free, Trial and Hobby | **Pro plan required** (this app has no HTTPS email API) |
| Real client address for rate limits | Railway's edge sets `X-Forwarded-For`; the hop count is not officially documented | `TRUST_PROXY=1` (no CDN in front); check after deploy |
| Backups | Volume backups: daily (kept 6 days), weekly (27), monthly (89), restore into the same project; "wiping a volume deletes all backups" | Use them **and** download `db:backup` copies off Railway |
| Configuration files | `railway.json`/`railway.toml` are deprecated; new services cannot use them | Settings are made in the dashboard (section 3); the `Dockerfile` is detected automatically |

## 2. What the repository contains for this

| File | Purpose |
|---|---|
| `Dockerfile` | `node:24.19.0-bookworm-slim`; installs with `npm ci --ignore-scripts` (the database driver's ready-made binary), builds the web app and the API, keeps the server's tools for `org:create` and `db:*`, starts `node dist/index.js` in `/app/server` with `NODE_ENV=production` and `WEB_DIST_DIR=/app/dist` |
| `.dockerignore`, `.railwayignore` | Keep `.env` files, databases, `server/data`, backups, uploads, `node_modules`, build output and test suites out of the upload and the image |
| `server/scripts/make-release.mjs` | Makes the folder you deploy from: an explicit list of source files, checked for secrets and data |
| `server/src/db/location.ts` | In production the server **refuses to start** unless `DB_PATH` (and `UPLOAD_DIR`, if set) is an absolute path outside the application folder. There is no fallback database |
| `server/src/web-app.ts` | With `WEB_DIST_DIR` set, the API serves the web app on the same origin (pages never cached, hashed assets cached a year, `/api` never falls back to the app) |

## 3. Steps (owner; dashboard and CLI)

**Never deploy from the project folder itself**: it holds `server/.env` and the development database. The
`.railwayignore` file keeps them out, but deploy from a release folder, which never contains them.

1. **Plan.** Railway account on the **Pro** plan (SMTP). Billing is yours to approve.
2. **Release folder.** On the development machine, in the project root:
   ```bash
   (cd server && npm run build && npm run test:smoke)            # all PASS
   node server/scripts/make-release.mjs --out C:\WorkEasy360-Releases
   ```
   Unpack the new `.tar.gz` into a new, empty folder (for example `C:\WorkEasy360-Releases\r1`) with
   `tar -xzf <file>.tar.gz -C <folder>`. Deploy from that folder.
3. **CLI.** Install the Railway CLI (see Railway's CLI guide) and run `railway login`.
4. **Project and service.** Dashboard → New Project → Empty Project. In it: Create → Empty Service, name it
   `workeasy360`. In the release folder: `railway link` (choose the project, the `production` environment and the
   `workeasy360` service).
5. **Volume.** In the project canvas, attach a volume to `workeasy360` with mount path **`/data`** (or
   `railway volume add --mount-path /data`).
6. **Domain.** Service → Settings → Networking → Generate Domain, target port **8080**. Note the address,
   `https://<name>.up.railway.app`.
7. **Variables.** Service → Variables → Raw Editor. Generate the two secrets on your own computer and paste them
   straight into Railway, nowhere else:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TWO_FACTOR_ENCRYPTION_KEY
   ```
   ```
   NODE_ENV=production
   PORT=8080
   DB_PATH=/data/workeasy360.db
   UPLOAD_DIR=/data/uploads
   CORS_ORIGIN=https://<name>.up.railway.app
   PUBLIC_APP_URL=https://<name>.up.railway.app
   TRUST_PROXY=1
   SIGNUP_MODE=closed
   EMAIL_TRANSPORT=disabled
   JWT_SECRET=<paste>
   TWO_FACTOR_ENCRYPTION_KEY=<paste>
   RAILWAY_DEPLOYMENT_DRAINING_SECONDS=15
   GEMINI_API_KEY=<paste your Gemini key>      # optional: the assistant answers with Gemini (DEPLOYMENT.md)
   ```
   Do not set `NOTIFICATIONS_PROVIDER_MODE`, `RATE_LIMITS`, `WEBHOOKS_ALLOW_PRIVATE_NETWORK`, `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `EMAIL_ALLOWED_RECIPIENTS` (except in step 12) or any provider key you are not deliberately
   setting up.
8. **Deploy settings.** Service → Settings → Deploy: Healthcheck Path **`/api/health`**; Restart Policy **On
   Failure**. Leave replicas at 1 (Railway refuses more with a volume).
9. **Deploy.** In the release folder: `railway up`. The build log shows both builds; the deploy log must show
   `[migrations] 17/17 applied; applied now: …` (a new, empty database on the volume), `Web app: served from /app/dist`,
   `Allowed app origins: https://<name>.up.railway.app`, and only the `[security]` warning that email is disabled. If
   it says `DB_PATH is not set` or `inside the application folder`, fix the variable: nothing was written.
10. **The client's business.** `railway ssh` (needs an SSH key added to Railway), then inside the container:
    ```bash
    cd /app/server
    npm run org:create -- --db /data/workeasy360.db --company "<Company name>" --name "<Administrator's name>" \
      --email <administrator's email> --country India
    npm run db:status -- --db /data/workeasy360.db      # integrity ok, 17 migrations
    exit
    ```
    The password is typed twice at a hidden prompt and never shown. Give it to the administrator by phone or in
    person.
11. **Checks**, from your computer, in the release folder:
    ```bash
    curl -fsS https://<name>.up.railway.app/api/health
    node server/scripts/staging-check.mjs --url https://<name>.up.railway.app      # every line PASS
    ```
    Sign in as the administrator. Then **prove persistence**: Deployments → the active deployment → Redeploy; after it
    is back, sign in again and check the business is still there. Only then is persistence verified.
12. **Email** (needs the Pro plan and your SMTP account). Add `EMAIL_TRANSPORT=smtp`, `EMAIL_FROM`, `SMTP_HOST`,
    `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER`, `SMTP_PASS` and, for the test only,
    `EMAIL_ALLOWED_RECIPIENTS=<your test inbox>`; the service redeploys. Then `railway ssh`:
    ```bash
    cd /app/server
    node -e "for (const k of ['EMAIL_TRANSPORT','EMAIL_FROM','SMTP_HOST','SMTP_USER','SMTP_PASS']) console.log(k.padEnd(16), process.env[k] ? 'set' : 'MISSING')"
    npm run email:test -- --verify-only            # signs in to the SMTP server, sends nothing
    npm run email:test -- --to <your test inbox>   # exactly one real email
    ```
    If the first command prints `MISSING` although the variables are set, the SSH shell does not carry the service's
    variables: tell your operator, do not paste credentials anywhere. Then book once on the public page with your test
    inbox, check the confirmation arrives (not in spam), and links to the Railway address. Remove
    `EMAIL_ALLOWED_RECIPIENTS`. "Accepted by the SMTP server" (what `email:test` reports) is not "delivered": only the
    message in the inbox proves delivery. Sending-domain authentication (SPF, DKIM, DMARC): `EMAIL.md`.
13. **Backups.** Service → Volume → Backups: turn on daily, weekly and monthly schedules. Off-site copy, at least
    weekly and before every deploy:
    ```bash
    railway ssh
    cd /app/server && npm run db:backup -- --db /data/workeasy360.db --out /data/backups && tar -czf /data/backups/uploads-$(date -u +%Y%m%dT%H%MZ).tar.gz -C /data uploads && ls -t /data/backups | head -4
    exit
    railway volume files list /backups
    railway volume files download /backups/<newest>.db <encrypted folder on your computer>
    railway volume files download /backups/<newest>.db.json <same folder>
    railway volume files download /backups/<newest uploads>.tar.gz <same folder>
    ```
    (Paths in `railway volume files` are relative to the volume, so `/data/backups` in the container is `/backups`
    there.) Restore drill on your computer: `npm run db:restore -- --from <file>.db --to <scratch>.db` and
    `npm run db:status -- --db <scratch>.db` in the release folder's `server/`. Backups contain customers' personal data:
    keep them encrypted.
14. **Monitoring.** An external uptime monitor on `https://<name>.up.railway.app/api/health` (Railway checks it only
    during deploys). Logs: service → Deployments → View logs.

## 4. Updates and rollback

New release folder (step 2), back up (step 13), `railway up` from it. The volume keeps the database and uploads; a
deploy has a few seconds of downtime. Railway's Rollback (deployment menu) redeploys an earlier deployment's source
code; it does not restore the volume. All migrations so far only add tables, so older code runs on the newer database.
If data must go back, restore a volume backup (Service → Backups → Restore, then Deploy) or a downloaded `db:backup`.

## 5. Restore

- **Railway volume backup:** Service → Backups → choose the date → Restore → review → Deploy. A new volume from the
  backup is mounted at `/data`; the previous volume is kept, unmounted.
- **Downloaded backup:** upload it with `railway volume files upload <file>.db /restore/<file>.db`, then in
  `railway ssh`: `cd /app/server && npm run db:status -- --db /data/restore/<file>.db`; switch `DB_PATH` to
  `/data/restore/<file>.db` (the service redeploys). The original file stays untouched.
