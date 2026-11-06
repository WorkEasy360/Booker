// The services and staff of a workspace (its card counts them). The link is stored on both sides (workspaces.service_ids /
// services.workspace_ids, workspaces.staff_ids / staff.workspace_ids); a link made from either side shows on the
// workspace, both sides stay in sync on every write, removed records are not counted, and businesses never see each
// other's links. Synthetic data in the per-file test database.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
let seq = 0;

async function business(label: string) {
  const res = await signUpAndSignIn(app, { name: `Owner ${label}`, email: `ws-${label}-${RUN}@example.com`, company: `Workspace ${label} ${RUN}`, password: 'StartPass123', timezone: 'Asia/Kolkata' });
  const h = { Authorization: `Bearer ${sessionToken(res)}` };
  const api = (method: 'get' | 'post' | 'put' | 'delete', path: string, body?: unknown) => request(app)[method](`/api${path}`).set(h).send(body as object);
  const service = async (extra: Record<string, unknown> = {}) => (await api('post', '/services', { name: `Svc ${label} ${++seq}`, category: 'consultation', duration: 30, price: 500, ...extra })).body.data.id as string;
  const staff = async (extra: Record<string, unknown> = {}) => (await api('post', '/staff', { name: `Staff ${label} ${++seq}`, email: `ws-staff-${label}-${++seq}-${RUN}@example.com`, ...extra })).body.data.id as string;
  const workspace = async (extra: Record<string, unknown> = {}) => (await api('post', '/workspaces', { name: `Room ${label} ${++seq}`, ...extra })).body.data.id as string;
  const card = async (id: string) => {
    const list = (await api('get', '/workspaces')).body.data as Array<{ id: string; serviceIds: string[]; staffIds: string[] }>;
    const one = list.find(w => w.id === id)!;
    return { services: [...one.serviceIds].sort(), staff: [...one.staffIds].sort() };
  };
  return { api, service, staff, workspace, card };
}
const sorted = (...ids: string[]) => [...ids].sort();
const column = (table: string, id: string, col: string) => JSON.parse((db.prepare(`SELECT ${col} FROM ${table} WHERE id = ?`).get(id) as Record<string, string>)[col]) as string[];

describe('services of a workspace', () => {
  it('a service given a workspace shows on that workspace (the card counted 0) and both sides are stored', async () => {
    const b = await business('svc');
    const ws = await b.workspace();
    const s1 = await b.service({ workspaceIds: [ws] });
    expect((await b.card(ws)).services).toEqual([s1]);
    expect(column('workspaces', ws, 'service_ids')).toEqual([s1]);
    // Detail view agrees with the list.
    expect((await b.api('get', `/workspaces/${ws}`)).body.data.serviceIds).toEqual([s1]);
  });

  it('choosing services on the workspace updates the services, and removing them unlinks both sides', async () => {
    const b = await business('choose');
    const ws = await b.workspace();
    const s1 = await b.service();
    const s2 = await b.service();
    expect((await b.card(ws)).services).toEqual([]);
    expect((await b.api('put', `/workspaces/${ws}`, { serviceIds: [s1, s2] })).status).toBe(200);
    expect((await b.card(ws)).services).toEqual(sorted(s1, s2));
    expect((await b.api('get', `/services/${s1}`)).body.data.workspaceIds).toEqual([ws]);
    await b.api('put', `/workspaces/${ws}`, { serviceIds: [s2] });
    expect((await b.card(ws)).services).toEqual([s2]);
    expect((await b.api('get', `/services/${s1}`)).body.data.workspaceIds).toEqual([]);
    // Changing the service's own workspaces is reflected on the workspace too.
    await b.api('put', `/services/${s2}`, { workspaceIds: [] });
    expect((await b.card(ws)).services).toEqual([]);
    expect(column('workspaces', ws, 'service_ids')).toEqual([]);
  });

  it('a link stored on only one side (older data) still counts; a deleted service does not', async () => {
    const b = await business('legacy');
    const ws = await b.workspace();
    const s1 = await b.service();
    const s2 = await b.service();
    // As older data may be: the service names the workspace, the workspace does not name the service (and vice versa).
    db.prepare('UPDATE services SET workspace_ids = ? WHERE id = ?').run(JSON.stringify([ws]), s1);
    db.prepare('UPDATE workspaces SET service_ids = ? WHERE id = ?').run(JSON.stringify([s2, 'svc-deleted-long-ago']), ws);
    expect((await b.card(ws)).services).toEqual(sorted(s1, s2));
    expect((await b.api('delete', `/services/${s2}`)).status).toBe(200);
    expect((await b.card(ws)).services).toEqual([s1]);
    expect(column('workspaces', ws, 'service_ids')).not.toContain(s2);
  });
});

describe('staff of a workspace', () => {
  it('a staff member given a workspace on the staff form shows on the workspace, and both sides follow later changes', async () => {
    const b = await business('staff');
    const ws = await b.workspace();
    const st = await b.staff({ workspaceIds: [ws] });
    expect((await b.card(ws)).staff).toEqual([st]);
    expect(column('workspaces', ws, 'staff_ids')).toEqual([st]);
    await b.api('put', `/staff/${st}`, { workspaceIds: [] });
    expect((await b.card(ws)).staff).toEqual([]);
    await b.api('put', `/workspaces/${ws}`, { staffIds: [st] });
    expect((await b.api('get', `/staff/${st}`)).body.data.workspaceIds).toEqual([ws]);
  });

  it('deleting a workspace removes it from its services and staff', async () => {
    const b = await business('delete');
    const ws = await b.workspace();
    const s1 = await b.service({ workspaceIds: [ws] });
    const st = await b.staff({ workspaceIds: [ws] });
    expect((await b.api('delete', `/workspaces/${ws}`)).status).toBe(200);
    expect(column('services', s1, 'workspace_ids')).toEqual([]);
    expect(column('staff', st, 'workspace_ids')).toEqual([]);
  });
});

describe('isolation between businesses', () => {
  it('another business can neither link to nor see this business\'s services', async () => {
    const a = await business('iso-a');
    const b = await business('iso-b');
    const wsA = await a.workspace();
    const sA = await a.service({ workspaceIds: [wsA] });
    const wsB = await b.workspace();
    expect((await b.api('put', `/workspaces/${wsB}`, { serviceIds: [sA] })).status).toBe(400);
    expect((await b.api('post', '/services', { name: 'Sneaky', category: 'consultation', duration: 30, price: 1, workspaceIds: [wsA] })).status).toBe(400);
    // Even a stray cross-business id stored by hand is not shown or counted.
    db.prepare('UPDATE workspaces SET service_ids = ? WHERE id = ?').run(JSON.stringify([sA]), wsB);
    expect((await b.card(wsB)).services).toEqual([]);
    expect((await a.card(wsA)).services).toEqual([sA]);
  });
});
