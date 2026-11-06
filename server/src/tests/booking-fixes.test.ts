// Regression tests for reported booking problems:
// - "Any available staff": eligibility, assignment, and a clear answer (not a missing-parameter error) when a service
//   has no staff;
// - the admin availability that the New Appointment form now uses;
// - a new business's time zone (India: Asia/Kolkata; elsewhere the signing-up browser's zone), workspace defaults, and
//   changing a business's time zone, which keeps every existing appointment at the same instant.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { todayInTimezone } from '../services/availability';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';
import { zonedToInstant, addMinutesToTime } from '../services/zoned-time';

// Some tests create several businesses (sign up, confirm the email, sign in: two password hashes each).
jest.setTimeout(30_000);

const RUN = Date.now().toString(36);
type Hours = Record<string, { enabled: boolean; start: string; end: string }>;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const hoursFor = (open: Record<string, [string, string]>): Hours =>
  Object.fromEntries(DAYS.map(d => [d, open[d] ? { enabled: true, start: open[d][0], end: open[d][1] } : { enabled: false, start: '09:00', end: '17:00' }]));

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** The next given weekday (0 = Sunday) at least two days ahead, so no "today" or notice rule interferes. */
function nextDow(from: string, dow: number): string {
  let d = shift(from, 2);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== dow) d = shift(d, 1);
  return d;
}

