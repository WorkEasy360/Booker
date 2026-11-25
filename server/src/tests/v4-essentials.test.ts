// V4 essentials: four statuses, customers with a phone or an email, one default booking link, different hours on a
// date, appointments affected by availability changes, the business location, the customer change cutoff and
// "Remember me". Synthetic data in the per-file test database.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
const PASSWORD = 'StartPass123';
const OWNER_EMAIL = `v4-owner-${RUN}@example.com`;
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  .map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });

let h: Record<string, string> = {};
let orgId = '';
let serviceId = '';
let staffId = '';

beforeAll(async () => {
  const res = await signUpAndSignIn(app, { name: 'V4 Owner', email: OWNER_EMAIL, company: `Acme Wellness ${RUN}`, password: PASSWORD, timezone: TZ });
  h = { Authorization: `Bearer ${sessionToken(res)}` };
  orgId = res.body.data.user.organization_id;
  serviceId = (await request(app).post('/api/services').set(h).send({ name: 'Consultation', category: 'consultation', duration: 30, price: 0, maxAdvance: 365 })).body.data.id;
  staffId = (await request(app).post('/api/staff').set(h).send({ name: 'Dr. Priya', email: `priya-${RUN}@example.com`, serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
});

describe('customers: a name and a phone number or an email address', () => {
  it('a phone number alone is enough; neither is refused', async () => {
    const phoneOnly = await request(app).post('/api/customers').set(h).send({ name: 'Rohan Mehta', phone: '+91 98765 43210' });
    expect(phoneOnly.status).toBe(201);
    expect(phoneOnly.body.data).toMatchObject({ name: 'Rohan Mehta', email: null, phone: '+91 98765 43210' });
    expect(phoneOnly.body.data).not.toHaveProperty('tags');
    expect((await request(app).post('/api/customers').set(h).send({ name: 'Nobody' })).status).toBe(400);
    // Two customers without email do not collide on the (empty) email.
    expect((await request(app).post('/api/customers').set(h).send({ name: 'Anita Sharma', phone: '+91 98123 45678' })).status).toBe(201);
  });

  it('an existing match is reported for the owner to resolve, never overwritten', async () => {
    const dup = await request(app).post('/api/customers').set(h).send({ name: 'Rohan M', phone: '98765 43210' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CUSTOMER_EXISTS');
    expect(typeof dup.body.customerId).toBe('string');
    const withEmail = await request(app).post('/api/customers').set(h).send({ name: 'Vikram Desai', email: `vikram-${RUN}@example.com` });
    expect(withEmail.status).toBe(201);
    // The email belongs to Vikram, the phone to Rohan: a conflict, not a silent merge.
    const conflict = await request(app).post('/api/customers').set(h).send({ name: 'Mixed', email: `vikram-${RUN}@example.com`, phone: '+91 98765 43210' });
    expect([conflict.status, conflict.body.code]).toEqual([409, 'CUSTOMER_MATCH_CONFLICT']);
    // A shared family phone: the owner confirms a separate customer.
    expect((await request(app).post('/api/customers').set(h).send({ name: 'Rohan Jr', phone: '+91 98765 43210', confirmNew: true })).status).toBe(201);
    expect((db.prepare("SELECT name FROM customers WHERE organization_id = ? AND email = ?").get(orgId, `vikram-${RUN}@example.com`) as { name: string }).name).toBe('Vikram Desai');
  });

  it('search finds customers by phone digits as well as name', async () => {
    const found = (await request(app).get('/api/customers?q=9812345678').set(h)).body.data as Array<{ name: string }>;
    expect(found.map(c => c.name)).toContain('Anita Sharma');
  });
});

describe('statuses', () => {
  it('a new appointment is Scheduled; the legacy "confirmed" is read as scheduled', async () => {
    const customerId = (await request(app).post('/api/customers').set(h).send({ name: 'Neha Kapoor', email: `neha-${RUN}@example.com` })).body.data.id;
    const created = await request(app).post('/api/appointments').set(h).send({ serviceId, staffId, customerId, date: day(5), startTime: '09:00', status: 'confirmed' });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('scheduled');
  });
});

describe('Email on / off', () => {
  it('switched off, the booking is saved and its email is reported as not sent; switched on again, it is sent', async () => {
    const setEmail = (enabled: boolean) => request(app).put('/api/notifications/settings/rules').set(h)
      .send({ rules: (['confirmed', 'rescheduled', 'cancelled'] as const).map(event => ({ event, role: 'customer', channel: 'email', enabled })) });
    const customerId = (await request(app).post('/api/customers').set(h).send({ name: 'Mail Off', email: `mail-off-${RUN}@example.com` })).body.data.id;
    expect((await setEmail(false)).status).toBe(200);
    const off = await request(app).post('/api/appointments').set(h).send({ serviceId, staffId, customerId, date: day(6), startTime: '09:00' });
    expect(off.status).toBe(201);
    expect(off.body.data.email).toMatchObject({ status: 'not_configured', switchedOff: true });
    expect((await setEmail(true)).status).toBe(200);
    const on = await request(app).post('/api/appointments').set(h).send({ serviceId, staffId, customerId, date: day(6), startTime: '10:00' });
    expect(on.body.data.email.switchedOff).toBeUndefined();
  });
});

describe('the default booking link', () => {
  it('is created on first use, published, offering every active service, and can stop taking bookings', async () => {
    const first = await request(app).get('/api/booking-pages/default').set(h);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ isPublished: true, slug: expect.stringMatching(/^acme-wellness-/) });
    expect((await request(app).get('/api/booking-pages/default').set(h)).body.data.id).toBe(first.body.data.id); // only one
    const page = await request(app).get(`/api/public/pages/${first.body.data.slug}`);
    expect(page.body.data.services.map((s: { id: string }) => s.id)).toEqual([serviceId]);

    // A new service is offered without editing the page; a deactivated one is not.
    const extra = (await request(app).post('/api/services').set(h).send({ name: 'Therapy Session', category: 'session', duration: 60, price: 0 })).body.data.id;
    await request(app).put(`/api/staff/${staffId}`).set(h).send({ serviceIds: [serviceId, extra] });
    const ids = () => request(app).get(`/api/public/pages/${first.body.data.slug}`).then(r => (r.body.data.services as Array<{ id: string }>).map(s => s.id).sort());
    expect(await ids()).toEqual([serviceId, extra].sort());
    await request(app).put(`/api/services/${extra}`).set(h).send({ isActive: false });
    expect(await ids()).toEqual([serviceId]);

    expect((await request(app).put('/api/booking-pages/default').set(h).send({ isPublished: false })).body.data.isPublished).toBe(false);
    expect((await request(app).get(`/api/public/pages/${first.body.data.slug}`)).status).toBe(404);
    expect((await request(app).put('/api/booking-pages/default').set(h).send({ isPublished: true })).body.data.isPublished).toBe(true);
    expect((await request(app).delete(`/api/booking-pages/${first.body.data.id}`).set(h)).status).toBe(409);
  });
});

describe('availability: different hours on a date and affected appointments', () => {
  it('a date with different hours replaces the weekly hours; existing bookings outside them are listed, not changed', async () => {
    const date = day(9);
    const customerId = (await request(app).post('/api/customers').set(h).send({ name: 'Arjun Rao', email: `arjun-${RUN}@example.com` })).body.data.id;
    const booked = await request(app).post('/api/appointments').set(h).send({ serviceId, staffId, customerId, date, startTime: '10:00' });
    expect(booked.status).toBe(201);

    const set = await request(app).post('/api/time-off/date-hours').set(h).send({ staffId, date, startTime: '12:00', endTime: '14:00', reason: 'Half day' });
    expect(set.status).toBe(201);
    expect(set.body.data).toMatchObject({ staffId, date, startTime: '12:00', endTime: '14:00' });

    const slots = (await request(app).get(`/api/appointments/availability?date=${date}&serviceId=${serviceId}&staffId=${staffId}`).set(h)).body.data as Array<{ start: string; available: boolean }>;
    const open = slots.filter(s => s.available).map(s => s.start);
    expect(open.length).toBeGreaterThan(0);
    expect(open.every(s => s >= '12:00' && s < '14:00')).toBe(true);

    const affected = (await request(app).get(`/api/time-off/affected?staffId=${staffId}`).set(h)).body.data as Array<{ id: string; customerName: string; problem: string }>;
    expect(affected.find(a => a.id === booked.body.data.id)).toMatchObject({ customerName: 'Arjun Rao' });
    expect((db.prepare('SELECT status, start_time FROM appointments WHERE id = ?').get(booked.body.data.id))).toEqual({ status: 'scheduled', start_time: '10:00' });

    const listed = (await request(app).get(`/api/time-off/date-hours?staffId=${staffId}`).set(h)).body.data as Array<{ id: string }>;
    expect(listed.map(r => r.id)).toContain(set.body.data.id);
    expect((await request(app).delete(`/api/time-off/date-hours/${set.body.data.id}`).set(h)).status).toBe(200);
    const after = (await request(app).get(`/api/time-off/affected?staffId=${staffId}`).set(h)).body.data as Array<{ id: string }>;
    expect(after.map(a => a.id)).not.toContain(booked.body.data.id);
  });

  it('provider hours on a date must fall within business hours', async () => {
    await request(app).put('/api/settings').set(h).send({ workingHours: Object.fromEntries(Object.keys(HOURS).map(d => [d, { enabled: true, start: '09:00', end: '18:00' }])) });
    const res = await request(app).post('/api/time-off/date-hours').set(h).send({ staffId, date: day(11), startTime: '07:00', endTime: '19:00' });
    expect([res.status, res.body.code]).toEqual([400, 'OUTSIDE_BUSINESS_HOURS']);
  });
});

describe('public booking: location, phone-only customers and the change cutoff', () => {
  it('shows the business location, books without an email, and closes online changes at the cutoff', async () => {
    expect((await request(app).put('/api/settings').set(h).send({ appointmentLocation: 'Room 4, MG Road', bookingRules: { customerChangeCutoffHours: 168 } })).status).toBe(200);
    const { slug } = (await request(app).get('/api/booking-pages/default').set(h)).body.data;
    expect((await request(app).get(`/api/public/pages/${slug}`)).body.data.location).toBe('Room 4, MG Road');

    const booked = await request(app).post('/api/public/book').send({
      pageSlug: slug, serviceId, staffId, date: day(3), startTime: '11:00',
      customer: { name: 'Phone Only', phone: '+91 99887 76655' },
    });
    expect(booked.status).toBe(201);
    expect(booked.body.data.emailUpdates).toBe(false);
    expect((db.prepare('SELECT location FROM appointments WHERE id = ?').get(booked.body.data.appointmentId) as { location: string }).location).toBe('Room 4, MG Road');

    const token = booked.body.data.manageToken as string;
    const view = await request(app).get('/api/public/appointments/manage').set('X-Booking-Token', token);
    expect(view.status).toBe(200);
    expect(view.body.data).toMatchObject({ canChange: false, cutoffHours: 168, business: { email: OWNER_EMAIL } });
    const refused = await request(app).post('/api/public/appointments/manage/cancel').set('X-Booking-Token', token).send({});
    expect([refused.status, refused.body.code]).toEqual([409, 'CUTOFF_PASSED']);

    await request(app).put('/api/settings').set(h).send({ bookingRules: { customerChangeCutoffHours: 0 } });
    expect((await request(app).post('/api/public/appointments/manage/cancel').set('X-Booking-Token', token).send({})).status).toBe(200);
  });
});

describe('Remember me', () => {
  const sessionCookieOf = (res: { headers: Record<string, unknown> }) =>
    ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []).find(c => /^(__Host-)?we360_session=/.test(c)) ?? '';

  it('unticked: the session cookie ends with the browser; ticked (default): it persists', async () => {
    const short = await request(app).post('/api/auth/login').send({ email: OWNER_EMAIL, password: PASSWORD, remember: false });
    expect(short.status).toBe(200);
    expect(sessionCookieOf(short)).not.toMatch(/Max-Age|Expires/i);
    const long = await request(app).post('/api/auth/login').send({ email: OWNER_EMAIL, password: PASSWORD });
    expect(sessionCookieOf(long)).toMatch(/Max-Age|Expires/i);
  });
});
