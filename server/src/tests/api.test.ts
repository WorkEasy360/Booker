// Environment variables are set by jest.setup.js (loaded via setupFiles)
// before any module is imported, so DB_PATH and JWT_SECRET are correct
// when db/init.ts and index.ts are first required.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { sessionToken, verificationTokenFor } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

let token = '';

// Unique suffix per run — prevents email collisions when test.db is reused
const RUN_ID = Date.now().toString(36);
// Booking tests use dates that may fall on weekends; staff must be scheduled every day for them.
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);
const signupEmail = `newuser-${RUN_ID}@example.com`;
const testCustomerEmail = `jane-${RUN_ID}@example.com`;

beforeAll(async () => {
  const bcrypt = await import('bcryptjs');
  const { nanoid } = await import('nanoid');

  // Ensure org exists
  if (!db.prepare('SELECT id FROM organizations WHERE id = ?').get('org-1')) {
    db.prepare(`INSERT INTO organizations (id, name, email) VALUES ('org-1','Test Org','test@example.com')`).run();
  }

  // Ensure admin user exists
  const email = process.env.ADMIN_EMAIL!.toLowerCase();
  if (!db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD!, 10);
    db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?,?,?,?,?,?)`)
      .run(`user-${nanoid(8)}`, 'org-1', email, hash, 'Test Admin', 'admin');
  }
});

// The DB connection is closed by jest.teardown.ts after each suite.
// The test.db file is kept for inspection; delete manually if needed.

// ─── Auth ──────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('rejects invalid credentials with 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'bad@bad.com', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 for malformed input', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('signs in with a session cookie and never returns the token in the body', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeUndefined();
    expect(res.body.data.csrfToken).toEqual(expect.any(String));
    token = sessionToken(res);
  });
});

describe('GET /api/auth/me', () => {
  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns user info with valid token', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(process.env.ADMIN_EMAIL!.toLowerCase());
  });
});

// ─── Health ────────────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('answers 503 without details when the database does not respond', async () => {
    const spy = jest.spyOn(db, 'prepare').mockImplementationOnce(() => { throw new Error('SQLITE_IOERR: disk I/O error at /var/data/workeasy360.db'); });
    try {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('unavailable');
      expect(JSON.stringify(res.body)).not.toMatch(/SQLITE|disk|\/var/);
    } finally { spy.mockRestore(); }
  });
});

// ─── Signup ───────────────────────────────────────────────────────────────────

let newUserToken = '';

describe('POST /api/auth/signup', () => {
  it('emails a confirmation link and signs nobody in; the account exists only once the link is used', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'New User',
      email: signupEmail,
      company: 'New Co',
      password: 'NewPass123!',
      confirmPassword: 'NewPass123!',
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { message: 'We’ll send an email with the next steps if the address can be used for this request.' } });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM users WHERE email = ?').get(signupEmail)).toBeUndefined();
    const verified = await request(app).post('/api/auth/verify-email').send({ token: await verificationTokenFor(signupEmail) });
    expect(verified.status).toBe(201);
    expect(verified.headers['set-cookie']).toBeUndefined(); // no automatic sign-in
    const login = await request(app).post('/api/auth/login').send({ email: signupEmail, password: 'NewPass123!' });
    expect(login.status).toBe(200);
    newUserToken = sessionToken(login);
  });

  it('answers an already-registered address exactly like a new one', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Dup User',
      email: signupEmail, // created by the previous test in this suite
      company: 'Another Co',
      password: 'NewPass123!',
      confirmPassword: 'NewPass123!',
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { message: 'We’ll send an email with the next steps if the address can be used for this request.' } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(signupEmail)).toEqual({ n: 1 });
  });

  it('rejects mismatched passwords', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Mismatch',
      email: 'mismatch@example.com',
      company: 'Co',
      password: 'Pass123!',
      confirmPassword: 'Different1!',
    });
    expect(res.status).toBe(400);
  });

  it('rejects weak password', async () => {
    const res = await request(app).post('/api/auth/signup').send({
      name: 'Weak',
      email: 'weak@example.com',
      company: 'Co',
      password: 'short',
      confirmPassword: 'short',
    });
    expect(res.status).toBe(400);
  });

  it('newly registered user can log in', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: signupEmail,
      password: 'NewPass123!',
    });
    expect(res.status).toBe(200);
    expect(sessionToken(res)).toEqual(expect.any(String));
  });

  it('newly registered user has a hashed password stored', () => {
    const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(signupEmail) as
      | { password_hash: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.password_hash).toMatch(/^\$2[ab]\$/);
    expect(row!.password_hash).not.toBe('NewPass123!');
  });
});

// ─── Authentication — HttpOnly cookie (Issue 3) ───────────────────────────────

describe('Authentication — HttpOnly cookie', () => {
  it('login sets an HttpOnly we360_session cookie', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
      .expect(200);

    const setCookies = (res.headers['set-cookie'] as string[] | string | undefined) ?? [];
    const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
    expect(cookies.some((c: string) => c.startsWith('we360_session='))).toBe(true);
    expect(cookies.some((c: string) => c.toLowerCase().includes('httponly'))).toBe(true);
  });

  it('accepts cookie auth without Authorization header', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });

    const raw = loginRes.headers['set-cookie'];
    const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
    const sessionCookie = setCookies.find((c: string) => c.startsWith('we360_session='))!;
    const cookieValue = sessionCookie.split(';')[0]; // "we360_session=<token>"

    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookieValue); // no Authorization header
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.email).toBe(process.env.ADMIN_EMAIL!.toLowerCase());
  });

  it('POST /api/auth/logout clears the session cookie', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD });

    const raw = loginRes.headers['set-cookie'];
    const setCookies: string[] = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
    const sessionCookie = setCookies.find((c: string) => c.startsWith('we360_session='))!;
    const cookieValue = sessionCookie.split(';')[0];

    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', cookieValue)
      .expect(200);

    // After logout the cookie should be cleared (Max-Age=0 or empty value)
    const rawClear = logoutRes.headers['set-cookie'];
    const clearCookies: string[] = Array.isArray(rawClear) ? rawClear : rawClear ? [rawClear as string] : [];
    expect(clearCookies.some((c: string) => c.startsWith('we360_session='))).toBe(true);
  });
});

// ─── Password change ──────────────────────────────────────────────────────────

describe('PUT /api/auth/password', () => {
  it('rejects wrong current password', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${newUserToken}`)
      .send({ currentPassword: 'WrongPass999!', newPassword: 'Changed456!' });
    expect(res.status).toBe(400);
  });

  it('rejects a weak new password', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${newUserToken}`)
      .send({ currentPassword: 'NewPass123!', newPassword: 'weak' });
    expect(res.status).toBe(400);
  });

  it('changes password successfully with correct current password', async () => {
    const res = await request(app)
      .put('/api/auth/password')
      .set('Authorization', `Bearer ${newUserToken}`)
      .send({ currentPassword: 'NewPass123!', newPassword: 'Changed456!' });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBeDefined();
  });

  it('can log in with the new password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: signupEmail, password: 'Changed456!' });
    expect(res.status).toBe(200);
    expect(sessionToken(res)).toEqual(expect.any(String));
  });
});

// ─── Services CRUD ─────────────────────────────────────────────────────────────

let createdServiceId = '';

describe('Services', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/services');
    expect(res.status).toBe(401);
  });

  it('creates a service', async () => {
    const res = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Service', category: 'consultation', duration: 30, price: 50, currency: 'USD' });
    expect(res.status).toBe(201);
    createdServiceId = res.body.data.id;
  });

  it('lists services and includes the created one', async () => {
    const res = await request(app).get('/api/services').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { id: string }) => s.id)).toContain(createdServiceId);
  });

  it('deletes a service', async () => {
    const res = await request(app).delete(`/api/services/${createdServiceId}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

// ─── Customers CRUD ────────────────────────────────────────────────────────────

let createdCustomerId = '';

describe('Customers', () => {
  it('creates a customer', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Jane Doe', email: testCustomerEmail });
    expect(res.status).toBe(201);
    createdCustomerId = res.body.data.id;
  });

  it('rejects duplicate email with 409', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Dup', email: testCustomerEmail });
    expect(res.status).toBe(409);
  });

  it('updates customer', async () => {
    const res = await request(app)
      .put(`/api/customers/${createdCustomerId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '+91 98765 43210' });
    expect(res.status).toBe(200);
    expect(res.body.data.phone).toBe('+91 98765 43210');
  });
});

// ─── Public booking — ref lookup security ──────────────────────────────────────

describe('Public booking ref lookup', () => {
  it('returns 404 for a non-existent ref — never exposes another booking', async () => {
    const res = await request(app).get('/api/public/appointments/WE-XXXXXXXX');
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });
});

// ─── Settings ──────────────────────────────────────────────────────────────────

describe('Settings', () => {
  it('returns org settings', async () => {
    const res = await request(app).get('/api/settings').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('org-1');
  });

  it('updates org name', async () => {
    const res = await request(app)
      .put('/api/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Test Org' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Test Org');
  });
});

// ─── Protected routes reject unauthenticated requests ─────────────────────────

describe('Auth guard', () => {
  it('rejects /api/appointments without token', async () => {
    const res = await request(app).get('/api/appointments');
    expect(res.status).toBe(401);
  });

  it('rejects /api/staff without token', async () => {
    const res = await request(app).get('/api/staff');
    expect(res.status).toBe(401);
  });
});

// ─── Booking integrity ─────────────────────────────────────────────────────────

describe('Booking integrity', () => {
  let bookingServiceId = '';
  let bookingStaffId   = '';
  let bookingCustId    = '';
  let firstApptId      = '';

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + 30);
  const testDate = futureDate.toISOString().split('T')[0]; // 30 days from now

  beforeAll(async () => {
    // Create a service
    const svcRes = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Booking-Test Service', category: 'consultation', duration: 60, price: 100, currency: 'USD' });
    bookingServiceId = svcRes.body.data.id;

    // Create a staff member
    const staffRes = await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Booking-Test Staff', email: `bookstaff-${RUN_ID}@example.com`, title: 'Tester', serviceIds: [bookingServiceId], workspaceIds: [], workingHours: EVERY_DAY });
    bookingStaffId = staffRes.body.data.id;

    // Create a customer
    const custRes = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Booking-Test Customer', email: `bookcust-${RUN_ID}@example.com` });
    bookingCustId = custRes.body.data.id;
  });

  it('rejects an appointment with a past date', async () => {
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId: bookingServiceId,
        staffId:   bookingStaffId,
        customerId: bookingCustId,
        date:      '2020-01-01',
        startTime: '10:00',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past/i);
  });

  it('creates the first appointment successfully', async () => {
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId:  bookingServiceId,
        staffId:    bookingStaffId,
        customerId: bookingCustId,
        date:       testDate,
        startTime:  '10:00',
      });
    expect(res.status).toBe(201);
    firstApptId = res.body.data.id;
    expect(firstApptId).toBeDefined();
  });

  it('rejects an overlapping appointment for the same staff member (409)', async () => {
    // 10:30 overlaps with 10:00–11:00
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId:  bookingServiceId,
        staffId:    bookingStaffId,
        customerId: bookingCustId,
        date:       testDate,
        startTime:  '10:30',
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer available/i);
  });

  it('allows an adjacent (non-overlapping) appointment immediately after', async () => {
    // 11:00 starts exactly when the first ends — no overlap
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId:  bookingServiceId,
        staffId:    bookingStaffId,
        customerId: bookingCustId,
        date:       testDate,
        startTime:  '11:00',
      });
    expect(res.status).toBe(201);
  });

  it('allows a same-time appointment for a different staff member', async () => {
    const staff2Res = await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Staff2', email: `staff2-${RUN_ID}@example.com`, title: 'Tester2', serviceIds: [bookingServiceId], workspaceIds: [], workingHours: EVERY_DAY });
    const staff2Id = staff2Res.body.data.id;

    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId:  bookingServiceId,
        staffId:    staff2Id,
        customerId: bookingCustId,
        date:       testDate,
        startTime:  '10:00',
      });
    expect(res.status).toBe(201);
  });

  it('allows a same-time appointment after cancelling the first', async () => {
    // Cancel the first appointment
    await request(app)
      .put(`/api/appointments/${firstApptId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'cancelled' });

    // Now the same slot should be bookable
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId:  bookingServiceId,
        staffId:    bookingStaffId,
        customerId: bookingCustId,
        date:       testDate,
        startTime:  '10:00',
      });
    expect(res.status).toBe(201);
    firstApptId = res.body.data.id; // update for reschedule test below
  });

  it('rejects rescheduling to a past date (400)', async () => {
    const res = await request(app)
      .put(`/api/appointments/${firstApptId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2020-06-15' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/past/i);
  });

  it('rejects a reschedule that conflicts with an existing appointment (409)', async () => {
    // Create a second appointment at 12:00 for the same staff
    const secondRes = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${token}`)
      .send({
        serviceId:  bookingServiceId,
        staffId:    bookingStaffId,
        customerId: bookingCustId,
        date:       testDate,
        startTime:  '12:00',
      });
    expect(secondRes.status).toBe(201);
    const secondId = secondRes.body.data.id;

    // Try to reschedule the first (10:00) to 12:30 — conflicts with 12:00–13:00
    const res = await request(app)
      .put(`/api/appointments/${firstApptId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ date: testDate, startTime: '12:30' });
    expect(res.status).toBe(409);

    // Cleanup: cancel second
    await request(app).put(`/api/appointments/${secondId}`).set('Authorization', `Bearer ${token}`).send({ status: 'cancelled' });
  });

  it('recomputes end_time when startTime is rescheduled', async () => {
    const res = await request(app)
      .put(`/api/appointments/${firstApptId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ startTime: '14:00' });
    expect(res.status).toBe(200);
    expect(res.body.data.endTime).toBe('15:00'); // 60-minute service
    expect(res.body.data.startTime).toBe('14:00');
  });

  it('concurrent duplicate booking: exactly one succeeds', async () => {
    const concDate = new Date();
    concDate.setDate(concDate.getDate() + 60);
    const concTestDate = concDate.toISOString().split('T')[0];

    const [r1, r2] = await Promise.all([
      request(app).post('/api/appointments').set('Authorization', `Bearer ${token}`)
        .send({ serviceId: bookingServiceId, staffId: bookingStaffId, customerId: bookingCustId, date: concTestDate, startTime: '09:00' }),
      request(app).post('/api/appointments').set('Authorization', `Bearer ${token}`)
        .send({ serviceId: bookingServiceId, staffId: bookingStaffId, customerId: bookingCustId, date: concTestDate, startTime: '09:00' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });
});

// ─── Input validation — phone, name length, XSS ────────────────────────────────

describe('Input validation — phone, name, XSS (Issues 4 & 9)', () => {
  it('rejects alphabetic phone on customer create (400)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Valid Name', email: `phone-bad-${RUN_ID}@example.com`, phone: 'abc' });
    expect(res.status).toBe(400);
  });

  it('accepts valid international phone on customer create', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Valid Name', email: `phone-ok-${RUN_ID}@example.com`, phone: '+44 20 7946 0958' });
    expect(res.status).toBe(201);
  });

  it('rejects XSS payload <img src=x onerror=alert(1)> in customer name (400)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '<img src=x onerror=alert(1)>', email: `xss-${RUN_ID}@example.com` });
    expect(res.status).toBe(400);
  });

  it('rejects name longer than 100 characters on customer create (400)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'A'.repeat(101), email: `longname-${RUN_ID}@example.com` });
    expect(res.status).toBe(400);
  });

  it('rejects whitespace-only name on customer create (400)', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '   ', email: `wsname-${RUN_ID}@example.com` });
    expect(res.status).toBe(400);
  });
});

