// Backup/restore, migrations on fresh and older databases, overlap triggers, and real multi-connection concurrency.
// Every database here is a throw-away file in the OS temp directory or the per-file Jest database; nothing touches
// the development database.

import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import { spawnSync } from 'child_process';
import app from '../index';
import db from '../db/init';
import { createSchema } from '../db/schema';
import { runMigrations, migrationStatus, MIGRATION_IDS } from '../db/migrations';
import { backupDatabase, restoreDatabase, summarize } from '../db/ops';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `we360-dbops-${RUN}-`));
afterAll(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
});

function freshDb(name: string): Database.Database {
  const d = new Database(path.join(TMP, name));
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  createSchema(d);
  return d;
}

/** Minimal records for appointments: organization, staff, service, customer. */
function seed(d: Database.Database, opts: { staffEmail?: string } = {}) {
  d.prepare("INSERT INTO organizations (id, name, email) VALUES ('org-t', 'Test Org', 'org@example.com')").run();
  d.prepare("INSERT INTO staff (id, organization_id, name, email) VALUES ('st-1', 'org-t', 'Sam', ?)").run(opts.staffEmail ?? 'sam@example.com');
  d.prepare("INSERT INTO services (id, organization_id, name, duration, price) VALUES ('sv-1', 'org-t', 'Cut', 60, 30)").run();
  d.prepare("INSERT INTO customers (id, organization_id, name, email) VALUES ('cu-1', 'org-t', 'Cara', 'cara@example.com')").run();
}

const insertAppt = (d: Database.Database, id: string, start: string, end: string, status = 'scheduled') =>
  d.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration)
             VALUES (?, ?, 'org-t', 'sv-1', 'st-1', 'cu-1', ?, '2030-01-07', ?, ?, 60)`).run(id, `WE-${id.toUpperCase()}`, status, start, end);

describe('backup and restore', () => {
  let ref = '';

  beforeAll(async () => {
    // Synthetic records through the API, so the backup holds real application data.
    const s = await signUpAndSignIn(app, {
      name: 'Backup Owner', email: `backup-${RUN}@example.com`, company: `Backup Org ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
    });
    const auth = { Authorization: `Bearer ${sessionToken(s)}` };
    const serviceId = (await request(app).post('/api/services').set(auth).send({ name: 'Backed Up', category: 'consultation', duration: 45, price: 20, maxAdvance: 365 })).body.data.id;
    const staffId = (await request(app).post('/api/staff').set(auth).send({
      name: 'Bea Backup', email: `bea-${RUN}@example.com`, serviceIds: [serviceId],
      workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }])),
    })).body.data.id;
    const customerId = (await request(app).post('/api/customers').set(auth).send({ name: 'Cal Customer', email: `cal-${RUN}@example.com` })).body.data.id;
    const d = new Date(); d.setDate(d.getDate() + 9);
    const appt = await request(app).post('/api/appointments').set(auth).send({ serviceId, staffId, customerId, date: d.toISOString().slice(0, 10), startTime: '10:00', internalNotes: 'restore me' });
    expect(appt.status).toBe(201);
    ref = appt.body.data.bookingRef;
  });

  it('takes a verified online backup with a manifest, then restores it to a separate database that matches record for record', async () => {
    const live = process.env.DB_PATH!;
    const backup = await backupDatabase(live, path.join(TMP, 'backups'), 'test');
    expect(fs.existsSync(backup.file)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(backup.manifest, 'utf8'));
    expect(manifest.sha256).toBe(backup.sha256);
    expect(manifest.summary.integrity).toBe('ok');
    expect(backup.summary.tables.appointments).toBeGreaterThan(0);
    expect(backup.summary.migrations).toEqual(MIGRATION_IDS);

    const target = path.join(TMP, 'restored.db');
    const restored = await restoreDatabase(backup.file, target);
    expect(restored.movedAside).toBeNull();
    expect(restored.summary.tables).toEqual(summarize(backup.file).tables);
    expect(restored.summary.triggers).toEqual(expect.arrayContaining(['trg_appointments_no_overlap_insert', 'trg_appointments_no_overlap_update']));

    const r = new Database(target, { readonly: true });
    try {
      const original = db.prepare('SELECT * FROM appointments WHERE booking_ref = ?').get(ref);
      expect(r.prepare('SELECT * FROM appointments WHERE booking_ref = ?').get(ref)).toEqual(original);
      expect(r.prepare('SELECT COUNT(*) AS c FROM users').get()).toEqual(db.prepare('SELECT COUNT(*) AS c FROM users').get());
    } finally { r.close(); }

    // Starting a server on the restored copy applies nothing new and changes nothing.
    const rw = new Database(target);
    try {
      const report = runMigrations(rw);
      expect(report.applied).toEqual([]);
      expect(report.skipped).toEqual([]);
    } finally { rw.close(); }
    expect(summarize(target).tables).toEqual(restored.summary.tables);
  });

  it('never overwrites an existing database unless forced, and then moves it aside instead of deleting it', async () => {
    const backup = await backupDatabase(process.env.DB_PATH!, path.join(TMP, 'backups'), 'second');
    const target = path.join(TMP, 'occupied.db');
    const occupied = freshDb('occupied.db');
    seed(occupied);
    occupied.close();
    const before = summarize(target);

    await expect(restoreDatabase(backup.file, target)).rejects.toThrow(/already exists/);
    expect(summarize(target)).toEqual(before);

    const result = await restoreDatabase(backup.file, target, { force: true });
    expect(result.movedAside).toMatch(/occupied\.db\.before-restore-/);
    expect(summarize(result.movedAside!)).toEqual(before); // the replaced database is intact
    expect(summarize(target).tables.appointments).toBe(backup.summary.tables.appointments);
  });

  it('refuses a damaged backup and leaves the target untouched', async () => {
    const bad = path.join(TMP, 'damaged.db');
    fs.writeFileSync(bad, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 7)]));
    const target = path.join(TMP, 'never-created.db');
    await expect(restoreDatabase(bad, target)).rejects.toThrow();
    expect(fs.existsSync(target)).toBe(false);
    await expect(restoreDatabase(path.join(TMP, 'missing.db'), target)).rejects.toThrow(/not found/);
  });
});

