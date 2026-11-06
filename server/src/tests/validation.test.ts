// Phone and email validation on every API that accepts them (customers, staff, workspaces, business profile, public
// booking), straight against the API: client-side checks are never the only protection. Invalid input must change
// nothing; valid phone numbers are stored in one international format. Synthetic data in the per-file test database.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { normalizePhone } from '../lib/phone';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const INVALID_PHONES = ['12', 'abc', '12345678901234567890', '98765 4321O', '+1 (555) 000-0000', 'call me', '9876543210 ext', '+91 98765 43210, +91 98765 43211'];
const INVALID_EMAILS = ['notanemail', 'name@', '@example.com', 'name@example', 'two words@example.com'];
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

beforeAll(async () => {
  const res = await signUpAndSignIn(app, { name: 'Validation Owner', email: `validation-${RUN}@example.com`, company: `Validation ${RUN}`, password: 'StartPass123' });
  token = sessionToken(res);
});

describe('the phone rule', () => {
  it('accepts Indian numbers with or without +91 and stores one international format', () => {
    for (const v of ['9876543210', '+91 98765 43210', '+919876543210', '098765 43210', ' +91-98765-43210 ']) {
      expect([v, normalizePhone(v)]).toEqual([v, { ok: true, phone: '+91 98765 43210' }]);
    }
  });
  it('accepts other countries when they start with + and the country code', () => {
    expect(normalizePhone('+44 20 7946 0958')).toEqual({ ok: true, phone: '+44 20 7946 0958' });
    expect(normalizePhone('+1 212 555 0123')).toEqual({ ok: true, phone: '+1 212 555 0123' });
  });
  it('refuses letters, too short, too long, fictional and list-like values', () => {
    for (const v of INVALID_PHONES) expect([v, normalizePhone(v).ok]).toEqual([v, false]);
  });
});

describe('customers', () => {
  it('refuses every invalid phone and email, and creates nothing', async () => {
    const before = count('SELECT COUNT(*) AS n FROM customers');
    for (const phone of INVALID_PHONES) {
      const res = await request(app).post('/api/customers').set(auth()).send({ name: 'Bad Phone', email: `bad-phone-${RUN}@example.com`, phone });
      expect([phone, res.status]).toEqual([phone, 400]);
    }
    for (const email of INVALID_EMAILS) {
      const res = await request(app).post('/api/customers').set(auth()).send({ name: 'Bad Email', email });
      expect([email, res.status]).toEqual([email, 400]);
    }
    expect(count('SELECT COUNT(*) AS n FROM customers')).toBe(before);
  });

  it('normalizes a valid phone, and a blank phone clears it', async () => {
    const created = await request(app).post('/api/customers').set(auth()).send({ name: 'Good Phone', email: `good-phone-${RUN}@example.com`, phone: '98765 43210' });
    expect(created.status).toBe(201);
    expect(created.body.data.phone).toBe('+91 98765 43210');
    const cleared = await request(app).put(`/api/customers/${created.body.data.id}`).set(auth()).send({ phone: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.phone).toBeNull();
    const refused = await request(app).put(`/api/customers/${created.body.data.id}`).set(auth()).send({ phone: 'abc' });
    expect(refused.status).toBe(400);
  });
});

describe('staff, workspaces and the business profile', () => {
  it('staff: refuses invalid phones and emails, normalizes valid ones', async () => {
    for (const phone of ['12', 'abc', '12345678901234567890']) {
      const res = await request(app).post('/api/staff').set(auth()).send({ name: 'Bad Staff', email: `bad-staff-${RUN}@example.com`, phone });
      expect([phone, res.status]).toEqual([phone, 400]);
    }
    expect((await request(app).post('/api/staff').set(auth()).send({ name: 'Bad Staff', email: 'notanemail' })).status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM staff WHERE email = ?', `bad-staff-${RUN}@example.com`)).toBe(0);
    const ok = await request(app).post('/api/staff').set(auth()).send({ name: 'Good Staff', email: `good-staff-${RUN}@example.com`, phone: '+919876543211' });
    expect([ok.status, ok.body.data.phone]).toEqual([201, '+91 98765 43211']);
  });

  it('workspaces: refuses invalid phones (they were accepted before), normalizes valid ones', async () => {
    for (const phone of ['12', 'abc', '12345678901234567890']) {
      const res = await request(app).post('/api/workspaces').set(auth()).send({ name: `Bad WS ${phone}`, phone });
      expect([phone, res.status]).toEqual([phone, 400]);
    }
    const ok = await request(app).post('/api/workspaces').set(auth()).send({ name: `Good WS ${RUN}`, phone: '022 2345 6789' });
    expect([ok.status, ok.body.data.phone]).toEqual([201, '+91 22 2345 6789']);
  });

  it('business profile: refuses an invalid phone and keeps the saved one', async () => {
    expect((await request(app).put('/api/settings').set(auth()).send({ phone: '+91 98765 43212' })).status).toBe(200);
    expect((await request(app).put('/api/settings').set(auth()).send({ phone: 'abc' })).status).toBe(400);
    expect((await request(app).get('/api/settings').set(auth())).body.data.phone).toBe('+91 98765 43212');
  });
});

describe('public booking', () => {
  let serviceId = '';
  let staffId = '';
  const date = (() => { const d = new Date(); d.setDate(d.getDate() + 70); return d.toISOString().slice(0, 10); })();
  const hours = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { enabled: true, start: '00:00', end: '23:30' }]));
  const book = (customer: Record<string, unknown>, startTime: string) => request(app).post('/api/public/book').send({ serviceId, staffId, date, startTime, customer });
  const created = () => ({
    customers: count('SELECT COUNT(*) AS n FROM customers WHERE organization_id = (SELECT organization_id FROM services WHERE id = ?)', serviceId),
    appointments: count('SELECT COUNT(*) AS n FROM appointments WHERE service_id = ?', serviceId),
  });

  beforeAll(async () => {
    serviceId = (await request(app).post('/api/services').set(auth()).send({ name: `Validation Svc ${RUN}`, category: 'consultation', duration: 60, price: 0, maxAdvance: 365 })).body.data.id;
    staffId = (await request(app).post('/api/staff').set(auth()).send({ name: 'Validation Staff', email: `val-staff-${RUN}@example.com`, serviceIds: [serviceId], workingHours: hours })).body.data.id;
    await publishBookingPage(app, auth(), [serviceId], 'validation');
  });

  it('"notanemail" and other invalid emails are refused, and no customer or appointment is created', async () => {
    const before = created();
    for (const email of INVALID_EMAILS) {
      const res = await book({ name: 'Bad Email', email, phone: '+91 98765 43213' }, '09:00');
      expect([email, res.status]).toEqual([email, 400]);
    }
    expect(created()).toEqual(before);
  });

  it('invalid phones are refused, a missing required phone too, and nothing is created', async () => {
    const before = created();
    for (const phone of INVALID_PHONES) {
      const res = await book({ name: 'Bad Phone', email: `pub-bad-${RUN}@example.com`, phone }, '10:00');
      expect([phone, res.status]).toEqual([phone, 400]);
    }
    expect((await book({ name: 'No Phone', email: `pub-none-${RUN}@example.com` }, '10:00')).status).toBe(400);
    expect(created()).toEqual(before);
  });

  it('a valid booking trims and lower-cases the email and stores the normalized phone', async () => {
    const res = await book({ name: 'Good Booker', email: `  Pub-Good-${RUN}@Example.COM `, phone: '98765 43214' }, '11:00');
    expect(res.status).toBe(201);
    const row = db.prepare('SELECT email, phone FROM customers WHERE email = ?').get(`pub-good-${RUN}@example.com`);
    expect(row).toEqual({ email: `pub-good-${RUN}@example.com`, phone: '+91 98765 43214' });
  });
});

