// Staff sign-in by invitation: email-only single-use tokens, expiry, reuse, forgery, revocation, cross-organization
// isolation, email-ownership changes, access on/off and what a staff sign-in can see.
// Synthetic records only, in the isolated per-file test database; email goes to the in-memory test transport.

import request from 'supertest';
import { createHash } from 'crypto';
import app from '../index';
import db from '../db/init';
import { initEmail, testOutbox } from '../services/email/notify';
import { rateLimitTesting } from '../middleware/rate-limit';
import { permissionsFor } from '../auth/permissions';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv;
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);
const date = (() => { const d = new Date(); d.setDate(d.getDate() + 20); return d.toISOString().slice(0, 10); })();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const PASSWORD = 'StaffPass123';

interface Org { token: string; orgId: string; serviceId: string; customerId: string }

async function makeOrg(label: string): Promise<Org> {
  const s = await signUpAndSignIn(app, {
    name: `Inviter ${label}`, email: `inviter-${label}-${RUN}@example.com`, company: `Invite Org ${label} ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  expect(s.status).toBe(200);
  const token = sessionToken(s);
  const serviceId = (await request(app).post('/api/services').set(bearer(token))
    .send({ name: `Massage ${label}`, category: 'session', duration: 60, price: 50, maxAdvance: 365 })).body.data.id;
  const customerId = (await request(app).post('/api/customers').set(bearer(token))
    .send({ name: `Invite Customer ${label}`, email: `invite-cust-${label}-${RUN}@example.com` })).body.data.id;
  return { token, orgId: s.body.data.user.organization_id, serviceId, customerId };
}

async function addStaff(org: Org, label: string, email = `member-${label}-${RUN}@example.com`): Promise<string> {
  const res = await request(app).post('/api/staff').set(bearer(org.token))
    .send({ name: `Member ${label}`, email, serviceIds: [org.serviceId], workingHours: EVERY_DAY });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

const invite = (org: Org, staffId: string, role: string = 'staff') =>
  request(app).post(`/api/staff/${staffId}/invitations`).set(bearer(org.token)).send({ role });

/** The token from the most recent invitation email (the only place it ever appears). */
function tokenFromEmail(to: string): string {
  const message = [...testOutbox.messages].reverse().find(m => m.to === to);
  const match = message?.text.match(/\/accept-invite#token=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`No invitation email for ${to}`);
  return decodeURIComponent(match[1]);
}

const inspect = (token: string) => request(app).post('/api/auth/invitations/inspect').send({ token });
const accept = (token: string, password = PASSWORD) =>
  request(app).post('/api/auth/invitations/accept').send({ token, password, confirmPassword: password });

let A: Org;
let B: Org;
beforeAll(async () => {
  initEmail(MEMORY_ENV);
  A = await makeOrg('a');
  B = await makeOrg('b');
});
beforeEach(() => testOutbox.clear());

describe('invitation delivery', () => {
  it('emails a single-use link to the staff address; the API never returns the token and the database stores only a hash', async () => {
    const staffId = await addStaff(A, 'deliver');
    const email = `member-deliver-${RUN}@example.com`;
    const res = await invite(A, staffId);
    expect(res.status).toBe(201);
    expect(res.body.data.invitation).toMatchObject({ email, role: 'staff', status: 'pending' });
    expect(res.body.data.email).toEqual({ status: 'sent' });
    expect(testOutbox.messages).toHaveLength(1);
    expect(testOutbox.messages[0].to).toBe(email);
    expect(testOutbox.messages[0].subject).toContain(`Invite Org a ${RUN}`);
    const token = tokenFromEmail(email);
    expect(JSON.stringify(res.body)).not.toContain(token);
    const row = db.prepare('SELECT * FROM staff_invitations WHERE staff_id = ?').get(staffId) as Record<string, unknown>;
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(token);
    const expires = Date.parse(row.expires_at as string) - Date.now();
    expect(expires).toBeGreaterThan(71 * 3600_000);
    expect(expires).toBeLessThanOrEqual(72 * 3600_000);
  });

  it('refuses to invite when email is not configured, and creates nothing', async () => {
    const staffId = await addStaff(A, 'noemail');
    initEmail({ EMAIL_TRANSPORT: 'disabled' } as NodeJS.ProcessEnv);
    try {
      const res = await invite(A, staffId);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('EMAIL_NOT_CONFIGURED');
    } finally {
      initEmail(MEMORY_ENV);
    }
    expect(db.prepare('SELECT 1 FROM staff_invitations WHERE staff_id = ?').get(staffId)).toBeUndefined();
  });

  it('closes the invitation when the email could not be delivered', async () => {
    const staffId = await addStaff(A, 'bounce');
    testOutbox.failNextSends(1);
    const res = await invite(A, staffId);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('INVITE_NOT_DELIVERED');
    const row = db.prepare('SELECT revoked_at, delivery_status FROM staff_invitations WHERE staff_id = ?').get(staffId) as { revoked_at: string | null; delivery_status: string };
    expect(row.delivery_status).toBe('failed');
    expect(row.revoked_at).not.toBeNull();
  });

  it('does not reveal to another business that an address already has an account', async () => {
    const inUse = `inviter-a-${RUN}@example.com`; // A's administrator
    const before = db.prepare('SELECT id, organization_id, password_hash, role FROM users WHERE email = ?').get(inUse);
    const fresh = await invite(B, await addStaff(B, 'fresh'));
    const probe = await invite(B, await addStaff(B, 'probe', inUse));
    // The same answer as for an address nobody uses.
    expect(probe.status).toBe(201);
    expect(probe.status).toBe(fresh.status);
    expect(Object.keys(probe.body.data).sort()).toEqual(Object.keys(fresh.body.data).sort());
    expect(JSON.stringify(probe.body)).not.toMatch(/already|EMAIL_IN_USE|account/i);
    // Only the inbox owner learns it, when accepting; A's sign-in is untouched and nothing is created in B.
    const accepted = await accept(tokenFromEmail(inUse));
    expect(accepted.status).toBe(409);
    expect(accepted.body.code).toBe('EMAIL_IN_USE');
    expect(db.prepare('SELECT id, organization_id, password_hash, role FROM users WHERE email = ?').get(inUse)).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get(inUse)).toEqual({ n: 1 });
  });

  it('does not invite an address that already has an account, an inactive member, or anyone as admin', async () => {
    const owner = await addStaff(A, 'owner', `inviter-a-${RUN}@example.com`);
    expect((await invite(A, owner)).body.code).toBe('EMAIL_IN_USE');
    const inactive = await addStaff(A, 'inactive');
    await request(app).put(`/api/staff/${inactive}`).set(bearer(A.token)).send({ isActive: false }).expect(200);
    expect((await invite(A, inactive)).body.code).toBe('STAFF_INACTIVE');
    const someone = await addStaff(A, 'escalate');
    expect((await invite(A, someone, 'admin')).status).toBe(400);
  });

  it('only administrators can invite, list or revoke invitations', async () => {
    const staffId = await addStaff(A, 'perm');
    await invite(A, staffId, 'manager').expect(201);
    const manager = sessionToken(await accept(tokenFromEmail(`member-perm-${RUN}@example.com`)));
    const other = await addStaff(A, 'perm2');
    expect((await request(app).post(`/api/staff/${other}/invitations`).set(bearer(manager)).send({ role: 'staff' })).status).toBe(403);
    expect((await request(app).get(`/api/staff/${other}/invitations`).set(bearer(manager))).status).toBe(403);
    expect((await request(app).put(`/api/staff/${other}/access`).set(bearer(manager)).send({ enabled: false })).status).toBe(403);
  });
});

describe('accepting an invitation', () => {
  let staffId = '';
  let token = '';
  let staffSession = '';
  const email = `member-accept-${RUN}@example.com`;
  beforeAll(async () => {
    staffId = await addStaff(A, 'accept');
    testOutbox.clear();
    await invite(A, staffId).expect(201);
    token = tokenFromEmail(email);
  });

  it('shows who is inviting whom before a password is chosen', async () => {
    const res = await inspect(token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({ businessName: `Invite Org a ${RUN}`, staffName: 'Member accept', email, role: 'staff' }));
  });

  it('enforces the password rules', async () => {
    expect((await accept(token, 'weak')).status).toBe(400);
    const mismatch = await request(app).post('/api/auth/invitations/accept').send({ token, password: PASSWORD, confirmPassword: 'Different123' });
    expect(mismatch.status).toBe(400);
  });

  it('creates a staff sign-in linked to exactly this staff record and organization', async () => {
    const res = await accept(token);
    expect(res.status).toBe(201);
    expect(res.body.data.token).toBeUndefined();
    staffSession = sessionToken(res);
    const me = await request(app).get('/api/auth/me').set(bearer(staffSession));
    expect(me.body.data).toMatchObject({ email, role: 'staff', staffId, organization_id: A.orgId, permissions: permissionsFor('staff') });
    const users = db.prepare('SELECT organization_id, staff_id FROM users WHERE email = ?').all(email);
    expect(users).toEqual([{ organization_id: A.orgId, staff_id: staffId }]);
  });

  it('cannot be used twice', async () => {
    expect((await accept(token, 'AnotherPass123')).body.code).toBe('INVITE_USED');
    expect((await inspect(token)).status).toBe(410);
  });

  it('the staff member signs in with their own password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.user.staffId).toBe(staffId);
  });

  it('a staff sign-in sees only its own appointments and none of the business data', async () => {
    const otherStaff = await addStaff(A, 'colleague');
    const mine = await request(app).post('/api/appointments').set(bearer(A.token)).send({ serviceId: A.serviceId, staffId, customerId: A.customerId, date, startTime: '09:00' });
    const theirs = await request(app).post('/api/appointments').set(bearer(A.token)).send({ serviceId: A.serviceId, staffId: otherStaff, customerId: A.customerId, date, startTime: '09:00' });
    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    const list = await request(app).get('/api/appointments').set(bearer(staffSession));
    expect(list.body.data.map((a: { id: string }) => a.id)).toEqual([mine.body.data.id]);
    expect((await request(app).get(`/api/appointments?staffId=${otherStaff}`).set(bearer(staffSession))).body.data).toEqual([]);
    expect((await request(app).get(`/api/appointments/${mine.body.data.id}`).set(bearer(staffSession))).status).toBe(200);
    expect((await request(app).get(`/api/appointments/${theirs.body.data.id}`).set(bearer(staffSession))).status).toBe(404);
    for (const [method, path] of [['get', '/api/customers'], ['get', '/api/reports/summary'], ['post', '/api/appointments'], ['put', '/api/settings'], ['post', '/api/ai/ask'], ['get', `/api/appointments/${mine.body.data.id}/emails`]] as const) {
      expect((await request(app)[method](path).set(bearer(staffSession)).send({})).status).toBe(403);
    }
  });
});

describe('expired, forged, replaced and revoked invitations', () => {
  it('rejects an expired invitation', async () => {
    const staffId = await addStaff(A, 'expired');
    await invite(A, staffId).expect(201);
    const token = tokenFromEmail(`member-expired-${RUN}@example.com`);
    db.prepare("UPDATE staff_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE staff_id = ?").run(staffId);
    expect((await inspect(token)).body.code).toBe('INVITE_EXPIRED');
    expect((await accept(token)).body.code).toBe('INVITE_EXPIRED');
    expect(db.prepare('SELECT 1 FROM users WHERE staff_id = ?').get(staffId)).toBeUndefined();
  });

  it('rejects forged and malformed tokens', async () => {
    for (const forged of ['', 'short', 'x'.repeat(43), 'A'.repeat(500), `${'a'.repeat(42)}!`]) {
      const res = await accept(forged);
      expect([400, 404]).toContain(res.status);
      expect(res.status).not.toBe(201);
    }
    expect((await inspect('a'.repeat(43))).body.code).toBe('INVITE_INVALID');
  });

  it('a newer invitation replaces the older one', async () => {
    const staffId = await addStaff(A, 'replace');
    const email = `member-replace-${RUN}@example.com`;
    await invite(A, staffId).expect(201);
    const first = tokenFromEmail(email);
    await invite(A, staffId).expect(201);
    const second = tokenFromEmail(email);
    expect(first).not.toBe(second);
    expect((await accept(first)).body.code).toBe('INVITE_REVOKED');
    expect((await accept(second)).status).toBe(201);
  });

  it('an administrator can revoke an open invitation', async () => {
    const staffId = await addStaff(A, 'revoke');
    const created = await invite(A, staffId).expect(201);
    const token = tokenFromEmail(`member-revoke-${RUN}@example.com`);
    await request(app).delete(`/api/staff/${staffId}/invitations/${created.body.data.invitation.id}`).set(bearer(A.token)).expect(200);
    expect((await accept(token)).body.code).toBe('INVITE_REVOKED');
    const list = await request(app).get(`/api/staff/${staffId}/invitations`).set(bearer(A.token));
    expect(list.body.data[0].status).toBe('revoked');
  });

  it('changing the staff email voids invitations sent to the old address', async () => {
    const staffId = await addStaff(A, 'moved');
    await invite(A, staffId).expect(201);
    const token = tokenFromEmail(`member-moved-${RUN}@example.com`);
    await request(app).put(`/api/staff/${staffId}`).set(bearer(A.token)).send({ email: `member-moved-new-${RUN}@example.com` }).expect(200);
    expect((await accept(token)).status).toBe(410);
    expect(db.prepare('SELECT 1 FROM users WHERE staff_id = ?').get(staffId)).toBeUndefined();
  });

  it('two simultaneous accepts of one invitation create exactly one sign-in', async () => {
    const staffId = await addStaff(A, 'race');
    await invite(A, staffId).expect(201);
    const token = tokenFromEmail(`member-race-${RUN}@example.com`);
    const results = await Promise.all([accept(token), accept(token, 'OtherPass456')]);
    expect(results.map(r => r.status).sort()).toEqual([201, 410]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM users WHERE staff_id = ?').get(staffId) as { c: number }).c).toBe(1);
  });
});

describe('organizations stay separate', () => {
  it("one organization cannot invite, list or revoke another's staff", async () => {
    const staffId = await addStaff(A, 'crossorg');
    const created = await invite(A, staffId).expect(201);
    expect((await request(app).post(`/api/staff/${staffId}/invitations`).set(bearer(B.token)).send({ role: 'staff' })).status).toBe(404);
    expect((await request(app).get(`/api/staff/${staffId}/invitations`).set(bearer(B.token))).status).toBe(404);
    expect((await request(app).delete(`/api/staff/${staffId}/invitations/${created.body.data.invitation.id}`).set(bearer(B.token))).status).toBe(404);
    expect((await request(app).put(`/api/staff/${staffId}/access`).set(bearer(B.token)).send({ enabled: false })).status).toBe(404);
    // The invitation still works for its own organization, and only for it.
    const session = sessionToken(await accept(tokenFromEmail(`member-crossorg-${RUN}@example.com`)));
    const me = await request(app).get('/api/auth/me').set(bearer(session));
    expect(me.body.data.organization_id).toBe(A.orgId);
    expect((await request(app).get(`/api/customers/${B.customerId}`).set(bearer(session))).status).toBe(403);
    const bStaff = await addStaff(B, 'b-colleague');
    const visible = (await request(app).get('/api/staff').set(bearer(session))).body.data.map((s: { id: string }) => s.id);
    expect(visible).toContain(staffId);
    expect(visible).not.toContain(bStaff);
    expect((await request(app).get(`/api/staff/${bStaff}`).set(bearer(session))).status).toBe(404);
  });
});

describe('turning sign-in access off and on', () => {
  async function staffWithLogin(label: string) {
    const staffId = await addStaff(A, label);
    const email = `member-${label}-${RUN}@example.com`;
    await invite(A, staffId).expect(201);
    const session = sessionToken(await accept(tokenFromEmail(email)));
    return { staffId, email, session };
  }
  const login = (email: string) => request(app).post('/api/auth/login').send({ email, password: PASSWORD });

  it('an administrator can turn a sign-in off (ending its sessions) and back on', async () => {
    const s = await staffWithLogin('access');
    await request(app).put(`/api/staff/${s.staffId}/access`).set(bearer(A.token)).send({ enabled: false }).expect(200);
    expect((await request(app).get('/api/auth/me').set(bearer(s.session))).status).toBe(401);
    expect((await login(s.email)).status).toBe(401);
    const listed = (await request(app).get(`/api/staff/${s.staffId}`).set(bearer(A.token))).body.data.account;
    expect(listed.status).toBe('disabled');
    await request(app).put(`/api/staff/${s.staffId}/access`).set(bearer(A.token)).send({ enabled: true }).expect(200);
    expect((await login(s.email)).status).toBe(200);
  });

  it('deactivating the staff record signs them out and blocks sign-in until reactivated', async () => {
    const s = await staffWithLogin('deact');
    await request(app).put(`/api/staff/${s.staffId}`).set(bearer(A.token)).send({ isActive: false }).expect(200);
    expect((await request(app).get('/api/auth/me').set(bearer(s.session))).status).toBe(401);
    expect((await login(s.email)).status).toBe(401);
    await request(app).put(`/api/staff/${s.staffId}`).set(bearer(A.token)).send({ isActive: true }).expect(200);
    expect((await request(app).get('/api/auth/me').set(bearer(s.session))).status).toBe(401); // old session stays ended
    expect((await login(s.email)).status).toBe(200);
  });

  it("deleting the staff record turns the sign-in off; the sign-in's email cannot be changed while linked", async () => {
    const s = await staffWithLogin('remove');
    const change = await request(app).put(`/api/staff/${s.staffId}`).set(bearer(A.token)).send({ email: `elsewhere-${RUN}@example.com` });
    expect(change.status).toBe(409);
    expect(change.body.code).toBe('EMAIL_LINKED_TO_SIGN_IN');
    await request(app).delete(`/api/staff/${s.staffId}`).set(bearer(A.token)).expect(200);
    expect((await login(s.email)).status).toBe(401);
    expect((db.prepare('SELECT is_active, staff_id FROM users WHERE email = ?').get(s.email) as { is_active: number; staff_id: string | null }))
      .toEqual({ is_active: 0, staff_id: null });
  });

  it('the staff list shows each sign-in state to administrators only', async () => {
    const s = await staffWithLogin('listing');
    const pendingId = await addStaff(A, 'pending');
    await invite(A, pendingId).expect(201);
    const list = (await request(app).get('/api/staff').set(bearer(A.token))).body.data as Array<{ id: string; account?: { status: string } }>;
    expect(list.find(x => x.id === s.staffId)!.account!.status).toBe('active');
    expect(list.find(x => x.id === pendingId)!.account!.status).toBe('invited');
    const asStaff = (await request(app).get('/api/staff').set(bearer(s.session))).body.data as Array<{ account?: unknown }>;
    expect(asStaff.every(x => x.account === undefined)).toBe(true);
  });
});

describe('roles, sessions and token guessing', () => {
  it('describes the enforced roles', async () => {
    const res = await request(app).get('/api/auth/roles').set(bearer(A.token));
    expect(res.status).toBe(200);
    expect(res.body.data.roles.map((r: { role: string }) => r.role)).toEqual(['admin', 'manager', 'staff']);
    expect(res.body.data.roles[2].permissions).toEqual(permissionsFor('staff'));
  });

  it('lists my sessions and signs out my other devices', async () => {
    const email = `inviter-a-${RUN}@example.com`;
    const second = sessionToken(await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' }));
    const sessions = await request(app).get('/api/auth/sessions').set(bearer(second));
    expect(sessions.body.data.length).toBeGreaterThanOrEqual(2);
    expect(sessions.body.data.filter((x: { current: boolean }) => x.current)).toHaveLength(1);
    const ended = await request(app).post('/api/auth/sessions/revoke-others').set(bearer(second));
    expect(ended.body.data.ended).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/auth/me').set(bearer(A.token))).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set(bearer(second))).status).toBe(200);
    A.token = second;
  });

  it('limits invitation-token guessing per network', async () => {
    process.env.RATE_LIMITS = 'on';
    rateLimitTesting.reset();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await inspect(`${'g'.repeat(40)}${i}`.padEnd(43, 'x'))).status);
      expect(statuses.slice(0, 10).every(s => s === 404)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      process.env.RATE_LIMITS = 'off';
      rateLimitTesting.reset();
    }
  });
});