describe('migrations', () => {
  it('apply in order on a fresh database, record themselves, and are idempotent', () => {
    const d = freshDb('fresh.db');
    try {
      expect(migrationStatus(d).every(m => m.state === 'pending')).toBe(true);
      const first = runMigrations(d);
      expect(first.applied).toEqual(MIGRATION_IDS);
      expect(first.skipped).toEqual([]);
      const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(t => t.name);
      expect(tables).toEqual(expect.arrayContaining(['email_deliveries', 'user_sessions', 'staff_invitations', 'email_outbox']));
      expect((d.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(c => c.name)).toContain('staff_id');
      const again = runMigrations(d);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toEqual(MIGRATION_IDS);
      expect(migrationStatus(d).every(m => m.state === 'applied' && m.appliedAt)).toBe(true);
    } finally { d.close(); }
  });

  it('on an older database with conflicting data: skip and report, never change the data, apply once resolved', () => {
    const d = freshDb('legacy.db');
    try {
      seed(d);
      // Conflicts that block 001 and 003 in a database created before those rules existed.
      d.prepare("INSERT INTO staff (id, organization_id, name, email) VALUES ('st-2', 'org-t', 'Sam Two', 'SAM@example.com')").run();
      insertAppt(d, 'a1', '10:00', '11:00');
      insertAppt(d, 'a2', '10:30', '11:30');
      const before = { staff: d.prepare('SELECT * FROM staff ORDER BY id').all(), appts: d.prepare('SELECT * FROM appointments ORDER BY id').all() };

      const status = migrationStatus(d);
      expect(status.find(m => m.id === '001_staff_unique_email_per_org')).toMatchObject({ state: 'blocked' });
      expect(status.find(m => m.id === '003_appointment_overlap_guard')).toMatchObject({ state: 'blocked' });

      const report = runMigrations(d);
      expect(report.skipped.map(s => s.id)).toEqual(['001_staff_unique_email_per_org', '003_appointment_overlap_guard']);
      expect(report.skipped[0].reason).toMatch(/duplicate staff email/);
      expect(report.skipped[1].reason).toMatch(/overlapping appointment/);
      expect(report.applied).toEqual(MIGRATION_IDS.filter(id => !id.startsWith('001') && !id.startsWith('003')));
      expect({ staff: d.prepare('SELECT * FROM staff ORDER BY id').all(), appts: d.prepare('SELECT * FROM appointments ORDER BY id').all() }).toEqual(before);

      // The business fixes the records in the app; the next start applies the rest.
      d.prepare("UPDATE staff SET email = 'sam.two@example.com' WHERE id = 'st-2'").run();
      d.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = 'a2'").run();
      const later = runMigrations(d);
      expect(later.applied).toEqual(['001_staff_unique_email_per_org', '003_appointment_overlap_guard']);
      expect(later.skipped).toEqual([]);
    } finally { d.close(); }
  });

  it('a migration that hits a real error stops startup, keeps earlier migrations, and leaves nothing half-applied', () => {
    const d = freshDb('broken.db');
    try {
      // Something in the way of 006: a view with the outbox table's name cannot be indexed.
      d.exec('CREATE VIEW email_outbox AS SELECT 1 AS id');
      // The error names the migration, so the startup failure says what to look at.
      expect(() => runMigrations(d)).toThrow(/^Migration 006_email_outbox failed: views may not be indexed/);
      const recorded = (d.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
      expect(recorded).toEqual(MIGRATION_IDS.slice(0, 5));
      expect(d.prepare("SELECT type FROM sqlite_master WHERE name = 'email_outbox'").get()).toEqual({ type: 'view' });
      expect(d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_email_outbox_due'").get()).toBeUndefined();
      expect(migrationStatus(d).find(m => m.id === '006_email_outbox')?.state).toBe('pending');
      // Once the obstacle is removed, the next start applies it and the migrations after it.
      d.exec('DROP VIEW email_outbox');
      expect(runMigrations(d).applied).toEqual(MIGRATION_IDS.slice(5));
      expect(MIGRATION_IDS.slice(5)).toEqual(['006_email_outbox', '007_time_off_and_breaks', '008_account_tokens', '009_account_email_queue', '010_appointment_history', '011_two_factor', '012_media_files', '013_appointment_resources', '014_notification_settings', '015_payments', '016_integrations', '017_notification_platform']);
    } finally { d.close(); }
  });

  it('after migration the database itself refuses overlapping active appointments', () => {
    const d = freshDb('triggers.db');
    try {
      runMigrations(d);
      seed(d);
      insertAppt(d, 't1', '09:00', '10:00');
      expect(() => insertAppt(d, 't2', '09:30', '10:30')).toThrow('APPOINTMENT_OVERLAP');
      expect(() => insertAppt(d, 't3', '09:30', '10:30', 'cancelled')).not.toThrow();
      insertAppt(d, 't4', '10:00', '11:00'); // touching, not overlapping
      expect(() => d.prepare("UPDATE appointments SET start_time = '09:45' WHERE id = 't4'").run()).toThrow('APPOINTMENT_OVERLAP');
      expect(() => d.prepare("UPDATE appointments SET status = 'scheduled' WHERE id = 't3'").run()).toThrow('APPOINTMENT_OVERLAP');
    } finally { d.close(); }
  });
});

describe('concurrency across separate connections', () => {
  const WORKER = `
    const { parentPort, workerData } = require('worker_threads');
    const Database = require(workerData.driver);
    const d = new Database(workerData.file, { timeout: 15000 });
    d.pragma('foreign_keys = ON');
    const gate = new Int32Array(workerData.gate);
    Atomics.add(gate, 0, 1);
    while (Atomics.load(gate, 0) < workerData.total) { /* start together for maximum contention */ }
    try {
      const outcome = d.transaction(() => {
        if (workerData.precheck) {
          const clash = d.prepare("SELECT 1 FROM appointments WHERE staff_id = 'st-1' AND date = '2030-01-07' AND status NOT IN ('cancelled','no_show') AND start_time < '15:00' AND end_time > '14:00'").get();
          if (clash) return 'conflict';
        }
        d.prepare("INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration) VALUES (?, ?, 'org-t', 'sv-1', 'st-1', 'cu-1', 'scheduled', '2030-01-07', '14:00', '15:00', 60)")
          .run('w' + workerData.n, 'WE-W' + workerData.n);
        return 'booked';
      }).immediate();
      parentPort.postMessage(outcome);
    } catch (e) {
      parentPort.postMessage(String(e.message).includes('APPOINTMENT_OVERLAP') ? 'overlap' : 'error: ' + e.code + ' ' + e.message);
    } finally { d.close(); }
  `;

  async function race(file: string, total: number, precheck: boolean): Promise<string[]> {
    const gate = new SharedArrayBuffer(4);
    return Promise.all(Array.from({ length: total }, (_, n) => new Promise<string>((resolve, reject) => {
      const w = new Worker(WORKER, { eval: true, workerData: { file, total, n: `${precheck ? 'p' : 'r'}${n}`, gate, precheck, driver: require.resolve('better-sqlite3') } });
      w.once('message', resolve);
      w.once('error', reject);
    })));
  }

  it('eight connections booking the same slot at once: exactly one wins, the rest are refused, none error', async () => {
    const d = freshDb('race.db');
    runMigrations(d);
    seed(d);
    d.close();
    const file = path.join(TMP, 'race.db');
    const withCheck = await race(file, 8, true);
    expect(withCheck.filter(r => r === 'booked')).toHaveLength(1);
    expect(withCheck.every(r => r === 'booked' || r === 'conflict' || r === 'overlap')).toBe(true);
  });

  it('even without the application check, the database trigger lets only one through', async () => {
    const d = freshDb('race-raw.db');
    runMigrations(d);
    seed(d);
    d.close();
    const results = await race(path.join(TMP, 'race-raw.db'), 8, false);
    expect(results.filter(r => r === 'booked')).toHaveLength(1);
    expect(results.filter(r => r === 'overlap')).toHaveLength(7);
  });
});

describe('demo data seeding', () => {
  // The seed creates a demo business whose admin uses ADMIN_EMAIL/ADMIN_PASSWORD; it must never reach a live server.
  function seed(nodeEnv: string, dbFile: string) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/db/seed.ts'], {
      cwd: path.join(__dirname, '..', '..'),
      env: { ...process.env, NODE_ENV: nodeEnv, DB_PATH: dbFile, ADMIN_EMAIL: 'seed-admin@example.com', ADMIN_PASSWORD: 'SeedTest123!' },
      encoding: 'utf8',
      timeout: 60_000,
    });
  }

  it('refuses with NODE_ENV=production before opening the database', () => {
    const file = path.join(TMP, 'seed-production.db');
    const run = seed('production', file);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Refusing to create demo data with NODE_ENV=production.');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('still seeds a development database', () => {
    const file = path.join(TMP, 'seed-development.db');
    const run = seed('development', file);
    expect(run.status).toBe(0);
    const d = new Database(file, { readonly: true });
    try {
      expect(d.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'seed-admin@example.com'`).get()).toEqual({ n: 1 });
    } finally { d.close(); }
  });
});
