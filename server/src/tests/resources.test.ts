// Rooms and other resources: a service linked to resources needs one free resource of that pool per booking; capacity
// is how many overlapping bookings a resource takes; opening hours, inactive resources and workspaces are respected;
// moves keep or swap the resource; cancelling frees it; the database refuses over-booking and cross-business
// references; two bookings racing for the last room cannot both win; links stay in sync on both sides.
// Synthetic businesses in the per-file test database.

import request from 'supertest';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(90_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
const ALL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const HOURS = Object.fromEntries(ALL_DAYS.map(d => [d, { enabled: true, start: '08:00', end: '18:00' }]));
// Each test books on its own Wednesday (week k after the one 30–36 days from now), so one test's bookings never decide
// another's outcome, and notice rules never interfere.
const wednesday = (k: number) => { const d = new Date(Date.now() + 30 * 86_400_000); d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7) + 7 * k); return d.toISOString().slice(0, 10); };
const plusDays = (date: string, n: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let DATE = wednesday(0);

interface Biz { orgId: string; h: Record<string, string>; staff: string[]; customer: string }

async function business(label: string): Promise<Biz> {
  const s = await signUpAndSignIn(app, { name: `Res ${label}`, email: `res-${label}-${RUN}@example.com`, company: `Rooms ${label} ${RUN}`, password: 'StartPass123', timezone: TZ });
  const h = { Authorization: `Bearer ${sessionToken(s)}` };
  const staff: string[] = [];
  for (const n of ['A', 'B', 'C']) {
    staff.push((await request(app).post('/api/staff').set(h).send({ name: `Staff ${n} ${label}`, email: `st-${n}-${label}-${RUN}@example.com`, workingHours: HOURS })).body.data.id);
  }
  const customer = (await request(app).post('/api/customers').set(h).send({ name: `Cust ${label}`, email: `c-${label}-${RUN}@example.com` })).body.data.id;
  return { orgId: s.body.data.user.organization_id, h, staff, customer };
}

async function service(b: Biz, name: string, resourceIds: string[]): Promise<string> {
  const res = await request(app).post('/api/services').set(b.h).send({ name, category: 'consultation', duration: 60, price: 0, maxAdvance: 365, staffIds: b.staff, resourceIds });
  expect(res.status).toBe(201);
  return res.body.data.id;
}
async function resource(b: Biz, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app).post('/api/resources').set(b.h).send({ name, type: 'room', capacity: 1, ...extra });
  expect(res.status).toBe(201);
  return res.body.data.id;
}
const book = (b: Biz, serviceId: string, staffIdx: number, startTime: string, extra: Record<string, unknown> = {}) =>
  request(app).post('/api/appointments').set(b.h).send({ serviceId, staffId: b.staff[staffIdx], customerId: b.customer, date: DATE, startTime, ...extra });
const held = (apptId: string) => (db.prepare('SELECT resource_id FROM appointment_resources WHERE appointment_id = ? ORDER BY resource_id').all(apptId) as Array<{ resource_id: string }>).map(r => r.resource_id);
const slotFree = async (b: Biz, serviceId: string, staffIdx: number, start: string, date = DATE) =>
  ((await request(app).get(`/api/appointments/availability?date=${date}&serviceId=${serviceId}&staffId=${b.staff[staffIdx]}`).set(b.h)).body.data as Array<{ start: string; available: boolean }>)
    .find(s => s.start === start)?.available;

let A: Biz;
let B: Biz;
beforeAll(async () => {
  A = await business('a');
  B = await business('b');
});

