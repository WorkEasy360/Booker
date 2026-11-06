import type Database from 'better-sqlite3';

// Forward-only, additive migrations recorded in schema_migrations.
// Existing data is never changed to make a migration fit: when existing records conflict with a migration,
// `blockedBy` explains why, the migration is skipped and reported, and it is retried on the next start.

interface Migration {
  id: string;
  description: string;
  /** Read-only check. Returns why the migration cannot be applied to this data yet, or null. */
  blockedBy?: (db: Database.Database) => string | null;
  apply: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    id: '001_staff_unique_email_per_org',
    description: 'One staff email address per organization (unique index)',
    blockedBy(db) {
      const dupes = db.prepare(
        `SELECT organization_id, lower(email) AS email, COUNT(*) AS c
         FROM staff GROUP BY organization_id, lower(email) HAVING c > 1`
      ).all() as Array<{ organization_id: string; email: string; c: number }>;
      return dupes.length
        ? `${dupes.length} duplicate staff email group(s) must be resolved first; the API still rejects new duplicates`
        : null;
    },
    apply(db) {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_org_email ON staff(organization_id, lower(email))');
    },
  },
  {
    id: '002_email_deliveries',
    description: 'Log of every booking email attempt (recipient stored only as a hash)',
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_deliveries (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          appointment_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'reschedule', 'cancellation')),
          status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
          transport TEXT NOT NULL,
          recipient_hash TEXT NOT NULL,
          provider_message_id TEXT,
          error TEXT,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_email_deliveries_appt ON email_deliveries(appointment_id, created_at);
      `);
    },
  },
  {
    id: '003_appointment_overlap_guard',
    description: 'Database triggers that refuse overlapping active appointments for one staff member',
    // Last line of defence behind the API checks. Only writes are checked, so pre-existing data is untouched;
    // refuse to install while it already overlaps.
    blockedBy(db) {
      const overlaps = db.prepare(
        `SELECT COUNT(*) AS c FROM appointments a JOIN appointments b
           ON a.staff_id = b.staff_id AND a.date = b.date AND a.id < b.id
         WHERE a.status NOT IN ('cancelled','no_show') AND b.status NOT IN ('cancelled','no_show')
           AND a.start_time < b.end_time AND a.end_time > b.start_time`
      ).get() as { c: number };
      return overlaps.c > 0 ? `${overlaps.c} overlapping appointment pair(s) exist; move or cancel one of each pair, then restart` : null;
    },
    apply(db) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_appointments_no_overlap_insert
        BEFORE INSERT ON appointments
        WHEN NEW.status NOT IN ('cancelled','no_show')
        BEGIN
          SELECT RAISE(ABORT, 'APPOINTMENT_OVERLAP')
          WHERE EXISTS (SELECT 1 FROM appointments
            WHERE staff_id = NEW.staff_id AND date = NEW.date AND status NOT IN ('cancelled','no_show')
              AND start_time < NEW.end_time AND end_time > NEW.start_time);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_appointments_no_overlap_update
        BEFORE UPDATE OF staff_id, date, start_time, end_time, status ON appointments
        WHEN NEW.status NOT IN ('cancelled','no_show')
          AND (NEW.staff_id IS NOT OLD.staff_id OR NEW.date IS NOT OLD.date OR NEW.start_time IS NOT OLD.start_time
               OR NEW.end_time IS NOT OLD.end_time OR OLD.status IN ('cancelled','no_show'))
        BEGIN
          SELECT RAISE(ABORT, 'APPOINTMENT_OVERLAP')
          WHERE EXISTS (SELECT 1 FROM appointments
            WHERE id != NEW.id AND staff_id = NEW.staff_id AND date = NEW.date AND status NOT IN ('cancelled','no_show')
              AND start_time < NEW.end_time AND end_time > NEW.start_time);
        END;
      `);
    },
  },
  {
    id: '004_user_sessions',
    description: 'Server-side sessions, so logout, password changes and deactivation end sessions',
    // The JWT only carries the user and session ids; role and organization are read from the database per request.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
      `);
    },
  },
  {
    id: '005_staff_accounts',
    description: 'Staff sign-ins linked to one staff record, and email invitations (token hashes only)',
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
      if (!columns.some(c => c.name === 'staff_id')) {
        db.exec('ALTER TABLE users ADD COLUMN staff_id TEXT REFERENCES staff(id) ON DELETE SET NULL');
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_staff ON users(staff_id) WHERE staff_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS staff_invitations (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          staff_id TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('staff', 'manager')),
          token_hash TEXT NOT NULL UNIQUE,
          invited_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          expires_at TEXT NOT NULL,
          accepted_at TEXT,
          accepted_user_id TEXT,
          revoked_at TEXT,
          delivery_status TEXT,
          delivery_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_staff_invitations_staff ON staff_invitations(staff_id, created_at);
      `);
    },
  },
  {
    id: '006_email_outbox',
    description: 'Email outbox: retries with backoff and no duplicate sends',
    // pending → sending → sent | pending (retry) | failed | not_configured | superseded;
    // sending → unknown when the server stopped mid-send (never retried automatically).
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS email_outbox (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL,
          appointment_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'reschedule', 'cancellation')),
          dedupe_key TEXT NOT NULL UNIQUE,
          previous TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'not_configured', 'superseded', 'unknown')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          provider_message_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_email_outbox_appt ON email_outbox(appointment_id);
      `);
    },
  },
  {
    id: '007_time_off_and_breaks',
    description: 'Staff time off, business closures and weekly breaks, which block new bookings',
    // New tables only: no existing row is read or changed.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS time_off (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          staff_id TEXT REFERENCES staff(id) ON DELETE CASCADE,   -- NULL: the whole business is closed
          start_date TEXT NOT NULL,                               -- business-local dates, inclusive
          end_date TEXT NOT NULL,
          start_time TEXT,                                        -- both NULL: whole days
          end_time TEXT,
          reason TEXT NOT NULL DEFAULT '',
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK (end_date >= start_date),
          CHECK ((start_time IS NULL AND end_time IS NULL) OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
        );
        CREATE INDEX IF NOT EXISTS idx_time_off_dates ON time_off(organization_id, start_date, end_date);
        CREATE TABLE IF NOT EXISTS schedule_breaks (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          staff_id TEXT REFERENCES staff(id) ON DELETE CASCADE,   -- NULL: a break for the whole business
          weekday TEXT NOT NULL CHECK (weekday IN ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          label TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK (end_time > start_time)
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_breaks_org ON schedule_breaks(organization_id, weekday);
      `);
    },
  },
  {
    id: '008_account_tokens',
    description: 'Password-reset links and email verification of new sign-ups (token hashes only)',
    // New tables only: existing users are untouched and count as verified (an account only exists once verified).
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS password_resets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,                        -- SHA-256 of the token; the token itself is never stored
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          expires_at TEXT NOT NULL,
          used_at TEXT,
          superseded_at TEXT,                                     -- a newer link was requested, or the password changed
          CHECK (expires_at > created_at)
        );
        CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id, created_at);
        CREATE TABLE IF NOT EXISTS signup_requests (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,                                    -- lower-case
          name TEXT NOT NULL,
          company TEXT NOT NULL,
          password_hash TEXT NOT NULL,                            -- bcrypt, as for users
          timezone TEXT,
          country TEXT,
          token_hash TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          expires_at TEXT NOT NULL,
          verified_at TEXT,
          superseded_at TEXT,                                     -- a newer sign-up or link for the same address
          user_id TEXT,                                           -- the account created on verification
          CHECK (expires_at > created_at)
        );
        CREATE INDEX IF NOT EXISTS idx_signup_requests_email ON signup_requests(email, created_at);
      `);
    },
  },
  {
    id: '009_account_email_queue',
    description: 'Account emails (sign-up confirmation, sign-in help, password reset, password changed) survive a restart',
    // New table and indexes only: no existing row is read or changed. A row never holds a token, link, message or
    // email address: the recipient is read through the reference when sending, and every retry issues a new link.
    // sending (first attempt, or claimed) → sent | pending (retry due) | failed | expired | superseded;
    // pending → sending (claimed) | expired (past expires_at) | superseded (newer request, or the link was used).
    // expires_at is the send deadline: 1 hour after the request (24 hours for the password-changed notice), and never
    // later than the link's own expiry.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS account_email_queue (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('verify', 'verify_again', 'existing_account', 'password_reset', 'password_changed')),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          signup_request_id TEXT REFERENCES signup_requests(id) ON DELETE CASCADE,
          password_reset_id TEXT REFERENCES password_resets(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'superseded', 'expired')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          expires_at TEXT NOT NULL,
          changed_at TEXT,                                        -- password_changed only: when the password changed
          last_error TEXT,                                        -- redacted: no addresses, no SMTP credentials
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
        CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_queue_signup ON account_email_queue(signup_request_id) WHERE signup_request_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_account_email_queue_reset ON account_email_queue(password_reset_id) WHERE password_reset_id IS NOT NULL;
      `);
    },
  },
  {
    id: '010_appointment_history',
    description: 'Append-only change history of appointments (created, status, time, staff, deleted; who and when)',
    // New table and triggers only: no existing row is read or changed, and nothing is back-filled (earlier changes
    // were never recorded, and the history does not pretend otherwise). Rows are written in the same transaction as
    // the change they describe. They cannot be edited or deleted; they go only with their organization.
    // appointment_id has no foreign key so the record outlives a deleted appointment; actor_user_id has none so it
    // outlives a removed sign-in (actor_name keeps the name it had at the time).
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS appointment_history (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          appointment_id TEXT NOT NULL,
          booking_ref TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('created', 'status_changed', 'rescheduled', 'reassigned', 'deleted')),
          from_status TEXT,
          to_status TEXT,
          from_date TEXT,
          from_start_time TEXT,
          to_date TEXT,
          to_start_time TEXT,
          from_staff_id TEXT,
          to_staff_id TEXT,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'customer', 'system')),
          actor_user_id TEXT,
          actor_name TEXT,
          source TEXT NOT NULL CHECK (source IN ('dashboard', 'assistant', 'booking_page', 'manage_link', 'system')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK ((actor_type = 'user') = (actor_user_id IS NOT NULL)),
          CHECK (action != 'status_changed' OR (from_status IS NOT NULL AND to_status IS NOT NULL AND from_status != to_status)),
          CHECK (action != 'rescheduled' OR (from_date IS NOT NULL AND from_start_time IS NOT NULL AND to_date IS NOT NULL AND to_start_time IS NOT NULL)),
          CHECK (action != 'reassigned' OR (from_staff_id IS NOT NULL AND to_staff_id IS NOT NULL AND from_staff_id != to_staff_id))
        );
        CREATE INDEX IF NOT EXISTS idx_appointment_history_appt ON appointment_history(organization_id, appointment_id, created_at);
        CREATE TRIGGER IF NOT EXISTS appointment_history_no_update BEFORE UPDATE ON appointment_history
        BEGIN SELECT RAISE(ABORT, 'appointment history is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS appointment_history_no_delete BEFORE DELETE ON appointment_history
          WHEN EXISTS (SELECT 1 FROM organizations WHERE id = OLD.organization_id)
        BEGIN SELECT RAISE(ABORT, 'appointment history is append-only'); END;
        CREATE TRIGGER IF NOT EXISTS appointment_history_no_replace BEFORE INSERT ON appointment_history
          WHEN EXISTS (SELECT 1 FROM appointment_history WHERE id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'appointment history is append-only'); END;
      `);
    },
  },
  {
    id: '011_two_factor',
    description: 'Two-factor sign-in: encrypted authenticator secrets and single-use recovery codes (new tables only)',
    // New tables only; the users table is not altered, so existing sign-ins are unchanged and have two-factor off.
    // Secrets are stored encrypted (AES-256-GCM, bound to the user id); recovery codes only as SHA-256 hashes of
    // 80-bit random codes. last_used_step makes each authenticator code usable once.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_two_factor (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          secret_enc TEXT,
          enabled_at TEXT,
          pending_secret_enc TEXT,
          pending_expires_at TEXT,
          last_used_step INTEGER,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK ((secret_enc IS NULL) = (enabled_at IS NULL)),
          CHECK ((pending_secret_enc IS NULL) = (pending_expires_at IS NULL))
        );
        CREATE TABLE IF NOT EXISTS user_recovery_codes (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
          used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_recovery_codes_hash ON user_recovery_codes(user_id, code_hash);
      `);
    },
  },
  {
    id: '012_media_files',
    description: 'Uploaded images (business logo, staff photos): what each stored file is (new table only)',
    // New table only. The bytes live in the storage adapter (UPLOAD_DIR); a row records the server-generated key, the
    // type read from the file itself, its size and checksum. One logo per business and one photo per staff member.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS media_files (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('logo', 'staff_photo')),
          owner_id TEXT NOT NULL,
          storage TEXT NOT NULL,
          storage_key TEXT NOT NULL UNIQUE,
          content_type TEXT NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
          byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
          width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 4096),
          height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 4096),
          sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
          uploaded_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          CHECK (kind != 'logo' OR owner_id = organization_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_files_owner ON media_files(organization_id, kind, owner_id);
      `);
    },
  },
  {
    id: '013_appointment_resources',
    description: 'Which rooms or resources each appointment holds, with database checks against over-booking them',
    // New table, filled once from appointments.resource_ids (same-organization references only; appointments are read,
    // never changed). The triggers check writes from now on: a resource with capacity N can be held by at most N
    // active appointments whose times overlap. Existing data is not judged (it was never checked before); an existing
    // appointment is checked when it is moved or brought back.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS appointment_resources (
          appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
          resource_id TEXT NOT NULL REFERENCES resources(id),
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          PRIMARY KEY (appointment_id, resource_id)
        );
        CREATE INDEX IF NOT EXISTS idx_appointment_resources_resource ON appointment_resources(resource_id);

        INSERT OR IGNORE INTO appointment_resources (appointment_id, resource_id, organization_id)
        SELECT a.id, r.id, a.organization_id
        FROM appointments a, json_each(CASE WHEN json_valid(a.resource_ids) THEN a.resource_ids ELSE '[]' END) j
        JOIN resources r ON r.id = j.value AND r.organization_id = a.organization_id;

        CREATE TRIGGER IF NOT EXISTS trg_appointment_resources_same_org
        BEFORE INSERT ON appointment_resources
        BEGIN
          SELECT RAISE(ABORT, 'RESOURCE_ORG_MISMATCH')
          WHERE (SELECT organization_id FROM appointments WHERE id = NEW.appointment_id) IS NOT NEW.organization_id
             OR (SELECT organization_id FROM resources WHERE id = NEW.resource_id) IS NOT NEW.organization_id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_appointment_resources_capacity
        BEFORE INSERT ON appointment_resources
        BEGIN
          SELECT RAISE(ABORT, 'RESOURCE_UNAVAILABLE')
          FROM appointments me
          WHERE me.id = NEW.appointment_id AND me.status NOT IN ('cancelled','no_show')
            AND (SELECT COUNT(*) FROM appointment_resources o JOIN appointments a ON a.id = o.appointment_id
                 WHERE o.resource_id = NEW.resource_id AND a.id != me.id AND a.date = me.date
                   AND a.status NOT IN ('cancelled','no_show') AND a.start_time < me.end_time AND a.end_time > me.start_time)
                >= (SELECT capacity FROM resources WHERE id = NEW.resource_id);
        END;

        CREATE TRIGGER IF NOT EXISTS trg_appointments_resource_capacity
        BEFORE UPDATE OF date, start_time, end_time, status ON appointments
        WHEN NEW.status NOT IN ('cancelled','no_show')
          AND (NEW.date IS NOT OLD.date OR NEW.start_time IS NOT OLD.start_time OR NEW.end_time IS NOT OLD.end_time
               OR OLD.status IN ('cancelled','no_show'))
        BEGIN
          SELECT RAISE(ABORT, 'RESOURCE_UNAVAILABLE')
          WHERE EXISTS (
            SELECT 1 FROM appointment_resources ar
            WHERE ar.appointment_id = NEW.id
              AND (SELECT COUNT(*) FROM appointment_resources o JOIN appointments a ON a.id = o.appointment_id
                   WHERE o.resource_id = ar.resource_id AND a.id != NEW.id AND a.date = NEW.date
                     AND a.status NOT IN ('cancelled','no_show') AND a.start_time < NEW.end_time AND a.end_time > NEW.start_time)
                  >= (SELECT capacity FROM resources WHERE id = ar.resource_id));
        END;
      `);
    },
  },
  {
    id: '014_notification_settings',
    description: 'Reminders, staff alerts, booking language and editable email texts (new tables only)',
    // New tables only. A business without a preferences row has the previous behaviour: English, no reminders, no
    // staff alerts, built-in email texts. notification_queue holds reminders and staff alerts (one row per event,
    // unique dedupe_key, so nothing is sent twice); it stores no address or message, only what to send and its outcome.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS organization_preferences (
          organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
          booking_language TEXT NOT NULL DEFAULT 'en' CHECK (booking_language IN ('en', 'hi')),
          reminders_enabled INTEGER NOT NULL DEFAULT 0 CHECK (reminders_enabled IN (0, 1)),
          reminder_hours_before INTEGER NOT NULL DEFAULT 24 CHECK (reminder_hours_before BETWEEN 1 AND 168),
          staff_alerts_enabled INTEGER NOT NULL DEFAULT 0 CHECK (staff_alerts_enabled IN (0, 1)),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE IF NOT EXISTS email_templates (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'reschedule', 'cancellation', 'reminder')),
          subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 150),
          intro TEXT NOT NULL CHECK (length(intro) BETWEEN 1 AND 1000),
          updated_by TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (organization_id, kind)
        );
        CREATE TABLE IF NOT EXISTS notification_queue (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          appointment_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('reminder', 'staff_new', 'staff_cancelled', 'staff_rescheduled')),
          dedupe_key TEXT NOT NULL UNIQUE,
          previous TEXT,                                          -- staff_rescheduled: the old date and times
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'not_configured', 'skipped', 'unknown')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notification_queue_due ON notification_queue(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_notification_queue_appt ON notification_queue(appointment_id);
      `);
    },
  },
  {
    id: '015_payments',
    description: 'Online payment records and the provider events applied to them (new tables only)',
    // New tables only. Amounts are in minor units (paise, cents). No card, bank, UPI or customer data is stored: only
    // the provider's payment id, the amount, the state and which provider events were applied (each once).
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          appointment_id TEXT,
          provider TEXT NOT NULL CHECK (provider IN ('stripe', 'razorpay', 'paypal')),
          provider_payment_id TEXT NOT NULL,
          amount INTEGER NOT NULL CHECK (amount > 0),
          currency TEXT NOT NULL CHECK (length(currency) = 3),
          status TEXT NOT NULL CHECK (status IN ('created', 'pending', 'paid', 'failed', 'cancelled', 'partially_refunded', 'refunded')),
          refunded_amount INTEGER NOT NULL DEFAULT 0,
          last_event_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE (provider, provider_payment_id),
          CHECK (refunded_amount >= 0 AND refunded_amount <= amount)
        );
        CREATE INDEX IF NOT EXISTS idx_payments_appointment ON payments(organization_id, appointment_id);
        CREATE TABLE IF NOT EXISTS payment_events (
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          payment_id TEXT REFERENCES payments(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'ignored_duplicate', 'ignored_unknown', 'ignored_stale')),
          received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (provider, event_id)
        );
      `);
    },
  },
  {
    id: '016_integrations',
    description: 'Outgoing webhooks (and Zapier) with signed, retried deliveries; connected-app tokens, encrypted (new tables only)',
    // New tables only. Endpoint secrets and connected-app tokens are stored encrypted (AES-256-GCM, bound to their row).
    // A delivery keeps its payload only until it is finished and 30 days old.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS webhook_endpoints (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          url TEXT NOT NULL CHECK (length(url) BETWEEN 8 AND 2048),
          secret_enc TEXT NOT NULL,
          events TEXT NOT NULL DEFAULT '[]',
          description TEXT NOT NULL DEFAULT '',
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_org ON webhook_endpoints(organization_id);
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          response_status INTEGER,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          delivered_at TEXT,
          UNIQUE (endpoint_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
        CREATE TABLE IF NOT EXISTS integration_connections (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'zoom', 'mailchimp')),
          access_token_enc TEXT NOT NULL,
          refresh_token_enc TEXT,
          expires_at TEXT,
          scopes TEXT NOT NULL,
          connected_by TEXT,
          connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (organization_id, provider)
        );
      `);
    },
  },
  {
    id: '017_notification_platform',
    description: 'One notification job queue for every recipient and channel (email, SMS, WhatsApp, calendars), with attempts, rules, recipients, consent and calendar links (new tables only)',
    // New tables only; no existing row is read or changed. Jobs hold what to send and its outcome, never a message
    // body, an address or a credential: those are read from the appointment when sending. Messaging credentials are
    // stored only encrypted. notification_queue (014) is no longer written; its rows stay readable in delivery history.
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notification_jobs (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          appointment_id TEXT NOT NULL,
          event TEXT NOT NULL CHECK (event IN ('confirmed', 'rescheduled', 'cancelled', 'reminder', 'status_changed')),
          recipient_role TEXT NOT NULL CHECK (recipient_role IN ('customer', 'staff', 'business', 'business_calendar')),
          recipient_id TEXT NOT NULL,
          channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'google_calendar', 'outlook_calendar')),
          dedupe_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled', 'unknown', 'not_configured')),
          reason TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 10),
          next_attempt_at TEXT,
          scheduled_for TEXT,
          appointment_version TEXT NOT NULL,
          slot TEXT NOT NULL,
          previous TEXT,
          offset_minutes INTEGER,
          provider TEXT,
          provider_message_id TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          sent_at TEXT,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_notification_jobs_due ON notification_jobs(status, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_notification_jobs_appt ON notification_jobs(organization_id, appointment_id);
        CREATE INDEX IF NOT EXISTS idx_notification_jobs_provider ON notification_jobs(provider, provider_message_id);
        CREATE TABLE IF NOT EXISTS notification_attempts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES notification_jobs(id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'retry', 'failed', 'unknown', 'not_configured', 'skipped', 'cancelled')),
          provider_status TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          UNIQUE (job_id, attempt)
        );
        CREATE TABLE IF NOT EXISTS notification_rules (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          event TEXT NOT NULL CHECK (event IN ('confirmed', 'rescheduled', 'cancelled', 'reminder', 'status_changed')),
          recipient_role TEXT NOT NULL CHECK (recipient_role IN ('customer', 'staff', 'business', 'business_calendar')),
          channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp', 'google_calendar', 'outlook_calendar')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (organization_id, event, recipient_role, channel)
        );
        CREATE TABLE IF NOT EXISTS organization_notification_settings (
          organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
          reminder_offsets TEXT NOT NULL DEFAULT '[1440]',
          business_calendar TEXT CHECK (business_calendar IN ('google', 'outlook')),
          invite_staff_to_calendar INTEGER NOT NULL DEFAULT 0 CHECK (invite_staff_to_calendar IN (0, 1)),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE IF NOT EXISTS business_notification_recipients (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
          email TEXT,
          phone TEXT,
          channels TEXT NOT NULL DEFAULT '["email"]',
          events TEXT NOT NULL DEFAULT '["confirmed","rescheduled","cancelled"]',
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE INDEX IF NOT EXISTS idx_business_recipients_org ON business_notification_recipients(organization_id);
        CREATE TABLE IF NOT EXISTS staff_notification_settings (
          staff_id TEXT PRIMARY KEY REFERENCES staff(id) ON DELETE CASCADE,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          channels TEXT NOT NULL DEFAULT '["email"]',
          events TEXT NOT NULL DEFAULT '["confirmed","rescheduled","cancelled","reminder"]',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        CREATE TABLE IF NOT EXISTS customer_contact_consent (
          customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
          status TEXT NOT NULL CHECK (status IN ('granted', 'revoked')),
          source TEXT NOT NULL CHECK (source IN ('booking_page', 'staff', 'reply_stop', 'manage_link')),
          recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (customer_id, channel)
        );
        CREATE TABLE IF NOT EXISTS messaging_connections (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          channel TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
          provider TEXT NOT NULL CHECK (provider IN ('twilio', 'whatsapp_cloud', 'mock')),
          config_enc TEXT NOT NULL,
          settings TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL CHECK (status IN ('configured_unverified', 'connected', 'error')),
          verified_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (organization_id, channel)
        );
        CREATE TABLE IF NOT EXISTS calendar_event_links (
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          appointment_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
          provider_event_id TEXT NOT NULL,
          sequence INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (appointment_id, provider)
        );
        CREATE TABLE IF NOT EXISTS messaging_webhook_events (
          provider TEXT NOT NULL,
          event_id TEXT NOT NULL,
          received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (provider, event_id)
        );
      `);
    },
  },
];

