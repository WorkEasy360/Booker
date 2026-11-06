// Dashboard and assistant bookings follow the rules public booking uses (the source of truth): the 30-minute grid,
// service buffers, staff hours narrowed by business hours in the business time zone, assignment, breaks, time off,
// closures and conflicts. The server enforces them, so direct API calls cannot bypass them.

import request from 'supertest';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { todayInTimezone } from '../services/availability';
import { executeTool, executeConfirmedProposal } from '../services/ai-tools';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

// Each test signs up whole businesses and makes many bookings.
jest.setTimeout(120_000);

const RUN = Date.now().toString(36);
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
type Hours = Record<string, { enabled: boolean; start: string; end: string }>;
const everyDay = (start: string, end: string): Hours => Object.fromEntries(DAYS.map(d => [d, { enabled: true, start, end }]));

function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

let n = 0;
async function business(opts: { timezone?: string; bufferBefore?: number; bufferAfter?: number } = {}) {
  const email = `rules-${++n}-${RUN}@example.com`;
  const res = await signUpAndSignIn(app, { name: `Rules ${n}`, email, company: `Rules ${n} ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123', ...(opts.timezone ? { timezone: opts.timezone } : {}) });
  expect(res.status).toBe(200);
  const owner = db.prepare('SELECT id, organization_id FROM users WHERE email = ?').get(email) as { id: string; organization_id: string };
  const h = { Authorization: `Bearer ${sessionToken(res)}` };
  const service = (await request(app).post('/api/services').set(h)
    .send({ name: `Svc ${n}`, category: 'consultation', duration: 60, price: 10, maxAdvance: 400, bufferBefore: opts.bufferBefore ?? 0, bufferAfter: opts.bufferAfter ?? 0 })).body.data.id as string;
  const staff = async (name: string, serviceIds: string[]) => (await request(app).post('/api/staff').set(h)
    .send({ name, email: `${name.replace(/\s/g, '').toLowerCase()}-${n}-${RUN}@example.com`, serviceIds, workingHours: everyDay('09:00', '17:00') })).body.data.id as string;
  const ada = await staff('Ada Rules', [service]);
  const customer = (await request(app).post('/api/customers').set(h).send({ name: 'Rules Customer', email: `rules-cust-${n}-${RUN}@example.com` })).body.data.id as string;
  await publishBookingPage(app, h, [service], `rules${n}`);
  const tz = (db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(owner.organization_id) as { timezone: string }).timezone;
  const user = { sub: owner.id, email, orgId: owner.organization_id, role: 'admin' as const };
  // Three weeks ahead: clear of every public notice rule, inside every advance window.
  const date = shift(todayInTimezone(tz), 21);
  return { h, orgId: owner.organization_id, service, staff, ada, customer, tz, user, date };
}
type Biz = Awaited<ReturnType<typeof business>>;

const book = (b: Biz, body: Record<string, unknown>) =>
  request(app).post('/api/appointments').set(b.h).send({ serviceId: b.service, staffId: b.ada, customerId: b.customer, date: b.date, ...body });
const move = (b: Biz, id: string, body: Record<string, unknown>) => request(app).put(`/api/appointments/${id}`).set(b.h).send(body);
const offered = async (b: Biz, path: '/api/public/availability' | '/api/appointments/availability', staffId = b.ada) =>
  ((await request(app).get(`${path}?date=${b.date}&serviceId=${b.service}&staffId=${staffId}`).set(b.h)).body.data as Array<{ start: string; available: boolean }>)
    .filter(s => s.available).map(s => s.start);
const activeRows = (b: Biz) => db.prepare(
  "SELECT start_time, end_time FROM appointments WHERE staff_id = ? AND date = ? AND status NOT IN ('cancelled','no_show') ORDER BY start_time",
).all(b.ada, b.date) as Array<{ start_time: string; end_time: string }>;

describe('the dashboard accepts exactly the times public booking offers', () => {
  it('with buffers and an existing booking, every start from 08:00 to 17:30 is accepted or refused as public booking would', async () => {
    const b = await business({ bufferBefore: 10, bufferAfter: 20 });
    const initial = await offered(b, '/api/public/availability');
    const taken = await request(app).post('/api/public/book')
      .send({ serviceId: b.service, staffId: b.ada, date: b.date, startTime: initial[3], customer: { name: 'Pat Public', email: `pat-${RUN}@example.com`, phone: '+91 98765 40100' } });
    expect(taken.status).toBe(201);

    const pub = await offered(b, '/api/public/availability');
    expect(pub.length).toBeGreaterThan(3);
    expect(await offered(b, '/api/appointments/availability')).toEqual(pub); // the New Appointment form agrees

    const accepted: string[] = [];
    for (let m = 8 * 60; m <= 17 * 60 + 30; m += 5) {
      const res = await book(b, { startTime: fromMin(m) });
      if (res.status === 201) {
        accepted.push(fromMin(m));
        await move(b, res.body.data.id, { status: 'cancelled' }).expect(200); // free it again for the next try
      } else {
        expect([400, 409]).toContain(res.status);
      }
    }
    expect(accepted).toEqual(pub);
  });
});

describe('the 30-minute grid', () => {
  it('refuses starts off the grid (which starts after the buffer before) and saves nothing', async () => {
    const b = await business({ bufferBefore: 15 });
    const early = await book(b, { startTime: '09:00' });
    expect(early.status).toBe(400);
    expect(early.body.error).toBe('Appointments for this service start every 30 minutes from 09:15 that day. Choose 09:15 or 09:45.');
    const off = await book(b, { startTime: '10:20' });
    expect(off.status).toBe(400);
    expect(off.body.error).toMatch(/Choose 10:15 or 10:45\.$/);
    expect(activeRows(b)).toEqual([]);
    expect((await book(b, { startTime: '09:15' })).status).toBe(201);
    expect(activeRows(b)).toEqual([{ start_time: '09:15', end_time: '10:15' }]);
  });
});

describe('buffers and the edges of the day', () => {
  it('keep the buffer clear of other appointments and inside staff and business hours', async () => {
    const b = await business({ bufferAfter: 30 });
    expect((await book(b, { startTime: '10:00' })).status).toBe(201);           // 10:00–11:00, kept free until 11:30
    const tooSoon = await book(b, { startTime: '11:00' });
    expect(tooSoon.status).toBe(400);
    expect(tooSoon.body.error).toBe('That time is too close to another appointment of Ada Rules: the buffer time this service keeps before and after would overlap it.');
    expect((await book(b, { startTime: '09:00' })).status).toBe(400);           // its own buffer would run into 10:00
    expect((await book(b, { startTime: '10:30' })).status).toBe(409);           // a plain overlap
    expect((await book(b, { startTime: '11:30' })).status).toBe(201);
    const late = await book(b, { startTime: '16:00' });                          // 17:00 + 30 minutes is past 17:00
    expect(late.status).toBe(400);
    expect(late.body.error).toBe("With its buffer times this service does not fit at 16:00 within Ada Rules's hours (09:00–17:00).");
    expect((await book(b, { startTime: '15:30' })).status).toBe(201);           // ends 16:30, buffer to 17:00
    expect((await book(b, { startTime: '08:30' })).status).toBe(400);           // before working hours

    // Saved business hours narrow the day, and the grid starts at their opening time.
    await request(app).put('/api/settings').set(b.h).send({ workingHours: everyDay('10:00', '16:00') }).expect(200);
    const nextDay = { date: shift(b.date, 1) };
    const outside = await book(b, { ...nextDay, startTime: '09:30' });
    expect(outside.body.error).toBe('That time is outside business hours for Ada Rules (10:00–16:00)');
    expect((await book(b, { ...nextDay, startTime: '15:00' })).status).toBe(400); // buffer would pass 16:00
    expect((await book(b, { ...nextDay, startTime: '14:30' })).status).toBe(201);
    expect((await book(b, { ...nextDay, startTime: '10:00' })).status).toBe(201);
  });

  it('breaks, time off and closures refuse dashboard bookings as they refuse public ones', async () => {
    const b = await business();
    const weekday = DAYS[(new Date(`${b.date}T12:00:00Z`).getUTCDay() + 6) % 7];
    await request(app).post('/api/time-off/breaks').set(b.h).send({ staffId: b.ada, weekday, startTime: '12:00', endTime: '13:00' }).expect(201);
    await request(app).post('/api/time-off').set(b.h).send({ staffId: b.ada, startDate: b.date, endDate: b.date, startTime: '15:00', endTime: '16:00' }).expect(201);
    for (const start of ['11:30', '12:00', '12:30', '14:30', '15:00', '15:30']) {
      expect({ start, status: (await book(b, { startTime: start })).status }).toEqual({ start, status: 400 });
    }
    await request(app).post('/api/time-off').set(b.h).send({ startDate: shift(b.date, 1), endDate: shift(b.date, 1), reason: 'Closed' }).expect(201);
    expect((await book(b, { date: shift(b.date, 1), startTime: '10:00' })).body.error).toBe('The business is closed that day (Closed)');
    expect((await book(b, { startTime: '13:00' })).status).toBe(201);
  });
});

describe('the business time zone', () => {
  it('decides which day is "today" for dashboard bookings, and appointments are recorded in it', async () => {
    const utcToday = new Date().toISOString().slice(0, 10);
    const todays: string[] = [];
    for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const b = await business({ timezone });
      expect(b.tz).toBe(timezone);
      const today = todayInTimezone(timezone);
      todays.push(today);
      const past = await book(b, { date: shift(today, -1), startTime: '10:00' });
      expect(past.status).toBe(400);
      expect(past.body.error).toBe('Cannot create appointments in the past.');
      const made = await book(b, { date: today, startTime: '16:00' });
      expect(made.status).toBe(201);
      expect((db.prepare('SELECT timezone FROM appointments WHERE id = ?').get(made.body.data.id) as { timezone: string }).timezone).toBe(timezone);
    }
    // UTC+14 and UTC-11 cannot both share the server's UTC date, so at least one case above differs from it.
    expect(todays.some(d => d !== utcToday)).toBe(true);
  });
});

describe('direct API requests cannot bypass the rules', () => {
  it('moves, staff changes and reactivations are checked; edits that leave an appointment in place are not', async () => {
    const b = await business({ bufferAfter: 30 });
    const una = await b.staff('Una Unassigned', []);
    const a = (await book(b, { startTime: '10:00' })).body.data.id as string;
    const bApp = (await book(b, { startTime: '13:00' })).body.data.id as string;

    expect((await move(b, bApp, { startTime: '11:00' })).status).toBe(400);    // inside 10:00's buffer
    expect((await move(b, bApp, { startTime: '11:15' })).status).toBe(400);    // off the grid
    expect((await move(b, bApp, { startTime: '10:30' })).status).toBe(409);    // overlaps 10:00
    const unassigned = await move(b, bApp, { staffId: una });
    expect(unassigned.status).toBe(400);
    expect(unassigned.body.error).toBe('Una Unassigned does not offer this service');
    expect((await move(b, bApp, { startTime: '11:30' })).status).toBe(200);
    expect((await move(b, bApp, { startTime: '13:00' })).status).toBe(200);    // its own old slot does not block it

    // Bringing back a cancelled appointment is a booking: it must still fit.
    await move(b, a, { status: 'cancelled' }).expect(200);
    const c = (await book(b, { startTime: '10:00' })).body.data.id as string;
    expect((await move(b, a, { status: 'scheduled' })).status).toBe(409);      // 10:00 is taken again
    await move(b, c, { status: 'cancelled' }).expect(200);
    expect((await move(b, bApp, { startTime: '11:00' })).status).toBe(200);    // fine while 10:00 is cancelled
    const back = await move(b, a, { status: 'confirmed' });
    expect(back.status).toBe(400);                                              // its buffer would now reach 11:00
    expect(back.body.error).toMatch(/buffer time/);

    // An appointment saved before these rules (off the grid) can still be completed or annotated, but not moved
    // anywhere invalid.
    const legacy = `appt-legacy-${nanoid(6)}`;
    db.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, timezone, price, currency)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, '14:10', '15:10', 60, ?, 10, 'USD')`)
      .run(legacy, `WE-${nanoid(8).toUpperCase()}`, b.orgId, b.service, b.ada, b.customer, b.date, b.tz);
    expect((await move(b, legacy, { notes: 'Brought a referral letter' })).status).toBe(200);
    expect((await move(b, legacy, { status: 'confirmed' })).status).toBe(200);              // status edits are not slot-checked
    expect((await move(b, legacy, { status: 'completed' })).body.code).toBe('APPOINTMENT_NOT_STARTED'); // but outcomes wait
    expect((await move(b, legacy, { startTime: '14:20' })).status).toBe(400);

    // New bookings need an active service; an existing appointment of a deactivated service can still move.
    await request(app).put(`/api/services/${b.service}`).set(b.h).send({ isActive: false }).expect(200);
    const inactive = await book(b, { startTime: '16:00', date: shift(b.date, 2) });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error).toBe('This service is inactive and cannot be booked');
    expect((await move(b, bApp, { startTime: '12:30' })).status).toBe(200);     // clear of the legacy 14:10 and its buffer

    // A client cannot choose its own end time or an off-grid start through any field.
    await request(app).put(`/api/services/${b.service}`).set(b.h).send({ isActive: true }).expect(200);
    const sneaky = await book(b, { date: shift(b.date, 3), startTime: '10:00', endTime: '18:00', duration: 5 });
    expect(sneaky.status).toBe(201);
    expect(db.prepare('SELECT end_time, duration FROM appointments WHERE id = ?').get(sneaky.body.data.id)).toEqual({ end_time: '11:00', duration: 60 });
    expect((await book(b, { date: shift(b.date, 3), startTime: '10:00:00' })).status).toBe(400);
  });

  it('two simultaneous dashboard bookings that would break each other\'s buffer: exactly one is saved', async () => {
    const b = await business({ bufferAfter: 30 });
    const [x, y] = await Promise.all([book(b, { startTime: '10:00' }), book(b, { startTime: '11:00' })]);
    expect([x.status, y.status].sort()).toEqual([201, 400]);
    expect(activeRows(b)).toHaveLength(1);
  });
});

