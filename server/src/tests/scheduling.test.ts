// Scheduling rules shared by public booking, the admin New Appointment form and every server-side booking check:
// business hours, weekly breaks, staff time off and business closures; plus time-zone changes that keep every
// appointment at the same instant, daylight-saving days, and the conversion helpers themselves.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { todayInTimezone } from '../services/availability';
import { zonedToInstant, instantToZoned } from '../services/zoned-time';
import { initEmail, testOutbox } from '../services/email/notify';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';
import { localAnswer } from '../services/local-answer';
import { executeTool } from '../services/ai-tools';

// Each test signs up whole businesses (password hashing, services, staff, pages); 5 s is too tight on a loaded machine.
jest.setTimeout(30_000);

const RUN = Date.now().toString(36);
type Hours = Record<string, { enabled: boolean; start: string; end: string }>;
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const everyDay = (start: string, end: string): Hours => Object.fromEntries(DAYS.map(d => [d, { enabled: true, start, end }]));

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

let n = 0;
async function business(extra: Record<string, unknown> = {}) {
  const email = `sched-${++n}-${RUN}@example.com`;
  const res = await signUpAndSignIn(app, { name: `Sched ${n}`, email, company: `Sched ${n} ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123', ...extra });
  expect(res.status).toBe(200);
  const orgId = (db.prepare('SELECT organization_id FROM users WHERE email = ?').get(email) as { organization_id: string }).organization_id;
  const h = { Authorization: `Bearer ${sessionToken(res)}` };
  const service = (await request(app).post('/api/services').set(h).send({ name: `Svc ${n}`, category: 'consultation', duration: 60, price: 10, maxAdvance: 400 })).body.data.id as string;
  const staff = async (name: string, hours: Hours) => (await request(app).post('/api/staff').set(h)
    .send({ name, email: `${name.replace(/\s/g, '').toLowerCase()}-${n}-${RUN}@example.com`, serviceIds: [service], workingHours: hours })).body.data.id as string;
  const customer = (await request(app).post('/api/customers').set(h).send({ name: 'Sched Customer', email: `sched-cust-${n}-${RUN}@example.com` })).body.data.id as string;
  await publishBookingPage(app, h, [service], `sched${n}`);
  const tz = (db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(orgId) as { timezone: string }).timezone;
  return { h, orgId, service, staff, customer, tz };
}
async function userWithRole(orgId: string, role: string) {
  const email = `${role}-${nanoid(6)}-${RUN}@example.com`.toLowerCase();
  db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`user-${nanoid(8)}`, orgId, email, bcrypt.hashSync('TestPass123', 4), `${role} user`, role);
  const res = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  return { Authorization: `Bearer ${sessionToken(res)}` };
}
const publicFree = async (service: string, staff: string, date: string) =>
  ((await request(app).get(`/api/public/availability?date=${date}&serviceId=${service}&staffId=${staff}`)).body.data as Array<{ start: string; available: boolean }>)
    .filter(s => s.available).map(s => s.start);
const adminFree = async (h: Record<string, string>, service: string, staff: string, date: string) =>
  ((await request(app).get(`/api/appointments/availability?date=${date}&serviceId=${service}&staffId=${staff}`).set(h)).body.data as Array<{ start: string; available: boolean }>)
    .filter(s => s.available).map(s => s.start);
const hourly = (from: number, to: number) => Array.from({ length: (to - from) * 2 + 1 }, (_, i) => `${String(from + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

describe('business hours narrow staff hours everywhere', () => {
  it('slots and server checks keep inside both, a closed business day is closed, and no saved hours means staff hours only', async () => {
    const b = await business();
    const ada = await b.staff('Ada Hours', everyDay('09:00', '17:00'));
    const mon = nextDow(todayInTimezone(b.tz), 1), sat = nextDow(todayInTimezone(b.tz), 6);
    expect(await publicFree(b.service, ada, mon)).toEqual(hourly(9, 16)); // no business hours saved yet
    const businessHours = { ...everyDay('10:00', '16:00'), saturday: { enabled: false, start: '10:00', end: '16:00' }, sunday: { enabled: false, start: '10:00', end: '16:00' } };
    await request(app).put('/api/settings').set(b.h).send({ workingHours: businessHours }).expect(200);
    expect(await publicFree(b.service, ada, mon)).toEqual(hourly(10, 15)); // 60-minute starts 10:00-15:00
    expect(await adminFree(b.h, b.service, ada, mon)).toEqual(hourly(10, 15)); // the New Appointment form agrees
    expect(await publicFree(b.service, ada, sat)).toEqual([]); // Ada works Saturdays, the business does not
    const create = (date: string, startTime: string) => request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date, startTime });
    const early = await create(mon, '09:00');
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('That time is outside business hours for Ada Hours (10:00–16:00)');
    const closed = await create(sat, '11:00');
    expect(closed.body.error).toBe('The business is closed on Saturdays');
    expect((await create(mon, '10:00')).status).toBe(201);
    await request(app).put('/api/settings').set(b.h).send({ workingHours: {} }).expect(200);
    expect((await publicFree(b.service, ada, sat)).length).toBeGreaterThan(0);
  });

  it('refuses malformed business hours instead of saving them', async () => {
    const b = await business();
    const bad = [
      { monday: { enabled: true, start: '17:00', end: '09:00' } },
      { monday: { enabled: true, start: '9am', end: '17:00' } },
      { funday: { enabled: true, start: '09:00', end: '17:00' } },
    ];
    for (const workingHours of bad) expect((await request(app).put('/api/settings').set(b.h).send({ workingHours })).status).toBe(400);
    expect((db.prepare('SELECT working_hours FROM organizations WHERE id = ?').get(b.orgId) as { working_hours: string }).working_hours).toBe('{}');
  });
});

describe('weekly breaks', () => {
  it('a staff break and a business break block slots and bookings; removing them restores the slots', async () => {
    const b = await business();
    const ada = await b.staff('Ada Break', everyDay('09:00', '17:00'));
    const ben = await b.staff('Ben Break', everyDay('09:00', '17:00'));
    const tue = nextDow(todayInTimezone(b.tz), 2);
    const own = await request(app).post('/api/time-off/breaks').set(b.h).send({ staffId: ada, weekday: 'tuesday', startTime: '12:00', endTime: '13:00', label: 'Lunch' });
    expect(own.status).toBe(201);
    expect(await publicFree(b.service, ada, tue)).toEqual(hourly(9, 16).filter(t => !['11:30', '12:00', '12:30'].includes(t)));
    expect(await publicFree(b.service, ben, tue)).toEqual(hourly(9, 16)); // only Ada's break
    const clash = await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date: tue, startTime: '12:30' });
    expect(clash.status).toBe(400);
    expect(clash.body.error).toBe("That time overlaps Ada Break's break (Lunch) (12:00–13:00)");
    const team = await request(app).post('/api/time-off/breaks').set(b.h).send({ weekday: 'tuesday', startTime: '15:00', endTime: '15:30', label: 'Team huddle' });
    expect(team.status).toBe(201);
    expect(await publicFree(b.service, ben, tue)).not.toContain('14:30');
    expect(await publicFree(b.service, ben, tue)).not.toContain('15:00');
    for (const id of [own.body.data.id, team.body.data.id]) await request(app).delete(`/api/time-off/breaks/${id}`).set(b.h).expect(200);
    expect(await publicFree(b.service, ada, tue)).toEqual(hourly(9, 16));
  });

  it('validates breaks and limits who may change them', async () => {
    const b = await business();
    const ada = await b.staff('Ada Rules', everyDay('09:00', '17:00'));
    const post = (h: Record<string, string>, body: Record<string, unknown>) => request(app).post('/api/time-off/breaks').set(h).send(body);
    expect((await post(b.h, { staffId: ada, weekday: 'tuesday', startTime: '13:00', endTime: '12:00' })).status).toBe(400);
    expect((await post(b.h, { staffId: ada, weekday: 'someday', startTime: '12:00', endTime: '13:00' })).status).toBe(400);
    expect((await post(b.h, { staffId: ada, weekday: 'tuesday', startTime: '12:00', endTime: '13:00', extra: true })).status).toBe(400);
    const manager = await userWithRole(b.orgId, 'manager');
    const staffUser = await userWithRole(b.orgId, 'staff');
    expect((await post(manager, { staffId: ada, weekday: 'tuesday', startTime: '12:00', endTime: '13:00' })).status).toBe(403);
    expect((await post(staffUser, { weekday: 'tuesday', startTime: '12:00', endTime: '13:00' })).status).toBe(403);
    expect((await request(app).get('/api/time-off/breaks').set(staffUser)).status).toBe(403);
    expect((await request(app).get('/api/time-off/breaks').set(manager)).status).toBe(200);
    expect((await request(app).post('/api/time-off/breaks').send({ weekday: 'tuesday', startTime: '12:00', endTime: '13:00' })).status).toBe(401);
  });
});

describe('time off and business closures', () => {
  it('whole days and part days block availability and bookings, without changing existing appointments', async () => {
    const b = await business();
    const ada = await b.staff('Ada Leave', everyDay('09:00', '17:00'));
    const ben = await b.staff('Ben Leave', everyDay('09:00', '17:00'));
    const wed = nextDow(todayInTimezone(b.tz), 3), thu = shift(wed, 1);
    const existing = await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date: wed, startTime: '10:00' });
    expect(existing.status).toBe(201);
    const before = db.prepare('SELECT date, start_time, end_time, status, staff_id FROM appointments WHERE id = ?').get(existing.body.data.id);

    const leave = await request(app).post('/api/time-off').set(b.h).send({ staffId: ada, startDate: wed, endDate: wed, reason: 'Annual leave' });
    expect(leave.status).toBe(201);
    // The appointment inside the leave is reported, not moved or cancelled.
    expect(leave.body.conflicts.map((c: { id: string }) => c.id)).toEqual([existing.body.data.id]);
    expect(db.prepare('SELECT date, start_time, end_time, status, staff_id FROM appointments WHERE id = ?').get(existing.body.data.id)).toEqual(before);

    expect(await publicFree(b.service, ada, wed)).toEqual([]);
    expect(await publicFree(b.service, ben, wed)).toEqual(hourly(9, 16));
    const days = (await request(app).get(`/api/public/availability/days?serviceId=${b.service}&staffId=${ada}&from=${wed}&to=${thu}`)).body.data;
    expect(days).toEqual([{ date: wed, available: false }, { date: thu, available: true }]);
    const refused = await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date: wed, startTime: '14:00' });
    expect(refused.body.error).toBe('Ada Leave is on time off that day (Annual leave)');
    // "Any available staff" goes to the colleague who is in.
    const anyone = await request(app).post('/api/public/book').send({ serviceId: b.service, staffId: 'any', date: wed, startTime: '14:00', customer: { name: 'Any Guest', email: `any-guest-${RUN}@example.com`, phone: '+91 98765 40100' } });
    expect(anyone.status).toBe(201);
    expect((db.prepare('SELECT staff_id FROM appointments WHERE booking_ref = ?').get(anyone.body.data.bookingRef) as { staff_id: string }).staff_id).toBe(ben);

    const partial = await request(app).post('/api/time-off').set(b.h).send({ staffId: ben, startDate: thu, endDate: thu, startTime: '13:00', endTime: '15:00', reason: 'Dentist' });
    expect(partial.status).toBe(201);
    expect(await publicFree(b.service, ben, thu)).toEqual(hourly(9, 16).filter(t => !['12:30', '13:00', '13:30', '14:00', '14:30'].includes(t)));

    const holiday = await request(app).post('/api/time-off').set(b.h).send({ startDate: thu, endDate: thu, reason: 'Diwali' });
    expect(holiday.status).toBe(201);
    expect(await publicFree(b.service, ada, thu)).toEqual([]);
    expect(await publicFree(b.service, ben, thu)).toEqual([]);
    const closedDay = await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date: thu, startTime: '10:00' });
    expect(closedDay.body.error).toBe('The business is closed that day (Diwali)');

    for (const id of [leave.body.data.id, partial.body.data.id, holiday.body.data.id]) await request(app).delete(`/api/time-off/${id}`).set(b.h).expect(200);
    expect(await publicFree(b.service, ada, wed)).toEqual(hourly(9, 16).filter(t => !['09:30', '10:00', '10:30'].includes(t)));
  });

  it('customers never learn why a time is unavailable: no time-off reason in public answers', async () => {
    const b = await business();
    const ada = await b.staff('Ada Reason', everyDay('09:00', '17:00'));
    const fri = nextDow(todayInTimezone(b.tz), 5);
    const booked = await request(app).post('/api/public/book').send({ serviceId: b.service, staffId: ada, date: fri, startTime: '10:00', customer: { name: 'Rhea Reason', email: `rhea-${RUN}@example.com`, phone: '+91 98765 40100' } });
    expect(booked.status).toBe(201);
    const next = shift(fri, 3);
    await request(app).post('/api/time-off').set(b.h).send({ staffId: ada, startDate: next, endDate: next, reason: 'Hospital appointment' }).expect(201);
    const moved = await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', booked.body.data.manageToken).send({ date: next, startTime: '10:00' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toBe('That time is not available. Please choose another time.');
    const anyone = await request(app).post('/api/public/book').send({ serviceId: b.service, staffId: ada, date: next, startTime: '11:00', customer: { name: 'Rhea Reason', email: `rhea2-${RUN}@example.com`, phone: '+91 98765 40100' } });
    for (const res of [moved, anyone, await request(app).get(`/api/public/availability?date=${next}&serviceId=${b.service}&staffId=${ada}`)]) {
      expect(JSON.stringify(res.body)).not.toMatch(/Hospital|time off/i);
    }
  });

  it('validates periods, limits who may change them, and keeps each business\'s periods private', async () => {
    const b = await business();
    const other = await business();
    const ada = await b.staff('Ada Private', everyDay('09:00', '17:00'));
    const d = nextDow(todayInTimezone(b.tz), 4);
    const post = (h: Record<string, string>, body: Record<string, unknown>) => request(app).post('/api/time-off').set(h).send(body);
    for (const body of [
      { staffId: ada, startDate: d, endDate: shift(d, -1) },
      { staffId: ada, startDate: d, endDate: d, startTime: '10:00' },
      { staffId: ada, startDate: d, endDate: d, startTime: '12:00', endTime: '11:00' },
      { staffId: ada, startDate: '2026-02-30', endDate: '2026-03-01' },
      { staffId: ada, startDate: d, endDate: shift(d, 400) },
    ]) expect((await post(b.h, body)).status).toBe(400);
    const manager = await userWithRole(b.orgId, 'manager');
    const staffUser = await userWithRole(b.orgId, 'staff');
    expect((await post(manager, { staffId: ada, startDate: d, endDate: d })).status).toBe(403); // staff management is admin-only
    expect((await post(manager, { startDate: d, endDate: d })).status).toBe(403);             // closures need business settings
    expect((await request(app).get('/api/time-off').set(manager)).status).toBe(200);           // but managers can see them
    expect((await request(app).get('/api/time-off').set(staffUser)).status).toBe(403);
    // Another business can neither use this staff member nor see or delete this business's periods.
    expect((await post(other.h, { staffId: ada, startDate: d, endDate: d })).status).toBe(404);
    const mine = await post(b.h, { staffId: ada, startDate: d, endDate: d, reason: 'Private reason' });
    expect(JSON.stringify((await request(app).get('/api/time-off').set(other.h)).body)).not.toContain('Private reason');
    expect((await request(app).delete(`/api/time-off/${mine.body.data.id}`).set(other.h)).status).toBe(404);
    expect((await request(app).get('/api/time-off')).status).toBe(401);
  });
});

