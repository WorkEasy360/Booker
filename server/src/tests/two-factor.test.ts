// Two-factor sign-in: TOTP matches RFC 6238; secrets are encrypted at rest and bound to their user; recovery codes are
// stored as hashes and work once; the password alone no longer creates a session; codes cannot be replayed; the second
// step is rate limited; setup, turning off and new recovery codes need the password (and a code); an administrator can
// reset a staff member's two-factor sign-in, nobody else. Synthetic accounts in the per-file test database.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import {
  base32Decode, base32Encode, hotp, stepAt, matchingStep, sealSecret, openSecret, beginSetup, confirmSetup,
  issueChallenge, verifyChallenge, TOTP_PERIOD_S,
} from '../services/two-factor';
import { initSecurityConfig, readSecurityConfig } from '../config/security';
import { rateLimitTesting } from '../middleware/rate-limit';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const PASSWORD = 'StartPass123';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const codeAt = (secret: string, offsetSteps = 0) => hotp(base32Decode(secret), stepAt(Date.now()) + offsetSteps);
const login = (email: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });
const secondStep = (body: Record<string, unknown>) => request(app).post('/api/auth/login/2fa').send(body);
const setCookies = (res: { headers: Record<string, unknown> }) => ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);

interface Account { email: string; userId: string; orgId: string; token: string }

async function account(label: string): Promise<Account> {
  const email = `tf-${label}-${RUN}@example.com`;
  const s = await signUpAndSignIn(app, { name: `Two Factor ${label}`, email, company: `TF ${label} ${RUN}`, password: PASSWORD });
  return { email, userId: s.body.data.user.id, orgId: s.body.data.user.organization_id, token: sessionToken(s) };
}

/** Turns two-factor on through the API; returns the secret and recovery codes. */
async function enable(a: Account): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await request(app).post('/api/auth/2fa/setup').set(bearer(a.token)).send({ password: PASSWORD });
  expect(setup.status).toBe(200);
  const enabled = await request(app).post('/api/auth/2fa/enable').set(bearer(a.token)).send({ code: codeAt(setup.body.data.secret) });
  expect(enabled.status).toBe(200);
  return { secret: setup.body.data.secret, recoveryCodes: enabled.body.data.recoveryCodes };
}

/** Password, then a challenge, then the second step; returns the session token. */
async function signInWith(a: Account, factor: Record<string, string>): Promise<string> {
  const first = await login(a.email);
  expect(first.body.data.twoFactorRequired).toBe(true);
  const res = await secondStep({ challenge: first.body.data.challenge, ...factor });
  expect(res.status).toBe(200);
  return sessionToken(res);
}