describe('one room, capacity 1', () => {
  let room = '';
  let svc = '';
  beforeAll(async () => {
    room = await resource(A, 'Room One');
    svc = await service(A, 'Needs Room One', [room]);
  });

  it('the first booking holds the room; another staff member cannot use it at an overlapping time', async () => {
    DATE = wednesday(0);
    const first = await book(A, svc, 0, '10:00');
    expect(first.status).toBe(201);
    expect(held(first.body.data.id)).toEqual([room]);
    expect(first.body.data.resourceIds).toEqual([room]);
    expect(await slotFree(A, svc, 1, '10:00')).toBe(false);
    expect(await slotFree(A, svc, 1, '10:30')).toBe(false);
    expect(await slotFree(A, svc, 1, '11:00')).toBe(true);
    const clash = await book(A, svc, 1, '10:30');
    expect([clash.status, clash.body.error]).toEqual([409, 'No room is free at that time. Please choose another time.']);
    expect((await book(A, svc, 1, '11:00')).status).toBe(201);
  });

  it('cancelling frees the room; bringing the booking back needs it free again', async () => {
    const a = await book(A, svc, 0, '13:00');
    expect((await request(app).put(`/api/appointments/${a.body.data.id}`).set(A.h).send({ status: 'cancelled' })).status).toBe(200);
    const b = await book(A, svc, 1, '13:00');
    expect(b.status).toBe(201);
    const back = await request(app).put(`/api/appointments/${a.body.data.id}`).set(A.h).send({ status: 'scheduled' });
    expect([back.status, back.body.error]).toEqual([409, 'No room is free at that time. Please choose another time.']);
    expect((db.prepare('SELECT status FROM appointments WHERE id = ?').get(a.body.data.id) as { status: string }).status).toBe('cancelled');
  });

  it('a move keeps the room when it is free at the new time and is refused when it is not', async () => {
    const a = await book(A, svc, 2, '15:00');
    const moved = await request(app).put(`/api/appointments/${a.body.data.id}`).set(A.h).send({ startTime: '16:00' });
    expect(moved.status).toBe(200);
    expect(held(a.body.data.id)).toEqual([room]);
    const blocked = await request(app).put(`/api/appointments/${a.body.data.id}`).set(A.h).send({ startTime: '10:00' });
    expect(blocked.status).toBe(409);
    expect((db.prepare('SELECT start_time FROM appointments WHERE id = ?').get(a.body.data.id) as { start_time: string }).start_time).toBe('16:00');
  });
});