describe('statuses, staff changes and racing bookings', () => {
  it('cancelled and no-show appointments free their time; scheduled, confirmed and completed ones keep it', async () => {
    const b = await business();
    const first = (await book(b, { startTime: '10:00' })).body.data.id as string;
    expect((await book(b, { startTime: '10:00' })).status).toBe(409);
    // What each status means for availability. The API records outcomes (no-show, completed) only once an appointment
    // has started, so for these future slots they are set directly.
    const setStatus = (id: string, status: string) => db.prepare('UPDATE appointments SET status = ? WHERE id = ?').run(status, id);
    setStatus(first, 'no_show');
    const second = (await book(b, { startTime: '10:00' })).body.data.id as string;     // a no-show frees the slot
    await move(b, second, { status: 'confirmed' }).expect(200);
    expect((await book(b, { startTime: '10:00' })).status).toBe(409);
    setStatus(second, 'completed');
    expect((await book(b, { startTime: '10:00' })).status).toBe(409);
    await move(b, second, { status: 'confirmed' }).expect(200);                        // a completed one is corrected first:
    await move(b, second, { status: 'cancelled' }).expect(200);                        // completed appointments are not cancelled
    expect((await book(b, { startTime: '10:00' })).status).toBe(201);                 // so does a cancellation
    expect((await offered(b, '/api/public/availability'))).not.toContain('10:00');     // and the public page agrees
  });

  it('moving to another staff member applies that person\'s assignment, hours and bookings', async () => {
    const b = await business();
    const ben = await b.staff('Ben Rules', [b.service]);
    const a = (await book(b, { startTime: '10:00' })).body.data.id as string;
    const bensOwn = await request(app).post('/api/appointments').set(b.h)
      .send({ serviceId: b.service, staffId: ben, customerId: b.customer, date: b.date, startTime: '10:00' });
    expect(bensOwn.status).toBe(201);
    expect((await move(b, a, { staffId: ben })).status).toBe(409);                    // Ben is busy at 10:00
    await move(b, bensOwn.body.data.id, { status: 'cancelled' }).expect(200);
    expect((await move(b, a, { staffId: ben })).status).toBe(200);                     // now Ben is free
    expect((db.prepare('SELECT staff_id FROM appointments WHERE id = ?').get(a) as { staff_id: string }).staff_id).toBe(ben);
  });

  it('the same slot booked at the same moment from the dashboard and the public page: exactly one is saved', async () => {
    const b = await business();
    const [dash, pub] = await Promise.all([
      book(b, { startTime: '11:00' }),
      request(app).post('/api/public/book').send({ serviceId: b.service, staffId: b.ada, date: b.date, startTime: '11:00', customer: { name: 'Race Public', email: `race-${RUN}@example.com`, phone: '+91 98765 40100' } }),
    ]);
    expect([dash.status, pub.status].filter(s => s === 201)).toHaveLength(1);
    expect([dash.status, pub.status].filter(s => s === 409)).toHaveLength(1);
    expect(activeRows(b)).toEqual([{ start_time: '11:00', end_time: '12:00' }]);
  });
});