describe('public booking and the New Appointment form apply the same rules', () => {
  // For every kind of rule: both slot lists agree, and a public booking, a dashboard booking and a dashboard
  // reschedule onto the blocked time are all refused. Public answers never carry the reason.
  it.each([
    ['business hours', 'monday', '09:00'],
    ['staff break', 'tuesday', '12:00'],
    ['business break', 'tuesday', '15:00'],
    ['staff time off', 'wednesday', '11:00'],
    ['business closure', 'thursday', '10:00'],
  ])('%s', async (rule, weekday, blocked) => {
    const b = await business();
    const ada = await b.staff(`Ada Same ${rule}`, everyDay('09:00', '17:00'));
    const date = nextDow(todayInTimezone(b.tz), DAYS.indexOf(weekday) + 1 === 7 ? 0 : DAYS.indexOf(weekday) + 1);
    const before = await publicFree(b.service, ada, date);
    expect(before).toContain(blocked);

    if (rule === 'business hours') await request(app).put('/api/settings').set(b.h).send({ workingHours: everyDay('10:00', '17:00') }).expect(200);
    if (rule === 'staff break') await request(app).post('/api/time-off/breaks').set(b.h).send({ staffId: ada, weekday, startTime: '12:00', endTime: '13:00', label: 'Private lunch' }).expect(201);
    if (rule === 'business break') await request(app).post('/api/time-off/breaks').set(b.h).send({ weekday, startTime: '15:00', endTime: '16:00', label: 'Private huddle' }).expect(201);
    if (rule === 'staff time off') await request(app).post('/api/time-off').set(b.h).send({ staffId: ada, startDate: date, endDate: date, startTime: '11:00', endTime: '12:00', reason: 'Private errand' }).expect(201);
    if (rule === 'business closure') await request(app).post('/api/time-off').set(b.h).send({ startDate: date, endDate: date, reason: 'Private holiday' }).expect(201);

    const pub = await publicFree(b.service, ada, date);
    expect(pub).not.toContain(blocked);
    expect(await adminFree(b.h, b.service, ada, date)).toEqual(pub);

    const publicBooking = await request(app).post('/api/public/book').send({ serviceId: b.service, staffId: ada, date, startTime: blocked, customer: { name: 'Same Rules', email: `same-${rule.replace(/\s/g, '')}-${RUN}@example.com`, phone: '+91 98765 40100' } });
    expect(publicBooking.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(publicBooking.body)).not.toMatch(/Private/);
    const dashboard = await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date, startTime: blocked });
    expect(dashboard.status).toBe(400);

    // A booking made elsewhere cannot be moved onto the blocked time from the dashboard either.
    const free = pub[pub.length - 1] ?? null;
    const otherDay = shift(date, 7);
    const existing = await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date: free ? date : otherDay, startTime: free ?? '16:00' });
    expect(existing.status).toBe(201);
    const moved = await request(app).put(`/api/appointments/${existing.body.data.id}`).set(b.h).send({ date, startTime: blocked });
    expect(moved.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE staff_id = ? AND date = ? AND start_time = ?').get(ada, date, blocked)).toEqual({ n: 0 });
  });
});

