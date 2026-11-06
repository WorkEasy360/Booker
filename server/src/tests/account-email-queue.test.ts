// Account emails survive a restart (migration 009, account_email_queue): the table and its rules, queueing and
// claiming, retries on the schedule, the send deadline and the link's own expiry, the five ways a newer request or a
// used link cancels a queued email, recovery of interrupted sends, the 7-day cleanup, and what the queue and the
// logs may contain.
// Synthetic accounts only, in the isolated per-file test database; email goes to the in-memory test transport, and
// every retry is run with an explicit clock, so no test waits for a real retry delay.

import request from 'supertest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import app from '../index';
import db from '../db/init';
import { createSchema } from '../db/schema';
import { runMigrations } from '../db/migrations';
import {
  initEmail, testOutbox, accountEmailsSettled, processDueAccountEmails, claimAccountEmail, pruneAccountEmailQueue,
  startEmailWorker, stopEmailWorker, ACCOUNT_EMAIL_MAX_AGE_MS, PASSWORD_CHANGED_MAX_AGE_MS, ACCOUNT_QUEUE_RETENTION_MS,
  STALE_SENDING_MS, FINISHED_ACCOUNT_EMAIL_STATUSES,
} from '../services/email/notify';
import { requestPasswordReset, VERIFY_TTL_MS, RESET_TTL_MS } from '../services/account-tokens';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `we360-acctq-${RUN}-`));
// Default retry delays (1, 5 and 15 minutes), as in production.
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv;
const PASSWORD = 'StartPass123';
const MINUTE = 60_000;
let seq = 0;
const address = (label: string) => `queue-${label}-${++seq}-${RUN}@example.com`;

const post = (p: string, body: unknown) => request(app).post(`/api/auth${p}`).send(body as object);
const signup = (email: string) => post('/signup', { name: 'Quinn Queue', email, company: `Queue Co ${RUN}`, password: PASSWORD, confirmPassword: PASSWORD });
const resend = (email: string) => post('/verify-email/resend', { email });
const forgot = (email: string) => post('/password/forgot', { email });

interface QueueRow {
  id: string; kind: string; user_id: string | null; signup_request_id: string | null; password_reset_id: string | null;
  status: string; attempts: number; next_attempt_at: string | null; expires_at: string; changed_at: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}
/** Queue rows for an address, oldest first (through the account or the sign-up request: the queue holds no address). */
const rowsFor = (email: string): QueueRow[] => db.prepare(
  `SELECT q.* FROM account_email_queue q
     LEFT JOIN users u ON u.id = q.user_id
     LEFT JOIN signup_requests s ON s.id = q.signup_request_id
    WHERE u.email = ? OR s.email = ? ORDER BY q.created_at, q.rowid`
).all(email, email) as QueueRow[];
const rowById = (id: string) => db.prepare('SELECT * FROM account_email_queue WHERE id = ?').get(id) as QueueRow;
const ms = (iso: string | null) => Date.parse(iso!);

async function mailsTo(email: string) {
  await accountEmailsSettled();
  return testOutbox.messages.filter(m => m.to === email);
}
function linkIn(text: string, page: 'reset-password' | 'verify-email'): string | null {
  const m = new RegExp(`/${page}#token=([A-Za-z0-9_%-]+)`).exec(text);
  return m ? decodeURIComponent(m[1]) : null;
}
async function linksTo(email: string, page: 'reset-password' | 'verify-email'): Promise<string[]> {
  return (await mailsTo(email)).map(m => linkIn(m.text, page)).filter((t): t is string => !!t);
}

async function account(label: string) {
  const email = address(label);
  const res = await signUpAndSignIn(app, { name: `Owner ${label}`, email, company: `Queue ${label} ${RUN}`, password: PASSWORD });
  expect(res.status).toBe(200);
  await accountEmailsSettled();
  testOutbox.clear();
  lines = [];
  return { email, token: sessionToken(res), userId: res.body.data.user.id as string };
}

/** A request whose first attempt fails temporarily: its row is pending, with the first retry due. */
async function pendingAfterFailure(send: () => Promise<unknown>, email: string): Promise<QueueRow> {
  testOutbox.failNextSends(1, 'transient');
  await send();
  await accountEmailsSettled();
  const row = rowsFor(email).at(-1)!;
  expect(row).toMatchObject({ status: 'pending', attempts: 1 });
  return row;
}

// Every account-email log line of the whole file, to check they are fixed and private (see the last tests).
const allLines: string[] = [];
let lines: string[] = [];
let spies: jest.SpyInstance[] = [];
const accountLines = () => lines.filter(l => l.startsWith('[email] account'));

beforeAll(() => initEmail(MEMORY_ENV));
beforeEach(() => {
  testOutbox.clear();
  lines = [];
  const capture = (...args: unknown[]) => { const l = args.map(String).join(' '); lines.push(l); if (l.startsWith('[email] account')) allLines.push(l); };
  spies = [jest.spyOn(console, 'log').mockImplementation(capture), jest.spyOn(console, 'warn').mockImplementation(capture)];
});
afterEach(async () => {
  await accountEmailsSettled();
  spies.forEach(s => s.mockRestore());
  initEmail(MEMORY_ENV);
});
afterAll(() => {
  stopEmailWorker();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ }
});