describe('the Reschedule page offers only times the server accepts', () => {
  it('leaves out the appointment being moved (within the business only), and every time it offers can be chosen', async () => {
    const b = await business({ bufferAfter: 30 });
    const other = await business();
    const a = (await book(b, { startTime: '10:00' })).body.data.id as string;
    const free = async (h: Record<string, string>, extra: string) =>
      ((await request(app).get(`/api/appointments/availability?date=${b.date}&serviceId=${b.service}&staffId=${b.ada}${extra}`).set(h)).body.data as Array<{ start: string; available: boolean }>)
        .filter(s => s.available).map(s => s.start);
    expect(await free(b.h, '')).not.toContain('10:00');
    const options = await free(b.h, `&excludeAppointmentId=${a}`);
    expect(options).toContain('10:00');
    expect(options).toContain('09:00');
    for (const startTime of options) {
      expect({ startTime, status: (await move(b, a, { startTime })).status }).toEqual({ startTime, status: 200 });
    }
    const foreign = (await book(other, { startTime: '10:00' })).body.data.id as string;
    const leak = await request(app).get(`/api/appointments/availability?date=${b.date}&serviceId=${b.service}&staffId=${b.ada}&excludeAppointmentId=${foreign}`).set(b.h);
    expect(leak.status).toBe(404);
  });
});