describe('the assistant offers the same times as the New Appointment form', () => {
  it('respects business hours, breaks and time off, and lists only staff assigned to the service', async () => {
    const b = await business();
    const ada = await b.staff('Ada Assist', everyDay('09:00', '17:00'));
    const outsider = await request(app).post('/api/staff').set(b.h)
      .send({ name: 'Una Unassigned', email: `una-${RUN}@example.com`, serviceIds: [], workingHours: everyDay('09:00', '17:00') });
    expect(outsider.status).toBe(201);
    const tue = nextDow(todayInTimezone(b.tz), 2);
    await request(app).put('/api/settings').set(b.h).send({ workingHours: everyDay('10:00', '16:00') }).expect(200);
    await request(app).post('/api/time-off/breaks').set(b.h).send({ staffId: ada, weekday: 'tuesday', startTime: '12:00', endTime: '13:00' }).expect(201);
    await request(app).post('/api/time-off').set(b.h).send({ staffId: ada, startDate: tue, endDate: tue, startTime: '14:00', endTime: '15:00' }).expect(201);

    const form = await adminFree(b.h, b.service, ada, tue);
    expect(form).toEqual(['10:00', '10:30', '11:00', '13:00', '15:00']);

    const owner = db.prepare('SELECT id, email FROM users WHERE organization_id = ?').get(b.orgId) as { id: string; email: string };
    const user = { sub: owner.id, email: owner.email, orgId: b.orgId, role: 'admin' as const };
    const answer = await localAnswer(`Show me available slots for ${tue}`, 5, user);
    expect(answer.type).toBe('availability');
    expect(answer.slots).toEqual([{ staffName: 'Ada Assist', times: form }]);
    const tool = executeTool('get_availability', { date: tue, serviceId: b.service }, user, 'conv-test');
    expect((tool.content as { slotsPerStaff: unknown }).slotsPerStaff).toEqual([{ staffId: ada, staffName: 'Ada Assist', slots: form }]);
  });
});

