// Customer self-service privacy: a booking reference alone reveals nothing; access needs reference + email or a
// signed, expiring link. Also: services are public only while listed on a published booking page.
// Synthetic records only, in the isolated per-file test database.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { testOutbox } from '../services/email/notify';
import { issueManageToken, verifyManageToken } from '../services/booking-access';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000);

const RUN = Date.now().toString(36);
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);
function daysAhead(n: number): string {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

let auth: Record<string, string> = {};
let serviceId = '';
let hiddenServiceId = '';
let staffId = '';
let slug = '';
const date = daysAhead(12);
const email = `Private.Person-${RUN}@Example.com`;

const book = (startTime: string, customerEmail = email, notes = 'Allergic to latex') => request(app).post('/api/public/book').send({
  pageSlug: slug, serviceId, staffId, date, startTime, notes,
  customer: { name: 'Priya Private', email: customerEmail, phone: '+91 98765 43210' },
});
const lookup = (ref: string, e: string) => request(app).post('/api/public/appointments/lookup').send({ ref, email: e });
const manage = (token: string) => request(app).get('/api/public/appointments/manage').set('X-Booking-Token', token);
const cancel = (token: string) => request(app).post('/api/public/appointments/manage/cancel').set('X-Booking-Token', token).send({});
const reschedule = (token: string, startTime: string) =>
  request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', token).send({ date, startTime });

beforeAll(async () => {
  const s = await signUpAndSignIn(app, {
    name: 'Privacy Owner', email: `privacy-owner-${RUN}@example.com`, company: `Privacy Org ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  auth = { Authorization: `Bearer ${sessionToken(s)}` };
  serviceId = (await request(app).post('/api/services').set(auth)
    .send({ name: 'Private Consult', category: 'consultation', duration: 30, price: 25, maxAdvance: 365 })).body.data.id;
  hiddenServiceId = (await request(app).post('/api/services').set(auth)
    .send({ name: 'Internal Only', category: 'consultation', duration: 30, price: 0, maxAdvance: 365 })).body.data.id;
  staffId = (await request(app).post('/api/staff').set(auth)
    .send({ name: 'Pat Provider', email: `pat-${RUN}@example.com`, serviceIds: [serviceId, hiddenServiceId], workingHours: EVERY_DAY })).body.data.id;
  slug = await publishBookingPage(app, auth, [serviceId], 'privacy');
});

beforeEach(() => testOutbox.clear());

describe('booking reference alone', () => {
  it('reveals nothing and cannot change the booking', async () => {
    const ref = (await book('09:00')).body.data.bookingRef;
    for (const res of [
      await request(app).get(`/api/public/appointments/${ref}`),
      await request(app).post(`/api/public/appointments/${ref}/cancel`).send({}),
      await request(app).post(`/api/public/appointments/${ref}/reschedule`).send({ date, startTime: '10:00' }),
    ]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toMatch(/Priya|latex|98765|private\.person/i);
    }
    const row = db.prepare('SELECT status, start_time FROM appointments WHERE booking_ref = ?').get(ref) as { status: string; start_time: string };
    expect(row).toEqual({ status: 'scheduled', start_time: '09:00' });
  });

  it('does not let availability requests probe whether a reference exists', async () => {
    const ref = (await book('09:30')).body.data.bookingRef;
    const plain = await request(app).get(`/api/public/availability?date=${date}&serviceId=${serviceId}&staffId=${staffId}`);
    const withRef = await request(app).get(`/api/public/availability?date=${date}&serviceId=${serviceId}&staffId=${staffId}&ref=${ref}`);
    expect(withRef.body).toEqual(plain.body);
  });
});

describe('lookup by reference + email', () => {
  it('gives the same answer for an unknown reference and a wrong email', async () => {
    const ref = (await book('10:00')).body.data.bookingRef;
    const wrongEmail = await lookup(ref, `someone-${RUN}@example.com`);
    const unknownRef = await lookup('WE-NOSUCH00', email);
    expect(wrongEmail.status).toBe(404);
    expect(unknownRef.status).toBe(404);
    expect(wrongEmail.body).toEqual(unknownRef.body);
  });

  it('accepts the booking email regardless of case or surrounding spaces and returns a 60-minute token', async () => {
    const ref = (await book('10:30')).body.data.bookingRef;
    const res = await lookup(` ${ref.toLowerCase()} `, `  ${email.toUpperCase()} `);
    expect(res.status).toBe(200);
    const ttl = Date.parse(res.body.data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(59 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);
    expect(verifyManageToken(res.body.data.token).ok).toBe(true);
  });

  it("shows the customer their booking but none of their personal data or the business's internal data", async () => {
    const booked = await book('11:00');
    const appt = db.prepare('SELECT id, customer_id FROM appointments WHERE booking_ref = ?').get(booked.body.data.bookingRef) as { id: string; customer_id: string };
    db.prepare("UPDATE appointments SET internal_notes = 'VIP - check balance' WHERE id = ?").run(appt.id);
    const res = await lookup(booked.body.data.bookingRef, email);
    const view = res.body.data.appointment;
    expect(view).toMatchObject({ bookingRef: booked.body.data.bookingRef, serviceName: 'Private Consult', staffName: 'Pat Provider', status: 'scheduled', startTime: '11:00' });
    expect(view.maskedEmail).toBe('p•••@example.com');
    expect(view.business.name).toBe(`Privacy Org ${RUN}`);
    const body = JSON.stringify(res.body);
    for (const secret of ['Priya', 'latex', '98765', 'VIP', email, email.toLowerCase(), appt.id, appt.customer_id]) {
      expect(body).not.toContain(secret);
    }
  });
});

describe('manage tokens', () => {
  it('work from the booking confirmation and the email link, and act only on their own booking', async () => {
    const first = await book('12:00');
    expect(first.status).toBe(201);
    const fromBooking = first.body.data.manageToken;
    const link = testOutbox.messages[0].text.match(/manage#token=([^\s]+)/)?.[1];
    expect(link).toBeDefined();
    const fromEmail = decodeURIComponent(link!);
    for (const token of [fromBooking, fromEmail]) {
      const view = await manage(token);
      expect(view.status).toBe(200);
      expect(view.body.data.bookingRef).toBe(first.body.data.bookingRef);
    }
    const second = await book('13:00', `other-${RUN}@example.com`);
    const res = await cancel(fromBooking);
    expect(res.status).toBe(200);
    const statuses = db.prepare('SELECT booking_ref, status FROM appointments WHERE booking_ref IN (?, ?)').all(first.body.data.bookingRef, second.body.data.bookingRef) as Array<{ booking_ref: string; status: string }>;
    expect(Object.fromEntries(statuses.map(s => [s.booking_ref, s.status]))).toEqual({
      [first.body.data.bookingRef]: 'cancelled', [second.body.data.bookingRef]: 'scheduled',
    });
  });

  it('email links stay valid until a week after the appointment', async () => {
    await book('13:30');
    const token = decodeURIComponent(testOutbox.messages[0].text.match(/manage#token=([^\s]+)/)![1]);
    const check = verifyManageToken(token);
    expect(check.ok).toBe(true);
    if (check.ok) {
      const expected = Date.parse(`${date}T23:59:59Z`) + 7 * 86_400_000;
      expect(Math.abs(Date.parse(check.expiresAt) - expected)).toBeLessThan(1000);
    }
  });

  it('refuse missing, tampered and re-targeted tokens', async () => {
    const a = await book('14:00');
    const b = await book('14:30', `b-${RUN}@example.com`);
    const token: string = a.body.data.manageToken;
    const bId = (db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(b.body.data.bookingRef) as { id: string }).id;
    const [v, , exp, sig] = token.split('.');
    const forgeries = [
      '',
      'v1.garbage',
      `${token.slice(0, -3)}${token.endsWith('AAA') ? 'BBB' : 'AAA'}`,
      [v, Buffer.from(bId).toString('base64url'), exp, sig].join('.'),                     // point at another booking
      [v, token.split('.')[1], (parseInt(exp, 36) + 86_400 * 365).toString(36), sig].join('.'), // extend the expiry
      ['v2', token.split('.')[1], exp, sig].join('.'),
    ];
    for (const forged of forgeries) {
      for (const res of [await manage(forged), await cancel(forged), await reschedule(forged, '15:00')]) {
        expect(res.status).toBe(401);
      }
    }
    expect((db.prepare('SELECT status FROM appointments WHERE id = ?').get(bId) as { status: string }).status).toBe('scheduled');
  });

  it('report expiry only for genuine tokens', async () => {
    const booked = await book('15:30');
    const id = (db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(booked.body.data.bookingRef) as { id: string }).id;
    const expired = issueManageToken(id, email, Date.now() - 1000);
    const res = await manage(expired);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('BOOKING_TOKEN_EXPIRED');
    const forgedExpired = issueManageToken(id, `attacker-${RUN}@example.com`, Date.now() - 1000);
    expect((await manage(forgedExpired)).body.code).toBe('BOOKING_TOKEN_INVALID');
  });

  it('stop working when the business changes the customer email (links sent to the old address die)', async () => {
    const victim = `typo-${RUN}@example.com`;
    const booked = await book('16:00', victim);
    const token = booked.body.data.manageToken;
    expect((await manage(token)).status).toBe(200);
    const customerId = (db.prepare('SELECT customer_id FROM appointments WHERE booking_ref = ?').get(booked.body.data.bookingRef) as { customer_id: string }).customer_id;
    await request(app).put(`/api/customers/${customerId}`).set(auth).send({ email: `fixed-${RUN}@example.com` }).expect(200);
    expect((await manage(token)).status).toBe(401);
    expect((await lookup(booked.body.data.bookingRef, `fixed-${RUN}@example.com`)).status).toBe(200);
  });

  it('cannot cancel twice or reschedule a cancelled booking', async () => {
    const token = (await book('16:30')).body.data.manageToken;
    expect((await cancel(token)).status).toBe(200);
    expect((await cancel(token)).status).toBe(400);
    expect((await reschedule(token, '17:00')).status).toBe(400);
  });

  it('a bad token on an availability request is refused rather than silently ignored', async () => {
    const res = await request(app).get(`/api/public/availability?date=${date}&serviceId=${serviceId}&staffId=${staffId}`).set('X-Booking-Token', 'v1.bad.bad.bad');
    expect(res.status).toBe(401);
  });
});

describe('only published services are public', () => {
  it('hides an active service that is on no published page', async () => {
    expect((await request(app).get(`/api/public/services/${hiddenServiceId}/staff`)).status).toBe(404);
    expect((await request(app).get(`/api/public/availability?date=${date}&serviceId=${hiddenServiceId}&staffId=${staffId}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/availability/days?serviceId=${hiddenServiceId}&staffId=${staffId}&from=${date}&to=${date}`)).status).toBe(404);
    const direct = await request(app).post('/api/public/book').send({
      serviceId: hiddenServiceId, staffId, date, startTime: '18:00', customer: { name: 'Sneaky', email: `sneaky-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(direct.status).toBe(400);
    const viaPage = await request(app).post('/api/public/book').send({
      pageSlug: slug, serviceId: hiddenServiceId, staffId, date, startTime: '18:00', customer: { name: 'Sneaky', email: `sneaky2-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(viaPage.status).toBe(400);
  });

  it('follows publishing: published → public, unpublished → hidden, but existing bookings can still be rescheduled', async () => {
    const pageSlug = await publishBookingPage(app, auth, [hiddenServiceId], 'temporary');
    expect((await request(app).get(`/api/public/availability?date=${date}&serviceId=${hiddenServiceId}&staffId=${staffId}`)).status).toBe(200);
    const booked = await request(app).post('/api/public/book').send({
      pageSlug, serviceId: hiddenServiceId, staffId, date, startTime: '18:30', customer: { name: 'Early Bird', email: `early-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(booked.status).toBe(201);
    const page = (await request(app).get('/api/booking-pages').set(auth)).body.data.find((p: { slug: string }) => p.slug === pageSlug);
    await request(app).put(`/api/booking-pages/${page.id}`).set(auth).send({ isPublished: false }).expect(200);
    expect((await request(app).get(`/api/public/availability?date=${date}&serviceId=${hiddenServiceId}&staffId=${staffId}`)).status).toBe(404);
    const withToken = await request(app).get(`/api/public/availability?date=${date}&serviceId=${hiddenServiceId}&staffId=${staffId}`)
      .set('X-Booking-Token', booked.body.data.manageToken);
    expect(withToken.status).toBe(200);
    expect((await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', booked.body.data.manageToken)
      .send({ date, startTime: '19:00' })).status).toBe(200);
  });

  it('a page that does not list the service refuses it before any availability is computed, even for "any staff"', async () => {
    const viaPage = await request(app).post('/api/public/book').send({
      pageSlug: slug, serviceId: hiddenServiceId, staffId: 'any', date, startTime: '18:00',
      customer: { name: 'Prober', email: `prober-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(viaPage.status).toBe(400);
    expect(viaPage.body.error).toBe('Service is not available on this booking page');
    const unknownPage = await request(app).post('/api/public/book').send({
      pageSlug: `no-such-page-${RUN}`, serviceId, staffId: 'any', date, startTime: '18:00',
      customer: { name: 'Prober', email: `prober2-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(unknownPage.status).toBe(404);
  });

  it('hides an inactive service even when its page is published', async () => {
    await request(app).put(`/api/services/${serviceId}`).set(auth).send({ isActive: false }).expect(200);
    try {
      expect((await request(app).get(`/api/public/services/${serviceId}/staff`)).status).toBe(404);
      expect((await request(app).get(`/api/public/availability?date=${date}&serviceId=${serviceId}&staffId=${staffId}`)).status).toBe(404);
    } finally {
      await request(app).put(`/api/services/${serviceId}`).set(auth).send({ isActive: true }).expect(200);
    }
  });
});