describe('the algorithm', () => {
  it('matches the RFC 6238 SHA-1 test vectors (6-digit form)', () => {
    const key = Buffer.from('12345678901234567890');
    const vectors: Array<[number, string]> = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
    for (const [t, code] of vectors) expect([t, hotp(key, Math.floor(t / TOTP_PERIOD_S))]).toEqual([t, code]);
  });

  it('accepts one step of clock drift either way, and nothing further or malformed', () => {
    const key = Buffer.from('12345678901234567890');
    const now = 1_700_000_000_000;
    const s = stepAt(now);
    for (const d of [-1, 0, 1]) expect(matchingStep(key, hotp(key, s + d), now)).toBe(s + d);
    for (const d of [-2, 2]) expect(matchingStep(key, hotp(key, s + d), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 5x']) expect(matchingStep(key, bad, now)).toBeNull();
    expect(matchingStep(key, hotp(key, s).replace(/^(\d{3})/, '$1 '), now)).toBe(s); // "123 456" as apps display it
  });

  it('base32 follows RFC 4648', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb-oi').toString()).toBe('foobar');
    expect(() => base32Decode('MZXW1')).toThrow();
  });
});

describe('secrets at rest', () => {
  it('are encrypted, bound to their user, and refused if altered or sealed with another key', () => {
    const secret = Buffer.from('0123456789abcdefghij');
    const sealed = sealSecret('user-a', secret);
    expect(sealed).not.toContain(base32Encode(secret));
    expect(sealed).not.toContain(secret.toString('hex'));
    expect(openSecret('user-a', sealed)).toEqual(secret);
    expect(openSecret('user-b', sealed)).toBeNull();
    const parts = sealed.split('.');
    const flipped = parts[4][0] === 'A' ? 'B' : 'A';
    expect(openSecret('user-a', [...parts.slice(0, 4), flipped + parts[4].slice(1)].join('.'))).toBeNull();
    try {
      initSecurityConfig({ ...process.env, TWO_FACTOR_ENCRYPTION_KEY: 'a1'.repeat(8) + 'b2c3d4e5f6a7b8c9'.repeat(3) });
      expect(openSecret('user-a', sealed)).toBeNull();               // another key: refused, not garbage
      expect(openSecret('user-a', sealSecret('user-a', secret))).toEqual(secret);
    } finally {
      initSecurityConfig(process.env);
    }
  });

  it('the configured key must be 32 bytes; its value never appears in the message', () => {
    const base = { ...process.env, NODE_ENV: 'test' };
    const bad = 'not-a-key-but-a-secret-value';
    let message = '';
    try { readSecurityConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: bad }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/TWO_FACTOR_ENCRYPTION_KEY must be 32 random bytes/);
    expect(message).not.toContain(bad);
    expect(readSecurityConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('hex').replace(/^0707/, '1a2b') }).twoFactorKey).toHaveLength(32);
    expect(readSecurityConfig({ ...base, TWO_FACTOR_ENCRYPTION_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString('base64') }).twoFactorKey).toHaveLength(32);
  });

  it('the database holds the sealed secret and recovery-code hashes only', async () => {
    const a = await account('rest');
    const { secret, recoveryCodes } = await enable(a);
    const row = db.prepare('SELECT * FROM user_two_factor WHERE user_id = ?').get(a.userId) as Record<string, string>;
    expect(row.secret_enc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(secret);
    const hashes = db.prepare('SELECT code_hash FROM user_recovery_codes WHERE user_id = ?').all(a.userId) as Array<{ code_hash: string }>;
    expect(hashes).toHaveLength(10);
    const stored = JSON.stringify(hashes);
    for (const code of recoveryCodes) {
      expect(code).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
      expect(stored).not.toContain(code.replace(/-/g, ''));
    }
    expect(new Set(recoveryCodes).size).toBe(10);
    // The API never shows the secret again.
    const status = await request(app).get('/api/auth/2fa').set(bearer(a.token));
    expect(status.body.data).toEqual({ enabled: true, enabledAt: expect.any(String), recoveryCodesLeft: 10 });
    expect(JSON.stringify(status.body)).not.toContain(secret);
  });
});

describe('setup', () => {
  it('needs the current password and a working code; an expired setup cannot be finished', async () => {
    const a = await account('setup');
    expect((await request(app).post('/api/auth/2fa/setup').set(bearer(a.token)).send({ password: 'WrongPass123' })).status).toBe(400);
    expect((await request(app).post('/api/auth/2fa/setup').send({ password: PASSWORD })).status).toBe(401);
    const setup = await request(app).post('/api/auth/2fa/setup').set(bearer(a.token)).send({ password: PASSWORD });
    expect(setup.body.data.otpauthUrl).toMatch(new RegExp(`^otpauth://totp/WorkEasy360%3A${encodeURIComponent(a.email).replace(/[.]/g, '\\.')}\\?secret=${setup.body.data.secret}&issuer=WorkEasy360&algorithm=SHA1&digits=6&period=30$`));
    expect((await request(app).post('/api/auth/2fa/enable').set(bearer(a.token)).send({ code: '000000' === codeAt(setup.body.data.secret) ? '111111' : '000000' })).status).toBe(400);
    expect((await request(app).get('/api/auth/2fa').set(bearer(a.token))).body.data.enabled).toBe(false);
    // Signing in still needs only the password until setup is confirmed.
    expect((await login(a.email)).body.data.twoFactorRequired).toBeUndefined();

    const later = Date.now() + 11 * 60_000;
    const late = confirmSetup(a.userId, hotp(base32Decode(setup.body.data.secret), stepAt(later)), later);
    expect(late).toEqual({ error: expect.stringMatching(/expired/) });
  });

  it('turning it on ends the account\'s other sessions; it cannot be set up twice', async () => {
    const a = await account('others');
    const other = sessionToken(await login(a.email));
    await enable(a);
    expect((await request(app).get('/api/auth/me').set(bearer(other))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(a.token))).status).toBe(200);
    expect((await request(app).post('/api/auth/2fa/setup').set(bearer(a.token)).send({ password: PASSWORD })).status).toBe(409);
    expect(beginSetup(a.userId, a.email)).toEqual({ error: expect.stringMatching(/already on/) });
  });
});

