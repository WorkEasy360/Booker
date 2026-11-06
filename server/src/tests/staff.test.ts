// Staff onboarding: direct creation, validation, duplicates, isolation, assignment, bookability, authorization.
// Runs against the isolated test DB from jest.setup.js; every record is created here.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '09:00', end: '17:00' }]),
);

function nextDow(dow: number, minDaysAhead = 2): string {
  const d = new Date();
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() !== dow) d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('sv-SE'); // the local calendar date whose weekday was checked (toISOString gives UTC's)
}

interface Org { token: string; orgId: string; serviceId: string; workspaceId: string }
const auth = (o: { token: string }) => ({ Authorization: `Bearer ${o.token}` });

async function makeOrg(label: string): Promise<Org> {
  const r = await signUpAndSignIn(app, {
    name: `Owner ${label}`, email: `staff-owner-${label}-${RUN}@example.com`, company: `Staff Org ${label} ${RUN}`,
    password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  expect(r.status).toBe(200);
  const token = sessionToken(r);
  const me = await request(app).get('/api/auth/me').set({ Authorization: `Bearer ${token}` });
  const svc = await request(app).post('/api/services').set({ Authorization: `Bearer ${token}` })
    .send({ name: `Consult ${label}`, category: 'consultation', duration: 60, price: 40, maxAdvance: 365 });
  const ws = await request(app).post('/api/workspaces').set({ Authorization: `Bearer ${token}` }).send({ name: `Room ${label}` });
  await publishBookingPage(app, { Authorization: `Bearer ${token}` }, [svc.body.data.id], `staff-${label}`);
  return { token, orgId: me.body.data.organization_id, serviceId: svc.body.data.id, workspaceId: ws.body.data.id };
}

let A: Org;
let B: Org;
beforeAll(async () => {
  A = await makeOrg('a');
  B = await makeOrg('b');
});

describe('direct staff creation', () => {
  it('creates an active staff member who is immediately listed, with default weekday hours', async () => {
    const res = await request(app).post('/api/staff').set(auth(A))
      .send({ name: 'Direct Dana', email: `Dana-${RUN}@Example.com`, phone: '+91 98765 43210' });
    expect(res.status).toBe(201);
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.email).toBe(`dana-${RUN}@example.com`);
    expect(res.body.data.workingHours.monday).toEqual({ enabled: true, start: '09:00', end: '17:00' });
    expect(res.body.data.workingHours.sunday.enabled).toBe(false);
    const list = await request(app).get('/api/staff').set(auth(A));
    expect(list.body.data.map((s: { id: string }) => s.id)).toContain(res.body.data.id);
  });

  it('assigns services on creation and keeps both sides in sync', async () => {
    const res = await request(app).post('/api/staff').set(auth(A))
      .send({ name: 'Assigned Ari', email: `ari-${RUN}@example.com`, serviceIds: [A.serviceId], workspaceIds: [A.workspaceId], workingHours: EVERY_DAY });
    expect(res.status).toBe(201);
    const svc = await request(app).get(`/api/services/${A.serviceId}`).set(auth(A));
    expect(svc.body.data.staffIds).toContain(res.body.data.id);
  });

  it('records the migration and enforces the unique index at the database level', () => {
    expect(db.prepare("SELECT 1 FROM schema_migrations WHERE id = '001_staff_unique_email_per_org'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_staff_org_email'").get()).toBeTruthy();
    expect(() => db.prepare(
      `INSERT INTO staff (id, organization_id, name, email) VALUES (?, ?, 'Raw', ?)`
    ).run(`staff-raw-${RUN}`, A.orgId, `DANA-${RUN}@EXAMPLE.COM`)).toThrow(/UNIQUE/);
  });
});

describe('validation', () => {
  const base = () => ({ name: 'Valid Val', email: `val-${nanoid(6)}-${RUN}@example.com` });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing name', { name: '' }],
    ['HTML in name', { name: '<b>Bold</b>' }],
    ['invalid email', { email: 'not-an-email' }],
    ['letters in phone', { phone: 'call me' }],
    ['unsupported role', { role: 'owner' }],
    ['non-hex colour', { color: 'red' }],
    ['end before start', { workingHours: { monday: { enabled: true, start: '17:00', end: '09:00' } } }],
    ['bad time format', { workingHours: { monday: { enabled: true, start: '9am', end: '17:00' } } }],
    ['unknown day', { workingHours: { funday: { enabled: true, start: '09:00', end: '17:00' } } }],
  ];
  it.each(cases)('rejects %s with 400 and field details', async (_label, patch) => {
    const res = await request(app).post('/api/staff').set(auth(A)).send({ ...base(), ...patch });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });
});