describe('pools, capacity and opening hours', () => {
  it('a pool of two rooms takes two overlapping bookings, one in each, and refuses a third', async () => {
    DATE = wednesday(1);
    const r1 = await resource(A, 'Pool Room 1');
    const r2 = await resource(A, 'Pool Room 2');
    const svc = await service(A, 'Pooled', [r1, r2]);
    const x = await book(A, svc, 0, '09:00');
    const y = await book(A, svc, 1, '09:00');
    expect([x.status, y.status]).toEqual([201, 201]);
    expect([...held(x.body.data.id), ...held(y.body.data.id)].sort()).toEqual([r1, r2].sort());
    expect((await book(A, svc, 2, '09:00')).status).toBe(409);
    // A move swaps to the other room when its own is taken at the new time.
    const z = await book(A, svc, 2, '12:00');
    const w = await book(A, svc, 0, '12:00');
    expect(new Set([...held(z.body.data.id), ...held(w.body.data.id)]).size).toBe(2);
    await request(app).put(`/api/appointments/${x.body.data.id}`).set(A.h).send({ status: 'cancelled' });
    const freedRoom = held(x.body.data.id)[0];
    const otherRoom = freedRoom === r1 ? r2 : r1;
    const hereFirst = held(z.body.data.id)[0] === otherRoom ? z : w; // the 12:00 booking that holds the other room
    const moveTo9 = await request(app).put(`/api/appointments/${hereFirst.body.data.id}`).set(A.h).send({ startTime: '09:00' });
    expect(moveTo9.status).toBe(200);
    expect(held(hereFirst.body.data.id)).toEqual([freedRoom]);
  });

  it('capacity 2 takes two overlapping bookings and refuses the third', async () => {
    DATE = wednesday(2);
    const big = await resource(A, 'Big Room', { capacity: 2 });
    const svc = await service(A, 'Shared Room', [big]);
    expect((await book(A, svc, 0, '14:00')).status).toBe(201);
    expect((await book(A, svc, 1, '14:00')).status).toBe(201);
    expect((await book(A, svc, 2, '14:00')).status).toBe(409);
  });

  it('a room\'s own hours limit the times offered and booked', async () => {
    DATE = wednesday(3);
    const hours = Object.fromEntries(ALL_DAYS.map(d => [d, d === 'saturday' ? { enabled: false, start: '09:00', end: '17:00' } : { enabled: true, start: '09:00', end: '12:00' }]));
    const morning = await resource(A, 'Morning Room', { availabilityRules: hours });
    const svc = await service(A, 'Mornings Only', [morning]);
    expect(await slotFree(A, svc, 0, '09:00')).toBe(true);
    expect(await slotFree(A, svc, 0, '11:00')).toBe(true);
    expect(await slotFree(A, svc, 0, '11:30')).toBe(false); // would end 12:30
    expect(await slotFree(A, svc, 0, '09:00', plusDays(DATE, 3))).toBe(false); // Saturday: closed
    const late = await book(A, svc, 0, '13:00');
    expect([late.status, late.body.error]).toEqual([409, 'No room is free at that time. Please choose another time.']);
  });

  it('a service whose only resource is inactive cannot be booked', async () => {
    DATE = wednesday(4);
    const closed = await resource(A, 'Closed Room', { isActive: false });
    const svc = await service(A, 'Needs Closed Room', [closed]);
    expect(await slotFree(A, svc, 0, '10:00')).toBe(false);
    const res = await book(A, svc, 0, '10:00');
    expect([res.status, res.body.error]).toEqual([409, expect.stringMatching(/needs a room, and none is available/)]);
  });

  it('a service without resources is not affected', async () => {
    DATE = wednesday(5);
    const svc = await service(A, 'No Room Needed', []);
    expect((await book(A, svc, 0, '17:00')).status).toBe(201);
    expect((await book(A, svc, 1, '17:00')).status).toBe(201);
  });

  it('in a workspace, only that workspace\'s rooms (or rooms of no workspace) are used', async () => {
    DATE = wednesday(6);
    const ws1 = (await request(app).post('/api/workspaces').set(A.h).send({ name: 'Branch 1' })).body.data.id;
    const ws2 = (await request(app).post('/api/workspaces').set(A.h).send({ name: 'Branch 2' })).body.data.id;
    const r1 = await resource(A, 'Branch 1 Room', { workspaceIds: [ws1] });
    await resource(A, 'Branch 2 Room', { workspaceIds: [ws2] });
    const svc = await service(A, 'Branch Service', []);
    // Linked from the resource side only: the pool still includes it.
    await request(app).put(`/api/resources/${r1}`).set(A.h).send({ serviceIds: [svc] });
    const inWs2 = await book(A, svc, 0, '08:00', { workspaceId: ws2 });
    expect(inWs2.status).toBe(409);
    const inWs1 = await book(A, svc, 0, '08:00', { workspaceId: ws1 });
    expect(inWs1.status).toBe(201);
    expect(held(inWs1.body.data.id)).toEqual([r1]);
  });
});

describe('links, deletes and other businesses', () => {
  it('linking from either side updates the other side', async () => {
    const r = await resource(A, 'Linked Room');
    const svc = await service(A, 'Linked Service', [r]);
    expect((await request(app).get(`/api/resources/${r}`).set(A.h)).body.data.serviceIds).toEqual([svc]);
    await request(app).put(`/api/resources/${r}`).set(A.h).send({ serviceIds: [] });
    expect((await request(app).get(`/api/services/${svc}`).set(A.h)).body.data.resourceIds).toEqual([]);
  });

  it('a resource held by bookings cannot be deleted (it can be deactivated); an unused one can', async () => {
    DATE = wednesday(7);
    const r = await resource(A, 'Busy Room');
    const svc = await service(A, 'Busy Service', [r]);
    expect((await book(A, svc, 0, '16:00')).status).toBe(201);
    expect((await request(app).delete(`/api/resources/${r}`).set(A.h)).status).toBe(409);
    const spare = await resource(A, 'Spare Room');
    const svc2 = await service(A, 'Spare Service', [spare]);
    expect((await request(app).delete(`/api/resources/${spare}`).set(A.h)).status).toBe(200);
    expect((await request(app).get(`/api/services/${svc2}`).set(A.h)).body.data.resourceIds).toEqual([]);
  });

  it('another business\'s resource cannot be named, and its rooms never count for this business', async () => {
    DATE = wednesday(8);
    const theirs = await resource(B, 'Their Room');
    const mine = await service(A, 'Mine', []);
    const res = await book(A, mine, 0, '15:00', { resourceIds: [theirs] });
    expect(res.status).toBe(400);
    expect((await request(app).get(`/api/resources/${theirs}`).set(A.h)).status).toBe(404);
    expect(() => db.prepare('INSERT INTO appointment_resources (appointment_id, resource_id, organization_id) VALUES (?, ?, ?)')
      .run((db.prepare('SELECT id FROM appointments WHERE organization_id = ? LIMIT 1').get(A.orgId) as { id: string }).id, theirs, A.orgId)).toThrow('RESOURCE_ORG_MISMATCH');
  });
});