describe('signing in', () => {
  let a: Account;
  let secret = '';
  let recoveryCodes: string[] = [];
  beforeAll(async () => {
    a = await account('signin');
    ({ secret, recoveryCodes } = await enable(a));
  });

  it('the password alone gives a challenge, no session cookie', async () => {
    const res = await login(a.email);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ twoFactorRequired: true, challenge: expect.any(String), expiresAt: expect.any(String) });
    expect(setCookies(res).some(c => /we360_session=[^;]/.test(c))).toBe(false);
    expect(Date.parse(res.body.data.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 1000);
    expect((await login(a.email, 'WrongPass123')).status).toBe(401); // a wrong password still says nothing about two-factor
    expect((await login(a.email, 'WrongPass123')).body.data).toBeUndefined();
  });

  it('a code from the app completes sign-in once; the same code cannot be used again', async () => {
    const first = await login(a.email);
    const code = codeAt(secret, 1);
    const ok = await secondStep({ challenge: first.body.data.challenge, code });
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.id).toBe(a.userId);
    expect((await request(app).get('/api/auth/me').set(bearer(sessionToken(ok)))).status).toBe(200);
    const again = await secondStep({ challenge: (await login(a.email)).body.data.challenge, code });
    expect([again.status, again.body.code]).toEqual([401, 'TWO_FACTOR_INVALID']);
    // An older code is refused once a newer one was used.
    expect((await secondStep({ challenge: (await login(a.email)).body.data.challenge, code: codeAt(secret, 0) })).status).toBe(401);
  });

  it('a recovery code works once, in any letter case and with or without dashes', async () => {
    const code = recoveryCodes[0].toUpperCase().replace(/-/g, ' ');
    await signInWith(a, { recoveryCode: code });
    const again = await secondStep({ challenge: (await login(a.email)).body.data.challenge, recoveryCode: recoveryCodes[0] });
    expect(again.status).toBe(401);
    expect((await request(app).get('/api/auth/2fa').set(bearer(a.token))).body.data.recoveryCodesLeft).toBe(9);
  });

  it('refuses altered, expired or reused-after-change challenges, and requests with both or neither factor', async () => {
    const { challenge } = (await login(a.email)).body.data;
    const parts = challenge.split('.');
    const altered = [...parts.slice(0, 4), (parts[4][0] === 'A' ? 'B' : 'A') + parts[4].slice(1)].join('.');
    expect((await secondStep({ challenge: altered, code: codeAt(secret, 1) })).body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    const expired = issueChallenge(a.userId, Date.now() - 6 * 60_000).challenge;
    expect((await secondStep({ challenge: expired, code: codeAt(secret, 1) })).body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
    expect((await secondStep({ challenge, code: '123456', recoveryCode: recoveryCodes[1] })).status).toBe(400);
    expect((await secondStep({ challenge })).status).toBe(400);
    // Another user's id in the challenge does not verify.
    const forged = ['v1', Buffer.from('user-someone').toString('base64url'), ...parts.slice(2)].join('.');
    expect(verifyChallenge(forged)).toBeNull();
  });

  it('a challenge stops working when the password changes', async () => {
    const b = await account('pwchange');
    const { secret: s } = await enable(b);
    const { challenge } = (await login(b.email)).body.data;
    const changed = await request(app).put('/api/auth/password').set(bearer(b.token)).send({ currentPassword: PASSWORD, newPassword: 'NewerPass456', confirmPassword: 'NewerPass456' });
    expect(changed.status).toBe(200);
    expect((await secondStep({ challenge, code: codeAt(s, 1) })).body.code).toBe('TWO_FACTOR_CHALLENGE_INVALID');
  });

  it('wrong codes are rate limited per account, even when the right code follows', async () => {
    const c = await account('limit');
    const { secret: s } = await enable(c);
    process.env.RATE_LIMITS = 'on';
    rateLimitTesting.reset();
    try {
      const { challenge } = (await login(c.email)).body.data;
      const right = codeAt(s, 1);
      const wrong = right === '000000' ? '111111' : '000000';
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await secondStep({ challenge, code: wrong })).status);
      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      expect((await secondStep({ challenge, code: right })).status).toBe(429);
    } finally {
      process.env.RATE_LIMITS = 'off';
      rateLimitTesting.reset();
    }
  });
});