describe('email uniqueness: one business, one record per person and role', () => {
  it('a duplicate customer or staff email is refused (letter case ignored); one person may be both customer and staff', async () => {
    const email = `same-person-${RUN}@example.com`;
    expect((await request(app).post('/api/customers').set(auth()).send({ name: 'Same Person', email })).status).toBe(201);
    const dupCustomer = await request(app).post('/api/customers').set(auth()).send({ name: 'Same Person Again', email: email.toUpperCase() });
    expect(dupCustomer.status).toBe(409);
    expect((await request(app).post('/api/staff').set(auth()).send({ name: 'Same Person', email })).status).toBe(201); // also staff: allowed
    const dupStaff = await request(app).post('/api/staff').set(auth()).send({ name: 'Same Person Twice', email: email.toUpperCase() });
    expect(dupStaff.status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM customers WHERE lower(email) = ?', email)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM staff WHERE lower(email) = ?', email)).toBe(1);
  });
});

describe('the business logo on the public booking page', () => {
  it('is the configured https logo, or none (the page then shows the business monogram)', async () => {
    const serviceId = (await request(app).post('/api/services').set(auth()).send({ name: `Logo Svc ${RUN}`, category: 'consultation', duration: 30, price: 0 })).body.data.id;
    const slug = await publishBookingPage(app, auth(), [serviceId], 'logo');
    expect((await request(app).get(`/api/public/pages/${slug}`)).body.data.logoUrl).toBeNull();
    expect((await request(app).put('/api/settings').set(auth()).send({ logo: 'https://cdn.example.com/logo.png' })).status).toBe(200);
    expect((await request(app).get(`/api/public/pages/${slug}`)).body.data.logoUrl).toBe('https://cdn.example.com/logo.png');
    expect((await request(app).put('/api/settings').set(auth()).send({ logo: 'http://insecure.example.com/logo.png' })).status).toBe(400);
  });
});
