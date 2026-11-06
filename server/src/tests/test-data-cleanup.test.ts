// The test-data cleanup refuses anything that is not confirmed and disposable, deletes all-or-nothing, and leaves no
// dangling references. Runs on the throwaway test database only.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { applyCleanup, planCleanup, type CleanupRecord } from '../db/cleanup';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);
const EVERY_DAY = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  .map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]));
const exists = (table: string, id: string) => !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id);
const list = (table: string, column: string, id: string) => JSON.parse((db.prepare(`SELECT ${column} AS v FROM ${table} WHERE id = ?`).get(id) as { v: string }).v) as string[];

let h: Record<string, string>;
let orgId = '', probeSvc = '', realSvc = '', room = '', ws = '', staff = '', probePage = '', sharedPage = '', customer = '', ownerId = '';

beforeAll(async () => {
  const email = `cleanup-${RUN}@example.com`;
  const s = await signUpAndSignIn(app, { name: 'Cleanup Owner', email, company: `Cleanup Org ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123' });
  h = { Authorization: `Bearer ${sessionToken(s)}` };
  ({ organization_id: orgId, id: ownerId } = db.prepare('SELECT organization_id, id FROM users WHERE email = ?').get(email) as { organization_id: string; id: string });
  probeSvc = (await request(app).post('/api/services').set(h).send({ name: `QA Probe ${RUN}`, category: 'consultation', duration: 30, price: 1 })).body.data.id;
  realSvc = (await request(app).post('/api/services').set(h).send({ name: `Real ${RUN}`, category: 'consultation', duration: 30, price: 1 })).body.data.id;
  room = (await request(app).post('/api/resources').set(h).send({ name: `QA Room ${RUN}`, type: 'room' })).body.data.id;
  ws = (await request(app).post('/api/workspaces').set(h).send({ name: `QA WS ${RUN}` })).body.data.id;
  staff = (await request(app).post('/api/staff').set(h).send({ name: `Staff ${RUN}`, email: `cleanup-staff-${RUN}@example.com`, serviceIds: [probeSvc, realSvc], workingHours: EVERY_DAY })).body.data.id;
  customer = (await request(app).post('/api/customers').set(h).send({ name: 'Real Customer', email: `real-${RUN}@example.com` })).body.data.id;
  const date = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  expect((await request(app).post('/api/appointments').set(h).send({ serviceId: realSvc, staffId: staff, customerId: customer, date, startTime: '10:00' })).status).toBe(201);
  probePage = (await request(app).post('/api/booking-pages').set(h).send({ title: 'Probe', slug: `qa-probe-${RUN}`, serviceIds: [probeSvc], isPublished: true })).body.data.id;
  sharedPage = (await request(app).post('/api/booking-pages').set(h).send({ title: 'Shared', slug: `shared-${RUN}`, serviceIds: [probeSvc, realSvc], isPublished: true })).body.data.id;
});

describe('test-data cleanup', () => {
  it('refuses a record whose name no longer matches the plan, and anything with real activity', () => {
    const plan = planCleanup(db, [
      { table: 'services', id: probeSvc, expect: 'Some other name' },
      { table: 'services', id: realSvc, expect: `Real ${RUN}` },
      { table: 'customers', id: customer, expect: `real-${RUN}@example.com` },
      { table: 'organizations', id: orgId, expect: `Cleanup Org ${RUN}` },
      { table: 'services', id: 'svc-does-not-exist', expect: 'x' },
    ]);
    expect(plan.map(p => p.problems)).toEqual([
      [`its name is "QA Probe ${RUN}", not "Some other name" as planned`],
      ['it has appointments'],
      ['the customer has appointments'],
      ['it has customers or appointments, so it is not test-only'],
      ['not found'],
    ]);
    // Removing a business's only administrator would lock it; that is allowed only when the business itself goes too.
    const owner = { table: 'users' as const, id: ownerId, expect: `cleanup-${RUN}@example.com` };
    expect(planCleanup(db, [owner])[0].problems).toEqual(["it is the business's last active administrator"]);
    expect(planCleanup(db, [owner, { table: 'organizations', id: orgId, expect: `Cleanup Org ${RUN}` }])[0].problems).toEqual([]);
  });

  it('deletes nothing when any planned record is refused', () => {
    const records: CleanupRecord[] = [
      { table: 'resources', id: room, expect: `QA Room ${RUN}` },
      { table: 'services', id: realSvc, expect: `Real ${RUN}` },
    ];
    expect(() => applyCleanup(db, records)).toThrow(/Nothing was deleted/);
    expect(exists('resources', room)).toBe(true);
    expect(exists('services', realSvc)).toBe(true);
  });

  it('deletes confirmed probe records and removes every reference to them', () => {
    applyCleanup(db, [
      { table: 'booking_pages', id: probePage, expect: `qa-probe-${RUN}` },
      { table: 'services', id: probeSvc, expect: `QA Probe ${RUN}` },
      { table: 'resources', id: room, expect: `QA Room ${RUN}` },
      { table: 'workspaces', id: ws, expect: `QA WS ${RUN}` },
    ]);
    for (const [table, id] of [['booking_pages', probePage], ['services', probeSvc], ['resources', room], ['workspaces', ws]]) expect(exists(table, id)).toBe(false);
    // What stays keeps working, without dangling ids.
    expect(list('booking_pages', 'service_ids', sharedPage)).toEqual([realSvc]);
    expect(list('staff', 'service_ids', staff)).toEqual([realSvc]);
    expect(exists('services', realSvc) && exists('customers', customer)).toBe(true);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
