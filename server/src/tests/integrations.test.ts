// Outgoing webhooks (and Zapier) against a local receiver on 127.0.0.1, and connecting accounts with OAuth against a
// stand-in token endpoint. Nothing reaches the internet. Covers: signed deliveries, the event queued in the same
// transaction as the change, retries, 410 turning an endpoint off, private-network addresses refused, secrets shown once
// and stored encrypted, revocation, business isolation, OAuth state/PKCE/scopes, encrypted tokens, disconnect.

import request from 'supertest';
import http from 'http';
import { createHash, createHmac } from 'crypto';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { processWebhookDeliveries, isPrivateAddress, endpointUrlProblem, RETRY_DELAYS_MS } from '../services/integrations/webhooks';
import { setOAuthHttpClient, readState } from '../services/integrations/oauth';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]));
const date = (() => { const d = new Date(); d.setDate(d.getDate() + 20); return d.toISOString().slice(0, 10); })();

interface Received { headers: http.IncomingHttpHeaders; body: string }
const received: Received[] = [];
let reply = 200;
let receiver: http.Server;
let base = '';

interface Biz { orgId: string; userId: string; h: Record<string, string>; serviceId: string; staffId: string; customerId: string }
async function business(label: string): Promise<Biz> {
  const s = await signUpAndSignIn(app, { name: `Int ${label}`, email: `int-${label}-${RUN}@example.com`, company: `Integrations ${label} ${RUN}`, password: 'StartPass123' });
  const h = { Authorization: `Bearer ${sessionToken(s)}` };
  const serviceId = (await request(app).post('/api/services').set(h).send({ name: `Hook Svc ${label}`, category: 'consultation', duration: 30, price: 0, maxAdvance: 365 })).body.data.id;
  const staffId = (await request(app).post('/api/staff').set(h).send({ name: `Hook Staff ${label}`, email: `hs-${label}-${RUN}@example.com`, serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  const customerId = (await request(app).post('/api/customers').set(h).send({ name: `Hook Cust ${label}`, email: `hc-${label}-${RUN}@example.com` })).body.data.id;
  return { orgId: s.body.data.user.organization_id, userId: s.body.data.user.id, h, serviceId, staffId, customerId };
}
const book = (b: Biz, startTime: string) => request(app).post('/api/appointments').set(b.h).send({ serviceId: b.serviceId, staffId: b.staffId, customerId: b.customerId, date, startTime });
const addHook = (b: Biz, events: string[], path = '/hook') => request(app).post('/api/integrations/webhooks').set(b.h).send({ url: `${base}${path}`, events, description: 'test receiver' });

let A: Biz;
let B: Biz;
beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = reply; res.end('ok'); });
  });
  await new Promise<void>(r => receiver.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`;
  process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK = '1';
  A = await business('a');
  B = await business('b');
});
afterAll(async () => {
  delete process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK;
  await new Promise<void>(r => receiver.close(() => r()));
});
beforeEach(() => { received.length = 0; reply = 200; });

describe('webhook addresses', () => {
  it('format rules: https in production, no credentials or fragments; private networks recognised', () => {
    expect(endpointUrlProblem('https://hooks.zapier.com/hooks/catch/1/abc/', true)).toBeNull();
    expect(endpointUrlProblem('http://example.com/hook', true)).toMatch(/https/);
    expect(endpointUrlProblem('https://user:pw@example.com/hook', true)).toMatch(/user name/);
    expect(endpointUrlProblem('https://example.com/hook#x', true)).toMatch(/fragment/);
    expect(endpointUrlProblem('not a url', true)).toMatch(/full address/);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });

  it('the signing secret is shown once and stored only encrypted; other businesses cannot see or remove it', async () => {
    const created = await addHook(A, ['appointment.created']);
    expect(created.status).toBe(201);
    const { secret, endpoint } = created.body.data;
    expect(secret).toMatch(/^whsec_/);
    const list = await request(app).get('/api/integrations/webhooks').set(A.h);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(JSON.stringify(db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(endpoint.id))).not.toContain(secret);
    expect((await request(app).get('/api/integrations/webhooks').set(B.h)).body.data.endpoints).toEqual([]);
    expect((await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(B.h)).status).toBe(404);
    expect((await request(app).get(`/api/integrations/webhooks/${endpoint.id}/deliveries`).set(B.h)).status).toBe(404);
    expect((await request(app).post('/api/integrations/webhooks').set(A.h).send({ url: `${base}/x`, events: ['appointment.exploded'] })).status).toBe(400);
    await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(A.h);
  });

  it('only people who can change business settings manage webhooks', async () => {
    const email = `staff-${nanoid(5)}-${RUN}@example.com`.toLowerCase();
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`user-${nanoid(8)}`, A.orgId, email, bcrypt.hashSync('TestPass123', 4), 'Manager', 'manager');
    const manager = { Authorization: `Bearer ${sessionToken(await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' }))}` };
    expect((await request(app).get('/api/integrations/webhooks').set(manager)).status).toBe(403);
    expect((await request(app).post('/api/integrations/webhooks').set(manager).send({ url: `${base}/x`, events: ['appointment.created'] })).status).toBe(403);
    expect((await request(app).get('/api/integrations/status').set(manager)).status).toBe(200);
  });
});

