// Password reset and email verification of new sign-ups: token handling (hash-only storage, expiry, single use,
// replacement, concurrent use), session invalidation, notices, email failures, anti-enumeration and rate limits.
// Synthetic accounts only, in the isolated per-file test database; email goes to the in-memory test transport.

import request from 'supertest';
import { createHash } from 'crypto';
import app from '../index';
import db from '../db/init';
import { initEmail, testOutbox, accountEmailsSettled, processDueAccountEmails } from '../services/email/notify';
import { rateLimitTesting } from '../middleware/rate-limit';
import { sessionToken, signUpAndSignIn, verificationTokenFor } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv;
const GENERIC = { data: { message: 'We’ll send an email with the next steps if the address can be used for this request.' } };
const PASSWORD = 'StartPass123';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
let seq = 0;
const address = (label: string) => `acct-${label}-${++seq}-${RUN}@example.com`;

const post = (path: string, body: unknown) => request(app).post(`/api/auth${path}`).send(body as object);
const login = (email: string, password: string) => post('/login', { email, password });
const forgot = (email: string) => post('/password/forgot', { email });
const reset = (token: string, password: string, confirmPassword = password) => post('/password/reset', { token, password, confirmPassword });

async function mailsTo(email: string) {
  await accountEmailsSettled();
  return testOutbox.messages.filter(m => m.to === email.toLowerCase());
}
async function resetTokenFor(email: string): Promise<string> {
  const mail = (await mailsTo(email)).reverse().find(m => /\/reset-password#token=/.test(m.text));
  if (!mail) throw new Error(`No reset email for ${email}`);
  return decodeURIComponent(/\/reset-password#token=([A-Za-z0-9_%-]+)/.exec(mail.text)![1]);
}
const passwordHashOf = (email: string) => (db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email) as { password_hash: string }).password_hash;

async function account(label: string) {
  const email = address(label);
  const res = await signUpAndSignIn(app, { name: `Owner ${label}`, email, company: `Acct ${label} ${RUN}`, password: PASSWORD });
  expect(res.status).toBe(200);
  return { email, token: sessionToken(res), orgId: res.body.data.user.organization_id as string, userId: res.body.data.user.id as string };
}

beforeAll(() => initEmail(MEMORY_ENV));
beforeEach(() => testOutbox.clear());

describe('password reset', () => {
  it('a valid link changes the password, ends every session, and sends a password-changed notice', async () => {
    const a = await account('reset-ok');
    const second = await login(a.email, PASSWORD);
    expect((await forgot(a.email)).body).toEqual(GENERIC);
    const mail = (await mailsTo(a.email)).find(m => /Reset your/.test(m.subject))!;
    expect(mail.text).toContain('http://localhost:5173/reset-password#token='); // PUBLIC_APP_URL, token in the fragment
    expect(mail.text).not.toMatch(/reset-password\?/);
    const token = await resetTokenFor(a.email);
    expect((await post('/password/reset/inspect', { token })).status).toBe(200);

    const res = await reset(token, 'Fresh0Pass');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined(); // no automatic sign-in
    for (const t of [a.token, sessionToken(second)]) expect((await request(app).get('/api/auth/me').set(bearer(t))).status).toBe(401);
    expect((await login(a.email, PASSWORD)).status).toBe(401);
    expect((await login(a.email, 'Fresh0Pass')).status).toBe(200);
    expect((await mailsTo(a.email)).some(m => /password was changed/.test(m.subject))).toBe(true);
  });

  it('rejects unknown, expired, used and replaced links, and never changes the password on failure', async () => {
    const a = await account('reset-bad');
    const original = passwordHashOf(a.email);
    expect((await reset('x'.repeat(43), 'Fresh0Pass')).body.code).toBe('RESET_INVALID');
    expect((await reset('short', 'Fresh0Pass')).status).toBe(400);

    await forgot(a.email);
    const expired = await resetTokenFor(a.email);
    db.prepare("UPDATE password_resets SET expires_at = '2000-01-01T00:00:00.000Z', created_at = '1999-12-31T23:00:00.000Z' WHERE token_hash = ?").run(sha256(expired));
    const exp = await reset(expired, 'Fresh0Pass');
    expect([exp.status, exp.body.code]).toEqual([410, 'RESET_EXPIRED']);

    await forgot(a.email);
    const first = await resetTokenFor(a.email);
    await forgot(a.email);
    const newest = await resetTokenFor(a.email);
    expect((await reset(first, 'Fresh0Pass')).body.code).toBe('RESET_REPLACED'); // a newer link replaces it

    // Validation failures leave the link usable and the password unchanged.
    expect((await reset(newest, 'weak')).status).toBe(400);
    expect((await reset(newest, 'Fresh0Pass', 'Other0Pass')).status).toBe(400);
    expect(passwordHashOf(a.email)).toBe(original);

    expect((await reset(newest, 'Fresh0Pass')).status).toBe(200);
    const again = await reset(newest, 'Second0Pass');
    expect([again.status, again.body.code]).toEqual([410, 'RESET_USED']);
    expect((await login(a.email, 'Fresh0Pass')).status).toBe(200);
  });

  it('two simultaneous uses of one link: exactly one succeeds', async () => {
    const a = await account('reset-race');
    await forgot(a.email);
    const token = await resetTokenFor(a.email);
    const results = await Promise.all([reset(token, 'Racer0One'), reset(token, 'Racer0Two'), reset(token, 'Racer0Three')]);
    expect(results.map(r => r.status).sort()).toEqual([200, 410, 410]);
    const winner = ['Racer0One', 'Racer0Two', 'Racer0Three'][results.findIndex(r => r.status === 200)];
    expect((await login(a.email, winner)).status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ? AND used_at IS NOT NULL').get(sha256(token)) as { n: number }).n).toBe(1);
  });

  it('changing the password in Settings ends links requested before', async () => {
    const a = await account('reset-settings');
    await forgot(a.email);
    const token = await resetTokenFor(a.email);
    expect((await request(app).put('/api/auth/password').set(bearer(a.token)).send({ currentPassword: PASSWORD, newPassword: 'Settings0Pass' })).status).toBe(200);
    expect((await reset(token, 'Fresh0Pass')).body.code).toBe('RESET_REPLACED');
  });

  it('a link changes only its own account, whatever else the request says', async () => {
    const a = await account('reset-own');
    const b = await account('reset-other');
    const bHash = passwordHashOf(b.email);
    await forgot(a.email);
    const token = await resetTokenFor(a.email);
    expect((await post('/password/reset', { token, password: 'Fresh0Pass', confirmPassword: 'Fresh0Pass', userId: b.userId, email: b.email })).status).toBe(200);
    expect(passwordHashOf(b.email)).toBe(bHash);
    expect((await login(b.email, PASSWORD)).status).toBe(200);
  });

  it('staff and manager sign-ins use the same reset; a turned-off sign-in gets no email', async () => {
    const owner = await account('reset-staff-owner');
    const service = (await request(app).post('/api/services').set(bearer(owner.token)).send({ name: 'Svc', category: 'consultation', duration: 30, price: 1, maxAdvance: 30 })).body.data.id;
    const staffEmail = address('reset-staff');
    const staffId = (await request(app).post('/api/staff').set(bearer(owner.token)).send({ name: 'Sam Staff', email: staffEmail, serviceIds: [service] })).body.data.id;
    expect((await request(app).post(`/api/staff/${staffId}/invitations`).set(bearer(owner.token)).send({ role: 'manager' })).status).toBe(201);
    const invite = (await mailsTo(staffEmail)).find(m => /accept-invite#token=/.test(m.text))!;
    const inviteToken = decodeURIComponent(/accept-invite#token=([A-Za-z0-9_%-]+)/.exec(invite.text)![1]);
    expect((await post('/invitations/accept', { token: inviteToken, password: PASSWORD, confirmPassword: PASSWORD })).status).toBe(201);

    await forgot(staffEmail);
    expect((await reset(await resetTokenFor(staffEmail), 'Staff0Fresh')).status).toBe(200);
    const signedIn = await login(staffEmail, 'Staff0Fresh');
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.user.role).toBe('manager'); // role and business unchanged

    expect((await request(app).put(`/api/staff/${staffId}/access`).set(bearer(owner.token)).send({ enabled: false })).status).toBe(200);
    testOutbox.clear();
    expect((await forgot(staffEmail)).body).toEqual(GENERIC);
    expect(await mailsTo(staffEmail)).toEqual([]);
  });
});

describe('email verification of new sign-ups', () => {
  it('a sign-up is pending until its link is used; the link creates the business and its administrator', async () => {
    const email = address('verify-ok');
    const res = await post('/signup', { name: 'Vera', email, company: `Verify Co ${RUN}`, password: PASSWORD, confirmPassword: PASSWORD, timezone: 'Asia/Kolkata' });
    expect([res.status, res.body]).toEqual([202, GENERIC]);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)).toBeUndefined();
    expect((await login(email, PASSWORD)).status).toBe(401);
    const pending = db.prepare('SELECT verified_at, expires_at, created_at FROM signup_requests WHERE email = ?').get(email) as { verified_at: string | null; expires_at: string; created_at: string };
    expect(pending.verified_at).toBeNull();
    expect(Date.parse(pending.expires_at) - Date.parse(pending.created_at)).toBe(24 * 60 * 60_000);

    const mail = (await mailsTo(email))[0];
    expect(mail.text).toContain('http://localhost:5173/verify-email#token=');
    const token = await verificationTokenFor(email);
    const inspected = await post('/verify-email/inspect', { token });
    expect(inspected.body.data).toMatchObject({ email, businessName: `Verify Co ${RUN}` });
    const verified = await post('/verify-email', { token });
    expect(verified.status).toBe(201);
    expect(verified.headers['set-cookie']).toBeUndefined();
    const user = db.prepare('SELECT role, organization_id FROM users WHERE email = ?').get(email) as { role: string; organization_id: string };
    expect(user.role).toBe('admin');
    expect(db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(user.organization_id)).toEqual({ timezone: 'Asia/Kolkata' });
    expect((db.prepare('SELECT password_hash FROM signup_requests WHERE email = ?').get(email) as { password_hash: string }).password_hash).toBe('');
    expect((await login(email, PASSWORD)).status).toBe(200);
  });

  it('rejects unknown, expired, used and replaced links', async () => {
    expect((await post('/verify-email', { token: 'y'.repeat(43) })).body.code).toBe('VERIFY_INVALID');
    const email = address('verify-bad');
    const body = { name: 'Vic', email, company: 'Bad Links', password: PASSWORD, confirmPassword: PASSWORD };
    await post('/signup', body);
    const expired = await verificationTokenFor(email);
    db.prepare("UPDATE signup_requests SET expires_at = '2000-01-01T00:00:00.000Z', created_at = '1999-12-31T00:00:00.000Z' WHERE token_hash = ?").run(sha256(expired));
    expect((await post('/verify-email', { token: expired })).body.code).toBe('VERIFY_EXPIRED');

    // A replacement link (requested from the expired page) makes earlier links stop working.
    expect((await post('/verify-email/resend', { email })).body).toEqual(GENERIC);
    const replacement = await verificationTokenFor(email);
    expect(replacement).not.toBe(expired);
    expect((await mailsTo(email)).some(m => /new link/.test(m.subject))).toBe(true);
    // Signing up again for the same address also replaces the link.
    await post('/signup', body);
    const newest = await verificationTokenFor(email);
    expect((await post('/verify-email', { token: replacement })).body.code).toBe('VERIFY_REPLACED');

    expect((await post('/verify-email', { token: newest })).status).toBe(201);
    expect((await post('/verify-email', { token: newest })).body.code).toBe('VERIFY_USED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(email)).toEqual({ n: 1 });
  });

  it('existing accounts keep working and are never asked to verify again', async () => {
    const a = await account('existing');
    expect((await login(a.email, PASSWORD)).status).toBe(200);
    testOutbox.clear();
    expect((await post('/verify-email/resend', { email: a.email })).body).toEqual(GENERIC);
    const mails = await mailsTo(a.email);
    expect(mails.map(m => m.subject)).toEqual(['Sign-in help for your WorkeasyBooking account']);
    expect(mails[0].text).not.toMatch(/token=/);
  });

  it('email failures are handled safely: same answer, nothing created, and temporary failures are retried', async () => {
    const permanent = address('mail-fail');
    testOutbox.failNextSends(1, 'permanent');
    const res = await post('/signup', { name: 'Fay', email: permanent, company: 'Fail Co', password: PASSWORD, confirmPassword: PASSWORD });
    expect([res.status, res.body]).toEqual([202, GENERIC]);
    expect(await mailsTo(permanent)).toEqual([]);
    expect(db.prepare('SELECT 1 FROM users WHERE email = ?').get(permanent)).toBeUndefined();
    // The person can ask for a new link, which then arrives.
    await post('/verify-email/resend', { email: permanent });
    expect((await mailsTo(permanent)).length).toBe(1);

    // A temporary failure is queued and retried by the email worker (run here with a clock one minute ahead).
    const transient = address('mail-retry');
    testOutbox.failNextSends(1, 'transient');
    await post('/signup', { name: 'Tim', email: transient, company: 'Retry Co', password: PASSWORD, confirmPassword: PASSWORD });
    expect(await mailsTo(transient)).toEqual([]);
    expect((await processDueAccountEmails(Date.now() + 61_000)).sent).toBe(1);
    expect((await mailsTo(transient)).length).toBe(1);
    expect((await post('/verify-email', { token: await verificationTokenFor(transient) })).status).toBe(201);
  });
});

describe('no account enumeration', () => {
  it('signing up with a registered address looks exactly like a new one, and only the mailbox owner learns more', async () => {
    const a = await account('enum-signup');
    testOutbox.clear(); // only what the probes below cause
    const timed = async (email: string) => {
      const started = process.hrtime.bigint();
      const res = await post('/signup', { name: 'Probe', email, company: 'Probe', password: PASSWORD, confirmPassword: PASSWORD });
      return { res, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    };
    const known: number[] = [], fresh: number[] = [];
    for (let i = 0; i < 3; i++) {
      const k = await timed(a.email);
      const f = await timed(address('enum-new'));
      expect([k.res.status, k.res.body, k.res.headers['set-cookie']]).toEqual([f.res.status, f.res.body, f.res.headers['set-cookie']]);
      known.push(k.ms); fresh.push(f.ms);
    }
    // Both paths hash the password, so neither is obviously faster (generous bounds: this is a timing smoke check).
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[1];
    const ratio = median(known) / median(fresh);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
    expect((await mailsTo(a.email)).every(m => /Sign-in help/.test(m.subject))).toBe(true);
  });

  it('password-reset and verification requests answer the same for registered, pending, deactivated and unknown addresses', async () => {
    const a = await account('enum-reset');
    const pending = address('enum-pending');
    await post('/signup', { name: 'Pen', email: pending, company: 'Pending', password: PASSWORD, confirmPassword: PASSWORD });
    const unknown = address('enum-unknown');
    for (const path of ['/password/forgot', '/verify-email/resend']) {
      const answers = await Promise.all([a.email, pending, unknown].map(email => post(path, { email })));
      for (const r of answers) expect([r.status, r.body]).toEqual([202, GENERIC]);
    }
    expect(await mailsTo(unknown)).toEqual([]);
  });

  it('without email the requests say so in the same way for every address', async () => {
    const a = await account('enum-noemail');
    initEmail({ EMAIL_TRANSPORT: 'disabled' } as NodeJS.ProcessEnv);
    try {
      for (const [path, extra] of [['/signup', { name: 'N', company: 'C', password: PASSWORD, confirmPassword: PASSWORD }], ['/password/forgot', {}], ['/verify-email/resend', {}]] as const) {
        const known = await post(path, { email: a.email, ...extra });
        const other = await post(path, { email: address('enum-x'), ...extra });
        expect(known.status).toBe(503);
        expect(known.body.code).toBe('EMAIL_NOT_CONFIGURED');
        expect(other.body).toEqual(known.body);
      }
    } finally {
      initEmail(MEMORY_ENV);
    }
  });
});

describe('token storage, logs and rate limits', () => {
  it('stores only token hashes and never writes a token or password to the logs', async () => {
    const logged: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map(k => jest.spyOn(console, k).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
    try {
      const email = address('storage');
      await post('/signup', { name: 'Sto', email, company: 'Storage', password: 'Secret0Pass', confirmPassword: 'Secret0Pass' });
      const verifyToken = await verificationTokenFor(email);
      await post('/verify-email', { token: verifyToken });
      await forgot(email);
      const resetToken = await resetTokenFor(email);
      await reset(resetToken, 'Second0Secret');
      await accountEmailsSettled();
      for (const token of [verifyToken, resetToken]) {
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
        for (const table of ['signup_requests', 'password_resets', 'users', 'user_sessions']) {
          expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain(token);
        }
        expect(logged.join('\n')).not.toContain(token);
      }
      expect(db.prepare('SELECT 1 FROM signup_requests WHERE token_hash = ?').get(sha256(verifyToken))).toBeTruthy();
      expect(db.prepare('SELECT 1 FROM password_resets WHERE token_hash = ?').get(sha256(resetToken))).toBeTruthy();
      expect(logged.join('\n')).not.toMatch(/Secret0Pass|Second0Secret/);
      expect(logged.join('\n')).not.toContain(email);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  describe('with rate limits on', () => {
    let now = Date.now();
    beforeAll(() => { process.env.RATE_LIMITS = 'on'; rateLimitTesting.setClock(() => now); });
    afterAll(() => { process.env.RATE_LIMITS = 'off'; rateLimitTesting.setClock(null); rateLimitTesting.reset(); });
    beforeEach(() => { rateLimitTesting.reset(); now = Date.now(); });

    it('limits reset and verification requests per address (from any network) and per network', async () => {
      app.set('trust proxy', true);
      try {
        for (const path of ['/password/forgot', '/verify-email/resend']) {
          const email = address('limit-email');
          const perEmail = [];
          for (let i = 0; i < 4; i++) perEmail.push((await request(app).post(`/api/auth${path}`).set('X-Forwarded-For', `198.51.100.${i + 1}`).send({ email })).status);
          expect(perEmail).toEqual([202, 202, 202, 429]);
          const perIp = [];
          for (let i = 0; i < 11; i++) perIp.push((await request(app).post(`/api/auth${path}`).set('X-Forwarded-For', '203.0.113.99').send({ email: address('limit-ip') })).status);
          expect(perIp.slice(0, 10).every(s => s === 202)).toBe(true);
          expect(perIp[10]).toBe(429);
          rateLimitTesting.reset();
        }
      } finally {
        app.set('trust proxy', false);
      }
    });

    it('limits guessing at links per network', async () => {
      const statuses = [];
      for (let i = 0; i < 11; i++) statuses.push((await post('/password/reset/inspect', { token: `guess${i}`.padEnd(43, 'x') })).status);
      expect(statuses.slice(0, 10).every(s => s === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
      now += 15 * 60_000 + 1;
      expect((await post('/verify-email/inspect', { token: 'z'.repeat(43) })).status).toBe(404);
    });
  });
});

describe('existing workflows', () => {
  it('sign-in, sign-out and cross-business isolation are unchanged', async () => {
    const a = await account('flow-a');
    const b = await account('flow-b');
    const s = await login(a.email, PASSWORD);
    expect((await request(app).post('/api/auth/logout').set('Cookie', `we360_session=${sessionToken(s)}`)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(sessionToken(s)))).status).toBe(401);
    const svc = (await request(app).post('/api/services').set(bearer(a.token)).send({ name: 'Iso', category: 'consultation', duration: 30, price: 1, maxAdvance: 30 })).body.data.id;
    expect((await request(app).get(`/api/services/${svc}`).set(bearer(b.token))).status).toBe(404);
  });
});

// Account emails are queued in account_email_queue (migration 009) and retried by the email worker, each retry with a
// new link. These tests pin the behaviour down: the schedule, the limit, no retry of permanent failures, and no second
// copy once an attempt succeeds. account-email-queue.test.ts covers deadlines, cancellation, recovery and cleanup.
describe('account email retries (from the queue)', () => {
  // Default retry delays (1, 5 and 15 minutes); each retry is run with an explicit clock instead of waiting.
  let lines: string[] = [];
  let spies: jest.SpyInstance[] = [];
  const accountLines = () => lines.filter(l => l.startsWith('[email] account password_reset'));
  const delivered = (email: string) => testOutbox.messages.filter(m => m.to === email.toLowerCase() && /\/reset-password#token=/.test(m.text));
  const nextRetry = (email: string) => {
    const row = db.prepare(
      `SELECT q.next_attempt_at FROM account_email_queue q JOIN users u ON u.id = q.user_id WHERE u.email = ? AND q.kind = 'password_reset' ORDER BY q.created_at DESC LIMIT 1`
    ).get(email) as { next_attempt_at: string | null };
    return row.next_attempt_at ? Date.parse(row.next_attempt_at) : null;
  };

  beforeEach(() => {
    lines = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    spies = [jest.spyOn(console, 'log').mockImplementation(capture), jest.spyOn(console, 'warn').mockImplementation(capture)];
  });
  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    testOutbox.clear();
  });

  it('a temporary failure is retried on the schedule, and the email then arrives exactly once', async () => {
    const { email } = await account('retry-ok');
    testOutbox.clear(); lines = [];
    testOutbox.failNextSends(2, 'transient');
    await forgot(email);
    await accountEmailsSettled();
    expect(delivered(email)).toHaveLength(0);
    await processDueAccountEmails(nextRetry(email)!);
    await processDueAccountEmails(nextRetry(email)!);
    expect(delivered(email)).toHaveLength(1);
    expect(accountLines()).toEqual([
      expect.stringMatching(/^\[email\] account password_reset: attempt 1 failed via memory, retrying in 60s: /),
      expect.stringMatching(/^\[email\] account password_reset: attempt 2 failed via memory, retrying in 300s: /),
      '[email] account password_reset: sent via memory (attempt 3)',
    ]);
    expect(nextRetry(email)).toBeNull();
    await processDueAccountEmails(Date.now() + 50 * 60_000);
    expect(delivered(email)).toHaveLength(1); // nothing is sent again after a success
  });

  it('retries stop after the last configured delay: FAILED after four attempts, nothing delivered, nothing more tried', async () => {
    const { email } = await account('retry-limit');
    testOutbox.clear(); lines = [];
    testOutbox.failNextSends(10, 'transient');
    await forgot(email);
    await accountEmailsSettled();
    for (let i = 0; i < 3; i++) await processDueAccountEmails(nextRetry(email)!);
    expect(delivered(email)).toHaveLength(0);
    const attempts = accountLines();
    expect(attempts.filter(l => /retrying in/.test(l))).toHaveLength(3);
    expect(attempts.at(-1)).toMatch(/^\[email\] account password_reset: FAILED via memory after 4 attempt\(s\): /);
    await processDueAccountEmails(Date.now() + 50 * 60_000);
    expect(accountLines()).toHaveLength(attempts.length);
  });

  it('a permanent failure is not retried; the person can request a new link, which then arrives', async () => {
    const { email } = await account('retry-permanent');
    testOutbox.clear(); lines = [];
    testOutbox.failNextSends(1, 'permanent');
    await forgot(email);
    await accountEmailsSettled();
    await processDueAccountEmails(Date.now() + 50 * 60_000);
    expect(accountLines()).toEqual([expect.stringMatching(/^\[email\] account password_reset: FAILED via memory after 1 attempt\(s\): /)]);
    expect(delivered(email)).toHaveLength(0);
    await forgot(email);
    await accountEmailsSettled();
    expect(delivered(email)).toHaveLength(1);
  });

  it('a successful first attempt is sent once and never retried', async () => {
    const { email } = await account('retry-none');
    testOutbox.clear(); lines = [];
    await forgot(email);
    await accountEmailsSettled();
    await processDueAccountEmails(Date.now() + 50 * 60_000);
    expect(delivered(email)).toHaveLength(1);
    expect(accountLines()).toEqual(['[email] account password_reset: sent via memory']);
  });
});