// ─── The table ───────────────────────────────────────────────────────────────

describe('migration 009', () => {
  function migrated(name: string): Database.Database {
    const d = new Database(path.join(TMP, name));
    d.pragma('foreign_keys = ON');
    createSchema(d);
    runMigrations(d);
    return d;
  }

  it('creates the queue table and its indexes, and a second run changes nothing', () => {
    const d = migrated('fresh.db');
    try {
      const columns = (d.prepare('PRAGMA table_info(account_email_queue)').all() as Array<{ name: string }>).map(c => c.name);
      expect(columns).toEqual(['id', 'kind', 'user_id', 'signup_request_id', 'password_reset_id', 'status', 'attempts',
        'next_attempt_at', 'expires_at', 'changed_at', 'last_error', 'created_at', 'updated_at']);
      const indexes = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'account_email_queue' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(i => i.name);
      expect(indexes).toEqual(['idx_account_email_queue_due', 'idx_account_email_queue_reset', 'idx_account_email_queue_signup']);
      const fks = d.prepare('PRAGMA foreign_key_list(account_email_queue)').all() as Array<{ table: string; from: string; on_delete: string }>;
      expect(fks.map(f => [f.from, f.table, f.on_delete]).sort()).toEqual([
        ['password_reset_id', 'password_resets', 'CASCADE'], ['signup_request_id', 'signup_requests', 'CASCADE'], ['user_id', 'users', 'CASCADE'],
      ]);
      const again = runMigrations(d);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toContain('009_account_email_queue');
      expect(d.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(d.pragma('foreign_key_check')).toEqual([]);
    } finally { d.close(); }
  });

  it('refuses rows that break its rules', () => {
    const d = migrated('rules.db');
    try {
      d.prepare("INSERT INTO organizations (id, name, email) VALUES ('org-q', 'Q', 'org-q@example.com')").run();
      d.prepare("INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES ('user-q', 'org-q', 'q@example.com', 'x', 'Q', 'admin')").run();
      d.prepare("INSERT INTO signup_requests (id, email, name, company, password_hash, token_hash, created_at, expires_at) VALUES ('signup-q', 'n@example.com', 'N', 'C', 'x', 'h1', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
      const insert = (kind: string, ref: { user?: string; signup?: string; reset?: string }, status = 'pending', expires = '2026-01-01T01:00:00.000Z') => () => d.prepare(
        `INSERT INTO account_email_queue (id, kind, user_id, signup_request_id, password_reset_id, status, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`
      ).run(`acct-${Math.random()}`, kind, ref.user ?? null, ref.signup ?? null, ref.reset ?? null, status, expires);
      expect(insert('existing_account', { user: 'user-q' })).not.toThrow();
      expect(insert('verify', { signup: 'signup-q' })).not.toThrow();
      expect(insert('newsletter', { user: 'user-q' })).toThrow(/CHECK/);
      expect(insert('existing_account', { user: 'user-q' }, 'queued')).toThrow(/CHECK/);
      expect(insert('verify', { user: 'user-q' })).toThrow(/CHECK/);                     // a confirmation needs its request
      expect(insert('password_reset', { user: 'user-q' })).toThrow(/CHECK/);             // a reset email needs its link
      expect(insert('password_changed', { user: 'user-q', signup: 'signup-q' })).toThrow(/CHECK/);
      expect(insert('existing_account', { user: 'user-q' }, 'pending', '2026-01-01T00:00:00.000Z')).toThrow(/CHECK/); // deadline after creation
      expect(insert('existing_account', { user: 'user-missing' })).toThrow(/FOREIGN KEY/);
      expect(insert('verify', { signup: 'signup-q' })).toThrow(/UNIQUE/);                // one queue row per request
    } finally { d.close(); }
  });

  it('deleting an account, a sign-up request or a reset link deletes its queued emails (ON DELETE CASCADE)', () => {
    const d = migrated('cascade.db');
    try {
      d.prepare("INSERT INTO organizations (id, name, email) VALUES ('org-c', 'C', 'org-c@example.com')").run();
      for (const u of ['user-a', 'user-b']) d.prepare("INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, 'org-c', ?, 'x', 'C', 'admin')").run(u, `${u}@example.com`);
      d.prepare("INSERT INTO signup_requests (id, email, name, company, password_hash, token_hash, created_at, expires_at) VALUES ('signup-c', 'c@example.com', 'C', 'C', 'x', 'h2', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')").run();
      d.prepare("INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES ('reset-c', 'user-b', 'h3', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z')").run();
      const q = d.prepare(`INSERT INTO account_email_queue (id, kind, user_id, signup_request_id, password_reset_id, status, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', '2026-01-01T01:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
      q.run('acct-1', 'existing_account', 'user-a', null, null);
      q.run('acct-2', 'password_changed', 'user-a', null, null);
      q.run('acct-3', 'verify', null, 'signup-c', null);
      q.run('acct-4', 'password_reset', null, null, 'reset-c');
      const ids = () => (d.prepare('SELECT id FROM account_email_queue ORDER BY id').all() as Array<{ id: string }>).map(r => r.id);
      d.prepare("DELETE FROM users WHERE id = 'user-a'").run();
      expect(ids()).toEqual(['acct-3', 'acct-4']);
      d.prepare("DELETE FROM signup_requests WHERE id = 'signup-c'").run();
      expect(ids()).toEqual(['acct-4']);
      d.prepare("DELETE FROM password_resets WHERE id = 'reset-c'").run();
      expect(ids()).toEqual([]);
    } finally { d.close(); }
  });
});

// ─── Queueing and claiming ───────────────────────────────────────────────────

describe('queueing and claiming', () => {
  it('each request records one row, with a deadline of one hour that never outlives the link', async () => {
    const a = await account('one-row');
    await forgot(a.email);
    const newcomer = address('one-row-new');
    await signup(newcomer);
    await signup(a.email); // a registered address: the account-information email
    await accountEmailsSettled();

    const [reset, existing] = rowsFor(a.email).slice(-2);
    expect(reset).toMatchObject({ kind: 'password_reset', status: 'sent', attempts: 1, user_id: a.userId, signup_request_id: null, next_attempt_at: null, last_error: null });
    const link = db.prepare('SELECT created_at, expires_at FROM password_resets WHERE id = ?').get(reset.password_reset_id) as { created_at: string; expires_at: string };
    expect(ms(reset.expires_at) - ms(reset.created_at)).toBe(Math.min(ACCOUNT_EMAIL_MAX_AGE_MS, RESET_TTL_MS));
    expect(ms(reset.expires_at)).toBeLessThanOrEqual(ms(link.expires_at));
    expect(existing).toMatchObject({ kind: 'existing_account', status: 'sent', user_id: a.userId, signup_request_id: null, password_reset_id: null });

    const [verify] = rowsFor(newcomer);
    expect(verify).toMatchObject({ kind: 'verify', status: 'sent', attempts: 1, user_id: null, password_reset_id: null });
    const request = db.prepare('SELECT created_at, expires_at FROM signup_requests WHERE id = ?').get(verify.signup_request_id) as { created_at: string; expires_at: string };
    expect(ms(request.expires_at) - ms(request.created_at)).toBe(VERIFY_TTL_MS);       // the link: 24 hours
    expect(ms(verify.expires_at) - ms(verify.created_at)).toBe(ACCOUNT_EMAIL_MAX_AGE_MS); // the email: 1 hour
    expect(await mailsTo(newcomer)).toHaveLength(1);
  });

  it('the first attempt is never claimable: no worker can start it a second time, however late it runs', async () => {
    const a = await account('first-claim');
    requestPasswordReset(a.email); // the first attempt is now running in this process
    const row = rowsFor(a.email).at(-1)!;
    expect(row).toMatchObject({ status: 'sending', attempts: 1 });
    expect(claimAccountEmail(row.id, Date.now() + 10 * MINUTE)).toBe(false);
    const run = await processDueAccountEmails(Date.now() + 10 * MINUTE); // past the interrupted-send threshold too
    expect(run.attempted).toBe(0);
    await accountEmailsSettled();
    expect(rowById(row.id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await linksTo(a.email, 'reset-password')).toHaveLength(1);
    expect((await processDueAccountEmails(Date.now() + 30 * MINUTE)).attempted).toBe(0);
  });

  it('a due retry is claimed by exactly one of several workers running at once', async () => {
    const a = await account('one-worker');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    const due = ms(row.next_attempt_at);
    const runs = await Promise.all([processDueAccountEmails(due), processDueAccountEmails(due), processDueAccountEmails(due)]);
    expect(runs.map(r => r.attempted).reduce((x, y) => x + y)).toBe(1);
    expect(await linksTo(a.email, 'reset-password')).toHaveLength(1);
    expect(rowById(row.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(claimAccountEmail(row.id, due)).toBe(false); // a finished row can never be claimed again
  });

  it('a row claimed by another server process is left to it; if that process stops, the row is retried once after five minutes', async () => {
    const a = await account('other-process');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    const due = ms(row.next_attempt_at);
    const other = new Database(db.name, { timeout: 5_000 });
    try {
      // The other process claims it with the same conditional update, then stops before finishing.
      const claimed = other.prepare(
        `UPDATE account_email_queue SET status = 'sending', attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND expires_at > ?`
      ).run(new Date(due).toISOString(), row.id, new Date(due).toISOString(), new Date(due).toISOString()).changes;
      expect(claimed).toBe(1);
    } finally { other.close(); }
    expect(claimAccountEmail(row.id, due)).toBe(false); // still looks due, but it is claimed
    expect((await processDueAccountEmails(due)).attempted).toBe(0);
    expect((await processDueAccountEmails(due + STALE_SENDING_MS - 1)).attempted).toBe(0); // it may still be sending
    expect(await mailsTo(a.email)).toHaveLength(0);
    const later = await processDueAccountEmails(due + STALE_SENDING_MS);
    expect(later).toMatchObject({ attempted: 1, sent: 1 });
    expect(rowById(row.id)).toMatchObject({ status: 'sent', attempts: 3 });
    expect(await linksTo(a.email, 'reset-password')).toHaveLength(1);
  });
});

// ─── Retries, the deadline and the link's expiry ─────────────────────────────

describe('retries, deadlines and link expiry', () => {
  it('a temporary failure is retried on the configured schedule with a new link, and the email then arrives once', async () => {
    const a = await account('schedule');
    testOutbox.failNextSends(2, 'transient');
    await forgot(a.email);
    await accountEmailsSettled();
    const row = rowsFor(a.email).at(-1)!;
    const originalLink = db.prepare('SELECT * FROM password_resets WHERE id = ?').get(row.password_reset_id) as { id: string; expires_at: string };
    const first = ms(row.next_attempt_at);
    expect(first - ms(row.updated_at)).toBe(1 * MINUTE);

    expect((await processDueAccountEmails(first - 1)).attempted).toBe(0); // not due yet
    expect(await processDueAccountEmails(first)).toMatchObject({ attempted: 1, retrying: 1 });
    const second = ms(rowById(row.id).next_attempt_at);
    expect(second - first).toBe(5 * MINUTE);
    expect(await processDueAccountEmails(second)).toMatchObject({ attempted: 1, sent: 1 });
    expect(accountLines()).toEqual([
      expect.stringMatching(/^\[email\] account password_reset: attempt 1 failed via memory, retrying in 60s: /),
      expect.stringMatching(/^\[email\] account password_reset: attempt 2 failed via memory, retrying in 300s: /),
      '[email] account password_reset: sent via memory (attempt 3)',
    ]);
    const [token] = await linksTo(a.email, 'reset-password');
    expect(token).toBeDefined();
    // The retry carried a new link with the original expiry; the first link (never delivered) no longer works.
    const now = rowById(row.id);
    expect(now.password_reset_id).not.toBe(originalLink.id);
    const fresh = db.prepare('SELECT * FROM password_resets WHERE id = ?').get(now.password_reset_id) as { expires_at: string };
    expect(fresh.expires_at).toBe(originalLink.expires_at);
    expect(db.prepare('SELECT superseded_at FROM password_resets WHERE id = ?').get(originalLink.id)).toEqual({ superseded_at: expect.any(String) });
    expect((await post('/password/reset/inspect', { token })).body.data.expiresAt).toBe(originalLink.expires_at);

    expect((await processDueAccountEmails(second + 60 * MINUTE)).attempted).toBe(0); // nothing after a success
    expect(await mailsTo(a.email)).toHaveLength(1);
  });

  it('retries stop after the last delay: FAILED after four attempts, nothing delivered, nothing more tried', async () => {
    const a = await account('limit');
    testOutbox.failNextSends(10, 'transient');
    await forgot(a.email);
    await accountEmailsSettled();
    const row = rowsFor(a.email).at(-1)!;
    for (let i = 0; i < 3; i++) await processDueAccountEmails(ms(rowById(row.id).next_attempt_at));
    expect(rowById(row.id)).toMatchObject({ status: 'failed', attempts: 4, next_attempt_at: null });
    expect(accountLines().filter(l => /retrying in/.test(l))).toHaveLength(3);
    expect(accountLines().at(-1)).toMatch(/^\[email\] account password_reset: FAILED via memory after 4 attempt\(s\): /);
    expect((await processDueAccountEmails(Date.now() + 50 * MINUTE)).attempted).toBe(0);
    expect(await mailsTo(a.email)).toHaveLength(0);
    testOutbox.clear();
  });

  it('a permanent failure is not retried; asking again sends a new link', async () => {
    const a = await account('permanent');
    testOutbox.failNextSends(1, 'permanent');
    await forgot(a.email);
    await accountEmailsSettled();
    const row = rowsFor(a.email).at(-1)!;
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await processDueAccountEmails(Date.now() + 30 * MINUTE)).attempted).toBe(0);
    await forgot(a.email);
    expect(await linksTo(a.email, 'reset-password')).toHaveLength(1);
  });

  it('a link that has reached its expiry is never sent, even when its email is still within the hour', async () => {
    const a = await account('link-expired');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    const due = ms(row.next_attempt_at);
    // The link expires exactly when the retry runs (the exact moment counts as expired); the email's deadline is later.
    db.prepare('UPDATE password_resets SET expires_at = ? WHERE id = ?').run(row.next_attempt_at, row.password_reset_id);
    expect(ms(row.expires_at)).toBeGreaterThan(due);
    expect(await processDueAccountEmails(due)).toMatchObject({ attempted: 1, expired: 1, sent: 0 });
    expect(rowById(row.id).status).toBe('expired');
    expect(accountLines().at(-1)).toBe('[email] account password_reset: EXPIRED, not sent (the link expired)');
    expect(await mailsTo(a.email)).toHaveLength(0);
  });

  it('the one-hour limit: at the deadline exactly nothing is sent, and a retry is scheduled only if it falls before it', async () => {
    initEmail({ ...MEMORY_ENV, EMAIL_RETRY_DELAYS_MS: '1800000,1800000,1800000' }); // 30 minutes
    const late = address('hour-late');
    const row = await pendingAfterFailure(() => signup(late), late);
    const deadline = ms(row.expires_at);
    expect(deadline - ms(row.created_at)).toBe(ACCOUNT_EMAIL_MAX_AGE_MS);
    // Attempt 2 runs exactly 30 minutes before the deadline and fails: attempt 3 would fall on the deadline, so none is scheduled.
    db.prepare('UPDATE account_email_queue SET next_attempt_at = ? WHERE id = ?').run(new Date(deadline - 30 * MINUTE).toISOString(), row.id);
    testOutbox.failNextSends(1, 'transient');
    expect(await processDueAccountEmails(deadline - 30 * MINUTE)).toMatchObject({ attempted: 1, expired: 1 });
    expect(rowById(row.id)).toMatchObject({ status: 'expired', attempts: 2 });
    expect(accountLines().at(-1)).toMatch(/^\[email\] account verify: EXPIRED after attempt 2 failed via memory: no retry fits before its age limit; not sent: /);

    // One millisecond earlier, the retry still fits.
    const early = address('hour-early');
    const other = await pendingAfterFailure(() => signup(early), early);
    const otherDeadline = ms(other.expires_at);
    db.prepare('UPDATE account_email_queue SET next_attempt_at = ? WHERE id = ?').run(new Date(otherDeadline - 30 * MINUTE - 1).toISOString(), other.id);
    testOutbox.failNextSends(1, 'transient');
    expect(await processDueAccountEmails(otherDeadline - 30 * MINUTE - 1)).toMatchObject({ attempted: 1, retrying: 1 });
    expect(ms(rowById(other.id).next_attempt_at)).toBe(otherDeadline - 1);
    // A pending row is never sent at its deadline; one millisecond before it, it is (the 24-hour link is still valid).
    expect(await processDueAccountEmails(otherDeadline)).toMatchObject({ attempted: 0, expired: 1 });
    expect(rowById(other.id).status).toBe('expired');
    expect(await mailsTo(early)).toHaveLength(0);

    const inTime = address('hour-in-time');
    const third = await pendingAfterFailure(() => signup(inTime), inTime);
    db.prepare('UPDATE account_email_queue SET next_attempt_at = ? WHERE id = ?').run(new Date(ms(third.expires_at) - 1).toISOString(), third.id);
    expect(await processDueAccountEmails(ms(third.expires_at) - 1)).toMatchObject({ attempted: 1, sent: 1 });
    const [token] = await linksTo(inTime, 'verify-email');
    expect((await post('/verify-email/inspect', { token })).status).toBe(200);
  });

  it('the password-changed notice may be retried for up to 24 hours; no other email ever gets more than one hour', async () => {
    const a = await account('changed');
    await forgot(a.email);
    const [token] = await linksTo(a.email, 'reset-password');
    testOutbox.clear();
    testOutbox.failNextSends(1, 'transient');
    expect((await post('/password/reset', { token, password: 'Fresh0Pass', confirmPassword: 'Fresh0Pass' })).status).toBe(200);
    await accountEmailsSettled();
    const notice = rowsFor(a.email).find(r => r.kind === 'password_changed')!;
    expect(notice).toMatchObject({ status: 'pending', user_id: a.userId, changed_at: expect.any(String) });
    expect(ms(notice.expires_at) - ms(notice.created_at)).toBe(PASSWORD_CHANGED_MAX_AGE_MS);

    // Delivered two hours later (the worker was down): no action link, and the original time of the change.
    db.prepare('UPDATE account_email_queue SET next_attempt_at = ? WHERE id = ?').run(new Date(ms(notice.created_at) + 2 * 60 * MINUTE).toISOString(), notice.id);
    expect(await processDueAccountEmails(ms(notice.created_at) + 2 * 60 * MINUTE)).toMatchObject({ sent: 1 });
    const [mail] = await mailsTo(a.email);
    expect(mail.subject).toMatch(/password was changed/);
    expect(mail.text).not.toMatch(/#token=/);
    expect(mail.text).toContain(new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(notice.changed_at!)));

    // A second notice, still failing at the 24-hour mark: never sent.
    await forgot(a.email);
    const [second] = await linksTo(a.email, 'reset-password');
    testOutbox.failNextSends(1, 'transient');
    await post('/password/reset', { token: second, password: 'Fresh1Pass', confirmPassword: 'Fresh1Pass' });
    await accountEmailsSettled();
    const again = rowsFor(a.email).filter(r => r.kind === 'password_changed').at(-1)!;
    db.prepare('UPDATE account_email_queue SET next_attempt_at = ? WHERE id = ?').run(new Date(ms(again.expires_at) - MINUTE).toISOString(), again.id);
    expect(await processDueAccountEmails(ms(again.expires_at))).toMatchObject({ attempted: 0, expired: 1 });

    // The exception is for this notice only.
    const longest = db.prepare(
      `SELECT MAX((julianday(expires_at) - julianday(created_at)) * 86400000) AS ms FROM account_email_queue WHERE kind != 'password_changed'`
    ).get() as { ms: number };
    expect(Math.round(longest.ms)).toBeLessThanOrEqual(ACCOUNT_EMAIL_MAX_AGE_MS);
  });
});

// ─── The five ways an email is cancelled ─────────────────────────────────────

describe('a newer request or a used link cancels the queued email', () => {
  const expectCancelled = async (row: QueueRow) => {
    expect(rowById(row.id)).toMatchObject({ status: 'superseded', last_error: 'Not sent: the link was replaced or used, or is no longer valid' });
    expect(lines).toContain(`[email] account ${row.kind}: superseded, not sent (the link was replaced or used, or is no longer valid)`);
    expect((await processDueAccountEmails(ms(row.next_attempt_at) + 30 * MINUTE)).attempted).toBe(0);
  };

  it('1. a new sign-up for the same address replaces the earlier confirmation request', async () => {
    const email = address('path-signup');
    const row = await pendingAfterFailure(() => signup(email), email);
    await signup(email);
    await expectCancelled(row);
    const tokens = await linksTo(email, 'verify-email');
    expect(tokens).toHaveLength(1); // only the newer request's email
    expect((await post('/verify-email/inspect', { token: tokens[0] })).status).toBe(200);
  });

  it('2. "Send a new link" replaces it', async () => {
    const email = address('path-resend');
    await signup(email);
    testOutbox.clear();
    const row = await pendingAfterFailure(() => resend(email), email);
    expect(row.kind).toBe('verify_again');
    await resend(email);
    await expectCancelled(row);
    const tokens = await linksTo(email, 'verify-email');
    expect(tokens).toHaveLength(1);
    expect((await post('/verify-email', { token: tokens[0] })).status).toBe(201);
  });

  it('3. a new password-reset request replaces it', async () => {
    const a = await account('path-reset');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    await forgot(a.email);
    await expectCancelled(row);
    const tokens = await linksTo(a.email, 'reset-password');
    expect(tokens).toHaveLength(1);
    expect((await post('/password/reset/inspect', { token: tokens[0] })).status).toBe(200);
  });

  it('4. a password change in Settings cancels it', async () => {
    const a = await account('path-settings');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    const res = await request(app).put('/api/auth/password').set({ Authorization: `Bearer ${a.token}` }).send({ currentPassword: PASSWORD, newPassword: 'Settings0Pass' });
    expect(res.status).toBe(200);
    await expectCancelled(row);
    expect(await mailsTo(a.email)).toHaveLength(0);
  });

  it('5. a completed password reset cancels a pending retry of its own email', async () => {
    const a = await account('path-complete');
    await forgot(a.email);
    const [token] = await linksTo(a.email, 'reset-password');
    const row = rowsFor(a.email).at(-1)!;
    // The email arrived, but its outcome was not recorded (the process stopped): a retry is pending.
    db.prepare("UPDATE account_email_queue SET status = 'pending', next_attempt_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    testOutbox.clear();
    expect((await post('/password/reset', { token, password: 'Fresh0Pass', confirmPassword: 'Fresh0Pass' })).status).toBe(200);
    await expectCancelled({ ...row, next_attempt_at: new Date().toISOString() });
    const mails = await mailsTo(a.email);
    expect(mails.map(m => m.subject)).toEqual([expect.stringMatching(/password was changed/)]); // the notice only
  });

  it('using the confirmation link cancels a pending retry of its email too', async () => {
    const email = address('path-verified');
    await signup(email);
    const [token] = await linksTo(email, 'verify-email');
    const [row] = rowsFor(email);
    db.prepare("UPDATE account_email_queue SET status = 'pending', next_attempt_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    testOutbox.clear();
    expect((await post('/verify-email', { token })).status).toBe(201);
    await expectCancelled({ ...row, next_attempt_at: new Date().toISOString() });
    expect(await mailsTo(email)).toHaveLength(0);
  });

  it('a retry checks the link itself as well: a used or replaced link is never sent, even if its row was not cancelled', async () => {
    const a = await account('path-direct');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.password_reset_id);
    expect(await processDueAccountEmails(ms(row.next_attempt_at))).toMatchObject({ attempted: 1, superseded: 1 });

    const email = address('path-direct-signup');
    const other = await pendingAfterFailure(() => signup(email), email);
    db.prepare('UPDATE signup_requests SET superseded_at = ? WHERE id = ?').run(new Date().toISOString(), other.signup_request_id);
    expect(await processDueAccountEmails(ms(other.next_attempt_at))).toMatchObject({ attempted: 1, superseded: 1 });
    expect(await mailsTo(a.email)).toHaveLength(0);
    expect(await mailsTo(email)).toHaveLength(0);

    // An account that can no longer sign in gets no reset link.
    const b = await account('path-inactive');
    const third = await pendingAfterFailure(() => forgot(b.email), b.email);
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(b.userId);
    expect(await processDueAccountEmails(ms(third.next_attempt_at))).toMatchObject({ attempted: 1, superseded: 1 });
    expect(await mailsTo(b.email)).toHaveLength(0);
  });
});

// ─── Interrupted sends ───────────────────────────────────────────────────────

describe('interrupted sends', () => {
  it('an attempt interrupted by a stop is retried after five minutes with a new link; the earlier link then says a newer one was sent', async () => {
    const a = await account('interrupted');
    await forgot(a.email);
    const [first] = await linksTo(a.email, 'reset-password');
    const row = rowsFor(a.email).at(-1)!;
    // The process stopped after handing the email over but before recording it: the row is still "sending".
    db.prepare("UPDATE account_email_queue SET status = 'sending' WHERE id = ?").run(row.id);
    const stoppedAt = ms(row.updated_at);
    lines = [];

    expect((await processDueAccountEmails(stoppedAt + STALE_SENDING_MS - 1)).attempted).toBe(0);
    expect(await processDueAccountEmails(stoppedAt + STALE_SENDING_MS)).toMatchObject({ attempted: 1, sent: 1 });
    expect(accountLines()).toEqual([
      '[email] account password_reset: an interrupted attempt was found; it will be retried with a new link',
      '[email] account password_reset: sent via memory (attempt 2)',
    ]);
    const tokens = await linksTo(a.email, 'reset-password');
    expect(tokens).toHaveLength(2); // the documented duplicate
    expect(tokens[1]).not.toBe(first);
    expect((await post('/password/reset/inspect', { token: first })).body.code).toBe('RESET_REPLACED');
    expect((await post('/password/reset/inspect', { token: tokens[1] })).status).toBe(200);
    expect(rowById(row.id)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('an interrupted notice without a link is sent again as it was', async () => {
    const a = await account('interrupted-existing');
    await signup(a.email);
    await accountEmailsSettled();
    const row = rowsFor(a.email).at(-1)!;
    expect(row.kind).toBe('existing_account');
    db.prepare("UPDATE account_email_queue SET status = 'sending' WHERE id = ?").run(row.id);
    testOutbox.clear();
    lines = [];
    expect(await processDueAccountEmails(ms(row.updated_at) + STALE_SENDING_MS)).toMatchObject({ attempted: 1, sent: 1 });
    expect(accountLines()).toEqual([
      '[email] account existing_account: an interrupted attempt was found; it will be retried',
      '[email] account existing_account: sent via memory (attempt 2)',
    ]);
    const mails = await mailsTo(a.email);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).not.toMatch(/#token=/);
  });
});

// ─── Cleanup and the running worker ──────────────────────────────────────────

describe('cleanup', () => {
  it('finished rows (sent, failed, superseded, expired) are deleted seven days after their last change; pending and sending rows never are', async () => {
    const a = await account('cleanup');
    expect(FINISHED_ACCOUNT_EMAIL_STATUSES).toEqual(['sent', 'failed', 'superseded', 'expired']);
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    const insert = db.prepare(
      `INSERT INTO account_email_queue (id, kind, user_id, status, attempts, next_attempt_at, expires_at, created_at, updated_at)
       VALUES (?, 'existing_account', ?, ?, 1, NULL, ?, ?, ?)`
    );
    const add = (id: string, status: string, updated: number) => insert.run(`acct-${RUN}-${id}`, a.userId, status, iso(updated + 1), iso(updated - MINUTE), iso(updated));
    const old = now - ACCOUNT_QUEUE_RETENTION_MS - 1;
    for (const s of FINISHED_ACCOUNT_EMAIL_STATUSES) add(`old-${s}`, s, old);
    add('boundary-sent', 'sent', now - ACCOUNT_QUEUE_RETENTION_MS); // exactly seven days: kept until it is older
    add('recent-sent', 'sent', now - MINUTE);
    add('old-pending', 'pending', now - 30 * 24 * 60 * MINUTE);
    add('old-sending', 'sending', now - 30 * 24 * 60 * MINUTE);
    const ours = () => (db.prepare('SELECT id FROM account_email_queue WHERE id LIKE ? ORDER BY id').all(`acct-${RUN}-%`) as Array<{ id: string }>).map(r => r.id.slice(`acct-${RUN}-`.length));

    expect(pruneAccountEmailQueue(now)).toBeGreaterThanOrEqual(4);
    expect(ours()).toEqual(['boundary-sent', 'old-pending', 'old-sending', 'recent-sent']);
    expect(lines).toContainEqual(expect.stringMatching(/^\[email\] account queue: removed \d+ finished row\(s\) older than 7 days$/));
    expect(pruneAccountEmailQueue(now + 1)).toBeGreaterThanOrEqual(1);
    expect(ours()).toEqual(['old-pending', 'old-sending', 'recent-sent']);
    db.prepare('DELETE FROM account_email_queue WHERE id LIKE ?').run(`acct-${RUN}-%`);
  });

  it('the running server’s worker retries queued account emails and cleans up', async () => {
    const a = await account('worker');
    const row = await pendingAfterFailure(() => forgot(a.email), a.email);
    db.prepare('UPDATE account_email_queue SET next_attempt_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    const old = new Date(Date.now() - ACCOUNT_QUEUE_RETENTION_MS - MINUTE).toISOString();
    db.prepare(`INSERT INTO account_email_queue (id, kind, user_id, status, expires_at, created_at, updated_at) VALUES (?, 'existing_account', ?, 'sent', ?, ?, ?)`)
      .run(`acct-${RUN}-worker-old`, a.userId, old, new Date(Date.parse(old) - MINUTE).toISOString(), old);
    startEmailWorker(25);
    try {
      for (let i = 0; i < 80 && rowById(row.id).status !== 'sent'; i++) await new Promise(r => setTimeout(r, 25));
      for (let i = 0; i < 80 && db.prepare('SELECT 1 FROM account_email_queue WHERE id = ?').get(`acct-${RUN}-worker-old`); i++) await new Promise(r => setTimeout(r, 25));
    } finally { stopEmailWorker(); }
    expect(rowById(row.id)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(await linksTo(a.email, 'reset-password')).toHaveLength(1);
    expect(db.prepare('SELECT 1 FROM account_email_queue WHERE id = ?').get(`acct-${RUN}-worker-old`)).toBeUndefined();
  });
});

// ─── Privacy and existing behaviour ──────────────────────────────────────────

describe('privacy and existing behaviour', () => {
  it('the queue never holds a token, link, message or address, and failures are stored without the address', async () => {
    const a = await account('privacy');
    await pendingAfterFailure(() => forgot(a.email), a.email);
    const sentTokens = testOutbox.messages.flatMap(m => [linkIn(m.text, 'reset-password'), linkIn(m.text, 'verify-email')]).filter(Boolean) as string[];
    const rows = db.prepare('SELECT * FROM account_email_queue').all() as QueueRow[];
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) {
      const text = JSON.stringify(row);
      expect(text).not.toMatch(/@|https?:|#token=|example\.com/);
      for (const t of sentTokens) expect(text).not.toContain(t);
    }
    expect(rows.filter(r => r.last_error && /Simulated transient delivery failure for \[email\]/.test(r.last_error)).length).toBeGreaterThan(0);
  });

  it('with email turned off, the requests answer as before and nothing is queued', async () => {
    const a = await account('disabled');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM account_email_queue').get() as { n: number }).n;
    initEmail({ EMAIL_TRANSPORT: 'disabled' } as NodeJS.ProcessEnv);
    for (const res of [await forgot(a.email), await signup(address('disabled-new')), await resend(a.email)]) expect(res.status).toBe(503);
    expect((db.prepare('SELECT COUNT(*) AS n FROM account_email_queue').get() as { n: number }).n).toBe(before);
  });

  it('every account-email log line is one of the fixed messages: the kind and outcome only, never an address, link or token', () => {
    expect(allLines.length).toBeGreaterThan(30);
    const kind = '(verify|verify_again|existing_account|password_reset|password_changed)';
    const fixed = [
      new RegExp(`^\\[email\\] account ${kind}: sent via memory( \\(attempt \\d\\))?$`),
      new RegExp(`^\\[email\\] account ${kind}: attempt \\d failed via memory, retrying in \\d+s: Simulated (transient|permanent) delivery failure for \\[email\\]$`),
      new RegExp(`^\\[email\\] account ${kind}: FAILED via memory after \\d attempt\\(s\\): Simulated (transient|permanent) delivery failure for \\[email\\]$`),
      new RegExp(`^\\[email\\] account ${kind}: EXPIRED after attempt \\d failed via memory: no retry fits before its age limit; not sent: Simulated transient delivery failure for \\[email\\]$`),
      new RegExp(`^\\[email\\] account ${kind}: EXPIRED, not sent \\((the link expired|past its age limit or its link expiry)\\)$`),
      new RegExp(`^\\[email\\] account ${kind}: superseded, not sent \\(the link was replaced or used, or is no longer valid\\)$`),
      new RegExp(`^\\[email\\] account ${kind}: an interrupted attempt was found; it will be retried( with a new link)?$`),
      /^\[email\] account queue: removed \d+ finished row\(s\) older than 7 days$/,
    ];
    for (const line of allLines) {
      expect([line, fixed.some(re => re.test(line))]).toEqual([line, true]);
      expect(line).not.toMatch(/@|https?:|token|example\.com/);
    }
  });
});