describe('deliveries', () => {
  it('a booking change is delivered, signed, with the booking and what changed; only subscribed events', async () => {
    const { secret, endpoint } = (await addHook(A, ['appointment.created', 'appointment.rescheduled'])).body.data;
    try {
      const booked = await book(A, '10:00');
      await request(app).put(`/api/appointments/${booked.body.data.id}`).set(A.h).send({ status: 'confirmed' }); // not subscribed
      await request(app).put(`/api/appointments/${booked.body.data.id}`).set(A.h).send({ startTime: '11:00' });
      await processWebhookDeliveries();
      expect(received.map(r => r.headers['x-workeasy360-event'])).toEqual(['appointment.created', 'appointment.rescheduled']);
      for (const r of received) {
        const [t, v1] = String(r.headers['x-workeasy360-signature']).split(',').map(p => p.split('=')[1]);
        expect(v1).toBe(createHmac('sha256', secret).update(`${t}.${r.body}`).digest('hex'));
        expect(r.headers['content-type']).toBe('application/json');
      }
      const created = JSON.parse(received[0].body);
      expect(created).toMatchObject({ type: 'appointment.created', data: { appointment: { id: booked.body.data.id, bookingRef: booked.body.data.bookingRef, customer: { name: 'Hook Cust a' } }, actor: { type: 'user', source: 'dashboard' } } });
      expect(JSON.parse(received[1].body).data.change).toMatchObject({ action: 'rescheduled', from: { startTime: '10:00' }, to: { startTime: '11:00' } });
      await processWebhookDeliveries();
      expect(received).toHaveLength(2); // nothing twice
      const log = (await request(app).get(`/api/integrations/webhooks/${endpoint.id}/deliveries`).set(A.h)).body.data;
      expect(log.map((d: { status: string; responseStatus: number }) => [d.status, d.responseStatus])).toEqual([['sent', 200], ['sent', 200]]);
    } finally {
      await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(A.h);
    }
  });

  it('the event is part of the change: if queuing it fails, the change is rolled back', async () => {
    const { endpoint } = (await addHook(A, ['appointment.status_changed'])).body.data;
    const booked = await book(A, '13:00');
    db.exec(`CREATE TEMP TRIGGER fail_hook BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'simulated'); END`);
    try {
      expect((await request(app).put(`/api/appointments/${booked.body.data.id}`).set(A.h).send({ status: 'confirmed' })).status).toBe(500);
    } finally {
      db.exec('DROP TRIGGER temp.fail_hook');
      await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(A.h);
    }
    expect((db.prepare('SELECT status FROM appointments WHERE id = ?').get(booked.body.data.id) as { status: string }).status).toBe('scheduled');
  });

  it('a failing receiver is retried later; 410 Gone turns the endpoint off; deleting it drops what is pending', async () => {
    const { endpoint } = (await addHook(A, ['appointment.created'])).body.data;
    reply = 500;
    await book(A, '15:00');
    await processWebhookDeliveries();
    let row = db.prepare('SELECT status, attempts, response_status FROM webhook_deliveries WHERE endpoint_id = ?').get(endpoint.id) as { status: string; attempts: number; response_status: number };
    expect([row.status, row.attempts, row.response_status]).toEqual(['pending', 1, 500]);
    reply = 200;
    await processWebhookDeliveries(Date.now() + RETRY_DELAYS_MS[0] + 1000);
    row = db.prepare('SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id = ?').get(endpoint.id) as typeof row;
    expect([row.status, row.attempts]).toEqual(['sent', 2]);

    reply = 410;
    await book(A, '16:00');
    await processWebhookDeliveries();
    expect((db.prepare('SELECT is_active FROM webhook_endpoints WHERE id = ?').get(endpoint.id) as { is_active: number }).is_active).toBe(0);

    reply = 500;
    const { endpoint: second } = (await addHook(A, ['appointment.created'])).body.data;
    await book(A, '17:00');
    expect((await request(app).delete(`/api/integrations/webhooks/${second.id}`).set(A.h)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM webhook_deliveries WHERE endpoint_id = ?').get(second.id)).toEqual({ c: 0 });
    await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(A.h);
  });

  it('addresses on a private network are refused when sending (outside local testing)', async () => {
    const { endpoint } = (await addHook(A, ['appointment.created'])).body.data;
    delete process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK;
    try {
      const test = await request(app).post(`/api/integrations/webhooks/${endpoint.id}/test`).set(A.h);
      expect(test.body.data).toMatchObject({ status: 'failed', error: 'The address is on a private network and cannot receive webhooks' });
      expect(received).toHaveLength(0);
    } finally {
      process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK = '1';
      await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(A.h);
    }
  });

  it('one business\'s bookings never reach another business\'s webhooks; the test button sends a ping', async () => {
    const { endpoint } = (await addHook(B, ['appointment.created'])).body.data;
    try {
      await book(A, '18:00');
      await processWebhookDeliveries();
      expect(received).toHaveLength(0);
      const ping = await request(app).post(`/api/integrations/webhooks/${endpoint.id}/test`).set(B.h);
      expect(ping.body.data).toMatchObject({ eventType: 'ping', status: 'sent', responseStatus: 200 });
      expect(received.map(r => r.headers['x-workeasy360-event'])).toEqual(['ping']);
    } finally {
      await request(app).delete(`/api/integrations/webhooks/${endpoint.id}`).set(B.h);
    }
  });
});

describe('connected accounts (OAuth)', () => {
  afterEach(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; setOAuthHttpClient(null); });

  it('without client credentials nothing can be connected, and status says so', async () => {
    const res = await request(app).get('/api/integrations/google/connect').set(A.h);
    expect([res.status, res.body.code]).toEqual([503, 'INTEGRATION_NOT_CONFIGURED']);
    const status = (await request(app).get('/api/integrations/status').set(A.h)).body.data;
    expect(status.accounts.google).toMatchObject({ configured: false, connected: false, scopes: ['https://www.googleapis.com/auth/calendar.events'] });
    expect(status.payments).toEqual({ stripe: false, razorpay: false, paypal: false });
    expect(status.sms).toEqual({ twilio: false });
  });

  it('connect: least scope, PKCE and an encrypted state for this user; tokens stored encrypted; disconnect revokes', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-client'; process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
    const calls: Array<{ url: string; body: string }> = [];
    setOAuthHttpClient(async (url, init) => {
      calls.push({ url, body: init.body });
      return url.includes('/token')
        ? { status: 200, json: async () => ({ access_token: 'ya29.ACCESS-SECRET', refresh_token: '1//REFRESH-SECRET', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.events' }) }
        : { status: 200, json: async () => ({}) };
    });
    const url = new URL((await request(app).get('/api/integrations/google/connect').set(A.h)).body.data.url);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    const s = readState('google', state)!;
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(s.verifier).digest('base64url'));
    expect(state).not.toContain(s.verifier);

    // Another user, another business, an altered state or another provider: refused.
    expect((await request(app).get(`/api/integrations/google/callback?code=c&state=${encodeURIComponent(state)}`).set(B.h)).status).toBe(400);
    expect((await request(app).get(`/api/integrations/google/callback?code=c&state=${encodeURIComponent(state.slice(0, -2) + 'xx')}`).set(A.h)).status).toBe(400);
    expect(readState('zoom', state)).toBeNull();
    expect(readState('google', state, Date.now() + 11 * 60_000)).toBeNull();

    const cb = await request(app).get(`/api/integrations/google/callback?code=the-code&state=${encodeURIComponent(state)}`).set(A.h);
    expect([cb.status, cb.headers.location]).toEqual([302, 'http://localhost:5173/integrations?connected=google']);
    expect(calls[0].body).toContain(`code_verifier=${s.verifier}`);
    const row = JSON.stringify(db.prepare("SELECT * FROM integration_connections WHERE organization_id = ? AND provider = 'google'").get(A.orgId));
    expect(row).not.toContain('ACCESS-SECRET');
    expect(row).not.toContain('REFRESH-SECRET');
    expect((await request(app).get('/api/integrations/status').set(A.h)).body.data.accounts.google).toMatchObject({ configured: true, connected: true });
    expect((await request(app).get('/api/integrations/status').set(B.h)).body.data.accounts.google.connected).toBe(false);

    expect((await request(app).delete('/api/integrations/google').set(A.h)).status).toBe(200);
    expect(calls.at(-1)!.url).toBe('https://oauth2.googleapis.com/revoke');
    expect(calls.at(-1)!.body).toContain('REFRESH-SECRET');
    expect(db.prepare("SELECT COUNT(*) c FROM integration_connections WHERE organization_id = ?").get(A.orgId)).toEqual({ c: 0 });
    expect((await request(app).delete('/api/integrations/google').set(A.h)).status).toBe(404);
  });
});
