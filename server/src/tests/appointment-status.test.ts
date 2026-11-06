// Appointment status changes, enforced by the server: completed and no-show only once the appointment has started
// (in its own time zone), no outcome for a cancelled appointment, no cancelling a completed one, new appointments only
// scheduled or confirmed, and concurrent changes that cannot both win. Synthetic data in the per-file test database.

import request from 'supertest';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { statusChangeProblem } from '../services/appointment-status';
import { zonedToInstant, instantToZoned } from '../services/zoned-time';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
let auth: Record<string, string> = {};
let orgId = '';
let serviceId = '';
let staffId = '';
let customerId = '';
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { enabled: true, start: '06:00', end: '22:00' }]));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });

/** An appointment row written directly (the API refuses past dates), so past and current cases can be tested. */
function insertAppointment(date: string, startTime: string, status = 'scheduled'): string {
  const id = `appt-${nanoid(8)}`;
  const [h, m] = startTime.split(':').map(Number);
  const end = `${String(h + (m + 30 >= 60 ? 1 : 0)).padStart(2, '0')}:${String((m + 30) % 60).padStart(2, '0')}`;
  db.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, price, currency, timezone)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, 10, 'INR', ?)`)
    .run(id, `WE-${nanoid(8).toUpperCase()}`, orgId, serviceId, staffId, customerId, status, date, startTime, end, TZ);
  return id;
}
const put = (id: string, body: Record<string, unknown>) => request(app).put(`/api/appointments/${id}`).set(auth).send(body);
const statusOf = (id: string) => (db.prepare('SELECT status FROM appointments WHERE id = ?').get(id) as { status: string }).status;

beforeAll(async () => {
  const res = await signUpAndSignIn(app, { name: 'Status Owner', email: `status-${RUN}@example.com`, company: `Status ${RUN}`, password: 'StartPass123', timezone: TZ });
  auth = { Authorization: `Bearer ${sessionToken(res)}` };
  orgId = res.body.data.user.organization_id;
  serviceId = (await request(app).post('/api/services').set(auth).send({ name: 'Status Svc', category: 'consultation', duration: 30, price: 10, maxAdvance: 365 })).body.data.id;
  staffId = (await request(app).post('/api/staff').set(auth).send({ name: 'Status Staff', email: `status-staff-${RUN}@example.com`, serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  customerId = (await request(app).post('/api/customers').set(auth).send({ name: 'Status Cust', email: `status-cust-${RUN}@example.com` })).body.data.id;
});

describe('the rule', () => {
  const appt = { date: '2026-10-24', startTime: '10:00', timezone: TZ };
  const start = zonedToInstant('2026-10-24', '10:00', TZ);
  it('an outcome is allowed from the start time on, not a moment before', () => {
    expect(statusChangeProblem('scheduled', 'completed', appt, start - 1)?.code).toBe('APPOINTMENT_NOT_STARTED');
    expect(statusChangeProblem('scheduled', 'completed', appt, start)).toBeNull();
    expect(statusChangeProblem('confirmed', 'no_show', appt, start - 60_000)?.code).toBe('APPOINTMENT_NOT_STARTED');
    expect(statusChangeProblem('confirmed', 'no_show', appt, start + 60_000)).toBeNull();
  });
  it('the start time is read in the appointment\'s own time zone', () => {
    const ny = { date: '2026-10-24', startTime: '10:00', timezone: 'America/New_York' };
    // 10:00 in New York is 19:30 in India: at 10:00 India time it has not started yet.
    expect(statusChangeProblem('scheduled', 'completed', ny, start)?.code).toBe('APPOINTMENT_NOT_STARTED');
    expect(statusChangeProblem('scheduled', 'completed', ny, zonedToInstant('2026-10-24', '10:00', 'America/New_York'))).toBeNull();
  });
  it('invalid changes, whatever the time', () => {
    expect(statusChangeProblem('cancelled', 'completed', appt, start + 1)?.code).toBe('INVALID_STATUS_CHANGE');
    expect(statusChangeProblem('cancelled', 'no_show', appt, start + 1)?.code).toBe('INVALID_STATUS_CHANGE');
    expect(statusChangeProblem('completed', 'cancelled', appt, start + 1)?.code).toBe('INVALID_STATUS_CHANGE');
    expect(statusChangeProblem('scheduled', 'cancelled', appt, start - 1)).toBeNull();
    expect(statusChangeProblem('completed', 'completed', appt, start - 1)).toBeNull(); // unchanged is never a problem
  });
});

describe('through the API', () => {
  it('a new appointment cannot be created as completed, no-show or cancelled', async () => {
    for (const status of ['completed', 'no_show', 'cancelled']) {
      const res = await request(app).post('/api/appointments').set(auth)
        .send({ serviceId, staffId, customerId, date: day(9), startTime: '09:00', status });
      expect([status, res.status, res.body.code]).toEqual([status, 400, 'INVALID_STATUS_CHANGE']);
    }
  });

  it('a future appointment cannot be marked complete or a no-show; it can still be confirmed or cancelled', async () => {
    const created = await request(app).post('/api/appointments').set(auth).send({ serviceId, staffId, customerId, date: day(10), startTime: '10:00' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    for (const status of ['completed', 'no_show']) {
      const res = await put(id, { status });
      expect([status, res.status, res.body.code]).toEqual([status, 409, 'APPOINTMENT_NOT_STARTED']);
      expect(statusOf(id)).toBe('scheduled');
    }
    expect((await put(id, { status: 'confirmed' })).status).toBe(200);
    expect((await put(id, { status: 'cancelled' })).status).toBe(200);
    expect(statusOf(id)).toBe('cancelled');
  });

  it('a past appointment can be completed or marked a no-show, and corrected afterwards', async () => {
    const done = insertAppointment(day(-2), '10:00');
    expect((await put(done, { status: 'completed' })).status).toBe(200);
    expect((await put(done, { status: 'completed' })).status).toBe(200); // repeating it changes nothing
    const noShow = insertAppointment(day(-3), '11:00');
    expect((await put(noShow, { status: 'no_show' })).status).toBe(200);
    expect((await put(noShow, { status: 'completed' })).status).toBe(200); // the person did come after all
    expect(statusOf(noShow)).toBe('completed');
  });

  it('an appointment that started a minute ago can be completed (the current day counts)', async () => {
    const started = instantToZoned(Date.now() - 60_000, TZ); // date and time from one instant, so midnight cannot split them
    const id = insertAppointment(started.date, started.time.slice(0, 5));
    expect((await put(id, { status: 'completed' })).status).toBe(200);
  });

  it('cancelled appointments get no outcome; completed ones cannot be cancelled', async () => {
    const cancelled = insertAppointment(day(-4), '09:00', 'cancelled');
    expect((await put(cancelled, { status: 'completed' })).body.code).toBe('INVALID_STATUS_CHANGE');
    expect((await put(cancelled, { status: 'no_show' })).body.code).toBe('INVALID_STATUS_CHANGE');
    const completed = insertAppointment(day(-5), '09:00', 'completed');
    const res = await put(completed, { status: 'cancelled' });
    expect([res.status, res.body.code]).toEqual([409, 'INVALID_STATUS_CHANGE']);
    expect([statusOf(cancelled), statusOf(completed)]).toEqual(['cancelled', 'completed']);
  });

  it('two conflicting changes sent at once: exactly one wins, and the result is a valid state', async () => {
    for (let i = 0; i < 5; i++) {
      const id = insertAppointment(day(-6 - i), '15:00');
      const [a, b] = await Promise.all([put(id, { status: 'completed' }), put(id, { status: 'cancelled' })]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(['completed', 'cancelled']).toContain(statusOf(id));
    }
  });
});