describe('duplicates', () => {
  it('rejects the same email in the same organization regardless of case', async () => {
    const res = await request(app).post('/api/staff').set(auth(A)).send({ name: 'Dup', email: `DANA-${RUN}@example.com` });
    expect(res.status).toBe(409);
  });

  it('rejects changing another staff member to an existing email', async () => {
    const other = await request(app).post('/api/staff').set(auth(A)).send({ name: 'Other', email: `other-${RUN}@example.com` });
    const res = await request(app).put(`/api/staff/${other.body.data.id}`).set(auth(A)).send({ email: `dana-${RUN}@example.com` });
    expect(res.status).toBe(409);
  });

  it('allows the same email in a different organization', async () => {
    const res = await request(app).post('/api/staff').set(auth(B)).send({ name: 'Dana Elsewhere', email: `dana-${RUN}@example.com` });
    expect(res.status).toBe(201);
  });
});

describe('organization isolation', () => {
  let aStaffId = '';
  beforeAll(async () => {
    aStaffId = (await request(app).post('/api/staff').set(auth(A)).send({ name: 'Private Pat', email: `pat-${RUN}@example.com` })).body.data.id;
  });

  it('another organization cannot read, edit or delete the staff member', async () => {
    expect((await request(app).get(`/api/staff/${aStaffId}`).set(auth(B))).status).toBe(404);
    expect((await request(app).put(`/api/staff/${aStaffId}`).set(auth(B)).send({ isActive: false })).status).toBe(404);
    expect((await request(app).delete(`/api/staff/${aStaffId}`).set(auth(B))).status).toBe(404);
    const list = await request(app).get('/api/staff').set(auth(B));
    expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(aStaffId);
  });

  it("cannot assign another organization's service or workspace", async () => {
    expect((await request(app).put(`/api/staff/${aStaffId}`).set(auth(A)).send({ serviceIds: [B.serviceId] })).status).toBe(400);
    expect((await request(app).put(`/api/staff/${aStaffId}`).set(auth(A)).send({ workspaceIds: [B.workspaceId] })).status).toBe(400);
  });
});

describe('authorization', () => {
  let staffUserToken = '';
  beforeAll(async () => {
    const email = `non-admin-${RUN}@example.com`;
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`user-${nanoid(8)}`, A.orgId, email, bcrypt.hashSync('TestPass123', 4), 'Non Admin', 'staff');
    const login = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
    staffUserToken = sessionToken(login);
  });

  it('non-admin users can view staff but cannot create, edit or delete', async () => {
    const t = { token: staffUserToken };
    expect((await request(app).get('/api/staff').set(auth(t))).status).toBe(200);
    expect((await request(app).post('/api/staff').set(auth(t)).send({ name: 'Nope', email: `nope-${RUN}@example.com` })).status).toBe(403);
    const someone = (await request(app).get('/api/staff').set(auth(A))).body.data[0].id;
    expect((await request(app).put(`/api/staff/${someone}`).set(auth(t)).send({ isActive: false })).status).toBe(403);
    expect((await request(app).delete(`/api/staff/${someone}`).set(auth(t))).status).toBe(403);
  });

  it('logged-out requests are rejected', async () => {
    expect((await request(app).get('/api/staff')).status).toBe(401);
    expect((await request(app).post('/api/staff').send({ name: 'x', email: 'x@example.com' })).status).toBe(401);
  });
});