describe('the database refuses over-booking itself', () => {
  it('inserting a holding beyond capacity, or moving a booking onto a full room, is refused', async () => {
    DATE = wednesday(9);
    const r = await resource(A, 'Guarded Room');
    const svc = await service(A, 'Guarded', [r]);
    const first = await book(A, svc, 0, '08:00');
    const other = await book(A, (await service(A, 'Unrelated', [])), 1, '08:00');
    expect(() => db.prepare('INSERT INTO appointment_resources (appointment_id, resource_id, organization_id) VALUES (?, ?, ?)')
      .run(other.body.data.id, r, A.orgId)).toThrow('RESOURCE_UNAVAILABLE');
    const later = await book(A, svc, 1, '12:00');
    expect(held(later.body.data.id)).toEqual([r]);
    expect(() => db.prepare("UPDATE appointments SET start_time = '08:00', end_time = '09:00' WHERE id = ?").run(later.body.data.id)).toThrow('RESOURCE_UNAVAILABLE');
    expect(held(first.body.data.id)).toEqual([r]);
  });

  it('two bookings racing for the last free room: exactly one wins', async () => {
    DATE = wednesday(10);
    const r = await resource(A, 'Race Room');
    const svc = await service(A, 'Race', [r]);
    const results = await Promise.all([book(A, svc, 0, '17:00'), book(A, svc, 1, '17:00'), book(A, svc, 2, '17:00')]);
    expect(results.map(x => x.status).sort()).toEqual([201, 409, 409]);
    const holders = db.prepare(
      `SELECT COUNT(*) c FROM appointment_resources ar JOIN appointments a ON a.id = ar.appointment_id
       WHERE ar.resource_id = ? AND a.status NOT IN ('cancelled','no_show')`
    ).get(r) as { c: number };
    expect(holders.c).toBe(1);
  });
});

describe('public booking and the customer\'s link', () => {
  it('a public booking takes the room; the customer can move it only to a time a room is free', async () => {
    DATE = wednesday(11);
    const r = await resource(A, 'Public Room');
    const svc = await service(A, 'Public Service', [r]);
    const slug = await publishBookingPage(app, A.h, [svc], `res-${nanoid(4).toLowerCase()}`);
    const pub = (startTime: string, staffIdx: number) => request(app).post('/api/public/book').send({
      pageSlug: slug, serviceId: svc, staffId: A.staff[staffIdx], date: DATE, startTime,
      customer: { name: 'Room Guest', email: `guest-${nanoid(5)}@example.com`, phone: '+91 98765 43210' },
    });
    const first = await pub('10:00', 0);
    expect(first.status).toBe(201);
    expect(held(first.body.data.appointmentId)).toEqual([r]);
    const second = await pub('10:00', 1);
    // The public route's early check answers first, in the same words as for any taken time.
    expect([second.status, second.body.error]).toEqual([409, 'That time slot is no longer available']);
    const publicSlots = (await request(app).get(`/api/public/availability?date=${DATE}&serviceId=${svc}&staffId=${A.staff[1]}`)).body.data as Array<{ start: string; available: boolean }>;
    expect(publicSlots.find(s => s.start === '10:00')?.available).toBe(false);
    const other = await pub('12:00', 1);
    expect(other.status).toBe(201);
    const token = first.body.data.manageToken;
    const clash = await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', token).send({ date: DATE, startTime: '12:00' });
    expect(clash.status).toBe(409);
    const ok = await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', token).send({ date: DATE, startTime: '14:00' });
    expect(ok.status).toBe(200);
    expect(held(first.body.data.appointmentId)).toEqual([r]);
  });
});
