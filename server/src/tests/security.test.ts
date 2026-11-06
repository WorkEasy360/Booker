// Sessions, CSRF and origin checks, rate limits (including recovery), production configuration and error handling.
// Runs against the isolated per-file test database from jest.setup.js; every record is synthetic.

import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index';
import db from '../db/init';
import { readSecurityConfig } from '../config/security';
import { RULES, consume, clientKey, rateLimitTesting } from '../middleware/rate-limit';
import { sessionToken, sessionCookie, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

// Sign-in tests run real bcrypt (cost 12) many times; give them room.
jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const PASSWORD = 'TestPass123';
const APP_ORIGIN = 'http://localhost:5173';

async function signup(label: string) {
  const email = `sec-${label}-${RUN}@example.com`;
  const res = await signUpAndSignIn(app, {
    name: `Sec ${label}`, email, company: `Sec Org ${label} ${RUN}`, password: PASSWORD, confirmPassword: PASSWORD,
  });
  expect(res.status).toBe(200);
  return { email, token: sessionToken(res), cookie: sessionCookie(res), csrf: res.body.data.csrfToken as string, userId: res.body.data.user.id as string };
}

const login = (email: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ email, password });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// ─── Production configuration ────────────────────────────────────────────────

describe('production configuration validation', () => {
  const STRONG = 'k3J9xQ2mZ7vB4nW8pL1rT6yH5cF0dS9aG2hJ4kL7zX3vB8nM1qW5eR0tY6uI2oP';
  const good = {
    NODE_ENV: 'production', JWT_SECRET: STRONG, CORS_ORIGIN: 'https://app.example.com',
    PUBLIC_APP_URL: 'https://book.example.com', TRUST_PROXY: '1', EMAIL_TRANSPORT: 'smtp',
  };

  it('accepts a complete, safe production setup and hardens the cookie', () => {
    const cfg = readSecurityConfig(good);
    expect(cfg.cookieName).toBe('__Host-we360_session');
    expect(cfg.cookieSecure).toBe(true);
    expect(cfg.allowedOrigins).toEqual(['https://app.example.com', 'https://book.example.com']);
    expect(cfg.trustProxy).toBe(1);
  });

  it.each([
    ['missing JWT_SECRET', { JWT_SECRET: undefined }, /JWT_SECRET is required/],
    ['short JWT_SECRET', { JWT_SECRET: 'Short-but-Varied-123' }, /at least 32 characters/],
    ['placeholder JWT_SECRET', { JWT_SECRET: 'replace_with_a_long_random_secret_at_least_64_chars' }, /placeholder/],
    ['low-variety JWT_SECRET', { JWT_SECRET: 'a'.repeat(64) }, /too little variety/],
    ['missing CORS_ORIGIN', { CORS_ORIGIN: undefined }, /CORS_ORIGIN is required/],
    ['wildcard CORS_ORIGIN', { CORS_ORIGIN: '*' }, /cannot be "\*"/],
    ['http CORS_ORIGIN', { CORS_ORIGIN: 'http://app.example.com' }, /must use https/],
    ['CORS_ORIGIN with a path', { CORS_ORIGIN: 'https://app.example.com/admin' }, /no path/],
    ['missing PUBLIC_APP_URL', { PUBLIC_APP_URL: undefined }, /PUBLIC_APP_URL is required/],
    ['http PUBLIC_APP_URL', { PUBLIC_APP_URL: 'http://book.example.com' }, /PUBLIC_APP_URL must use https/],
    ['bad session lifetime', { JWT_EXPIRES_IN: '7 weeks' }, /JWT_EXPIRES_IN/],
    ['session lifetime too long', { JWT_EXPIRES_IN: '90d' }, /between 5 minutes and 30 days/],
  ])('refuses to start with %s', (_label, override, message) => {
    expect(() => readSecurityConfig({ ...good, ...override } as NodeJS.ProcessEnv)).toThrow(message);
  });

  it('never repeats the secret value in its error messages', () => {
    const secret = 'replace_with_a_long_random_secret_at_least_64_chars';
    try { readSecurityConfig({ ...good, JWT_SECRET: secret }); throw new Error('expected a configuration error'); }
    catch (e) { expect((e as Error).message).not.toContain(secret); }
  });

  it('warns about a missing proxy setting and disabled email in production', () => {
    const cfg = readSecurityConfig({ ...good, TRUST_PROXY: undefined, EMAIL_TRANSPORT: 'disabled' });
    expect(cfg.warnings.join(' ')).toMatch(/TRUST_PROXY is not set/);
    expect(cfg.warnings.join(' ')).toMatch(/EMAIL_TRANSPORT is disabled/);
  });

  it('only warns (does not stop) in development, and keeps a non-prefixed, non-Secure cookie for http://localhost', () => {
    const cfg = readSecurityConfig({ NODE_ENV: 'development', JWT_SECRET: 'replace_with_a_long_random_secret_at_least_64_chars' });
    expect(cfg.warnings.join(' ')).toMatch(/placeholder/);
    expect(cfg.cookieName).toBe('we360_session');
    expect(cfg.cookieSecure).toBe(false);
    expect(cfg.allowedOrigins).toEqual([APP_ORIGIN]);
  });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

describe('server-side sessions', () => {
  it('never returns the session token in the body and sets a HttpOnly, SameSite=Lax, path-wide cookie', async () => {
    const u = await signup('cookie');
    const res = await login(u.email);
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.user.permissions).toContain('settings:write');
    const raw = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('we360_session='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
    expect(raw).not.toMatch(/;\s*Secure/i); // plain http in tests; production adds Secure and the __Host- prefix
  });

  it('logout revokes the session on the server: a copied cookie or bearer token stops working', async () => {
    const u = await signup('logout');
    expect((await request(app).get('/api/auth/me').set('Cookie', u.cookie)).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set('Cookie', u.cookie)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', u.cookie)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
  });

  it('changing the password ends every other session but keeps the current one', async () => {
    const u = await signup('password');
    const other = sessionToken(await login(u.email));
    const res = await request(app).put('/api/auth/password').set(bearer(u.token))
      .send({ currentPassword: PASSWORD, newPassword: 'NewerPass456' });
    expect(res.status).toBe(200);
    expect(res.body.data.otherSessionsEnded).toBe(1);
    expect((await request(app).get('/api/auth/me').set(bearer(other))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(200);
  });

  it('a deactivated user is signed out immediately', async () => {
    const u = await signup('deactivate');
    db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(u.userId);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
    expect((await login(u.email)).status).toBe(401);
  });

  it('role changes apply on the next request, without signing in again', async () => {
    const u = await signup('demote');
    const svc = { name: 'Before Demotion', category: 'consultation', duration: 30, price: 10 };
    expect((await request(app).post('/api/services').set(bearer(u.token)).send(svc)).status).toBe(201);
    db.prepare("UPDATE users SET role = 'staff' WHERE id = ?").run(u.userId);
    expect((await request(app).post('/api/services').set(bearer(u.token)).send(svc)).status).toBe(403);
    const me = await request(app).get('/api/auth/me').set(bearer(u.token));
    expect(me.body.data.role).toBe('staff');
    expect(me.body.data.permissions).not.toContain('services:write');
  });

  it('rejects tokens from before server-side sessions, forged tokens and expired sessions', async () => {
    const u = await signup('tokens');
    const secret = process.env.JWT_SECRET!;
    const orgId = (db.prepare('SELECT organization_id FROM users WHERE id = ?').get(u.userId) as { organization_id: string }).organization_id;
    const legacy = jwt.sign({ sub: u.userId, email: u.email, orgId, role: 'admin' }, secret, { expiresIn: '1h' });
    expect((await request(app).get('/api/auth/me').set(bearer(legacy))).status).toBe(401);

    const { sid } = jwt.decode(u.token) as { sid: string };
    const otherKey = jwt.sign({ sub: u.userId, sid }, 'a-different-secret-that-is-long-enough-1234567890', { expiresIn: '1h' });
    expect((await request(app).get('/api/auth/me').set(bearer(otherKey))).status).toBe(401);
    const unsigned = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: u.userId, sid })).toString('base64url')}.`;
    expect((await request(app).get('/api/auth/me').set(bearer(unsigned))).status).toBe(401);

    db.prepare("UPDATE user_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(sid);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
  });

  it('a session is tied to its organization', async () => {
    const u = await signup('moved');
    const other = await signup('target');
    const otherOrg = (db.prepare('SELECT organization_id FROM users WHERE id = ?').get(other.userId) as { organization_id: string }).organization_id;
    db.prepare('UPDATE users SET organization_id = ? WHERE id = ?').run(otherOrg, u.userId);
    expect((await request(app).get('/api/auth/me').set(bearer(u.token))).status).toBe(401);
  });
});

// ─── CSRF and origins ────────────────────────────────────────────────────────

describe('CSRF protection for cookie sessions', () => {
  let u: Awaited<ReturnType<typeof signup>>;
  beforeAll(async () => { u = await signup('csrf'); });
  const customer = (n: string) => ({ name: `Csrf ${n}`, email: `csrf-${n}-${RUN}@example.com` });

  it('refuses a cookie-authenticated change without the CSRF token', async () => {
    const res = await request(app).post('/api/customers').set('Cookie', u.cookie).send(customer('none'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_FAILED');
  });

  it("refuses another session's CSRF token", async () => {
    const other = await signup('csrf-other');
    const res = await request(app).post('/api/customers').set('Cookie', u.cookie).set('X-CSRF-Token', other.csrf).send(customer('foreign'));
    expect(res.status).toBe(403);
  });

  it('accepts the matching token, and /auth/me returns the same token after a page reload', async () => {
    const me = await request(app).get('/api/auth/me').set('Cookie', u.cookie);
    expect(me.body.data.csrfToken).toBe(u.csrf);
    const res = await request(app).post('/api/customers').set('Cookie', u.cookie).set('X-CSRF-Token', u.csrf).send(customer('ok'));
    expect(res.status).toBe(201);
  });

  it('applies to updates and deletes too, but not to reads', async () => {
    const id = (await request(app).post('/api/customers').set(bearer(u.token)).send(customer('target'))).body.data.id;
    expect((await request(app).get(`/api/customers/${id}`).set('Cookie', u.cookie)).status).toBe(200);
    expect((await request(app).put(`/api/customers/${id}`).set('Cookie', u.cookie).send({ notes: 'x' })).status).toBe(403);
    expect((await request(app).delete(`/api/customers/${id}`).set('Cookie', u.cookie)).status).toBe(403);
    expect((await request(app).delete(`/api/customers/${id}`).set('Cookie', u.cookie).set('X-CSRF-Token', u.csrf)).status).toBe(200);
  });

  it('bearer tokens need no CSRF token (browsers never attach them automatically)', async () => {
    expect((await request(app).post('/api/customers').set(bearer(u.token)).send(customer('bearer'))).status).toBe(201);
  });
});

describe('cross-site request rejection', () => {
  let u: Awaited<ReturnType<typeof signup>>;
  beforeAll(async () => { u = await signup('origin'); });
  const post = () => request(app).post('/api/customers').set(bearer(u.token));

  it.each([
    ['another website', { Origin: 'https://evil.example' }],
    ['an opaque origin', { Origin: 'null' }],
    ['a foreign Referer without Origin', { Referer: 'https://evil.example/page' }],
  ])('refuses a change sent from %s', async (_label, headers) => {
    const res = await post().set(headers).send({ name: 'X Site', email: `x-${Math.random()}@example.com` });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('refuses public bookings and lookups sent from another website', async () => {
    expect((await request(app).post('/api/public/book').set('Origin', 'https://evil.example').send({})).status).toBe(403);
    expect((await request(app).post('/api/public/appointments/lookup').set('Origin', 'https://evil.example').send({})).status).toBe(403);
  });

  it('accepts the app origin (and its loopback alias in development)', async () => {
    for (const origin of [APP_ORIGIN, 'http://127.0.0.1:5173']) {
      const res = await post().set('Origin', origin).send({ name: 'Same Site', email: `same-${Math.random()}@example.com` });
      expect(res.status).toBe(201);
    }
  });

  it('only grants CORS to the app origin', async () => {
    const ok = await request(app).get('/api/health').set('Origin', APP_ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ─── Rate limits ─────────────────────────────────────────────────────────────

describe('rate limits', () => {
  let now = Date.now();
  beforeAll(() => {
    process.env.RATE_LIMITS = 'on';
    rateLimitTesting.setClock(() => now);
  });
  afterAll(() => {
    process.env.RATE_LIMITS = 'off';
    rateLimitTesting.setClock(null);
    rateLimitTesting.reset();
  });
  beforeEach(() => { rateLimitTesting.reset(); now = Date.now(); });
  const advance = (ms: number) => { now += ms; };

  it('locks an account on this network after 5 failed sign-ins, even for the right password, and recovers after 15 minutes', async () => {
    const u = await signup('lock');
    for (let i = 0; i < 5; i++) expect((await login(u.email, 'WrongPass999')).status).toBe(401);
    const locked = await login(u.email);
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('RATE_LIMITED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    advance(15 * 60_000 + 1);
    expect((await login(u.email)).status).toBe(200);
  });

  it('a successful sign-in clears earlier failures; successful sign-ins never count', async () => {
    const u = await signup('clear');
    for (let i = 0; i < 4; i++) expect((await login(u.email, 'WrongPass999')).status).toBe(401);
    expect((await login(u.email)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(u.email, 'WrongPass999')).status).toBe(401);
    expect((await login(u.email)).status).toBe(200);
    // A shared office network: many successful sign-ins from one address are never throttled.
    for (let i = 0; i < 8; i++) expect((await login(u.email)).status).toBe(200);
  });

  it('failures for one account do not lock other accounts on the same network', async () => {
    const a = await signup('neighbour-a');
    const b = await signup('neighbour-b');
    for (let i = 0; i < 5; i++) await login(a.email, 'WrongPass999');
    expect((await login(a.email)).status).toBe(429);
    expect((await login(b.email)).status).toBe(200);
  });

  it('someone guessing passwords from other addresses cannot lock the owner out of a browser they already use', async () => {
    const owner = await signup('owner-dos');
    const other = await signup('other-dos');
    const ownerBrowser = await login(owner.email);
    expect(ownerBrowser.status).toBe(200);
    const deviceCookie = ([] as string[]).concat(ownerBrowser.headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('we360_device='))!;
    expect(deviceCookie).toMatch(/HttpOnly/i);
    expect(deviceCookie).toMatch(/SameSite=Lax/i);
    const known = deviceCookie.split(';')[0];
    const otherDevice = ([] as string[]).concat((await login(other.email)).headers['set-cookie'] as unknown as string[]).find(c => c.startsWith('we360_device='))!.split(';')[0];

    app.set('trust proxy', true); // simulate attackers on many addresses
    try {
      // 20 wrong passwords from four addresses (5 each, the per-address limit).
      for (let i = 0; i < 20; i++) {
        expect((await login(owner.email, 'WrongPass999').set('X-Forwarded-For', `203.0.113.${10 + Math.floor(i / 5)}`)).status).toBe(401);
      }
      // A new device is now refused for an hour, even with the right password…
      expect((await login(owner.email).set('X-Forwarded-For', '198.51.100.20')).status).toBe(429);
      // …and neither a forged device cookie nor another account's real one helps.
      const forged = known.replace(/.$/, c => (c === 'A' ? 'B' : 'A'));
      expect((await login(owner.email).set('X-Forwarded-For', '198.51.100.21').set('Cookie', forged)).status).toBe(429);
      expect((await login(owner.email).set('X-Forwarded-For', '198.51.100.22').set('Cookie', otherDevice)).status).toBe(429);
      // The owner's own browser still signs in normally.
      expect((await login(owner.email).set('X-Forwarded-For', '192.0.2.50').set('Cookie', known)).status).toBe(200);
    } finally {
      app.set('trust proxy', false);
    }
  });

  it('ignores a spoofed X-Forwarded-For unless TRUST_PROXY is configured', async () => {
    const u = await signup('spoof');
    for (let i = 0; i < 5; i++) {
      await login(u.email, 'WrongPass999').set('X-Forwarded-For', `203.0.113.${i}`);
    }
    expect((await login(u.email).set('X-Forwarded-For', '198.51.100.7')).status).toBe(429);
  });

  it('limits signups per network to 10 an hour', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await request(app).post('/api/auth/signup').send({
        name: 'Burst', email: `burst-${i}-${RUN}@example.com`, company: `Burst ${i}`, password: PASSWORD, confirmPassword: PASSWORD,
      })).status);
    }
    expect(statuses.slice(0, 10).every(s => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
    advance(60 * 60_000 + 1);
    expect((await request(app).post('/api/auth/signup').send({
      name: 'After', email: `after-${RUN}@example.com`, company: 'After', password: PASSWORD, confirmPassword: PASSWORD,
    })).status).toBe(202);
  });

  it('limits signups for one address to 3 an hour, from any network', async () => {
    app.set('trust proxy', true); // simulate requests from different addresses
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push((await request(app).post('/api/auth/signup').set('X-Forwarded-For', `203.0.113.${40 + i}`).send({
          name: 'Same', email: `same-address-${RUN}@example.com`, company: `Same ${i}`, password: PASSWORD, confirmPassword: PASSWORD,
        })).status);
      }
      expect(statuses).toEqual([202, 202, 202, 429]);
    } finally {
      app.set('trust proxy', false);
    }
  });

  it('limits wrong current-password attempts on password change', async () => {
    const u = await signup('pwlimit');
    for (let i = 0; i < 5; i++) {
      expect((await request(app).put('/api/auth/password').set(bearer(u.token)).send({ currentPassword: 'Nope1234', newPassword: 'Another123' })).status).toBe(400);
    }
    expect((await request(app).put('/api/auth/password').set(bearer(u.token)).send({ currentPassword: PASSWORD, newPassword: 'Another123' })).status).toBe(429);
  });

  describe('public booking, lookup and self-service changes', () => {
    let org: Awaited<ReturnType<typeof signup>>;
    let serviceId = '';
    let staffId = '';
    let date = '';
    const EVERY_DAY = Object.fromEntries(
      ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
    );
    beforeAll(async () => {
      org = await signup('public');
      serviceId = (await request(app).post('/api/services').set(bearer(org.token))
        .send({ name: 'Limited', category: 'consultation', duration: 30, price: 5, maxAdvance: 365 })).body.data.id;
      staffId = (await request(app).post('/api/staff').set(bearer(org.token))
        .send({ name: 'Limit Staff', email: `limit-staff-${RUN}@example.com`, serviceIds: [serviceId], workingHours: EVERY_DAY })).body.data.id;
      await publishBookingPage(app, bearer(org.token), [serviceId], 'limits');
      const d = new Date(); d.setDate(d.getDate() + 30); date = d.toISOString().slice(0, 10);
    });
    const book = (startTime: string, email: string) => request(app).post('/api/public/book').send({
      serviceId, staffId, date, startTime, customer: { name: 'Limit Lou', email, phone: '+91 98765 40100' },
    });

    it('limits bookings to one email address (5 an hour), so confirmations cannot be used to flood an inbox', async () => {
      const email = `flood-${RUN}@example.com`;
      const times = ['08:00', '08:30', '09:00', '09:30', '10:00', '10:30'];
      const statuses = [];
      for (const t of times) statuses.push((await book(t, email)).status);
      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
      expect((await book('11:00', `someone-else-${RUN}@example.com`)).status).toBe(201);
      advance(60 * 60_000 + 1);
      expect((await book('10:30', email)).status).toBe(201);
    });

    it('limits failed lookups per reference and per network; successful lookups do not count', async () => {
      const email = `lookup-${RUN}@example.com`;
      const booked = await book('12:00', email);
      const ref = booked.body.data.bookingRef;
      for (let i = 0; i < 3; i++) expect((await request(app).post('/api/public/appointments/lookup').send({ ref, email })).status).toBe(200);
      for (let i = 0; i < 5; i++) expect((await request(app).post('/api/public/appointments/lookup').send({ ref, email: `wrong${i}@example.com` })).status).toBe(404);
      // Locked for this reference, even with the right email, until the window passes.
      expect((await request(app).post('/api/public/appointments/lookup').send({ ref, email })).status).toBe(429);
      advance(15 * 60_000 + 1);
      expect((await request(app).post('/api/public/appointments/lookup').send({ ref, email })).status).toBe(200);
      // Guessing many references from one network: 10 failures, then refused.
      const statuses = [];
      for (let i = 0; i < 11; i++) statuses.push((await request(app).post('/api/public/appointments/lookup').send({ ref: `WE-GUESS${i}`, email })).status);
      expect(statuses.slice(0, 10).every(s => s === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it('limits self-service changes to one booking (6 an hour)', async () => {
      const booked = await book('14:00', `mover-${RUN}@example.com`);
      const token = booked.body.data.manageToken;
      const statuses = [];
      for (const t of ['14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30']) {
        statuses.push((await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', token).send({ date, startTime: t })).status);
      }
      expect(statuses.slice(0, 6).every(s => s === 200)).toBe(true);
      expect(statuses[6]).toBe(429);
    });

    it('limits email resends per appointment', async () => {
      const customerId = (await request(app).post('/api/customers').set(bearer(org.token))
        .send({ name: 'Resend Rae', email: `resend-${RUN}@example.com` })).body.data.id;
      const appt = await request(app).post('/api/appointments').set(bearer(org.token))
        .send({ serviceId, staffId, customerId, date, startTime: '18:00' });
      expect(appt.status).toBe(201);
      const resend = () => request(app).post(`/api/appointments/${appt.body.data.id}/emails`).set(bearer(org.token)).send({ kind: 'confirmation' });
      expect([(await resend()).status, (await resend()).status, (await resend()).status]).toEqual([200, 200, 200]);
      expect((await resend()).status).toBe(429);
      advance(10 * 60_000 + 1);
      expect((await resend()).status).toBe(200);
    });
  });

  it('records attempts up front, so parallel requests cannot overshoot a limit', () => {
    const rule = { id: `test-parallel-${RUN}`, limit: 3, windowMs: 60_000 };
    const results = Array.from({ length: 6 }, () => consume([{ rule, key: 'k' }]).allowed);
    expect(results).toEqual([true, true, true, false, false, false]);
  });

  it('refunds attempts that turned out to be legitimate', () => {
    const rule = { id: `test-refund-${RUN}`, limit: 2, windowMs: 60_000 };
    for (let i = 0; i < 5; i++) consume([{ rule, key: 'k' }]).refund();
    expect(consume([{ rule, key: 'k' }]).allowed).toBe(true);
  });

  it('groups IPv6 clients by /64 network and unwraps IPv4-mapped addresses', () => {
    const key = (ip: string) => clientKey({ ip, socket: {} } as unknown as import('express').Request);
    expect(key('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe(key('2001:db8:1:2::1'));
    expect(key('2001:db8:1:3::1')).not.toBe(key('2001:db8:1:2::1'));
    expect(key('::ffff:198.51.100.4')).toBe('198.51.100.4');
  });

  it('covers every endpoint the brief names', () => {
    expect(Object.keys(RULES)).toEqual(expect.arrayContaining([
      'loginAccountIp', 'loginIp', 'loginAccount', 'signupIp', 'bookIp', 'bookEmail', 'lookupIp', 'lookupRef', 'manageIp', 'manageBooking', 'resendAppointment',
    ]));
  });
});

// ─── Error handling ──────────────────────────────────────────────────────────

describe('error handling', () => {
  it('malformed JSON is a 400, not a 500', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email": ');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid JSON/);
  });

  it('oversized bodies are refused with 413', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'a@example.com', password: 'x'.repeat(150_000) });
    expect(res.status).toBe(413);
  });

  it('unknown API paths return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('the old reference-only booking endpoints no longer exist', async () => {
    expect((await request(app).get('/api/public/appointments/WE-ABCDEFGH')).status).toBe(404);
    expect((await request(app).post('/api/public/appointments/WE-ABCDEFGH/cancel').send({})).status).toBe(404);
    expect((await request(app).post('/api/public/appointments/WE-ABCDEFGH/reschedule').send({})).status).toBe(404);
  });
});
