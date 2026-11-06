// Cross-tenant isolation, data-relationship and booking-integrity checks.
// Runs against the isolated test DB configured in jest.setup.js; every record is created here.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);
const ALL_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    .map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);

function isoDaysAhead(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

interface Org { token: string; serviceId: string; staffId: string; customerId: string; customerName: string }

async function makeOrg(label: string): Promise<Org> {
  const signup = await signUpAndSignIn(app, {
    name: `Owner ${label}`, email: `owner-${label}-${RUN}@example.com`, company: `Org ${label} ${RUN}`,
    password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  expect(signup.status).toBe(200);
  const token = sessionToken(signup);
  const auth = { Authorization: `Bearer ${token}` };

  const svc = await request(app).post('/api/services').set(auth)
    .send({ name: `Svc ${label}`, category: 'consultation', duration: 60, price: 50 });
  const staff = await request(app).post('/api/staff').set(auth)
    .send({ name: `Staff ${label}`, email: `staff-${label}-${RUN}@example.com`, serviceIds: [svc.body.data.id], workingHours: ALL_DAY });
  const customerName = `Cust${label}${RUN}`;
  const cust = await request(app).post('/api/customers').set(auth)
    .send({ name: customerName, email: `cust-${label}-${RUN}@example.com` });

  expect(svc.status).toBe(201);
  expect(staff.status).toBe(201);
  expect(cust.status).toBe(201);
  await publishBookingPage(app, auth, [svc.body.data.id], `org-${label}`);
  return { token, serviceId: svc.body.data.id, staffId: staff.body.data.id, customerId: cust.body.data.id, customerName };
}

let A: Org;
let B: Org;
const bearer = (o: Org) => ({ Authorization: `Bearer ${o.token}` });
/** The business's own time zone: availability and booking rules count days in it. */
async function businessTimeZone(o: Org): Promise<string> {
  const tz = (await request(app).get('/api/settings').set(bearer(o))).body.data?.timezone as string | undefined;
  expect(tz).toBeTruthy();
  return tz!;
}

beforeAll(async () => {
  A = await makeOrg('a');
  B = await makeOrg('b');
});

describe('staff ↔ service assignment stays in sync', () => {
  it('assigning a service on the staff record makes the staff appear on the service', async () => {
    const svc = await request(app).get(`/api/services/${A.serviceId}`).set(bearer(A));
    expect(svc.body.data.staffIds).toContain(A.staffId);
  });

  it('removing the service from the staff record removes the staff from the service', async () => {
    await request(app).put(`/api/staff/${A.staffId}`).set(bearer(A)).send({ serviceIds: [] }).expect(200);
    const svc = await request(app).get(`/api/services/${A.serviceId}`).set(bearer(A));
    expect(svc.body.data.staffIds).not.toContain(A.staffId);
  });

  it('assigning staff on the service updates the staff record', async () => {
    await request(app).put(`/api/services/${A.serviceId}`).set(bearer(A)).send({ staffIds: [A.staffId] }).expect(200);
    const staff = await request(app).get(`/api/staff/${A.staffId}`).set(bearer(A));
    expect(staff.body.data.serviceIds).toContain(A.serviceId);
  });

  it('rejects assigning another organization\'s service to a staff member', async () => {
    const res = await request(app).put(`/api/staff/${A.staffId}`).set(bearer(A)).send({ serviceIds: [B.serviceId] });
    expect(res.status).toBe(400);
  });
});

describe('cross-organization isolation', () => {
  const date = isoDaysAhead(20);

  it('rejects an appointment that references another organization\'s customer', async () => {
    const before = await request(app).get(`/api/customers/${B.customerId}`).set(bearer(B));
    const res = await request(app).post('/api/appointments').set(bearer(A))
      .send({ serviceId: A.serviceId, staffId: A.staffId, customerId: B.customerId, date, startTime: '09:00' });
    expect(res.status).toBe(400);
    const after = await request(app).get(`/api/customers/${B.customerId}`).set(bearer(B));
    expect(after.body.data.totalBookings).toBe(before.body.data.totalBookings);
  });

  it('rejects an appointment that references another organization\'s staff', async () => {
    const res = await request(app).post('/api/appointments').set(bearer(A))
      .send({ serviceId: A.serviceId, staffId: B.staffId, customerId: A.customerId, date, startTime: '09:00' });
    expect(res.status).toBe(400);
  });

  it('cannot read, update or delete another organization\'s appointment', async () => {
    const created = await request(app).post('/api/appointments').set(bearer(B))
      .send({ serviceId: B.serviceId, staffId: B.staffId, customerId: B.customerId, date, startTime: '09:00' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await request(app).get(`/api/appointments/${id}`).set(bearer(A))).status).toBe(404);
    expect((await request(app).put(`/api/appointments/${id}`).set(bearer(A)).send({ status: 'cancelled' })).status).toBe(404);
    expect((await request(app).delete(`/api/appointments/${id}`).set(bearer(A))).status).toBe(404);
    const list = await request(app).get('/api/appointments').set(bearer(A));
    expect(list.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
  });

  it('requires authentication', async () => {
    expect((await request(app).get('/api/appointments')).status).toBe(401);
    expect((await request(app).get('/api/appointments').set({ Authorization: 'Bearer not-a-token' })).status).toBe(401);
  });
});

describe('appointment status values and search', () => {
  let apptId = '';
  const date = isoDaysAhead(21);

  beforeAll(async () => {
    const res = await request(app).post('/api/appointments').set(bearer(A))
      .send({ serviceId: A.serviceId, staffId: A.staffId, customerId: A.customerId, date, startTime: '13:00' });
    expect(res.status).toBe(201);
    apptId = res.body.data.id;
  });

  it('accepts the backend status values (outcomes only once the appointment has started)', async () => {
    for (const status of ['confirmed', 'scheduled']) {
      const res = await request(app).put(`/api/appointments/${apptId}`).set(bearer(A)).send({ status });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
    for (const status of ['no_show', 'completed']) {
      const res = await request(app).put(`/api/appointments/${apptId}`).set(bearer(A)).send({ status });
      expect([status, res.status, res.body.code]).toEqual([status, 409, 'APPOINTMENT_NOT_STARTED']);
    }
    // Once the appointment is in the past (time has passed), the outcomes are accepted.
    db.prepare('UPDATE appointments SET date = ? WHERE id = ?').run(isoDaysAhead(-1), apptId);
    for (const status of ['no_show', 'completed', 'scheduled']) {
      const res = await request(app).put(`/api/appointments/${apptId}`).set(bearer(A)).send({ status });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
  });

  it('rejects legacy frontend status spellings', async () => {
    for (const status of ['no-show', 'pending']) {
      const res = await request(app).put(`/api/appointments/${apptId}`).set(bearer(A)).send({ status });
      expect(res.status).toBe(400);
    }
  });

  it('list returns the joined fields the UI consumes', async () => {
    const res = await request(app).get('/api/appointments').set(bearer(A));
    const row = res.body.data.find((a: { id: string }) => a.id === apptId);
    for (const key of ['customerName', 'customerEmail', 'serviceName', 'serviceColor', 'staffName', 'staffColor', 'bookingRef', 'endTime', 'duration', 'price']) {
      expect(row).toHaveProperty(key);
    }
    expect(row.customerName).toBe(A.customerName);
  });

  it('filters by q on customer name and treats LIKE wildcards literally', async () => {
    const hit = await request(app).get(`/api/appointments?q=${encodeURIComponent(A.customerName.slice(0, 6))}`).set(bearer(A));
    expect(hit.body.data.map((a: { id: string }) => a.id)).toContain(apptId);
    const wildcard = await request(app).get('/api/appointments?q=%25').set(bearer(A));
    expect(wildcard.body.data).toHaveLength(0);
  });
});

describe('public booking integrity', () => {
  const date = isoDaysAhead(22);

  it('rejects a service/staff pair from different organizations', async () => {
    const avail = await request(app).get(`/api/public/availability?date=${date}&serviceId=${A.serviceId}&staffId=${B.staffId}`);
    expect(avail.status).toBe(400);
    const book = await request(app).post('/api/public/book').send({
      serviceId: A.serviceId, staffId: B.staffId, date, startTime: '10:00',
      customer: { name: 'Mallory', email: `mallory-${RUN}@example.com` },
    });
    expect(book.status).toBe(400);
  });

  it('never offers a start time that has already passed today', async () => {
    const tz = await businessTimeZone(A);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const nowLocal = new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date()).replace(' ', 'T');
    const res = await request(app).get(`/api/public/availability?date=${today}&serviceId=${A.serviceId}&staffId=${A.staffId}`);
    expect(res.status).toBe(200);
    for (const slot of res.body.data as Array<{ start: string; available: boolean }>) {
      if (`${today}T${slot.start}` <= nowLocal) expect(slot.available).toBe(false);
    }
  });

  it('rejects a booking in the past', async () => {
    const res = await request(app).post('/api/public/book').send({
      serviceId: A.serviceId, staffId: A.staffId, date: '2020-01-06', startTime: '10:00',
      customer: { name: 'Past Pat', email: `past-${RUN}@example.com` },
    });
    expect(res.status).toBe(400);
  });

  it('accepts exactly one of two simultaneous bookings for the same slot', async () => {
    const body = (n: number) => ({
      serviceId: A.serviceId, staffId: A.staffId, date, startTime: '15:00',
      customer: { name: `Racer ${n}`, email: `racer${n}-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    const results = await Promise.all([1, 2].map(n => request(app).post('/api/public/book').send(body(n))));
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
  });

  it('lets a customer reschedule into a slot that overlaps their own booking, but not someone else\'s', async () => {
    const mine = await request(app).post('/api/public/book').send({
      serviceId: A.serviceId, staffId: A.staffId, date, startTime: '10:00',
      customer: { name: 'Mover', email: `mover-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(mine.status).toBe(201);
    const ref = mine.body.data.bookingRef;
    const reschedule = (startTime: string) => request(app).post('/api/public/appointments/manage/reschedule')
      .set('X-Booking-Token', mine.body.data.manageToken).send({ date, startTime });

    const overlapOwn = await reschedule('10:30');
    expect(overlapOwn.status).toBe(200);

    const intoOther = await reschedule('15:00');
    expect(intoOther.status).toBe(409);

    const admin = await request(app).get(`/api/appointments?q=${ref}`).set(bearer(A));
    expect(admin.body.data[0].startTime).toBe('10:30');
  });
});

describe('booking pages', () => {
  const slug = `page-${RUN}`;

  it('enforces slug uniqueness across organizations', async () => {
    const a = await request(app).post('/api/booking-pages').set(bearer(A))
      .send({ title: 'A page', slug, serviceIds: [A.serviceId], isPublished: true });
    expect(a.status).toBe(201);
    const b = await request(app).post('/api/booking-pages').set(bearer(B)).send({ title: 'B page', slug });
    expect(b.status).toBe(409);
  });

  it('rejects listing another organization\'s service on a page', async () => {
    const res = await request(app).post('/api/booking-pages').set(bearer(A))
      .send({ title: 'Bad page', slug: `bad-${RUN}`, serviceIds: [B.serviceId] });
    expect(res.status).toBe(400);
  });

  it('public page lists only its own active services', async () => {
    const res = await request(app).get(`/api/public/pages/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.data.services.map((s: { id: string }) => s.id)).toEqual([A.serviceId]);
  });
});

describe('resources and referential deletes', () => {
  it('accepts the table resource type end to end', async () => {
    const res = await request(app).post('/api/resources').set(bearer(A)).send({ name: `Table ${RUN}`, type: 'table', capacity: 4 });
    expect(res.status).toBe(201);
    const got = await request(app).get(`/api/resources/${res.body.data.id}`).set(bearer(A));
    expect(got.body.data.type).toBe('table');
  });

  it('refuses to delete staff that still has appointments with a clear 409', async () => {
    const res = await request(app).delete(`/api/staff/${A.staffId}`).set(bearer(A));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still used/i);
    const svc = await request(app).get(`/api/services/${A.serviceId}`).set(bearer(A));
    expect(svc.body.data.staffIds).toContain(A.staffId);
  });
});

describe('saved booking rules change real availability', () => {
  let tz = '';
  beforeAll(async () => { tz = await businessTimeZone(A); });
  /** The date offsetDays from today in the business's time zone. */
  const businessDate = (offsetDays: number) => {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offsetDays);
    return d.toISOString().split('T')[0];
  };
  const availableCount = async (date: string) => {
    const res = await request(app).get(`/api/public/availability?date=${date}&serviceId=${A.serviceId}&staffId=${A.staffId}`);
    expect(res.status).toBe(200);
    return (res.body.data as Array<{ available: boolean }>).filter(s => s.available).length;
  };
  const setRules = (bookingRules: Record<string, unknown>) =>
    request(app).put('/api/settings').set(bearer(A)).send({ bookingRules });

  afterEach(async () => {
    await setRules({});
    await request(app).put(`/api/services/${A.serviceId}`).set(bearer(A)).send({ minNotice: 0, maxAdvance: 30 });
  });

  it('rejects booking rules with the wrong types or units', async () => {
    expect((await setRules({ minNoticeHours: '24' })).status).toBe(400);
    expect((await setRules({ maxAdvanceDays: -1 })).status).toBe(400);
    expect((await setRules({ defaultBufferMinutes: 2.5 })).status).toBe(400);
  });

  it('organization minimum notice (hours) blocks near-term slots', async () => {
    expect(await availableCount(businessDate(1))).toBeGreaterThan(0);
    expect((await setRules({ minNoticeHours: 72 })).status).toBe(200);
    expect(await availableCount(businessDate(1))).toBe(0);
    expect(await availableCount(businessDate(6))).toBeGreaterThan(0);
  });

  it('organization maximum advance (days) blocks far-future dates', async () => {
    expect(await availableCount(businessDate(10))).toBeGreaterThan(0);
    await setRules({ maxAdvanceDays: 7 });
    expect(await availableCount(businessDate(10))).toBe(0);
    expect(await availableCount(businessDate(6))).toBeGreaterThan(0);
  });

  it('same-day booking off blocks every slot today', async () => {
    await setRules({ sameDay: false });
    expect(await availableCount(businessDate(0))).toBe(0);
    expect(await availableCount(businessDate(1))).toBeGreaterThan(0);
  });

  it('service-level notice and advance apply, and the stricter rule wins', async () => {
    await request(app).put(`/api/services/${A.serviceId}`).set(bearer(A)).send({ minNotice: 72 }).expect(200);
    expect(await availableCount(businessDate(1))).toBe(0);
    await request(app).put(`/api/services/${A.serviceId}`).set(bearer(A)).send({ minNotice: 0, maxAdvance: 5 }).expect(200);
    expect(await availableCount(businessDate(8))).toBe(0);
    await setRules({ maxAdvanceDays: 3 });
    expect(await availableCount(businessDate(4))).toBe(0);
    expect(await availableCount(businessDate(2))).toBeGreaterThan(0);
  });

  it('phone is required by default and optional only when turned off', async () => {
    const date = businessDate(9);
    const body = (email: string, time: string) => ({
      serviceId: A.serviceId, staffId: A.staffId, date, startTime: time,
      customer: { name: 'No Phone', email },
    });
    const page = await request(app).get(`/api/public/pages/page-${RUN}`);
    expect(page.body.data.requirePhone).toBe(true);
    expect((await request(app).post('/api/public/book').send(body(`nophone1-${RUN}@example.com`, '09:00'))).status).toBe(400);
    await setRules({ requirePhone: false });
    expect((await request(app).get(`/api/public/pages/page-${RUN}`)).body.data.requirePhone).toBe(false);
    expect((await request(app).post('/api/public/book').send(body(`nophone2-${RUN}@example.com`, '09:00'))).status).toBe(201);
  });
});

describe('"any available staff" and booking-page questions', () => {
  const date = isoDaysAhead(12);
  let secondStaffName = '';
  const slug = `b-page-${RUN}`;

  beforeAll(async () => {
    const second = await request(app).post('/api/staff').set(bearer(B))
      .send({ name: 'Zed Second', email: `zed-${RUN}@example.com`, serviceIds: [B.serviceId], workingHours: ALL_DAY });
    expect(second.status).toBe(201);
    secondStaffName = second.body.data.name;
    const page = await request(app).post('/api/booking-pages').set(bearer(B)).send({
      title: 'B page', slug, serviceIds: [B.serviceId], isPublished: true,
      formFields: [
        { id: 'reason', label: 'Reason for visit', type: 'text', required: true },
        { id: 'notes', label: 'Anything else', type: 'textarea', required: false },
      ],
    });
    expect(page.status).toBe(201);
  });

  const book = (staffId: string, startTime: string, n: string, answers = [{ fieldId: 'reason', answer: 'Checkup' }]) =>
    request(app).post('/api/public/book').send({
      pageSlug: slug, serviceId: B.serviceId, staffId, date, startTime,
      customer: { name: `Any ${n}`, email: `any-${n}-${RUN}@example.com`, phone: '+91 98765 40100' },
      customerAnswers: answers,
    });

  it('offers a time while at least one assigned staff member is free, and assigns that person', async () => {
    expect((await book(B.staffId, '11:00', 'named')).status).toBe(201);
    const avail = await request(app).get(`/api/public/availability?date=${date}&serviceId=${B.serviceId}&staffId=any`);
    expect(avail.body.data.find((s: { start: string }) => s.start === '11:00')?.available).toBe(true);
    const anyBooking = await book('any', '11:00', 'first');
    expect(anyBooking.status).toBe(201);
    expect(anyBooking.body.data.staffName).toBe(secondStaffName);
  });

  it('rejects "any" once every assigned staff member is busy', async () => {
    const avail = await request(app).get(`/api/public/availability?date=${date}&serviceId=${B.serviceId}&staffId=any`);
    expect(avail.body.data.find((s: { start: string }) => s.start === '11:00')?.available).toBe(false);
    expect((await book('any', '11:00', 'second')).status).toBe(409);
  });

  it('requires answers to required questions and rejects unknown ones', async () => {
    expect((await book('any', '15:00', 'noanswer', [])).status).toBe(400);
    expect((await book('any', '15:00', 'unknown', [{ fieldId: 'reason', answer: 'x' }, { fieldId: 'evil', answer: 'x' }])).status).toBe(400);
    const ok = await book('any', '15:00', 'answered', [{ fieldId: 'reason', answer: 'Back pain' }]);
    expect(ok.status).toBe(201);
    const appt = await request(app).get(`/api/appointments?q=${ok.body.data.bookingRef}`).set(bearer(B));
    const detail = await request(app).get(`/api/appointments/${appt.body.data[0].id}`).set(bearer(B));
    expect(detail.body.data.customerAnswers).toEqual([{ question: 'Reason for visit', answer: 'Back pain' }]);
  });

  it('public page exposes theme and questions; unsafe theme values are rejected', async () => {
    const bad = await request(app).post('/api/booking-pages').set(bearer(B))
      .send({ title: 'x', slug: `bad-theme-${RUN}`, serviceIds: [B.serviceId], theme: { primaryColor: 'red;}body{display:none' } });
    expect(bad.status).toBe(400);
    const pub = await request(app).get(`/api/public/pages/${slug}`);
    expect(pub.body.data.formFields).toHaveLength(2);
  });
});
