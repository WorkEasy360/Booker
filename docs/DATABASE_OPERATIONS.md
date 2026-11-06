# Database operations: backup, restore and migrations

WorkEasy360 stores everything in one SQLite database (default `server/data/workeasy360.db`, set with `DB_PATH`).
SQLite runs in WAL mode, so recent changes may live in the `-wal` file next to the database for a while.

## Back up

```bash
cd server
npm run db:backup                       # uses DB_PATH (or ./data/workeasy360.db), writes to ./backups
npm run db:backup -- --db ./data/workeasy360.db --out /secure/backups
```

- Safe while the server is running. The script uses SQLite's online backup API, which produces a consistent snapshot
  including changes still in the WAL file. **Do not copy the `.db` file by hand while the server runs**: without its
  `-wal` file the copy can be incomplete or inconsistent.
- The backup is checked (`PRAGMA integrity_check`) and a manifest `<backup>.db.json` is written next to it. The manifest
  records the source, time, size, SHA-256, row counts per table and the applied migrations.
- The source database is opened read-only when SQLite allows it. If it does not (a database in WAL mode that no process
  has open may first need its shared-memory file created), it is opened normally. Data is never changed, but closing
  that connection can fold the `-wal` file into the `.db` file, so the source file's bytes (not its content) may
  change. To leave a file byte-for-byte untouched, copy the `.db` and `-wal` files while nothing has them open and
  back up the copy.

**Schedule.** Run the command from cron (Linux/macOS) or Task Scheduler (Windows), for example every night and before
every upgrade. Keep several generations (for example 14 daily and 8 weekly backups). Copy them off the server to
storage with access control. Backups contain customer names, emails and phone numbers: treat them like the live
database, and encrypt them at rest if they leave the server.

## Restore

1. **Stop the API server.** Restoring under a running server would be overwritten or corrupted by it.
2. Restore the chosen backup:
   ```bash
   cd server
   npm run db:restore -- --from ./backups/workeasy360-<time>.db --to ./data/workeasy360.db --force
   ```
   - The backup is verified before anything changes.
   - Without `--force`, an existing target is left untouched and the command stops.
   - With `--force`, the current database and its `-wal`/`-shm` files are **moved aside** to
     `workeasy360.db.before-restore-<time>`. They are never deleted.
   - After copying, the restored database is checked: integrity, row counts per table, migration history and
     triggers must all match the backup, or the command reports the difference.
3. Start the server. Migrations newer than the backup are applied automatically (see below).
4. Sign in and spot-check recent bookings. Everyone signs in again if the backup predates their session.

To test a backup without touching the live database, restore it to a separate file and open it with
`DB_PATH=./data/restore-test.db` on another port, or inspect it with `npm run db:status -- --db ./data/restore-test.db`.

## Migrations

Schema changes are forward-only, additive migrations in `server/src/db/migrations.ts`. They run automatically when the
server starts and are recorded in the `schema_migrations` table.

| Id | What it adds |
|---|---|
| 001_staff_unique_email_per_org | Unique staff email per organization (index) |
| 002_email_deliveries | Log of every booking email attempt (recipient stored as a hash) |
| 003_appointment_overlap_guard | Database triggers that refuse overlapping active appointments for one staff member |
| 004_user_sessions | Server-side sessions (logout, password change and deactivation end sessions) |
| 005_staff_accounts | Staff sign-in link on users, and staff invitations |
| 006_email_outbox | Email outbox for retries without duplicates |
| 007_time_off_and_breaks | Staff time off, business closures and weekly breaks (new tables only; see `SCHEDULING.md`) |
| 008_account_tokens | Password reset links and pending sign-ups awaiting email confirmation (new tables only; only token hashes are stored; see `SECURITY.md`) |
| 009_account_email_queue | Queue of account emails, so their retries survive a restart (new table only; no token, link, message or email address; finished rows are deleted after 7 days; see `EMAIL.md`) |
| 010_appointment_history | Append-only change history of appointments: who created, moved, reassigned, cancelled, completed or deleted one, and when (new table and triggers; entries cannot be edited or deleted, they go only with their organization; nothing is back-filled) |
| 011_two_factor | Two-factor sign-in: authenticator secrets (encrypted) and recovery codes (SHA-256 hashes only) in new tables; the users table is not altered |
| 012_media_files | Records of uploaded images (business logo, staff photos): type read from the file, size, checksum, storage key. The files themselves are in `UPLOAD_DIR` (see below) |
| 013_appointment_resources | Which room or resource each appointment holds, filled once from existing references; triggers refuse over-booking a resource beyond its capacity from now on |
| 014_notification_settings | Reminders, staff alerts, booking language and the business's own email texts; a queue for reminders and staff alerts (no address or message stored) |
| 015_payments | Online payment records and the provider events applied to them (no card, bank, UPI or customer data) |
| 016_integrations | Outgoing webhooks and their deliveries (payloads dropped 30 days after finishing); connected-app tokens, encrypted |
| 017_notification_platform | Notification jobs and their attempts (email, SMS, WhatsApp, calendar), rules per event, recipient and channel, reminder times and business calendar, business recipients, staff preferences, customer SMS/WhatsApp consent, SMS/WhatsApp connections (credentials encrypted), calendar event links, provider callback ids (new tables only; see `NOTIFICATIONS.md`) |

