// Role permissions (admin / manager / staff / unknown) and organization isolation for every sensitive resource.
// Synthetic users and records only, in the isolated per-file test database.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { executeConfirmedProposal } from '../services/ai-tools';
import { permissionsFor } from '../auth/permissions';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);
const date = (() => { const d = new Date(); d.setDate(d.getDate() + 15); return d.toISOString().slice(0, 10); })();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Org {
  orgId: string; adminId: string; token: string;
  customerId: string; serviceId: string; staffId: string; workspaceId: string; resourceId: string;
  pageId: string; appointmentId: string; conversationId: string; proposalId: string; workflowId: string;
}

async function makeOrg(label: string): Promise<Org> {
  const s = await signUpAndSignIn(app, {
    name: `Admin ${label}`, email: `rbac-${label}-${RUN}@example.com`, company: `RBAC ${label} ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  expect(s.status).toBe(200);
  const token = sessionToken(s);
  const h = bearer(token);
  const adminId = s.body.data.user.id;
  const orgId = s.body.data.user.organization_id;
  const serviceId = (await request(app).post('/api/services').set(h).send({ name: `Svc ${label}`, category: 'consultation', duration: 30, price: 20, maxAdvance: 365 })).body.data.id;
  const staffId = (await request(app).post('/api/staff').set(h).send({ name: `Staff ${label}`, email: `rbac-staff-${label}-${RUN}@example.com`, serviceIds: [serviceId], workingHours: EVERY_DAY })).body.data.id;
  const customerId = (await request(app).post('/api/customers').set(h).send({ name: `Secret Customer ${label} ${RUN}`, email: `rbac-cust-${label}-${RUN}@example.com` })).body.data.id;
  const workspaceId = (await request(app).post('/api/workspaces').set(h).send({ name: `Room ${label}` })).body.data.id;
  const resourceId = (await request(app).post('/api/resources').set(h).send({ name: `Chair ${label}`, type: 'equipment' })).body.data.id;
  const slug = await publishBookingPage(app, h, [serviceId], `rbac-${label}`);
  const pageId = (await request(app).get('/api/booking-pages').set(h)).body.data.find((p: { slug: string }) => p.slug === slug).id;
  const appt = await request(app).post('/api/appointments').set(h).send({ serviceId, staffId, customerId, date, startTime: '10:00' });
  expect(appt.status).toBe(201);
  const conversationId = (await request(app).post('/api/ai/conversations').set(h).send({ title: `Conv ${label}` })).body.data.id;
  const proposalId = `prop-${nanoid(12)}`;
  db.prepare(`INSERT INTO ai_proposals (id, conversation_id, organization_id, user_id, tool_name, input_data, display_data, status, expires_at)
              VALUES (?, ?, ?, ?, 'propose_create_service', ?, '{}', 'pending', ?)`)
    .run(proposalId, conversationId, orgId, adminId, JSON.stringify({ name: `Proposed ${label}`, duration: 30, price: 10 }), new Date(Date.now() + 600_000).toISOString());
  const workflowId = `wf-${nanoid(10)}`;
  db.prepare(`INSERT INTO ai_workflows (id, organization_id, user_id, conversation_id, type, original_query, step, context, status, expires_at)
              VALUES (?, ?, ?, ?, 'availability_request', 'q', 'awaiting', '{}', 'active', ?)`)
    .run(workflowId, orgId, adminId, conversationId, new Date(Date.now() + 600_000).toISOString());
  return { orgId, adminId, token, customerId, serviceId, staffId, workspaceId, resourceId, pageId, appointmentId: appt.body.data.id, conversationId, proposalId, workflowId };
}

/** A user with a given role inside an organization, created directly (sign-in for invited staff is not enabled). */
async function userWithRole(orgId: string, role: string): Promise<{ id: string; token: string }> {
  const id = `user-${nanoid(8)}`;
  const email = `${role}-${nanoid(6)}-${RUN}@example.com`.toLowerCase();
  db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, email, bcrypt.hashSync('TestPass123', 4), `${role} user`, role);
  const res = await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' });
  expect(res.status).toBe(200);
  return { id, token: sessionToken(res) };
}

let A: Org;
let B: Org;
let manager: { id: string; token: string };
let staff: { id: string; token: string };
let unknown: { id: string; token: string };

beforeAll(async () => {
  A = await makeOrg('a');
  B = await makeOrg('b');
  manager = await userWithRole(A.orgId, 'manager');
  staff = await userWithRole(A.orgId, 'staff');
  unknown = await userWithRole(A.orgId, 'owner'); // not a defined role: gets nothing
});

// ─── Role matrix ─────────────────────────────────────────────────────────────

type Role = 'admin' | 'manager' | 'staff' | 'unknown';
interface Case { method: 'get' | 'post' | 'put' | 'delete'; path: () => string; body?: () => object; allowed: Role[] }

// Letters and digits only, so the value is valid in slugs and emails alike.
const n = () => Math.random().toString(36).slice(2, 9);
let slotIndex = 0;
const nextSlot = () => ['12:00', '12:30', '13:00', '13:30', '14:00', '14:30'][slotIndex++ % 6];
const CASES: Record<string, Case> = {
  'list customers':            { method: 'get', path: () => '/api/customers', allowed: ['admin', 'manager'] },
  'create customer':           { method: 'post', path: () => '/api/customers', body: () => ({ name: 'Role Cust', email: `rc-${n()}@example.com` }), allowed: ['admin', 'manager'] },
  'list services':             { method: 'get', path: () => '/api/services', allowed: ['admin', 'manager', 'staff'] },
  'create service':            { method: 'post', path: () => '/api/services', body: () => ({ name: `Role Svc ${n()}`, category: 'class', duration: 30, price: 5 }), allowed: ['admin', 'manager'] },
  'list staff':                { method: 'get', path: () => '/api/staff', allowed: ['admin', 'manager', 'staff'] },
  'create staff':              { method: 'post', path: () => '/api/staff', body: () => ({ name: 'Role Staff', email: `rs-${n()}@example.com` }), allowed: ['admin'] },
  'edit staff':                { method: 'put', path: () => `/api/staff/${A.staffId}`, body: () => ({ title: 'Senior' }), allowed: ['admin'] },
  'list workspaces':           { method: 'get', path: () => '/api/workspaces', allowed: ['admin', 'manager', 'staff'] },
  'create workspace':          { method: 'post', path: () => '/api/workspaces', body: () => ({ name: `Role Room ${n()}` }), allowed: ['admin'] },
  'list resources':            { method: 'get', path: () => '/api/resources', allowed: ['admin', 'manager', 'staff'] },
  'create resource':           { method: 'post', path: () => '/api/resources', body: () => ({ name: `Role Chair ${n()}` }), allowed: ['admin', 'manager'] },
  'list booking pages':        { method: 'get', path: () => '/api/booking-pages', allowed: ['admin', 'manager', 'staff'] },
  'create booking page':       { method: 'post', path: () => '/api/booking-pages', body: () => ({ title: 'Role Page', slug: `role-${n()}`, serviceIds: [A.serviceId] }), allowed: ['admin', 'manager'] },
  'read settings':             { method: 'get', path: () => '/api/settings', allowed: ['admin', 'manager', 'staff'] },
  'change settings':           { method: 'put', path: () => '/api/settings', body: () => ({ phone: '+91 98765 40199' }), allowed: ['admin'] },
  'reports':                   { method: 'get', path: () => '/api/reports/summary?range=30d', allowed: ['admin', 'manager'] },
  'top customers report':      { method: 'get', path: () => '/api/reports/top-customers', allowed: ['admin', 'manager'] },
  'list appointments':         { method: 'get', path: () => '/api/appointments', allowed: ['admin', 'manager', 'staff'] },
  'admin availability':        { method: 'get', path: () => `/api/appointments/availability?date=${date}&serviceId=${A.serviceId}&staffId=${A.staffId}`, allowed: ['admin', 'manager'] },
  'create appointment':        { method: 'post', path: () => '/api/appointments', body: () => ({ serviceId: A.serviceId, staffId: A.staffId, customerId: A.customerId, date, startTime: nextSlot() }), allowed: ['admin', 'manager'] },
  'appointment email history': { method: 'get', path: () => `/api/appointments/${A.appointmentId}/emails`, allowed: ['admin', 'manager'] },
  'resend booking email':      { method: 'post', path: () => `/api/appointments/${A.appointmentId}/emails`, body: () => ({ kind: 'confirmation' }), allowed: ['admin', 'manager'] },
  'assistant':                 { method: 'post', path: () => '/api/ai/ask', body: () => ({ query: 'how do I add a service?' }), allowed: ['admin', 'manager'] },
  'assistant conversations':   { method: 'get', path: () => '/api/ai/conversations', allowed: ['admin', 'manager'] },
  'knowledge coverage':        { method: 'get', path: () => '/api/ai/knowledge/coverage', allowed: ['admin', 'manager'] },
  'knowledge reindex':         { method: 'post', path: () => '/api/ai/knowledge/reindex', body: () => ({}), allowed: ['admin'] },
};

const tokenFor = (role: Role) => ({ admin: A.token, manager: manager.token, staff: staff.token, unknown: unknown.token }[role]);

describe('role permissions are enforced by the server', () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const role of ['admin', 'manager', 'staff', 'unknown'] as Role[]) {
      const allowed = c.allowed.includes(role);
      it(`${role} ${allowed ? 'may' : 'may not'}: ${name}`, async () => {
        let req = request(app)[c.method](c.path()).set(bearer(tokenFor(role)));
        if (c.body) req = req.send(c.body());
        const res = await req;
        if (allowed) {
          expect(res.status).toBeLessThan(400);
        } else {
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('FORBIDDEN');
        }
      });
    }
  }

  it('every role can read its own profile and permissions; unknown roles have none', async () => {
    const expectPerms = async (token: string, role: string) => {
      const me = await request(app).get('/api/auth/me').set(bearer(token));
      expect(me.status).toBe(200);
      expect(me.body.data.permissions).toEqual(permissionsFor(role));
    };
    await expectPerms(A.token, 'admin');
    await expectPerms(manager.token, 'manager');
    await expectPerms(staff.token, 'staff');
    await expectPerms(unknown.token, 'owner');
    expect(permissionsFor('owner')).toEqual([]);
  });

  it('a staff account without a linked staff record sees no appointments and cannot open one', async () => {
    const list = await request(app).get('/api/appointments').set(bearer(staff.token));
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([]);
    expect((await request(app).get(`/api/appointments/${A.appointmentId}`).set(bearer(staff.token))).status).toBe(404);
  });

  it('knowledge coverage does not reveal server file paths', async () => {
    const res = await request(app).get('/api/ai/knowledge/coverage').set(bearer(manager.token));
    expect(res.body.data.knowledgeDirectory).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });

  it('assistant proposals are re-checked against the role when confirmed', () => {
    const proposalId = `prop-${nanoid(12)}`;
    db.prepare(`INSERT INTO ai_proposals (id, conversation_id, organization_id, user_id, tool_name, input_data, display_data, status, expires_at)
                VALUES (?, ?, ?, ?, 'propose_create_service', ?, '{}', 'pending', ?)`)
      .run(proposalId, A.conversationId, A.orgId, staff.id, JSON.stringify({ name: 'Should Not Exist', duration: 30, price: 1 }), new Date(Date.now() + 600_000).toISOString());
    const result = executeConfirmedProposal(proposalId, { sub: staff.id, email: 'x', orgId: A.orgId, role: 'staff' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/permission/);
    expect(db.prepare("SELECT 1 FROM services WHERE name = 'Should Not Exist'").get()).toBeUndefined();
  });

  it('a manager cannot create staff, change settings or rebuild the knowledge index, but can run the day-to-day business', async () => {
    const h = bearer(manager.token);
    expect((await request(app).post('/api/customers').set(h).send({ name: 'Mgr Cust', email: `mgr-${RUN}@example.com` })).status).toBe(201);
    const zoneBefore = (db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(A.orgId) as { timezone: string }).timezone;
    expect((await request(app).put('/api/settings').set(h).send({ timezone: zoneBefore === 'Europe/Paris' ? 'Asia/Tokyo' : 'Europe/Paris' })).status).toBe(403);
    expect((db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(A.orgId) as { timezone: string }).timezone).toBe(zoneBefore);
  });
});

// ─── Organization isolation ──────────────────────────────────────────────────

describe("one organization cannot read or change another organization's records", () => {
  const asA = () => bearer(A.token);

  it.each([
    ['customer', () => `/api/customers/${B.customerId}`, { notes: 'hijack' }],
    ['service', () => `/api/services/${B.serviceId}`, { price: 1 }],
    ['staff member', () => `/api/staff/${B.staffId}`, { title: 'hijack' }],
    ['workspace', () => `/api/workspaces/${B.workspaceId}`, { name: 'hijack' }],
    ['resource', () => `/api/resources/${B.resourceId}`, { name: 'hijack' }],
    ['booking page', () => `/api/booking-pages/${B.pageId}`, { title: 'hijack' }],
    ['appointment', () => `/api/appointments/${B.appointmentId}`, { internalNotes: 'hijack' }],
  ])('%s: read, update and delete by id all return 404', async (_label, path, body) => {
    expect((await request(app).get(path()).set(asA())).status).toBe(404);
    expect((await request(app).put(path()).set(asA()).send(body)).status).toBe(404);
    expect((await request(app).delete(path()).set(asA())).status).toBe(404);
  });

  it("B's records are untouched after those attempts", () => {
    expect(db.prepare('SELECT 1 FROM customers WHERE id = ?').get(B.customerId)).toBeDefined();
    expect((db.prepare('SELECT notes FROM customers WHERE id = ?').get(B.customerId) as { notes: string }).notes).not.toBe('hijack');
    expect((db.prepare('SELECT internal_notes FROM appointments WHERE id = ?').get(B.appointmentId) as { internal_notes: string }).internal_notes).not.toBe('hijack');
    expect((db.prepare('SELECT title FROM booking_pages WHERE id = ?').get(B.pageId) as { title: string }).title).not.toBe('hijack');
  });

  it('nested resources: appointment email history, resend and publishing', async () => {
    expect((await request(app).get(`/api/appointments/${B.appointmentId}/emails`).set(asA())).status).toBe(404);
    expect((await request(app).post(`/api/appointments/${B.appointmentId}/emails`).set(asA()).send({ kind: 'confirmation' })).status).toBe(404);
    expect((await request(app).post(`/api/booking-pages/${B.pageId}/publish`).set(asA())).status).toBe(404);
  });

  it("assistant conversations, proposals and workflows", async () => {
    expect((await request(app).get(`/api/ai/conversations/${B.conversationId}`).set(asA())).status).toBe(404);
    expect((await request(app).delete(`/api/ai/conversations/${B.conversationId}`).set(asA())).status).toBe(404);
    expect((await request(app).get(`/api/ai/proposals/${B.proposalId}`).set(asA())).status).toBe(404);
    expect((await request(app).post(`/api/ai/proposals/${B.proposalId}/confirm`).set(asA())).status).toBe(400);
    expect((await request(app).post(`/api/ai/proposals/${B.proposalId}/cancel`).set(asA())).status).toBe(400);
    expect((db.prepare('SELECT status FROM ai_proposals WHERE id = ?').get(B.proposalId) as { status: string }).status).toBe('pending');
    expect((await request(app).post(`/api/ai/workflows/${B.workflowId}/cancel`).set(asA())).status).toBe(404);
    expect((db.prepare('SELECT status FROM ai_workflows WHERE id = ?').get(B.workflowId) as { status: string }).status).toBe('active');
  });

  it("another organization's staff schedule cannot be read through admin availability", async () => {
    const res = await request(app).get(`/api/appointments/availability?date=${date}&serviceId=${A.serviceId}&staffId=${B.staffId}`).set(asA());
    expect(res.status).toBe(404);
  });

  it("records cannot point at another organization's records", async () => {
    const h = asA();
    expect((await request(app).post('/api/appointments').set(h).send({ serviceId: A.serviceId, staffId: B.staffId, customerId: A.customerId, date, startTime: '11:00' })).status).toBe(400);
    expect((await request(app).post('/api/appointments').set(h).send({ serviceId: A.serviceId, staffId: A.staffId, customerId: B.customerId, date, startTime: '11:00' })).status).toBe(400);
    expect((await request(app).post('/api/appointments').set(h).send({ serviceId: B.serviceId, staffId: A.staffId, customerId: A.customerId, date, startTime: '11:00' })).status).toBe(400);
    expect((await request(app).post('/api/appointments').set(h).send({ serviceId: A.serviceId, staffId: A.staffId, customerId: A.customerId, date, startTime: '11:00', resourceIds: [B.resourceId] })).status).toBe(400);
    expect((await request(app).post('/api/resources').set(h).send({ name: 'X', workspaceIds: [B.workspaceId] })).status).toBe(400);
    expect((await request(app).post('/api/resources').set(h).send({ name: 'X', serviceIds: [B.serviceId] })).status).toBe(400);
    expect((await request(app).post('/api/services').set(h).send({ name: 'X', category: 'class', duration: 30, price: 1, workspaceIds: [B.workspaceId] })).status).toBe(400);
    expect((await request(app).post('/api/services').set(h).send({ name: 'X', category: 'class', duration: 30, price: 1, resourceIds: [B.resourceId] })).status).toBe(400);
    expect((await request(app).post('/api/services').set(h).send({ name: 'X', category: 'class', duration: 30, price: 1, staffIds: [B.staffId] })).status).toBe(400);
    expect((await request(app).post('/api/workspaces').set(h).send({ name: 'X', serviceIds: [B.serviceId] })).status).toBe(400);
    expect((await request(app).post('/api/workspaces').set(h).send({ name: 'X', staffIds: [B.staffId] })).status).toBe(400);
    expect((await request(app).post('/api/booking-pages').set(h).send({ title: 'X', slug: `x-${RUN}`, serviceIds: [B.serviceId] })).status).toBe(400);
    expect((await request(app).put(`/api/staff/${A.staffId}`).set(h).send({ serviceIds: [B.serviceId] })).status).toBe(400);
  });

  it("lists, reports and assistant searches never include another organization's data", async () => {
    const h = asA();
    const lists = await Promise.all(['/api/customers', '/api/services', '/api/staff', '/api/workspaces', '/api/resources', '/api/booking-pages', '/api/appointments', '/api/reports/top-customers', '/api/ai/conversations']
      .map(p => request(app).get(p).set(h)));
    for (const res of lists) {
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      for (const id of [B.customerId, B.serviceId, B.staffId, B.workspaceId, B.resourceId, B.pageId, B.appointmentId, B.conversationId]) {
        expect(body).not.toContain(id);
      }
      expect(body).not.toContain(`Secret Customer b ${RUN}`);
    }
    const search = await request(app).post('/api/ai/ask').set(h).send({ query: `find customer Secret Customer b ${RUN}` });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain(`Secret Customer b ${RUN}`);
  });

  it("settings and reports only ever reflect the caller's organization", async () => {
    await request(app).put('/api/settings').set(asA()).send({ phone: '+91 98765 40111' }).expect(200);
    const bSettings = await request(app).get('/api/settings').set(bearer(B.token));
    expect(bSettings.body.data.id).toBe(B.orgId);
    expect(bSettings.body.data.phone).not.toBe('+91 98765 40111');
    // A completed, paid appointment for B inside the report window must not show up in A's figures.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    db.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, price, currency)
                VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, '09:00', '09:30', 30, 999, ?)`)
      .run(`appt-${nanoid(8)}`, `WE-${nanoid(8).toUpperCase()}`, B.orgId, B.serviceId, B.staffId, B.customerId, yesterday,
        (db.prepare('SELECT currency FROM organizations WHERE id = ?').get(B.orgId) as { currency: string }).currency);
    const aSummary = (await request(app).get('/api/reports/summary?range=30d').set(asA())).body.data;
    const bSummary = (await request(app).get('/api/reports/summary?range=30d').set(bearer(B.token))).body.data;
    const aCount = (db.prepare('SELECT COUNT(*) AS c FROM appointments WHERE organization_id = ? AND date BETWEEN ? AND ?')
      .get(A.orgId, aSummary.from, aSummary.to) as { c: number }).c;
    expect(aSummary.totalAppointments).toBe(aCount);
    expect(aSummary.revenue).toBe(0);
    expect(bSummary.revenue).toBe(999);
  });
});
