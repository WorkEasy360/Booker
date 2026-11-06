// Real process interruption and recovery for booking emails. Real API processes (not the in-test app) run on a
// throw-away database and send through an SMTP server inside this test; nothing leaves the machine.
//  - A process killed while the mail server holds its message unacknowledged must not resend it after a restart.
//  - A retry queued before a crash is delivered exactly once by the next process.
//  - Two live processes sharing the database claim each due email atomically: it is sent once.

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import net, { type AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { SMTPServer } from 'smtp-server';

jest.setTimeout(180_000);

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we360-email-restart-'));
const DB_FILE = path.join(TMP, 'restart.db');
const SECRET = randomBytes(32).toString('hex');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Local SMTP server whose behaviour each step chooses ─────────────────────
let mode: 'accept' | 'stall' | 'tempfail' = 'accept';
const received: string[] = [];   // every message whose data reached the server, acknowledged or not
const accepted: string[] = [];   // messages the server acknowledged (250)
const stalled: Array<() => void> = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  onRcptTo(_address, _session, callback) {
    if (mode === 'tempfail') { callback(Object.assign(new Error('Try again later'), { responseCode: 451 })); return; }
    callback();
  },
  onData(stream, _session, callback) {
    let raw = '';
    stream.on('data', (c: Buffer) => { raw += c.toString(); });
    stream.on('end', () => {
      received.push(raw);
      if (mode === 'stall') { stalled.push(() => callback()); return; } // the sender is now mid-send
      accepted.push(raw);
      callback();
    });
  },
});
let smtpPort = 0;
// Killing a sender drops its SMTP connection; the server reports that as an error event, which is expected here.
const smtpErrors: string[] = [];
smtp.on('error', (e: NodeJS.ErrnoException) => { smtpErrors.push(e.code ?? e.message); });

// ─── API processes ───────────────────────────────────────────────────────────
interface Api { child: ChildProcess; port: number; logs: string[] }
const running: Api[] = [];

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise(r => s.close(r));
  return port;
}

async function startApi(): Promise<Api> {
  const port = await freePort();
  // One plain Node process (no tsx CLI wrapper), so killing it really stops the server like a crash would.
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development', DB_PATH: DB_FILE, PORT: String(port), JWT_SECRET: SECRET, JWT_EXPIRES_IN: '1h',
      CORS_ORIGIN: 'http://localhost:5173', PUBLIC_APP_URL: 'http://localhost:5173', RATE_LIMITS: 'off',
      EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
      SMTP_USER: '', SMTP_PASS: '', EMAIL_FROM: 'Bookings <bookings@example.com>',
      EMAIL_RETRY_DELAYS_MS: '1500,1500,1500', EMAIL_WORKER_INTERVAL_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const api: Api = { child, port, logs: [] };
  child.stdout!.on('data', d => api.logs.push(...String(d).split('\n').filter(Boolean)));
  child.stderr!.on('data', d => api.logs.push(...String(d).split('\n').filter(Boolean)));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { running.push(api); return api; } } catch { /* starting */ }
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error(`API did not start: ${api.logs.slice(-5).join(' | ')}`);
}

async function crash(api: Api): Promise<void> {
  const exited = new Promise(r => api.child.once('exit', r));
  api.child.kill('SIGKILL');
  await exited;
  running.splice(running.indexOf(api), 1);
}

async function call(api: Api, method: string, p: string, token: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${api.port}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as { data?: any; error?: string } };
}

function outbox(appointmentId: string): Array<{ status: string; attempts: number; dedupe_key: string }> {
  const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT status, attempts, dedupe_key FROM email_outbox WHERE appointment_id = ? ORDER BY created_at').all(appointmentId) as never;
  } finally { db.close(); }
}