export const MIGRATION_IDS = MIGRATIONS.map(m => m.id);

export interface MigrationReport {
  applied: string[];
  skipped: Array<{ id: string; reason: string }>;
  alreadyApplied: string[];
}

function appliedMap(db: Database.Database): Map<string, string> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!exists) return new Map();
  return new Map((db.prepare('SELECT id, applied_at FROM schema_migrations').all() as Array<{ id: string; applied_at: string }>)
    .map(r => [r.id, r.applied_at]));
}

/** Applies every pending migration that existing data allows, each in its own transaction. */
export function runMigrations(db: Database.Database): MigrationReport {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`);
  const applied = appliedMap(db);
  const report: MigrationReport = { applied: [], skipped: [], alreadyApplied: [] };
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) { report.alreadyApplied.push(m.id); continue; }
    let reason: string | null;
    try {
      reason = db.transaction(() => {
        const blocked = m.blockedBy?.(db) ?? null;
        if (blocked) return blocked;
        m.apply(db);
        db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
        return null;
      })();
    } catch (e) {
      // Rolled back as a whole; startup stops and says which migration failed. Later migrations are not attempted.
      const failure = new Error(`Migration ${m.id} failed: ${(e as Error).message}`);
      (failure as Error & { cause?: unknown }).cause = e;
      throw failure;
    }
    if (reason) report.skipped.push({ id: m.id, reason });
    else report.applied.push(m.id);
  }
  return report;
}

export interface MigrationState {
  id: string;
  description: string;
  state: 'applied' | 'pending' | 'blocked';
  appliedAt?: string;
  reason?: string;
}

/** Read-only report of every migration for a database: applied (when), pending, or blocked (why). */
export function migrationStatus(db: Database.Database): MigrationState[] {
  const applied = appliedMap(db);
  return MIGRATIONS.map(m => {
    if (applied.has(m.id)) return { id: m.id, description: m.description, state: 'applied' as const, appliedAt: applied.get(m.id) };
    let reason: string | null = null;
    try { reason = m.blockedBy?.(db) ?? null; } catch (e) { reason = `cannot check: ${(e as Error).message}`; }
    return reason
      ? { id: m.id, description: m.description, state: 'blocked' as const, reason }
      : { id: m.id, description: m.description, state: 'pending' as const };
  });
}