describe('bookability: active, assigned and within working hours', () => {
  let staffId = '';
  let customerId = '';
  const weekday = nextDow(3); // a Wednesday at least two days ahead
  const sunday = nextDow(0);

  beforeAll(async () => {
    staffId = (await request(app).post('/api/staff').set(auth(A)).send({
      name: 'Bookable Bo', email: `bo-${RUN}@example.com`, serviceIds: [A.serviceId],
      workingHours: { ...EVERY_DAY, sunday: { enabled: false, start: '09:00', end: '17:00' } },
    })).body.data.id;
    customerId = (await request(app).post('/api/customers').set(auth(A)).send({ name: 'Cust Bo', email: `custbo-${RUN}@example.com` })).body.data.id;
  });

  const adminBook = (date: string, startTime: string, sid = staffId) =>
    request(app).post('/api/appointments').set(auth(A)).send({ serviceId: A.serviceId, staffId: sid, customerId, date, startTime });

  it('is listed publicly and offers slots while active', async () => {
    const staffList = await request(app).get(`/api/public/services/${A.serviceId}/staff`);
    expect(staffList.body.data.map((s: { id: string }) => s.id)).toContain(staffId);
    const avail = await request(app).get(`/api/public/availability?date=${weekday}&serviceId=${A.serviceId}&staffId=${staffId}`);
    expect(avail.body.data.some((s: { available: boolean }) => s.available)).toBe(true);
  });

  it('rejects admin bookings outside working hours or on a day off', async () => {
    const early = await adminBook(weekday, '07:00');
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/working hours/i);
    const lateEnd = await adminBook(weekday, '16:30'); // 60-minute service would end at 17:30
    expect(lateEnd.status).toBe(400);
    const dayOff = await adminBook(sunday, '10:00');
    expect(dayOff.status).toBe(400);
    expect(dayOff.body.error).toMatch(/does not work on Sundays/);
    expect((await adminBook(weekday, '16:00')).status).toBe(201);
  });

  it('rejects staff who do not offer the service', async () => {
    const unassigned = (await request(app).post('/api/staff').set(auth(A))
      .send({ name: 'Unassigned Uma', email: `uma-${RUN}@example.com`, workingHours: EVERY_DAY })).body.data.id;
    const res = await adminBook(weekday, '10:00', unassigned);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not offer this service/);
  });

  it('inactive staff cannot be booked publicly or by admins, and become bookable again when reactivated', async () => {
    await request(app).put(`/api/staff/${staffId}`).set(auth(A)).send({ isActive: false }).expect(200);
    const staffList = await request(app).get(`/api/public/services/${A.serviceId}/staff`);
    expect(staffList.body.data.map((s: { id: string }) => s.id)).not.toContain(staffId);
    expect((await request(app).get(`/api/public/availability?date=${weekday}&serviceId=${A.serviceId}&staffId=${staffId}`)).status).toBe(400);
    const pub = await request(app).post('/api/public/book').send({
      serviceId: A.serviceId, staffId, date: weekday, startTime: '11:00',
      customer: { name: 'Public P', email: `pp-${RUN}@example.com`, phone: '+91 98765 40100' },
    });
    expect(pub.status).toBe(400);
    const admin = await adminBook(weekday, '11:00');
    expect(admin.status).toBe(400);
    expect(admin.body.error).toMatch(/inactive/);

    await request(app).put(`/api/staff/${staffId}`).set(auth(A)).send({ isActive: true }).expect(200);
    expect((await adminBook(weekday, '11:00')).status).toBe(201);
  });

  it('rescheduling is held to the same rules', async () => {
    const appt = (await adminBook(weekday, '13:00')).body.data;
    const res = await request(app).put(`/api/appointments/${appt.id}`).set(auth(A)).send({ date: sunday, startTime: '13:00' });
    expect(res.status).toBe(400);
  });
});