async function waitUntil(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────
let token = '';
let serviceId = '';
let staffId = '';
let customerId = '';
let slot = 0;
const date = (() => { const d = new Date(); d.setDate(d.getDate() + 20); return d.toISOString().slice(0, 10); })();
const book = (api: Api) => call(api, 'POST', '/appointments', token, { serviceId, staffId, customerId, date, startTime: `${String(8 + slot++).padStart(2, '0')}:00` });

beforeAll(async () => {
  await new Promise<void>(r => smtp.listen(0, '127.0.0.1', () => r()));
  smtpPort = (smtp.server.address() as AddressInfo).port;
  const api = await startApi();
  const post = (p: string, body: unknown) => fetch(`http://127.0.0.1:${api.port}/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const s = await post('/auth/signup', { name: 'Restart Owner', email: 'restart-owner@example.com', company: 'Restart Org', password: 'TestPass123', confirmPassword: 'TestPass123' });
  expect(s.status).toBe(202);
  // Sign-up only emails a confirmation link: confirm it through this SMTP server, then sign in.
  const unfold = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  let link: RegExpExecArray | null = null;
  for (let i = 0; i < 100 && !link; i++) {
    link = received.map(unfold).map(m => /verify-email#token=([A-Za-z0-9_-]+)/.exec(m)).find(Boolean) ?? null;
    if (!link) await sleep(100);
  }
  if (!link) throw new Error('No confirmation email reached the test SMTP server');
  expect((await post('/auth/verify-email', { token: link[1] })).status).toBe(201);
  const login = await post('/auth/login', { email: 'restart-owner@example.com', password: 'TestPass123' });
  token = (login.headers.get('set-cookie') ?? '').split(';')[0].split('=')[1];
  received.length = 0;
  accepted.length = 0;
  serviceId = (await call(api, 'POST', '/services', token, { name: 'Restart Service', category: 'consultation', duration: 60, price: 10, maxAdvance: 365 })).body.data.id;
  staffId = (await call(api, 'POST', '/staff', token, {
    name: 'Restart Staff', email: 'restart-staff@example.com', serviceIds: [serviceId],
    workingHours: Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '07:00', end: '21:00' }])),
  })).body.data.id;
  customerId = (await call(api, 'POST', '/customers', token, { name: 'Rita Restart', email: 'rita.restart@example.com' })).body.data.id;
});

afterAll(async () => {
  for (const api of [...running]) await crash(api);
  for (const release of stalled) { try { release(); } catch { /* the client is gone */ } }
  await new Promise<void>(r => smtp.close(() => r()));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
});

describe('real process interruption', () => {
  let interruptedId = '';

  it('a server killed while the mail server holds its message does not resend it after restarting', async () => {
    const a = running[0];
    mode = 'stall';
    const pending = book(a).catch(() => null); // the request never completes: the process dies mid-send
    await waitUntil(() => received.length === 1, 20_000, 'the confirmation to reach the mail server');
    const db = new Database(DB_FILE, { readonly: true });
    interruptedId = (db.prepare('SELECT id FROM appointments ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id;
    db.close();
    expect(outbox(interruptedId)).toMatchObject([{ status: 'sending', attempts: 1 }]);

    await crash(a);
    await pending;
    mode = 'accept';
    await waitUntil(() => smtpErrors.includes('ECONNRESET'), 5_000, 'the mail server to notice the dropped connection');

    const b = await startApi();
    expect(b.logs.join('\n')).toMatch(/1 email\(s\) were interrupted by a restart; marked "unknown"/);
    await sleep(2_500); // ten worker cycles
    expect(received).toHaveLength(1);
    expect(accepted).toHaveLength(0);
    expect(outbox(interruptedId)).toMatchObject([{ status: 'unknown', attempts: 1 }]);

    const history = await call(b, 'GET', `/appointments/${interruptedId}/emails`, token);
    expect(history.body.data.map((h: { status: string }) => h.status)).toContain('unknown');
  });

  it('an administrator can deliberately resend it: exactly one new email', async () => {
    const b = running[0];
    const res = await call(b, 'POST', `/appointments/${interruptedId}/emails`, token, { kind: 'confirmation' });
    expect(res.body.data.status).toBe('sent');
    expect(received).toHaveLength(2);
    expect(accepted).toHaveLength(1);
    await sleep(1_000);
    expect(received).toHaveLength(2);
  });

  it('a retry queued before a crash survives the restart and is delivered exactly once', async () => {
    const b = running[0];
    mode = 'tempfail';
    const res = await book(b);
    expect(res.status).toBe(201);
    expect(res.body.data.email.status).toBe('retrying'); // the response is honest: not sent yet
    const id = res.body.data.id;
    expect(outbox(id)).toMatchObject([{ status: 'pending', attempts: 1 }]);
    await crash(b); // before the retry is due
    mode = 'accept';
    const before = accepted.length;

    await startApi();
    await waitUntil(() => accepted.length === before + 1, 15_000, 'the queued retry to be delivered');
    await sleep(2_000);
    expect(accepted.length).toBe(before + 1);
    expect(outbox(id)).toMatchObject([{ status: 'sent', attempts: 2 }]);
  });

  it('two live server processes on one database claim each due email once', async () => {
    const c = running[0];
    const d = await startApi(); // started while no email is mid-send
    mode = 'tempfail';
    const res = await book(c);
    const id = res.body.data.id;
    expect(res.body.data.email.status).toBe('retrying');
    mode = 'accept';
    const before = accepted.length;
    await waitUntil(() => accepted.length >= before + 1, 15_000, 'the retry to be delivered');
    await sleep(2_500); // both workers keep polling every 250 ms
    expect(accepted.length).toBe(before + 1);
    const rows = outbox(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(d.logs.join('\n') + c.logs.join('\n')).not.toMatch(/interrupted by a restart; marked "unknown"/);
  });

  it('never prints the signing secret or SMTP settings in its logs', () => {
    const all = running.flatMap(r => r.logs).join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/SMTP_PASS|password/i);
  });
});

// Account emails (migration 009) are queued too, but an interrupted one IS retried, with a new link, because its link
// is stored only as a hash: the earlier link then says a newer one was sent. These run after the log check above,
// since their log lines name the password-reset email.
describe('account emails across a real restart', () => {
  const OWNER = 'restart-owner@example.com';
  const unfold = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  const resetLinks = (raws: string[]) => raws.map(unfold).map(m => /reset-password#token=([A-Za-z0-9_-]+)/.exec(m)?.[1]).filter((t): t is string => !!t);
  const post = (api: Api, p: string, body: unknown) => fetch(`http://127.0.0.1:${api.port}/api${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) as { code?: string } }));
  function lastResetRow(): { status: string; attempts: number } | undefined {
    const d = new Database(DB_FILE, { readonly: true, fileMustExist: true });
    try {
      return d.prepare("SELECT status, attempts FROM account_email_queue WHERE kind = 'password_reset' ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as never;
    } finally { d.close(); }
  }

  it('a reset email interrupted by a crash is retried once by the next process, with a new link', async () => {
    while (running.length > 1) await crash(running[running.length - 1]); // one process, so "the next one" is clear
    const a = running[0];
    mode = 'stall';
    const before = received.length;
    expect((await post(a, '/auth/password/forgot', { email: OWNER })).status).toBe(202);
    await waitUntil(() => received.length === before + 1, 20_000, 'the reset email to reach the mail server');
    expect(lastResetRow()).toMatchObject({ status: 'sending', attempts: 1 });
    await crash(a);
    mode = 'accept';
    // The next process retries an interrupted row only after five minutes (it may still be sending elsewhere):
    // move this throw-away database's record back six minutes instead of waiting.
    const d = new Database(DB_FILE);
    try {
      d.prepare("UPDATE account_email_queue SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 minutes') WHERE status = 'sending'").run();
    } finally { d.close(); }

    const acceptedBefore = accepted.length;
    const b = await startApi();
    await waitUntil(() => accepted.length === acceptedBefore + 1, 15_000, 'the retried reset email');
    await sleep(2_000); // eight worker cycles: nothing more
    expect(accepted.length).toBe(acceptedBefore + 1);
    expect(lastResetRow()).toMatchObject({ status: 'sent', attempts: 2 });
    const [first] = resetLinks(received.slice(before, before + 1));
    const [second] = resetLinks(accepted.slice(acceptedBefore));
    expect(first && second && first !== second).toBe(true);
    expect((await post(b, '/auth/password/reset/inspect', { token: first })).body.code).toBe('RESET_REPLACED');
    expect((await post(b, '/auth/password/reset/inspect', { token: second })).status).toBe(200);
    const logs = b.logs.join('\n');
    expect(logs).toContain('[email] account password_reset: an interrupted attempt was found; it will be retried with a new link');
    expect(logs).toContain('[email] account password_reset: sent via smtp (attempt 2)');
  });

  it('a reset retry queued before a crash is delivered exactly once by the next process', async () => {
    const b = running[0];
    mode = 'tempfail';
    expect((await post(b, '/auth/password/forgot', { email: OWNER })).status).toBe(202);
    await waitUntil(() => lastResetRow()?.status === 'pending', 10_000, 'the first attempt to fail');
    await crash(b); // before the retry is due (1.5 s)
    mode = 'accept';
    const before = accepted.length;
    await startApi();
    await waitUntil(() => accepted.length === before + 1, 15_000, 'the queued retry');
    await sleep(2_000);
    expect(accepted.length).toBe(before + 1);
    expect(lastResetRow()).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('two live server processes on one database send a due account retry once', async () => {
    const c = running[0];
    const d = await startApi();
    mode = 'tempfail';
    expect((await post(c, '/auth/password/forgot', { email: OWNER })).status).toBe(202);
    await waitUntil(() => lastResetRow()?.status === 'pending', 10_000, 'the first attempt to fail');
    mode = 'accept';
    const before = accepted.length;
    await waitUntil(() => accepted.length >= before + 1, 15_000, 'the retry');
    await sleep(2_500); // both workers keep polling every 250 ms
    expect(accepted.length).toBe(before + 1);
    expect(lastResetRow()).toMatchObject({ status: 'sent', attempts: 2 });
    expect(c.logs.join('\n') + d.logs.join('\n')).not.toMatch(/interrupted attempt was found/);
  });
});