// ─── Public booking — validation and concurrency (Issues 2, 4, 8, 9) ──────────

describe('Public booking — validation and concurrency', () => {
  let pubServiceId = '';
  let pubStaffId   = '';

  // Working hours that cover every day and a wide time window, so the test
  // slot (10:00) is always available regardless of what day-of-week the
  // test date falls on.
  const ALL_DAY_HOURS = Object.fromEntries(
    ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map(d => [
      d, { enabled: true, start: '00:00', end: '23:30' },
    ])
  );

  // Use a date far enough in the future that no other test occupies it.
  // Offset by 80 days (distinct from the admin concurrency test at 60 days).
  const pubDate = new Date();
  pubDate.setDate(pubDate.getDate() + 80);
  const pubTestDate = pubDate.toISOString().split('T')[0];

  beforeAll(async () => {
    const svcRes = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Pub-Test Svc', category: 'consultation', duration: 60, price: 0, currency: 'USD', maxAdvance: 365 });
    pubServiceId = svcRes.body.data.id;

    const staffRes = await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Pub-Test Staff',
        email: `pubstaff-${RUN_ID}@example.com`,
        title: 'Tester',
        serviceIds: [pubServiceId],
        workspaceIds: [],
        workingHours: ALL_DAY_HOURS,
      });
    pubStaffId = staffRes.body.data.id;
    await publishBookingPage(app, { Authorization: `Bearer ${token}` }, [pubServiceId], 'pub');
  });

  it('rejects alphabetic phone in public booking (400)', async () => {
    const res = await request(app)
      .post('/api/public/book')
      .send({
        serviceId: pubServiceId,
        staffId:   pubStaffId,
        date:      pubTestDate,
        startTime: '10:00',
        customer: { name: 'Test Customer', email: `badphone-${RUN_ID}@example.com`, phone: 'abc' },
      });
    expect(res.status).toBe(400);
  });

  it('rejects XSS name in public booking (400)', async () => {
    const res = await request(app)
      .post('/api/public/book')
      .send({
        serviceId: pubServiceId,
        staffId:   pubStaffId,
        date:      pubTestDate,
        startTime: '10:00',
        customer: { name: '<img src=x onerror=alert(1)>', email: `xssbook-${RUN_ID}@example.com` },
      });
    expect(res.status).toBe(400);
  });

  it('concurrent public bookings: exactly one succeeds, one gets 409 (Issue 2)', async () => {
    const [r1, r2] = await Promise.all([
      request(app).post('/api/public/book').send({
        serviceId: pubServiceId,
        staffId:   pubStaffId,
        date:      pubTestDate,
        startTime: '10:00',
        customer:  { name: 'Concurrent A', email: `conc-a-${RUN_ID}@example.com`, phone: '+91 98765 40100' },
      }),
      request(app).post('/api/public/book').send({
        serviceId: pubServiceId,
        staffId:   pubStaffId,
        date:      pubTestDate,
        startTime: '10:00',
        customer:  { name: 'Concurrent B', email: `conc-b-${RUN_ID}@example.com`, phone: '+91 98765 40100' },
      }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });
});

// ─── Integration: public booking appears in admin appointment list ─────────────

describe('Integration — public booking appears in admin list', () => {
  let intServiceId = '';
  let intStaffId   = '';
  let intBookingRef = '';

  const ALL_DAY_HOURS = Object.fromEntries(
    ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'].map(d => [
      d, { enabled: true, start: '00:00', end: '23:30' },
    ])
  );

  const intDate = new Date();
  intDate.setDate(intDate.getDate() + 100);
  const intTestDate = intDate.toISOString().split('T')[0];

  beforeAll(async () => {
    const svcRes = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Integration-Test Svc', category: 'consultation', duration: 30, price: 50, currency: 'USD', maxAdvance: 365 });
    intServiceId = svcRes.body.data.id;

    const staffRes = await request(app)
      .post('/api/staff')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Integration-Test Staff',
        email: `intstaff-${RUN_ID}@example.com`,
        title: 'Tester',
        serviceIds: [intServiceId],
        workspaceIds: [],
        workingHours: ALL_DAY_HOURS,
      });
    intStaffId = staffRes.body.data.id;
    await publishBookingPage(app, { Authorization: `Bearer ${token}` }, [intServiceId], 'int');
  });

  it('POST /api/public/book creates a real booking (201)', async () => {
    const res = await request(app)
      .post('/api/public/book')
      .send({
        serviceId: intServiceId,
        staffId:   intStaffId,
        date:      intTestDate,
        startTime: '14:00',
        customer:  { name: 'Integration Customer', email: `intcust-${RUN_ID}@example.com`, phone: '+91 98765 40100' },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.bookingRef).toMatch(/^WE-/);
    intBookingRef = res.body.data.bookingRef;
  });

  it('GET /api/appointments (admin) returns the same booking ref', async () => {
    const res = await request(app)
      .get('/api/appointments')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const refs = (res.body.data as { bookingRef: string }[]).map(a => a.bookingRef);
    expect(refs).toContain(intBookingRef);
  });

  it('GET /api/appointments includes joined customer/service/staff names', async () => {
    const res = await request(app)
      .get('/api/appointments')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const apt = (res.body.data as Record<string, string>[]).find(a => a.bookingRef === intBookingRef);
    expect(apt).toBeDefined();
    expect(apt!.customerName).toBe('Integration Customer');
    expect(apt!.serviceName).toBe('Integration-Test Svc');
    expect(apt!.staffName).toBe('Integration-Test Staff');
  });
});