describe('assistant bookings', () => {
  it('are proposed and confirmed under the same rules, with the end time taken from the service', async () => {
    const b = await business({ bufferAfter: 30 });
    const conv = `conv-rules-${nanoid(6)}`;
    db.prepare('INSERT INTO ai_conversations (id, organization_id, user_id, title) VALUES (?, ?, ?, ?)').run(conv, b.orgId, b.user.sub, 'Rules');
    expect((await book(b, { startTime: '10:00' })).status).toBe(201);
    const propose = (startTime: string, extra: Record<string, unknown> = {}) => executeTool('propose_create_appointment',
      { serviceId: b.service, staffId: b.ada, customerId: b.customer, date: b.date, startTime, ...extra }, b.user, conv);

    const inBuffer = propose('11:00');
    expect(inBuffer.type).toBe('error');
    expect(String(inBuffer.content)).toMatch(/buffer time/);
    expect(String(propose('11:15').content)).toMatch(/every 30 minutes/);
    expect(String(propose('10:00').content)).toMatch(/no longer available/);

    // A valid proposal is refused at confirmation if the slot stopped fitting in the meantime.
    const later = propose('13:00');
    expect(later.type).toBe('proposal');
    expect((await book(b, { startTime: '14:00' })).status).toBe(201);
    const refused = executeConfirmedProposal((later as unknown as { proposal: { id: string } }).proposal.id, b.user);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/buffer time/);

    // A proposal cannot carry its own end time.
    const fine = propose('15:30', { endTime: '18:00' });
    expect(fine.type).toBe('proposal');
    const done = executeConfirmedProposal((fine as unknown as { proposal: { id: string } }).proposal.id, b.user);
    expect(done.ok).toBe(true);
    expect(activeRows(b).map(r => `${r.start_time}-${r.end_time}`)).toEqual(['10:00-11:00', '14:00-15:00', '15:30-16:30']);
  });
});
