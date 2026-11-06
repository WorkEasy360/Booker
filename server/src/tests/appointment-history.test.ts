// Appointment change history and customer booking links: every create, status change, move, staff change and delete
// is recorded with who did it, in the same transaction; entries cannot be edited or deleted; each business sees only
// its own; staff accounts see only their own appointments' history. Customers can change a booking only while it is
// scheduled or confirmed and has not started, and can ask for their manage link again without learning whether the
// details matched. Synthetic data in the per-file test database; emails go to the in-memory test transport.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { testOutbox } from '../services/email/notify';
import { verifyManageToken, issueManageToken } from '../services/booking-access';
import { listHistory } from '../services/appointment-history';
import { executeTool, executeConfirmedProposal } from '../services/ai-tools';
import { instantToZoned } from '../services/zoned-time';
import { rateLimitTesting } from '../middleware/rate-limit';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';
import type { AuthPayload } from '../types';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { enabled: true, start: '06:00', end: '22:00' }]));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });

interface Biz { orgId: string; userId: string; h: Record<string, string>; serviceId: string; staffA: string; staffB: string; customerId: string; slug: string }

async function business(label: string): Promise<Biz> {
  const s = await signUpAndSignIn(app, { name: `Owner ${label}`, email: `hist-${label}-${RUN}@example.com`, company: `History ${label} ${RUN}`, password: 'StartPass123', timezone: TZ });
  const h = { Authorization: `Bearer ${sessionToken(s)}` };
  const serviceId = (await request(app).post('/api/services').set(h).send({ name: `Hist Svc ${label}`, category: 'consultation', duration: 30, price: 10, maxAdvance: 365 })).body.data.id;
  const staffA = (await request(app).post('/api/staff').set(h).send({ name: `Asha ${label}`, email: `asha-${label}-${RUN}@example.com`, serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  const staffB = (await request(app).post('/api/staff').set(h).send({ name: `Bilal ${label}`, email: `bilal-${label}-${RUN}@example.com`, serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  const customerId = (await request(app).post('/api/customers').set(h).send({ name: `Cust ${label}`, email: `cust-${label}-${RUN}@example.com` })).body.data.id;
  const slug = await publishBookingPage(app, h, [serviceId], `hist-${label}`);
  return { orgId: s.body.data.user.organization_id, userId: s.body.data.user.id, h, serviceId, staffA, staffB, customerId, slug };
}

/** A sign-in with a role, optionally linked to a staff record (invited-staff sign-in is created directly here). */
async function userWithRole(orgId: string, role: string, staffId: string | null = null): Promise<Record<string, string>> {
  const email = `${role}-${nanoid(6)}-${RUN}@example.com`.toLowerCase();
  db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`user-${nanoid(8)}`, orgId, email, bcrypt.hashSync('TestPass123', 4), `${role} person`, role, staffId);
  const res = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  expect(res.status).toBe(200);
  return { Authorization: `Bearer ${sessionToken(res)}` };
}

/** An appointment row written directly (the API refuses past dates), so started and past cases can be tested. */
function insertAppointment(b: Biz, date: string, startTime: string, status = 'scheduled', staffId = b.staffA): { id: string; ref: string } {
  const id = `appt-${nanoid(8)}`;
  const ref = `WE-${nanoid(8).toUpperCase()}`;
  const [hh, mm] = startTime.split(':').map(Number);
  const end = `${String(hh + (mm + 30 >= 60 ? 1 : 0)).padStart(2, '0')}:${String((mm + 30) % 60).padStart(2, '0')}`;
  db.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, price, currency, timezone)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, 10, 'INR', ?)`)
    .run(id, ref, b.orgId, b.serviceId, staffId, b.customerId, status, date, startTime, end, TZ);
  return { id, ref };
}

const history = (b: Biz, id: string, h = b.h) => request(app).get(`/api/appointments/${id}/history`).set(h);
const put = (b: Biz, id: string, body: Record<string, unknown>) => request(app).put(`/api/appointments/${id}`).set(b.h).send(body);
const rowsFor = (id: string) => db.prepare('SELECT * FROM appointment_history WHERE appointment_id = ? ORDER BY created_at, rowid').all(id) as Array<Record<string, string | null>>;
const publicBook = (b: Biz, date: string, startTime: string, email: string) => request(app).post('/api/public/book').send({
  pageSlug: b.slug, serviceId: b.serviceId, staffId: b.staffA, date, startTime,
  customer: { name: 'Meera Customer', email, phone: '+91 98765 43210' },
});
const manageCancel = (token: string) => request(app).post('/api/public/appointments/manage/cancel').set('X-Booking-Token', token).send({});
const manageMove = (token: string, date: string, startTime: string) =>
  request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', token).send({ date, startTime });
const sendLink = (ref: string, email: string) => request(app).post('/api/public/appointments/manage-link').send({ ref, email });
const outboxCount = (id: string) => (db.prepare('SELECT COUNT(*) c FROM email_outbox WHERE appointment_id = ?').get(id) as { c: number }).c;

let A: Biz;
let B: Biz;

beforeAll(async () => {
  A = await business('a');
  B = await business('b');
});
beforeEach(() => testOutbox.clear());

describe('recorded from the dashboard', () => {
  it('creation, confirmation, a move, a staff change, cancellation and restoring, in order, with who did each', async () => {
    const created = await request(app).post('/api/appointments').set(A.h).send({ serviceId: A.serviceId, staffId: A.staffA, customerId: A.customerId, date: day(20), startTime: '10:00' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await put(A, id, { status: 'confirmed' })).status).toBe(200);
    expect((await put(A, id, { date: day(21), startTime: '11:00' })).status).toBe(200);
    expect((await put(A, id, { staffId: A.staffB })).status).toBe(200);
    expect((await put(A, id, { status: 'cancelled' })).status).toBe(200);
    expect((await put(A, id, { status: 'scheduled' })).status).toBe(200);
    expect((await put(A, id, { notes: 'Parking at the back' })).status).toBe(200); // not a tracked change

    const res = await history(A, id);
    expect(res.status).toBe(200);
    const entries = res.body.data as Array<Record<string, any>>;
    expect(entries.map(e => [e.action, e.fromStatus, e.toStatus])).toEqual([
      ['created', null, 'scheduled'],
      ['status_changed', 'scheduled', 'confirmed'],
      ['rescheduled', null, null],
      ['reassigned', null, null],
      ['status_changed', 'confirmed', 'cancelled'],
      ['status_changed', 'cancelled', 'scheduled'],
    ]);
    expect(entries[0]).toMatchObject({ toDate: day(20), toStartTime: '10:00', toStaff: { id: A.staffA, name: 'Asha a' } });
    expect(entries[2]).toMatchObject({ fromDate: day(20), fromStartTime: '10:00', toDate: day(21), toStartTime: '11:00' });
    expect(entries[3]).toMatchObject({ fromStaff: { id: A.staffA, name: 'Asha a' }, toStaff: { id: A.staffB, name: 'Bilal a' } });
    for (const e of entries) expect(e.actor).toEqual({ type: 'user', name: 'Owner a', source: 'dashboard' });
    expect(entries.every(e => !Number.isNaN(Date.parse(e.createdAt)))).toBe(true);
  });

  it('completion and no-show are recorded for appointments that have started; refused changes record nothing', async () => {
    const past = insertAppointment(A, day(-2), '10:00');
    const future = await request(app).post('/api/appointments').set(A.h).send({ serviceId: A.serviceId, staffId: A.staffA, customerId: A.customerId, date: day(22), startTime: '09:00' });
    expect((await put(A, future.body.data.id, { status: 'completed' })).status).toBe(409);
    expect(rowsFor(future.body.data.id).map(r => r.action)).toEqual(['created']);

    expect((await put(A, past.id, { status: 'no_show' })).status).toBe(200);
    expect((await put(A, past.id, { status: 'completed' })).status).toBe(200); // corrected: the person came after all
    expect((await put(A, past.id, { status: 'cancelled' })).status).toBe(409); // completed cannot be cancelled
    expect(rowsFor(past.id).map(r => `${r.from_status}>${r.to_status}`)).toEqual(['scheduled>no_show', 'no_show>completed']);
    // Made before history was recorded: no "created" entry is invented for it.
    expect((await history(A, past.id)).body.data[0].action).toBe('status_changed');
  });

  it('a deleted appointment keeps a "deleted" entry; its history is no longer served', async () => {
    const created = await request(app).post('/api/appointments').set(A.h).send({ serviceId: A.serviceId, staffId: A.staffA, customerId: A.customerId, date: day(23), startTime: '12:00' });
    const id = created.body.data.id;
    expect((await request(app).delete(`/api/appointments/${id}`).set(A.h)).status).toBe(200);
    expect(rowsFor(id).map(r => [r.action, r.from_status, r.from_date, r.actor_type])).toEqual([
      ['created', null, null, 'user'], ['deleted', 'scheduled', day(23), 'user'],
    ]);
    expect((await history(A, id)).status).toBe(404);
    expect((await request(app).delete(`/api/appointments/${id}`).set(A.h)).status).toBe(404);
    expect(rowsFor(id)).toHaveLength(2);
  });

  it('a change and its entry are saved together: when recording fails, the change is rolled back', async () => {
    const created = await request(app).post('/api/appointments').set(A.h).send({ serviceId: A.serviceId, staffId: A.staffA, customerId: A.customerId, date: day(24), startTime: '13:00' });
    const id = created.body.data.id;
    db.exec(`CREATE TEMP TRIGGER fail_history BEFORE INSERT ON appointment_history WHEN NEW.appointment_id = '${id}'
             BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`);
    try {
      expect((await put(A, id, { status: 'confirmed' })).status).toBe(500);
    } finally {
      db.exec('DROP TRIGGER temp.fail_history');
    }
    expect((db.prepare('SELECT status FROM appointments WHERE id = ?').get(id) as { status: string }).status).toBe('scheduled');
    expect(rowsFor(id).map(r => r.action)).toEqual(['created']);
  });
});

describe('who can read it', () => {
  it('another business gets 404 and its own history query returns nothing', async () => {
    const { id } = insertAppointment(A, day(-3), '09:00');
    await put(A, id, { status: 'completed' });
    expect((await history(B, id)).status).toBe(404);
    expect(listHistory(B.orgId, id)).toEqual([]);
    expect(listHistory(A.orgId, id)).toHaveLength(1);
  });

  it('a staff account sees its own appointments\' history, not a colleague\'s; managers see all', async () => {
    const mine = insertAppointment(A, day(-4), '09:00', 'scheduled', A.staffA);
    const theirs = insertAppointment(A, day(-4), '10:00', 'scheduled', A.staffB);
    const asha = await userWithRole(A.orgId, 'staff', A.staffA);
    const unlinked = await userWithRole(A.orgId, 'staff', null);
    const manager = await userWithRole(A.orgId, 'manager');
    expect((await history(A, mine.id, asha)).status).toBe(200);
    expect((await history(A, theirs.id, asha)).status).toBe(404);
    expect((await history(A, mine.id, unlinked)).status).toBe(404);
    expect((await history(A, theirs.id, manager)).status).toBe(200);
    expect((await request(app).get(`/api/appointments/${mine.id}/history`)).status).toBe(401);
  });

  it('there is no route that edits or removes an entry', async () => {
    const { id } = insertAppointment(A, day(-5), '09:00');
    await put(A, id, { status: 'completed' });
    for (const method of ['put', 'patch', 'delete', 'post'] as const) {
      const res = await request(app)[method](`/api/appointments/${id}/history`).set(A.h).send({});
      expect([method, res.status]).toEqual([method, 404]);
    }
    expect(rowsFor(id)).toHaveLength(1);
  });
});

describe('append-only in the database', () => {
  it('refuses updates, deletes and replacing an entry; entries go only with their organization', async () => {
    const { id } = insertAppointment(A, day(-6), '09:00');
    await put(A, id, { status: 'no_show' });
    const [row] = rowsFor(id);
    expect(() => db.prepare("UPDATE appointment_history SET to_status = 'completed' WHERE id = ?").run(row.id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM appointment_history WHERE id = ?').run(row.id)).toThrow(/append-only/);
    expect(() => db.prepare(`INSERT OR REPLACE INTO appointment_history (id, organization_id, appointment_id, booking_ref, action, actor_type, source)
                             VALUES (?, ?, ?, 'x', 'created', 'customer', 'booking_page')`).run(row.id, A.orgId, id)).toThrow(/append-only/);
    expect(rowsFor(id)).toEqual([row]);

    // A throw-away organization with one entry: deleting the organization removes it.
    const orgId = `org-${nanoid(8)}`;
    db.prepare("INSERT INTO organizations (id, name) VALUES (?, 'Disposable')").run(orgId);
    db.prepare(`INSERT INTO appointment_history (id, organization_id, appointment_id, booking_ref, action, actor_type, source)
                VALUES (?, ?, 'appt-gone', 'WE-GONE', 'created', 'customer', 'booking_page')`).run(`hist-${nanoid(8)}`, orgId);
    db.prepare('DELETE FROM organizations WHERE id = ?').run(orgId);
    expect(db.prepare('SELECT COUNT(*) c FROM appointment_history WHERE organization_id = ?').get(orgId)).toEqual({ c: 0 });
  });

  it('refuses entries that do not describe a change', () => {
    const insert = (action: string, cols: Record<string, string | null>) => () => db.prepare(
      `INSERT INTO appointment_history (id, organization_id, appointment_id, booking_ref, action, actor_type, actor_user_id, source, ${Object.keys(cols).join(', ')})
       VALUES (?, ?, 'appt-x', 'WE-X', ?, 'user', ?, 'dashboard', ${Object.keys(cols).map(() => '?').join(', ')})`
    ).run(`hist-${nanoid(8)}`, A.orgId, action, A.userId, ...Object.values(cols));
    expect(insert('status_changed', { from_status: 'scheduled', to_status: 'scheduled' })).toThrow(/CHECK/);
    expect(insert('reassigned', { from_staff_id: A.staffA, to_staff_id: A.staffA })).toThrow(/CHECK/);
    expect(insert('rescheduled', { from_date: day(1), from_start_time: null })).toThrow(/CHECK/);
    expect(insert('archived', { to_status: 'scheduled' })).toThrow(/CHECK/);
    // A user action must name the user; a customer action must not.
    expect(() => db.prepare(`INSERT INTO appointment_history (id, organization_id, appointment_id, booking_ref, action, actor_type, source, to_status)
                             VALUES (?, ?, 'appt-x', 'WE-X', 'created', 'user', 'dashboard', 'scheduled')`).run(`hist-${nanoid(8)}`, A.orgId)).toThrow(/CHECK/);
  });
});

describe('recorded from the booking page, the manage link and the assistant', () => {
  it('a public booking, then a move and a cancellation with the manage link, are recorded as the customer\'s', async () => {
    const email = `meera-${RUN}@example.com`;
    const booked = await publicBook(A, day(25), '10:00', email);
    expect(booked.status).toBe(201);
    const { appointmentId: id, manageToken } = booked.body.data;
    expect((await manageMove(manageToken, day(26), '11:00')).status).toBe(200);
    expect((await manageCancel(manageToken)).status).toBe(200);
    const entries = (await history(A, id)).body.data as Array<Record<string, any>>;
    expect(entries.map(e => [e.action, e.actor.type, e.actor.source, e.actor.name])).toEqual([
      ['created', 'customer', 'booking_page', null],
      ['rescheduled', 'customer', 'manage_link', null],
      ['status_changed', 'customer', 'manage_link', null],
    ]);
    expect(entries[1]).toMatchObject({ fromDate: day(25), fromStartTime: '10:00', toDate: day(26), toStartTime: '11:00' });
    expect(entries[2]).toMatchObject({ fromStatus: 'scheduled', toStatus: 'cancelled' });
    // The link still shows the booking, but cannot cancel it twice or move it back.
    expect((await request(app).get('/api/public/appointments/manage').set('X-Booking-Token', manageToken)).body.data.status).toBe('cancelled');
    expect((await manageCancel(manageToken)).status).toBe(400);
    expect((await manageMove(manageToken, day(27), '10:00')).status).toBe(400);
    expect(rowsFor(id)).toHaveLength(3);
  });

  it('moving a confirmed booking records the move and the status going back to scheduled', async () => {
    const booked = await publicBook(A, day(28), '10:00', `confirm-${RUN}@example.com`);
    const { appointmentId: id, manageToken } = booked.body.data;
    expect((await put(A, id, { status: 'confirmed' })).status).toBe(200);
    expect((await manageMove(manageToken, day(28), '12:00')).status).toBe(200);
    expect(rowsFor(id).map(r => [r.action, r.actor_type])).toEqual([
      ['created', 'customer'], ['status_changed', 'user'], ['status_changed', 'customer'], ['rescheduled', 'customer'],
    ]);
  });

  it('a booking the assistant makes is recorded as the user\'s, through the assistant', async () => {
    const user: AuthPayload = { sub: A.userId, email: `hist-a-${RUN}@example.com`, orgId: A.orgId, role: 'admin' };
    const conv = `conv-hist-${nanoid(6)}`;
    db.prepare('INSERT INTO ai_conversations (id, organization_id, user_id, title) VALUES (?, ?, ?, ?)').run(conv, A.orgId, A.userId, 'History');
    const proposal = executeTool('propose_create_appointment',
      { serviceId: A.serviceId, staffId: A.staffB, customerId: A.customerId, date: day(29), startTime: '15:00' }, user, conv);
    expect(proposal.type).toBe('proposal');
    const done = executeConfirmedProposal((proposal as unknown as { proposal: { id: string } }).proposal.id, user);
    expect(done.ok).toBe(true);
    const id = (done.result as { id: string }).id;
    expect((await history(A, id)).body.data.map((e: any) => [e.action, e.actor])).toEqual([
      ['created', { type: 'user', name: 'Owner a', source: 'assistant' }],
    ]);
  });
});

describe('what customers can change online', () => {
  it('a no-show stays a no-show: it cannot be cancelled or moved with the link', async () => {
    const { id } = insertAppointment(A, day(-7), '09:00', 'no_show');
    const token = issueManageToken(id, `cust-a-${RUN}@example.com`, Date.now() + 3_600_000);
    const cancel = await manageCancel(token);
    expect([cancel.status, cancel.body.error]).toEqual([400, expect.stringMatching(/marked as missed/)]);
    const move = await manageMove(token, day(30), '10:00');
    expect([move.status, move.body.error]).toEqual([400, expect.stringMatching(/marked as missed/)]);
    const row = db.prepare('SELECT status, date FROM appointments WHERE id = ?').get(id);
    expect(row).toEqual({ status: 'no_show', date: day(-7) });
    expect(rowsFor(id)).toEqual([]);
  });

  it('an appointment that has started cannot be cancelled or moved online', async () => {
    const started = instantToZoned(Date.now() - 5 * 60_000, TZ);
    const { id } = insertAppointment(A, started.date, started.time.slice(0, 5), 'confirmed', A.staffB);
    const token = issueManageToken(id, `cust-a-${RUN}@example.com`, Date.now() + 3_600_000);
    const cancel = await manageCancel(token);
    expect([cancel.status, cancel.body.error]).toEqual([400, expect.stringMatching(/already started/)]);
    expect((await manageMove(token, day(31), '10:00')).status).toBe(400);
    expect((db.prepare('SELECT status FROM appointments WHERE id = ?').get(id) as { status: string }).status).toBe('confirmed');
  });

  it('an expired or altered link changes nothing', async () => {
    const booked = await publicBook(A, day(32), '10:00', `expiry-${RUN}@example.com`);
    const id = booked.body.data.appointmentId;
    const expired = issueManageToken(id, `expiry-${RUN}@example.com`, Date.now() - 1000);
    expect((await manageCancel(expired)).body.code).toBe('BOOKING_TOKEN_EXPIRED');
    const altered = booked.body.data.manageToken.slice(0, -2) + (booked.body.data.manageToken.endsWith('AA') ? 'BB' : 'AA');
    expect((await manageCancel(altered)).body.code).toBe('BOOKING_TOKEN_INVALID');
    // Issued for another address (or the customer's address changed since): not valid.
    expect((await manageCancel(issueManageToken(id, 'someone-else@example.com', Date.now() + 60_000))).body.code).toBe('BOOKING_TOKEN_INVALID');
    expect(rowsFor(id).map(r => r.action)).toEqual(['created']);
  });
});

describe('emailing the manage link again', () => {
  const waitForMail = async (to: string) => {
    for (let i = 0; i < 50; i++) {
      const m = testOutbox.messages.find(x => x.to === to);
      if (m) return m;
      await new Promise(r => setTimeout(r, 20));
    }
    return undefined;
  };

  it('sends a working, expiring link to the address on the booking only; the answer never says whether it matched', async () => {
    const email = `link-${RUN}@example.com`;
    const booked = await publicBook(A, day(33), '10:00', email);
    const { appointmentId: id, bookingRef: ref } = booked.body.data;
    await waitForMail(email);
    testOutbox.clear();
    const before = outboxCount(id);

    const ok = await sendLink(ref.toLowerCase(), `  ${email.toUpperCase()} `);
    const wrongEmail = await sendLink(ref, `not-${email}`);
    const unknownRef = await sendLink('WE-NOPE0000', email);
    for (const res of [ok, wrongEmail, unknownRef]) expect([res.status, res.body]).toEqual([202, ok.body]);
    expect(outboxCount(id)).toBe(before + 1);

    const mail = await waitForMail(email);
    expect(mail).toBeDefined();
    expect(testOutbox.messages.map(m => m.to)).toEqual([email]);
    const token = decodeURIComponent(/manage#token=([^\s"]+)/.exec(mail!.text)![1]);
    const check = verifyManageToken(token);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.appointment.id).toBe(id);
      expect(Date.parse(check.expiresAt)).toBeGreaterThan(Date.now() + 86_400_000);
    }
  });

  it('sends nothing for bookings that can no longer be changed, and records no history', async () => {
    const cancelled = insertAppointment(A, day(34), '10:00', 'cancelled');
    const past = insertAppointment(A, day(-8), '10:00', 'scheduled');
    for (const { id, ref } of [cancelled, past]) {
      expect((await sendLink(ref, `cust-a-${RUN}@example.com`)).status).toBe(202);
      expect(outboxCount(id)).toBe(0);
      expect(rowsFor(id)).toEqual([]);
    }
  });

  it('rejects incomplete requests and is rate limited per booking reference and per network', async () => {
    expect((await sendLink('', 'x@example.com')).status).toBe(400);
    expect((await sendLink('WE-AAAA1111', 'not-an-email')).status).toBe(400);
    process.env.RATE_LIMITS = 'on';
    rateLimitTesting.reset();
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await sendLink('WE-LIMIT001', `x${i}@example.com`)).status);
      expect(statuses).toEqual([202, 202, 202, 429]);
      rateLimitTesting.reset();
      const perNetwork = [];
      for (let i = 0; i < 6; i++) perNetwork.push((await sendLink(`WE-NET0000${i}`, 'x@example.com')).status);
      expect(perNetwork).toEqual([202, 202, 202, 202, 202, 429]);
    } finally {
      process.env.RATE_LIMITS = 'off';
      rateLimitTesting.reset();
    }
  });
});