describe('turning it off and replacing recovery codes', () => {
  it('needs the password and a code; a wrong password does not use up a recovery code', async () => {
    const a = await account('off');
    const { secret, recoveryCodes } = await enable(a);
    const other = await signInWith(a, { code: codeAt(secret, 1) });
    const wrongPw = await request(app).post('/api/auth/2fa/disable').set(bearer(a.token)).send({ password: 'WrongPass123', recoveryCode: recoveryCodes[0] });
    expect(wrongPw.status).toBe(400);
    expect((await request(app).get('/api/auth/2fa').set(bearer(a.token))).body.data.recoveryCodesLeft).toBe(10);
    expect((await request(app).post('/api/auth/2fa/disable').set(bearer(a.token)).send({ password: PASSWORD })).status).toBe(400);
    expect((await request(app).post('/api/auth/2fa/disable').set(bearer(a.token)).send({ password: PASSWORD, code: '12345' })).status).toBe(400);

    const off = await request(app).post('/api/auth/2fa/disable').set(bearer(a.token)).send({ password: PASSWORD, recoveryCode: recoveryCodes[0] });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(other))).status).toBe(401); // other sessions ended
    expect(db.prepare('SELECT COUNT(*) c FROM user_two_factor WHERE user_id = ?').get(a.userId)).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM user_recovery_codes WHERE user_id = ?').get(a.userId)).toEqual({ c: 0 });
    const plain = await login(a.email);
    expect([plain.status, plain.body.data.twoFactorRequired]).toEqual([200, undefined]);
    expect((await request(app).post('/api/auth/2fa/disable').set(bearer(a.token)).send({ password: PASSWORD, code: '123456' })).status).toBe(409);
  });

  it('new recovery codes replace the old ones', async () => {
    const a = await account('regen');
    const { secret, recoveryCodes } = await enable(a);
    const res = await request(app).post('/api/auth/2fa/recovery-codes').set(bearer(a.token)).send({ password: PASSWORD, code: codeAt(secret, 1) });
    expect(res.status).toBe(200);
    expect(res.body.data.recoveryCodes).toHaveLength(10);
    expect(res.body.data.recoveryCodes).not.toContain(recoveryCodes[1]);
    expect((await secondStep({ challenge: (await login(a.email)).body.data.challenge, recoveryCode: recoveryCodes[1] })).status).toBe(401);
    await signInWith(a, { recoveryCode: res.body.data.recoveryCodes[0] });
  });
});

describe('administrator reset for a staff member', () => {
  it('only an administrator of the same business can reset it; the staff member is signed out', async () => {
    const owner = await account('owner');
    const outsider = await account('outsider');
    const h = bearer(owner.token);
    const staffId = (await request(app).post('/api/staff').set(h).send({ name: 'Locked Out', email: `locked-${RUN}@example.com` })).body.data.id;
    const userId = `user-${nanoid(8)}`;
    const email = `locked-${RUN}@example.com`;
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(userId, owner.orgId, email, bcrypt.hashSync(PASSWORD, 4), 'Locked Out', 'staff', staffId);
    const staff: Account = { email, userId, orgId: owner.orgId, token: sessionToken(await login(email)) };
    const { secret } = await enable(staff);
    const managerId = `user-${nanoid(8)}`;
    const managerEmail = `mgr-${RUN}@example.com`;
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(managerId, owner.orgId, managerEmail, bcrypt.hashSync(PASSWORD, 4), 'Manager', 'manager');
    const manager = bearer(sessionToken(await login(managerEmail)));

    const list = await request(app).get('/api/staff').set(h);
    expect(list.body.data.find((s: { id: string }) => s.id === staffId).account).toMatchObject({ status: 'active', twoFactor: true });
    expect((await request(app).post(`/api/staff/${staffId}/two-factor/reset`).set(manager)).status).toBe(403);
    expect((await request(app).post(`/api/staff/${staffId}/two-factor/reset`).set(bearer(outsider.token))).status).toBe(404);
    expect((await request(app).post(`/api/staff/${staffId}/two-factor/reset`).set(bearer(staff.token))).status).toBe(403);
    expect((await secondStep({ challenge: (await login(email)).body.data.challenge, code: codeAt(secret, 1) })).status).toBe(200);

    expect((await request(app).post(`/api/staff/${staffId}/two-factor/reset`).set(h)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set(bearer(staff.token))).status).toBe(401);
    expect((await login(email)).body.data.twoFactorRequired).toBeUndefined();
    expect((await request(app).post(`/api/staff/${staffId}/two-factor/reset`).set(h)).status).toBe(409);
  });
});