describe('time-zone changes keep every appointment at the same instant', () => {
  it('re-expresses appointments across daylight saving, past midnight, and back again exactly', async () => {
    const b = await business({ timezone: 'America/New_York' });
    const ada = await b.staff('Ada Zone', everyDay('00:00', '23:59'));
    const year = Number(todayInTimezone(b.tz).slice(0, 4)) + 1;
    const winter = `${year}-01-12`, summer = `${year}-07-13`; // EST (UTC-5) and EDT (UTC-4)
    const make = async (date: string, startTime: string) => (await request(app).post('/api/appointments').set(b.h)
      .send({ serviceId: b.service, staffId: ada, customerId: b.customer, date, startTime })).body.data.id as string;
    const ids = [await make(winter, '10:00'), await make(summer, '10:00'), await make(summer, '14:00')];
    await request(app).put(`/api/appointments/${ids[0]}`).set(b.h).send({ status: 'cancelled' }).expect(200);
    const rows = () => ids.map(id => db.prepare('SELECT date, start_time, end_time, timezone, status, staff_id FROM appointments WHERE id = ?').get(id));
    const original = rows();
    const instants = ids.map(id => { const r = db.prepare('SELECT date, start_time, timezone FROM appointments WHERE id = ?').get(id) as { date: string; start_time: string; timezone: string }; return zonedToInstant(r.date, r.start_time, r.timezone); });

    const res = await request(app).put('/api/settings').set(b.h).send({ timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(200);
    expect(res.body.appointmentsReexpressed).toBe(3);
    expect(rows()).toEqual([
      { date: winter, start_time: '20:30', end_time: '21:30', timezone: 'Asia/Kolkata', status: 'cancelled', staff_id: ada }, // +10:30 in winter
      { date: summer, start_time: '19:30', end_time: '20:30', timezone: 'Asia/Kolkata', status: 'scheduled', staff_id: ada }, // +9:30 in summer
      { date: summer, start_time: '23:30', end_time: '24:30', timezone: 'Asia/Kolkata', status: 'scheduled', staff_id: ada }, // runs past midnight
    ]);
    ids.forEach((id, i) => {
      const r = db.prepare('SELECT date, start_time, timezone FROM appointments WHERE id = ?').get(id) as { date: string; start_time: string; timezone: string };
      expect(zonedToInstant(r.date, r.start_time, r.timezone)).toBe(instants[i]);
    });
    // Changing back restores the original values exactly.
    await request(app).put('/api/settings').set(b.h).send({ timezone: 'America/New_York' }).expect(200);
    expect(rows()).toEqual(original);
    // Saving the same zone again changes nothing.
    expect((await request(app).put('/api/settings').set(b.h).send({ timezone: 'America/New_York' })).body.appointmentsReexpressed).toBe(0);
  });

  it('refuses a change that would put two appointments of one staff member at the same moment, and changes nothing', async () => {
    const b = await business({ timezone: 'America/New_York' });
    const ada = await b.staff('Ada Overlap', everyDay('00:00', '23:59'));
    const date = shift(todayInTimezone(b.tz), 30);
    const ny = (await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date, startTime: '10:00' })).body.data.id;
    // A legacy row recorded in Kolkata at the same instant (10:00 New York) for the same staff member.
    const local = instantToZoned(zonedToInstant(date, '10:00', 'America/New_York'), 'Asia/Kolkata');
    const row = db.prepare('SELECT * FROM appointments WHERE id = ?').get(ny) as Record<string, unknown>;
    db.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, timezone)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, 60, 'Asia/Kolkata')`)
      .run(`appt-${nanoid(8)}`, `WE-${nanoid(8)}`, row.organization_id, row.service_id, ada, row.customer_id, local.date, local.time, `${String(Number(local.time.slice(0, 2)) + 1).padStart(2, '0')}${local.time.slice(2)}`);
    const before = db.prepare('SELECT * FROM appointments WHERE organization_id = ? ORDER BY id').all(row.organization_id);
    const res = await request(app).put('/api/settings').set(b.h).send({ timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT * FROM appointments WHERE organization_id = ? ORDER BY id').all(row.organization_id)).toEqual(before);
    expect((db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(b.orgId) as { timezone: string }).timezone).toBe('America/New_York');
  });

  it('emails about a re-expressed appointment show its new local time and zone', async () => {
    initEmail({ EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173', EMAIL_FROM: 'Test <test@example.com>' });
    const b = await business({ timezone: 'America/New_York' });
    const ada = await b.staff('Ada Mail', everyDay('00:00', '23:59'));
    const date = `${Number(todayInTimezone(b.tz).slice(0, 4)) + 1}-01-12`;
    const id = (await request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: ada, customerId: b.customer, date, startTime: '10:00' })).body.data.id;
    await request(app).put('/api/settings').set(b.h).send({ timezone: 'Asia/Kolkata' }).expect(200);
    testOutbox.clear();
    await request(app).put(`/api/appointments/${id}`).set(b.h).send({ status: 'cancelled' }).expect(200);
    const m = testOutbox.messages.find(x => x.subject.startsWith('Booking cancelled'));
    expect(m?.text).toMatch(/8:30 PM–9:30 PM .*Asia\/Kolkata/);
  });
});

describe('daylight-saving days', () => {
  it('offer the same wall-clock times as any other day', async () => {
    const b = await business({ timezone: 'America/New_York' });
    const ada = await b.staff('Ada Dst', everyDay('09:00', '17:00'));
    const year = Number(todayInTimezone(b.tz).slice(0, 4)) + 1;
    // Second Sunday of March and first Sunday of November in the United States.
    const sundays = (month: number) => Array.from({ length: 14 }, (_, i) => `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`)
      .filter(d => new Date(`${d}T12:00:00Z`).getUTCDay() === 0);
    const [springForward, fallBack] = [sundays(3)[1], sundays(11)[0]];
    for (const day of [springForward, fallBack, shift(springForward, 7)]) {
      expect(await adminFree(b.h, b.service, ada, day)).toEqual(hourly(9, 16));
    }
  });

  it('conversions handle skipped and repeated hours', () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(iso(zonedToInstant('2026-03-08', '02:30', 'America/New_York'))).toBe('2026-03-08T07:30:00.000Z'); // skipped: lands after the jump
    expect(iso(zonedToInstant('2026-11-01', '01:30', 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z'); // repeated: first occurrence
    expect(iso(zonedToInstant('2026-10-25', '01:30', 'Europe/London'))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(zonedToInstant('2026-04-05', '02:30', 'Australia/Sydney'))).toBe('2026-04-04T15:30:00.000Z');
    expect(iso(zonedToInstant('2026-10-23', '10:00', 'Asia/Kolkata'))).toBe('2026-10-23T04:30:00.000Z');
    expect(instantToZoned(Date.parse('2026-07-15T14:00:00Z'), 'America/New_York')).toEqual({ date: '2026-07-15', time: '10:00' });
  });
});
