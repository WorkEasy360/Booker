// Date selection and slot generation: weekdays/weekends, business time zone, duration, validation and concurrency.

import request from 'supertest';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { todayInTimezone } from '../services/availability';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nextDow(from: string, dow: number): string {
  let d = shift(from, 2);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== dow) d = shift(d, 1);
  return d;
}

interface Ctx { token: string; serviceId: string; staffId: string; customerId: string; tz: string }
const auth = (c: Ctx) => ({ Authorization: `Bearer ${c.token}` });

async function setup(label: string, tz: string, hours: Record<string, { enabled: boolean; start: string; end: string }>, duration = 45): Promise<Ctx> {
  const r = await signUpAndSignIn(app, {
    name: `Avail ${label}`, email: `avail-${label}-${RUN}@example.com`, company: `Avail ${label} ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  const token = sessionToken(r);
  const h = { Authorization: `Bearer ${token}` };
  await request(app).put('/api/settings').set(h).send({ timezone: tz }).expect(200);
  const serviceId = (await request(app).post('/api/services').set(h)
    .send({ name: `Svc ${label}`, category: 'consultation', duration, price: 10, maxAdvance: 60 })).body.data.id;
  const staffId = (await request(app).post('/api/staff').set(h)
    .send({ name: `Staff ${label}`, email: `staff-${label}-${RUN}@example.com`, serviceIds: [serviceId], workingHours: hours })).body.data.id;
  const customerId = (await request(app).post('/api/customers').set(h).send({ name: 'Cust', email: `c-${label}-${RUN}@example.com` })).body.data.id;
  await publishBookingPage(app, h, [serviceId], `avail-${label}`);
  return { token, serviceId, staffId, customerId, tz };
}

const WEEK = (overrides: Record<string, { enabled: boolean; start: string; end: string }> = {}) => ({
  monday: { enabled: true, start: '09:00', end: '17:00' },
  tuesday: { enabled: true, start: '09:00', end: '17:00' },
  wednesday: { enabled: true, start: '09:00', end: '17:00' },
  thursday: { enabled: true, start: '09:00', end: '17:00' },
  friday: { enabled: true, start: '09:00', end: '17:00' },
  saturday: { enabled: true, start: '10:00', end: '14:00' },
  sunday: { enabled: false, start: '10:00', end: '14:00' },
  ...overrides,
});

const days = (c: Ctx, from: string, to: string, staffId = c.staffId, extra = '') =>
  request(app).get(`/api/public/availability/days?serviceId=${c.serviceId}&staffId=${staffId}&from=${from}&to=${to}${extra}`);
const slots = (c: Ctx, date: string, staffId = c.staffId) =>
  request(app).get(`/api/public/availability?date=${date}&serviceId=${c.serviceId}&staffId=${staffId}`);
const book = (c: Ctx, date: string, startTime: string, n: string, staffId = c.staffId) =>
  request(app).post('/api/public/book').send({
    serviceId: c.serviceId, staffId, date, startTime, customer: { name: `B ${n}`, email: `b-${n}-${RUN}@example.com`, phone: '+91 98765 40100' },
  });

describe('weekdays, weekends and service duration', () => {
  let c: Ctx;
  beforeAll(async () => { c = await setup('week', 'Asia/Kolkata', WEEK()); });

  it('offers Saturday (scheduled) and blocks Sunday (day off) — weekends are not disabled wholesale', async () => {
    const today = todayInTimezone(c.tz);
    const sat = nextDow(today, 6);
    // The Sunday right after that Saturday (an independent "next Sunday" falls before it when today is a Friday).
    const sun = shift(sat, 1);
    const res = await days(c, sat, sun);
    expect(res.status).toBe(200);
    const byDate = Object.fromEntries(res.body.data.map((d: { date: string; available: boolean }) => [d.date, d.available]));
    expect(byDate[sat]).toBe(true);
    expect(byDate[sun]).toBe(false);
    expect((await slots(c, sun)).body.data).toEqual([]);
  });

  it('every slot ends exactly one service duration after it starts, inside working hours', async () => {
    const sat = nextDow(todayInTimezone(c.tz), 6);
    const list = (await slots(c, sat)).body.data as Array<{ start: string; end: string }>;
    expect(list[0].start).toBe('10:00');
    for (const s of list) {
      const [sh, sm] = s.start.split(':').map(Number);
      const [eh, em] = s.end.split(':').map(Number);
      expect((eh * 60 + em) - (sh * 60 + sm)).toBe(45);
      expect(s.end <= '14:00').toBe(true);
    }
    expect(list[list.length - 1].start).toBe('13:00'); // 13:30 would end at 14:15
  });

  it('stores the business time zone, never the client-supplied one', async () => {
    const wed = nextDow(todayInTimezone(c.tz), 3);
    const pub = await book(c, wed, '09:00', 'tz1');
    const stored = db.prepare('SELECT timezone FROM appointments WHERE booking_ref = ?').get(pub.body.data.bookingRef) as { timezone: string };
    expect(stored.timezone).toBe('Asia/Kolkata');
    const admin = await request(app).post('/api/appointments').set(auth(c))
      .send({ serviceId: c.serviceId, staffId: c.staffId, customerId: c.customerId, date: wed, startTime: '11:00', timezone: 'UTC' });
    expect(admin.body.data.timezone).toBe('Asia/Kolkata');
  });

  it('days beyond the advance window are unavailable', async () => {
    const today = todayInTimezone(c.tz);
    const res = await days(c, shift(today, 55), shift(today, 62));
    const after = res.body.data.filter((d: { date: string }) => d.date > shift(today, 60));
    expect(after.every((d: { available: boolean }) => !d.available)).toBe(true);
  });

  it('rejects oversized and malformed day ranges', async () => {
    const today = todayInTimezone(c.tz);
    expect((await days(c, today, shift(today, 70))).status).toBe(400);
    expect((await days(c, shift(today, 5), today)).status).toBe(400);
    expect((await days(c, '2026-02-30', '2026-03-05')).status).toBe(400);
  });
});

describe('business time zone boundaries', () => {
  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    it(`uses "today" in ${tz} for past-date checks and calendars`, async () => {
      const c = await setup(tz.split('/')[1].toLowerCase(), tz, Object.fromEntries(
        ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '00:00', end: '23:30' }]),
      ));
      const today = todayInTimezone(tz);
      const yesterday = shift(today, -1);
      const res = await days(c, yesterday, shift(today, 1));
      const byDate = Object.fromEntries(res.body.data.map((d: { date: string; available: boolean }) => [d.date, d.available]));
      expect(byDate[yesterday]).toBe(false);
      expect(byDate[shift(today, 1)]).toBe(true);
      const past = await book(c, yesterday, '12:00', `past-${tz}`);
      expect(past.status).toBe(400);
      // No start time earlier than "now" in the business time zone is offered today.
      const nowLocal = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date());
      const todaySlots = (await slots(c, today)).body.data as Array<{ start: string; available: boolean }>;
      expect(todaySlots.filter(s => s.available).every(s => s.start > nowLocal)).toBe(true);
    });
  }
});

describe('server-side validation of dates and times', () => {
  let c: Ctx;
  beforeAll(async () => { c = await setup('valid', 'America/New_York', WEEK()); });

  it.each(['2026-02-30', '2026-13-01', '2026-1-5', 'tomorrow'])('rejects impossible date %s everywhere', async (bad) => {
    expect((await slots(c, bad)).status).toBe(400);
    expect((await book(c, bad, '10:00', `bad-${bad}`)).status).toBe(400);
    expect((await request(app).post('/api/appointments').set(auth(c))
      .send({ serviceId: c.serviceId, staffId: c.staffId, customerId: c.customerId, date: bad, startTime: '10:00' })).status).toBe(400);
  });

  it.each(['24:00', '9:00', '10:60', '10:00:00'])('rejects malformed time %s', async (bad) => {
    const wed = nextDow(todayInTimezone(c.tz), 3);
    expect((await book(c, wed, bad, `badtime-${bad}`)).status).toBe(400);
  });

  it('rejects a public reschedule onto a day off or an impossible date', async () => {
    const today = todayInTimezone(c.tz);
    const wed = nextDow(today, 3);
    const manage = (await book(c, wed, '10:00', 'resch')).body.data.manageToken as string;
    const reschedule = (body: object) => request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', manage).send(body);
    expect((await reschedule({ date: nextDow(today, 0), startTime: '10:00' })).status).toBe(409);
    expect((await reschedule({ date: '2026-02-30', startTime: '10:00' })).status).toBe(400);
  });
});

describe('rescheduling availability', () => {
  it("treats the booking's own slot as free when its manage token is sent", async () => {
    const c = await setup('own', 'America/New_York', WEEK());
    const wed = nextDow(todayInTimezone(c.tz), 3);
    const booked = (await book(c, wed, '10:00', 'own')).body.data;
    const without = (await slots(c, wed)).body.data as Array<{ start: string; available: boolean }>;
    expect(without.find(s => s.start === '10:30')?.available).toBe(false);
    // The reference alone no longer changes anything.
    const withRefOnly = (await request(app).get(`/api/public/availability?date=${wed}&serviceId=${c.serviceId}&staffId=${c.staffId}&ref=${booked.bookingRef}`)).body.data as Array<{ start: string; available: boolean }>;
    expect(withRefOnly.find(s => s.start === '10:30')?.available).toBe(false);
    const withToken = (await slots(c, wed).set('X-Booking-Token', booked.manageToken)).body.data as Array<{ start: string; available: boolean }>;
    expect(withToken.find(s => s.start === '10:30')?.available).toBe(true);
    const day = (await days(c, wed, wed, c.staffId).set('X-Booking-Token', booked.manageToken)).body.data[0];
    expect(day.available).toBe(true);
  });
});

describe('concurrency and the database overlap guard', () => {
  let c: Ctx;
  beforeAll(async () => { c = await setup('race', 'America/New_York', WEEK()); });

  it('two simultaneous "any staff" bookings for the last free slot: exactly one wins', async () => {
    const thu = nextDow(todayInTimezone(c.tz), 4);
    const results = await Promise.all(['x', 'y'].map(n => book(c, thu, '15:00', `any-${n}`, 'any')));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
  });

  it('two simultaneous reschedules into the same slot: exactly one wins', async () => {
    const fri = nextDow(todayInTimezone(c.tz), 5);
    const a = (await book(c, fri, '09:00', 'ra')).body.data.manageToken as string;
    const b = (await book(c, fri, '10:00', 'rb')).body.data.manageToken as string;
    const results = await Promise.all([a, b].map(manage =>
      request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', manage).send({ date: fri, startTime: '13:00' })));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
  });

  it('the database itself refuses an overlapping insert', async () => {
    const mon = nextDow(todayInTimezone(c.tz), 1);
    const first = await book(c, mon, '11:00', 'db1');
    expect(first.status).toBe(201);
    const row = db.prepare('SELECT * FROM appointments WHERE booking_ref = ?').get(first.body.data.bookingRef) as Record<string, unknown>;
    expect(() => db.prepare(
      `INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, '11:30', '12:15', 45)`
    ).run(`appt-${nanoid(8)}`, `WE-${nanoid(8)}`, row.organization_id, row.service_id, row.staff_id, row.customer_id, mon)).toThrow('APPOINTMENT_OVERLAP');
  });

  it('reactivating a cancelled booking over a taken slot is rejected with 409', async () => {
    const tue = nextDow(todayInTimezone(c.tz), 2);
    const first = await request(app).post('/api/appointments').set(auth(c))
      .send({ serviceId: c.serviceId, staffId: c.staffId, customerId: c.customerId, date: tue, startTime: '14:00' });
    await request(app).put(`/api/appointments/${first.body.data.id}`).set(auth(c)).send({ status: 'cancelled' }).expect(200);
    await request(app).post('/api/appointments').set(auth(c))
      .send({ serviceId: c.serviceId, staffId: c.staffId, customerId: c.customerId, date: tue, startTime: '14:00' }).expect(201);
    const revive = await request(app).put(`/api/appointments/${first.body.data.id}`).set(auth(c)).send({ status: 'scheduled' });
    expect(revive.status).toBe(409);
  });

  it('inactive staff are excluded from "any staff" days', async () => {
    await request(app).put(`/api/staff/${c.staffId}`).set(auth(c)).send({ isActive: false }).expect(200);
    const today = todayInTimezone(c.tz);
    const res = await days(c, shift(today, 2), shift(today, 8), 'any');
    expect(res.status).toBe(404);
    await request(app).put(`/api/staff/${c.staffId}`).set(auth(c)).send({ isActive: true }).expect(200);
  });
});