Migrations 010–017 only add tables, indexes and triggers; no existing row is changed. **Uploaded images are files,
not database rows:** `db:backup` does not include them. Back up `UPLOAD_DIR` (default: an `uploads` folder next to
the database file) together with the database.

**Existing data is never changed to make a migration fit.** If existing records conflict with a migration, it is
skipped and the server still starts:

- 001 is skipped while two staff members in one organization share an email address.
- 003 is skipped while overlapping active appointments exist for the same staff member.

At startup the server prints which migrations were applied or skipped and why. The same report is available without
starting the server:

```bash
cd server
npm run db:status                       # DB_PATH or ./data/workeasy360.db, opened read-only
npm run db:status -- --db ./backups/workeasy360-<time>.db
```

To resolve a skipped migration, fix the listed records in the app (give one staff member a different email, or move
or cancel one of the overlapping appointments), then restart the server. The migration is retried at every start
until it applies.

While a migration is skipped, the API still enforces the rule for new writes. For example, it rejects duplicate staff
emails and overlapping bookings. Only the extra database-level guard is missing.

If a migration fails with an error (rather than being skipped for data reasons), the server does not start. The error
names the migration, for example `Migration 006_email_outbox failed: …`. Each migration runs in its own transaction,
so the failed one leaves nothing half-applied, earlier ones stay applied, and later ones are not attempted. Fix the
cause, and the next start continues from that migration.

## Removing test data

Test records (QA probes, test sign-ups) are removed only from a reviewed plan, never by pattern matching.
`server/data/test-data-cleanup-plan.json` lists each record with its id, the name (or slug or email) it must still
have, and the reason it is considered test data.

```bash
cd server
npx tsx scripts/cleanup-test-data.ts --plan ./data/test-data-cleanup-plan.json                 # dry run: changes nothing
npx tsx scripts/cleanup-test-data.ts --plan ./data/test-data-cleanup-plan.json --only id1,id2  # a subset
npx tsx scripts/cleanup-test-data.ts --plan ./data/test-data-cleanup-plan.json --apply         # stop the API first
```

- A dry run opens the database read-only and lists, for each record, what deleting it would do (for example a booking
  page's public link stops working) or why it is refused.
- A record is refused when its name no longer matches the plan, when it has appointments or customers, or when it is
  a business's last administrator (unless the business itself is in the plan).
- If any record is refused, nothing is deleted. Otherwise a backup is written to `./backups` first, then every record
  is deleted in one transaction, and ids are removed from the lists that referred to them (staff services, booking
  page services, and so on).
- It never runs with `NODE_ENV=production`.

## Verification in the test suites

`src/tests/db-ops.test.ts` runs only on throw-away databases. It covers:
- a backup and restore round trip, with record-level comparison;
- refusal to overwrite, moving aside with `--force`, and rejection of corrupt backups;
- migrations on a fresh database and on an older database with conflicting data (skips reported, data untouched);
- the overlap triggers after migration;
- several independent connections, from separate threads, racing to book the same slot.
