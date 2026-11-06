// Currency is stored and returned consistently, INR is supported, and amounts are never mixed across currencies.

import request from 'supertest';
import app from '../index';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);
let token = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().split('T')[0]; };
const daysAhead = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };

beforeAll(async () => {
  const r = await signUpAndSignIn(app, {
    name: 'Rupee Owner', email: `inr-${RUN}@example.com`, company: `Rupee Org ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  token = sessionToken(r);
});

describe('business currency', () => {
  it('defaults new organizations to INR (the deployment default)', async () => {
    expect((await request(app).get('/api/settings').set(auth())).body.data.currency).toBe('INR');
  });

  it('accepts INR (case-insensitively) and returns it', async () => {
    expect((await request(app).put('/api/settings').set(auth()).send({ currency: 'inr' })).status).toBe(200);
    expect((await request(app).get('/api/settings').set(auth())).body.data.currency).toBe('INR');
  });

  it('rejects unsupported currency codes', async () => {
    expect((await request(app).put('/api/settings').set(auth()).send({ currency: 'XYZ' })).status).toBe(400);
    expect((await request(app).put('/api/settings').set(auth()).send({ currency: 'rupees' })).status).toBe(400);
  });

  it('lists the supported currencies including INR', async () => {
    expect((await request(app).get('/api/settings/currencies').set(auth())).body.data).toEqual(['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD']);
  });
});

describe('services, appointments, public pages and reports', () => {
  let inrService = '';
  let gbpService = '';
  let staffId = '';
  let customerId = '';

  beforeAll(async () => {
    inrService = (await request(app).post('/api/services').set(auth())
      .send({ name: 'Ayurveda Consult', category: 'consultation', duration: 30, price: 1499.5, maxAdvance: 365 })).body.data.id;
    gbpService = (await request(app).post('/api/services').set(auth())
      .send({ name: 'London Session', category: 'session', duration: 30, price: 40, currency: 'GBP', maxAdvance: 365 })).body.data.id;
    staffId = (await request(app).post('/api/staff').set(auth())
      .send({ name: 'Priya Rao', email: `priya-${RUN}@example.com`, serviceIds: [inrService, gbpService], workingHours: EVERY_DAY })).body.data.id;
    customerId = (await request(app).post('/api/customers').set(auth()).send({ name: 'Arjun', email: `arjun-${RUN}@example.com` })).body.data.id;
  });

  it('new services inherit the business currency; explicit currencies are kept', async () => {
    expect((await request(app).get(`/api/services/${inrService}`).set(auth())).body.data.currency).toBe('INR');
    expect((await request(app).get(`/api/services/${gbpService}`).set(auth())).body.data.currency).toBe('GBP');
    expect((await request(app).post('/api/services').set(auth())
      .send({ name: 'Bad', category: 'other', duration: 30, price: 1, currency: 'DOGE' })).status).toBe(400);
  });

  it('appointments copy the service price and currency', async () => {
    const a = await request(app).post('/api/appointments').set(auth())
      .send({ serviceId: inrService, staffId, customerId, date: daysAhead(5), startTime: '10:00' });
    expect(a.status).toBe(201);
    expect(a.body.data.currency).toBe('INR');
    expect(a.body.data.price).toBe(1499.5);
  });

  it('public booking pages return each service with its currency', async () => {
    const slug = `rupee-${RUN}`;
    await request(app).post('/api/booking-pages').set(auth()).send({ title: 'Rupee page', slug, serviceIds: [inrService], isPublished: true }).expect(201);
    const page = await request(app).get(`/api/public/pages/${slug}`);
    expect(page.body.data.services[0]).toMatchObject({ currency: 'INR', price: 1499.5 });
  });

  it('reports total revenue in the business currency and list other currencies separately', async () => {
    // Completed appointments in the recent past: one INR, one GBP. Created then moved/marked through the API.
    for (const [svc, time] of [[inrService, '11:00'], [gbpService, '12:00']] as const) {
      const a = await request(app).post('/api/appointments').set(auth())
        .send({ serviceId: svc, staffId, customerId, date: daysAhead(6), startTime: time });
      expect(a.status).toBe(201);
      // Past dates cannot be booked, so record history directly on the stored row for the report check.
      const { default: db } = await import('../db/init');
      db.prepare("UPDATE appointments SET date = ?, status = 'completed' WHERE id = ?").run(daysAgo(2), a.body.data.id);
    }
    const summary = (await request(app).get('/api/reports/summary?range=7d').set(auth())).body.data;
    expect(summary.currency).toBe('INR');
    expect(summary.revenue).toBe(1499.5);
    expect(summary.otherCurrencyRevenue).toEqual([{ currency: 'GBP', revenue: 40 }]);
    const byService = (await request(app).get('/api/reports/by-service?range=7d').set(auth())).body.data as Array<{ name: string; currency: string }>;
    expect(byService.find(r => r.name === 'London Session')?.currency).toBe('GBP');
  });
});