let counter = 0;
async function signup(extra: Record<string, unknown> = {}) {
  const n = ++counter;
  const email = `fix-${n}-${RUN}@example.com`;
  const res = await signUpAndSignIn(app, {
    name: `Fix Owner ${n}`, email, company: `Fix Org ${n} ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123', ...extra,
  });
  expect(res.status).toBe(200);
  const orgId = (db.prepare('SELECT organization_id FROM users WHERE email = ?').get(email) as { organization_id: string }).organization_id;
  const org = () => db.prepare('SELECT timezone, country FROM organizations WHERE id = ?').get(orgId) as { timezone: string; country: string };
  return { h: { Authorization: `Bearer ${sessionToken(res)}` }, orgId, org };
}

describe('"Any available staff" on a public booking page', () => {
  let svc = '', emptySvc = '', a = '', b = '', inactive = '', unassigned = '', tz = '';
  const ids = () => ({ a, b });

  beforeAll(async () => {
    const { h, org } = await signup();
    tz = org().timezone;
    svc = (await request(app).post('/api/services').set(h).send({ name: 'Any Svc', category: 'consultation', duration: 60, price: 10, maxAdvance: 90 })).body.data.id;
    emptySvc = (await request(app).post('/api/services').set(h).send({ name: 'No Staff Svc', category: 'consultation', duration: 30, price: 10, maxAdvance: 90 })).body.data.id;
    const other = (await request(app).post('/api/services').set(h).send({ name: 'Other Svc', category: 'consultation', duration: 30, price: 10, maxAdvance: 90 })).body.data.id;
    const staff = async (name: string, serviceIds: string[], hours: Hours) =>
      (await request(app).post('/api/staff').set(h).send({ name, email: `${name.replace(/\s/g, '')}-${RUN}@example.com`, serviceIds, workingHours: hours })).body.data.id as string;
    const weekdays = { monday: ['09:00', '17:00'], tuesday: ['09:00', '17:00'], wednesday: ['09:00', '17:00'], thursday: ['09:00', '17:00'], friday: ['09:00', '17:00'] } as Record<string, [string, string]>;
    a = await staff('Ada Any', [svc], hoursFor(weekdays));
    b = await staff('Ben Any', [svc], hoursFor({ monday: ['13:00', '17:00'], saturday: ['10:00', '12:00'] }));
    // Both of these work on Sunday, but neither may ever be offered for the service.
    inactive = await staff('Cy Inactive', [svc], hoursFor({ ...weekdays, sunday: ['09:00', '17:00'] }));
    await request(app).put(`/api/staff/${inactive}`).set(h).send({ isActive: false }).expect(200);
    unassigned = await staff('Di Unassigned', [other], hoursFor({ ...weekdays, sunday: ['09:00', '17:00'] }));
    await publishBookingPage(app, h, [svc, emptySvc, other], 'anyfix');
  });

  const days = (serviceId: string, from: string, to: string, staffId?: string) =>
    request(app).get(`/api/public/availability/days?serviceId=${serviceId}${staffId === undefined ? '' : `&staffId=${staffId}`}&from=${from}&to=${to}`);
  const slots = (date: string, staffId = 'any') => request(app).get(`/api/public/availability?date=${date}&serviceId=${svc}&staffId=${staffId}`);
  const book = (date: string, startTime: string, who: string, staffId = 'any') => request(app).post('/api/public/book').send({
    serviceId: svc, staffId, date, startTime, customer: { name: `Cust ${who}`, email: `cust-${who}-${RUN}@example.com`, phone: '+91 98765 40100' },
  });

  it('a service with no staff is not offered at all, and a missing staff id is still refused', async () => {
    const today = todayInTimezone(tz);
    // Not listed on the published page, so the wizard shows its existing "No services available" state.
    const page = (db.prepare('SELECT slug FROM booking_pages WHERE service_ids LIKE ?').get(`%${emptySvc}%`) as { slug: string }).slug;
    const listed = ((await request(app).get(`/api/public/pages/${page}`)).body.data.services as Array<{ id: string }>).map(s => s.id);
    expect(listed).toContain(svc);
    expect(listed).not.toContain(emptySvc);
    // Not public either when asked for directly: no schedule, no staff list, no booking.
    expect((await days(emptySvc, shift(today, 2), shift(today, 9), 'any')).status).toBe(404);
    expect((await request(app).get(`/api/public/services/${emptySvc}/staff`)).status).toBe(404);
    const booked = await request(app).post('/api/public/book').send({ serviceId: emptySvc, staffId: 'any', date: shift(today, 3), startTime: '10:00', customer: { name: 'Nobody', email: `nobody-${RUN}@example.com`, phone: '+91 98765 40100' } });
    expect(booked.status).toBe(400);
    // The parameter is still required: an empty or missing staff id is refused as before.
    expect((await days(svc, shift(today, 2), shift(today, 9))).status).toBe(400);
    expect((await days(svc, shift(today, 2), shift(today, 9), '')).status).toBe(400);
  });

  it('days are open when an eligible staff member works, and closed when only inactive or unassigned staff do', async () => {
    const today = todayInTimezone(tz);
    const sat = nextDow(today, 6), sun = nextDow(today, 0), wed = nextDow(today, 3);
    const from = [sat, sun, wed].sort()[0], to = [sat, sun, wed].sort()[2];
    const res = await days(svc, from, to, 'any');
    expect(res.status).toBe(200);
    const open = Object.fromEntries((res.body.data as Array<{ date: string; available: boolean }>).map(d => [d.date, d.available]));
    expect(open[wed]).toBe(true);   // Ada
    expect(open[sat]).toBe(true);   // Ben, 10:00-12:00
    expect(open[sun]).toBe(false);  // only the inactive and the unassigned staff work on Sundays
  });

  it('start times are the union of eligible staff, within their working hours', async () => {
    const sat = nextDow(todayInTimezone(tz), 6);
    const free = ((await slots(sat)).body.data as Array<{ start: string; available: boolean }>).filter(s => s.available).map(s => s.start);
    expect(free).toEqual(['10:00', '10:30', '11:00']); // 60-minute starts every 30 minutes inside Ben's 10:00-12:00
    const sun = nextDow(todayInTimezone(tz), 0);
    expect(((await slots(sun)).body.data as Array<{ available: boolean }>).some(s => s.available)).toBe(false);
  });

  it('booking "any" assigns a free, eligible staff member and stops when everyone is booked', async () => {
    const mon = nextDow(todayInTimezone(tz), 1);
    const first = await book(mon, '14:00', 'any1');
    const second = await book(mon, '14:00', 'any2');
    expect([first.status, second.status]).toEqual([201, 201]);
    const assigned = [first, second].map(r =>
      (db.prepare('SELECT staff_id FROM appointments WHERE booking_ref = ?').get(r.body.data.bookingRef) as { staff_id: string }).staff_id);
    expect(assigned.sort()).toEqual([ids().a, ids().b].sort());
    expect(assigned).not.toContain(inactive);
    expect(assigned).not.toContain(unassigned);
    expect((await book(mon, '14:00', 'any3')).status).toBe(409);
    // 09:00 on Monday is Ada's alone (Ben starts at 13:00): once she is booked, "any" no longer offers it.
    expect((await book(mon, '09:00', 'ada', a)).status).toBe(201);
    expect(((await slots(mon)).body.data as Array<{ start: string; available: boolean }>).find(s => s.start === '09:00')?.available).toBe(false);
    expect((await book(mon, '09:00', 'any4')).status).toBe(409);
  });

  it('outside every eligible staff member\'s hours nothing can be booked', async () => {
    const sat = nextDow(todayInTimezone(tz), 6);
    expect((await book(sat, '13:00', 'late')).status).toBe(409);       // Ben works until 12:00
    expect((await book(sat, '10:00', 'ada-sat', a)).status).toBe(409); // Ada does not work on Saturdays
  });
});

describe('New Appointment form data: admin availability and server-side checks', () => {
  it('offers only free times within working hours, and the server refuses the rest', async () => {
    const { h, org } = await signup();
    const svc = (await request(app).post('/api/services').set(h).send({ name: 'Admin Svc', category: 'consultation', duration: 60, price: 10, maxAdvance: 90 })).body.data.id;
    const staff = (await request(app).post('/api/staff').set(h).send({
      name: 'Admin Staff', email: `admin-staff-${RUN}@example.com`, serviceIds: [svc], workingHours: hoursFor({ tuesday: ['09:00', '12:00'] }),
    })).body.data.id;
    const customer = (await request(app).post('/api/customers').set(h).send({ name: 'Walk In', email: `walk-${RUN}@example.com` })).body.data.id;
    const tue = nextDow(todayInTimezone(org().timezone), 2);
    const free = async () => ((await request(app).get(`/api/appointments/availability?date=${tue}&serviceId=${svc}&staffId=${staff}`).set(h)).body.data as Array<{ start: string; available: boolean }>)
      .filter(s => s.available).map(s => s.start);
    expect(await free()).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00']);
    const create = (startTime: string) => request(app).post('/api/appointments').set(h).send({ serviceId: svc, staffId: staff, customerId: customer, date: tue, startTime });
    expect((await create('10:00')).status).toBe(201);
    expect(await free()).toEqual(['09:00', '11:00']);
    const clash = await create('10:30');
    expect(clash.status).toBe(409);
    const late = await create('11:30');
    expect(late.status).toBe(400);
    expect(late.body.error).toMatch(/outside/);
  });
});

describe('time zone of a new business', () => {
  it('India gets Asia/Kolkata: from a browser on Indian time, the old Calcutta name, or the country', async () => {
    const browser = await signup({ timezone: 'Asia/Kolkata' });
    expect(browser.org()).toEqual({ timezone: 'Asia/Kolkata', country: 'IN' });
    expect((await signup({ timezone: 'Asia/Calcutta' })).org().timezone).toBe('Asia/Kolkata');
    // An Indian business set up while travelling still runs on Indian time.
    expect((await signup({ country: 'India', timezone: 'Europe/London' })).org()).toEqual({ timezone: 'Asia/Kolkata', country: 'India' });
  });

  it('elsewhere the business gets its own browser zone, so India is not hardcoded for everyone', async () => {
    expect((await signup({ timezone: 'Europe/London' })).org().timezone).toBe('Europe/London');
    expect((await signup({ timezone: 'America/Sao_Paulo' })).org().timezone).toBe('America/Sao_Paulo');
  });

  it('without a usable zone or country a new business gets the Indian defaults, and a bad value never blocks sign-up', async () => {
    const plain = await signup();
    expect(plain.org().timezone).toBe('Asia/Kolkata');
    expect(db.prepare('SELECT country, currency, date_format FROM organizations WHERE id = ?').get(plain.orgId))
      .toEqual({ country: 'IN', currency: 'INR', date_format: 'DD/MM/YYYY' });
    expect((await signup({ timezone: 'Mars/Olympus_Mons' })).org().timezone).toBe('Asia/Kolkata');
    // A business signed up from another zone keeps that zone (its times stay right) and the deployment's currency.
    const abroad = await signup({ timezone: 'Europe/London' });
    expect(abroad.org().timezone).toBe('Europe/London');
    expect((db.prepare('SELECT currency FROM organizations WHERE id = ?').get(abroad.orgId) as { currency: string }).currency).toBe('INR');
  });

  it('a new workspace follows its business zone unless one is chosen', async () => {
    const { h } = await signup({ timezone: 'Asia/Kolkata' });
    const plain = await request(app).post('/api/workspaces').set(h).send({ name: 'Main room' });
    expect(plain.status).toBe(201);
    expect(plain.body.data.timezone).toBe('Asia/Kolkata');
    const chosen = await request(app).post('/api/workspaces').set(h).send({ name: 'Paris room', timezone: 'Europe/Paris' });
    expect(chosen.body.data.timezone).toBe('Europe/Paris');
  });
});

describe('changing a business time zone', () => {
  it('keeps each existing appointment at the same instant (re-expressed in the new zone) and records new ones there', async () => {
    const { h, orgId } = await signup({ timezone: 'America/New_York' }); // the premise: a business moving from New York to India
    const svc = (await request(app).post('/api/services').set(h).send({ name: 'Tz Svc', category: 'consultation', duration: 30, price: 10, maxAdvance: 90 })).body.data.id;
    const staff = (await request(app).post('/api/staff').set(h).send({
      name: 'Tz Staff', email: `tz-staff-${RUN}@example.com`, serviceIds: [svc],
      workingHours: hoursFor(Object.fromEntries(DAYS.map(d => [d, ['08:00', '20:00']])) as Record<string, [string, string]>),
    })).body.data.id;
    const customer = (await request(app).post('/api/customers').set(h).send({ name: 'Tz Cust', email: `tz-cust-${RUN}@example.com` })).body.data.id;
    const date = shift(todayInTimezone('America/New_York'), 5);
    const before = await request(app).post('/api/appointments').set(h).send({ serviceId: svc, staffId: staff, customerId: customer, date, startTime: '10:00' });
    expect(before.status).toBe(201);
    const row = () => db.prepare('SELECT date, start_time, end_time, timezone FROM appointments WHERE id = ?').get(before.body.data.id);
    const recorded = row();
    expect(recorded).toEqual({ date, start_time: '10:00', end_time: '10:30', timezone: 'America/New_York' });

    const instantBefore = zonedToInstant(date, '10:00', 'America/New_York');
    const change = await request(app).put('/api/settings').set(h).send({ timezone: 'Asia/Kolkata' }).expect(200);
    expect(change.body.appointmentsReexpressed).toBe(1);
    const moved = row() as { date: string; start_time: string; end_time: string; timezone: string };
    expect(moved.timezone).toBe('Asia/Kolkata');
    expect(zonedToInstant(moved.date, moved.start_time, 'Asia/Kolkata')).toBe(instantBefore);
    expect(moved.end_time).toBe(addMinutesToTime(moved.start_time, 30));

    const after = await request(app).post('/api/appointments').set(h).send({ serviceId: svc, staffId: staff, customerId: customer, date: shift(date, 1), startTime: '10:00' });
    expect(after.status).toBe(201);
    expect((db.prepare('SELECT timezone FROM appointments WHERE id = ?').get(after.body.data.id) as { timezone: string }).timezone).toBe('Asia/Kolkata');
    expect((db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(orgId) as { timezone: string }).timezone).toBe('Asia/Kolkata');
  });
});
