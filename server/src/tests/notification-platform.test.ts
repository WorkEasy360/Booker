// The notification platform end to end, with mock providers only (nothing leaves the machine): one booking fans out to
// the customer (SMS, WhatsApp with consent), the assigned staff member (email, SMS, WhatsApp), business recipients and
// the business calendar; each job is sent once; failures in one channel never stop the others; retries back off and
// stop; unknown outcomes are not resent on their own; calendars are updated and cancelled, never duplicated; provider
// callbacks need valid signatures and only move a status forward; credentials are never returned; each business sees
// only its own; live adapters map provider answers correctly (checked against stand-in HTTP clients).

import request from 'supertest';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import app from '../index';
import db from '../db/init';
import { testOutbox } from '../services/email/notify';
import { processNotificationJobs, attemptJob, recoverInterruptedJobs, backoffMs } from '../services/notifications/worker';
import { mockProviders, setProviderHttp, sendSms, sendWhatsApp, syncCalendar, smsParts, googleEventId, type Http } from '../services/notifications/providers';
import { buildIcs } from '../services/notifications/ics';
import { twilioSignature, whatsappSignature } from '../routes/messaging-webhooks';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(90_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { enabled: true, start: '06:00', end: '22:00' }]));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });
const AUTH_TOKEN = 'a'.repeat(16) + 'b1c2d3e4f5a6b7c8';
const APP_SECRET = 'whatsapp-app-secret-for-tests';
const VERIFY_TOKEN = 'verify-token-for-tests-123';

interface Biz { orgId: string; h: Record<string, string>; serviceId: string; staffA: string; staffB: string; slug: string }

async function business(label: string): Promise<Biz> {
  const s = await signUpAndSignIn(app, { name: `P ${label}`, email: `plat-${label}-${RUN}@example.com`, company: `Platform ${label} ${RUN}`, password: 'StartPass123', timezone: TZ });
  const h = { Authorization: `Bearer ${sessionToken(s)}` };
  const serviceId = (await request(app).post('/api/services').set(h).send({ name: `Massage ${label}`, category: 'session', duration: 30, price: 800, maxAdvance: 365 })).body.data.id;
  const staffA = (await request(app).post('/api/staff').set(h).send({ name: `Meera ${label}`, email: `meera-${label}-${RUN}@example.com`, phone: '+91 98765 41001', serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  const staffB = (await request(app).post('/api/staff').set(h).send({ name: `Kabir ${label}`, email: `kabir-${label}-${RUN}@example.com`, phone: '+91 98765 41002', serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  const slug = await publishBookingPage(app, h, [serviceId], `plat-${label}`);
  return { orgId: s.body.data.user.organization_id, h, serviceId, staffA, staffB, slug };
}

const rules = (b: Biz, list: Array<[string, string, string, boolean]>) =>
  request(app).put('/api/notifications/settings/rules').set(b.h).send({ rules: list.map(([event, role, channel, enabled]) => ({ event, role, channel, enabled })) });
async function connect(b: Biz, channel: 'sms' | 'whatsapp', provider = 'mock', config: Record<string, string> = {}) {
  const put = await request(app).put(`/api/notifications/connections/${channel}`).set(b.h).send({ provider, config });
  expect(put.status).toBe(200);
  const v = await request(app).post(`/api/notifications/connections/${channel}/verify`).set(b.h);
  expect(v.body.data.status).toBe('connected');
}
let n = 0;
const publicBook = (b: Biz, startTime: string, opts: { phone?: string; consent?: { sms?: boolean; whatsapp?: boolean }; staffId?: string; date?: string } = {}) =>
  request(app).post('/api/public/book').send({
    pageSlug: b.slug, serviceId: b.serviceId, staffId: opts.staffId ?? b.staffA, date: opts.date ?? day(10), startTime,
    customer: { name: 'Riya Sen', email: `riya-${++n}-${RUN}@example.com`, phone: opts.phone ?? '+91 98765 42001' }, consent: opts.consent,
  });
const jobs = (apptId: string) => db.prepare('SELECT * FROM notification_jobs WHERE appointment_id = ? ORDER BY created_at, rowid').all(apptId) as Array<Record<string, any>>;
const summary = (rows: Array<Record<string, any>>) => rows.map(j => `${j.event}:${j.recipient_role}:${j.channel}:${j.status}`);

let A: Biz;
let B: Biz;
beforeAll(async () => {
  process.env.PUBLIC_API_URL = 'https://api.example.test';
  A = await business('a');
  B = await business('b');
});
beforeEach(() => { testOutbox.clear(); mockProviders.reset(); });
afterAll(() => { delete process.env.PUBLIC_API_URL; setProviderHttp(null); });

describe('fan-out after a confirmed booking', () => {
  it('customer SMS and WhatsApp (with consent), staff email/SMS/WhatsApp, a business recipient and the business calendar: each once', async () => {
    await connect(A, 'sms'); await connect(A, 'whatsapp');
    await rules(A, [['confirmed', 'customer', 'sms', true], ['confirmed', 'customer', 'whatsapp', true],
      ['confirmed', 'staff', 'email', true], ['confirmed', 'staff', 'sms', true], ['confirmed', 'staff', 'whatsapp', true]]);
    await request(app).put(`/api/notifications/staff/${A.staffA}`).set(A.h).send({ channels: ['email', 'sms', 'whatsapp'], events: ['confirmed', 'rescheduled', 'cancelled'] });
    const rec = await request(app).post('/api/notifications/recipients').set(A.h).send({ name: 'Front desk', email: `desk-${RUN}@example.com`, phone: '+91 98765 43001', channels: ['email', 'sms'], events: ['confirmed'] });
    expect(rec.status).toBe(201);
    await request(app).post('/api/notifications/calendars/google/mock-connect').set(A.h);
    expect((await request(app).put('/api/notifications/settings/schedule').set(A.h).send({ businessCalendar: 'google', inviteStaffToCalendar: true })).status).toBe(200);

    const page = await request(app).get(`/api/public/pages/${A.slug}`);
    expect(page.body.data.messaging).toEqual({ sms: true, whatsapp: true });
    const booked = await publicBook(A, '09:00', { consent: { sms: true, whatsapp: true } });
    expect(booked.status).toBe(201);
    const id = booked.body.data.appointmentId;
    expect(booked.body.data.email.status).toBe('sent'); // the customer's booking email went at once (outbox)
    expect(booked.body.data.messages).toEqual({ sms: 'queued', whatsapp: 'queued' }); // will be sent, not "sent"

    expect(summary(jobs(id))).toEqual([
      'confirmed:customer:sms:pending', 'confirmed:customer:whatsapp:pending',
      'confirmed:staff:email:pending', 'confirmed:staff:sms:pending', 'confirmed:staff:whatsapp:pending',
      'confirmed:business:email:pending', 'confirmed:business:sms:pending', 'confirmed:business_calendar:google_calendar:pending',
    ]);
    await processNotificationJobs();
    expect(jobs(id).every(j => j.status === 'sent')).toBe(true);
    await processNotificationJobs();
    expect(mockProviders.sms.map(m => m.to).sort()).toEqual(['+919876541001', '+919876542001', '+919876543001']);
    expect(mockProviders.whatsapp.map(m => [m.to, m.template])).toEqual([['+919876542001', 'we360_booking_confirmed'], ['+919876541001', 'we360_team_booking_new']]);
    const customerSms = mockProviders.sms.find(m => m.to === '+919876542001')!;
    expect(customerSms.body).toContain(booked.body.data.bookingRef);
    expect(customerSms.body).not.toContain('98765 41001'); // never the staff member's number
    expect(mockProviders.whatsapp[0].params).toEqual(['Riya Sen', `Massage a`, expect.any(String), '9:00 AM', `Platform a ${RUN}`, booked.body.data.bookingRef]);
    expect(testOutbox.messages.filter(m => m.to === `meera-a-${RUN}@example.com`)).toHaveLength(1);
    expect(testOutbox.messages.filter(m => m.to === `desk-${RUN}@example.com`)).toHaveLength(1);
    const event = [...mockProviders.calendar.values()][0];
    expect(event).toMatchObject({ provider: 'google', status: 'confirmed', attendees: [`meera-a-${RUN}@example.com`], revisions: 1, id: googleEventId(A.orgId, id) });
    // The customer's own booking email carries the calendar file.
    const customerMail = testOutbox.messages.find(m => m.subject.startsWith('Booking confirmed'))!;
    expect(customerMail.attachments?.[0].content).toMatch(/BEGIN:VEVENT[\s\S]*UID:/);
  });

  it('a booking still succeeds and shows confirmed when every provider is down; delivery status says what happened', async () => {
    mockProviders.failNext('sms', 'permanent');
    mockProviders.failNext('whatsapp', 'transient');
    mockProviders.failNext('calendar', 'timeout');
    testOutbox.failNextSends(1, 'transient'); // the customer email's first attempt
    const booked = await publicBook(A, '10:00', { consent: { sms: true, whatsapp: true } });
    expect(booked.status).toBe(201);
    expect(booked.body.data.email.status).toBe('retrying');
    await processNotificationJobs();
    const by = Object.fromEntries(jobs(booked.body.data.appointmentId).map(j => [`${j.recipient_role}:${j.channel}`, j.status]));
    expect(by['customer:sms']).toBe('failed');
    expect(by['customer:whatsapp']).toBe('pending');      // retried later
    expect(by['business_calendar:google_calendar']).toBe('unknown'); // may have been created: not repeated on its own
    expect(by['staff:email']).toBe('sent');                // other channels went ahead
    expect(by['staff:sms']).toBe('sent');
    const row = (await request(app).get(`/api/appointments/${booked.body.data.appointmentId}`).set(A.h)).body.data;
    expect(row.status).toBe('scheduled');
  });
});

describe('consent, contact details and providers', () => {
  it('no consent, opted out, missing or invalid number: recorded as skipped with the reason; no provider: not configured', async () => {
    const none = await publicBook(A, '11:00');
    expect(none.body.data.messages).toEqual({}); // nothing to report for channels the customer did not agree to
    await processNotificationJobs();
    const skipped = jobs(none.body.data.appointmentId).filter(j => j.recipient_role === 'customer');
    expect(skipped.map(j => [j.channel, j.status, j.reason])).toEqual([
      ['sms', 'skipped', 'The customer has not agreed to text messages'], ['whatsapp', 'skipped', 'The customer has not agreed to WhatsApp messages'],
    ]);
    await request(app).put('/api/settings').set(A.h).send({ bookingRules: { requirePhone: false } });
    try {
      const noPhone = await publicBook(A, '11:30', { phone: '', consent: { sms: true } });
      expect(noPhone.status).toBe(201);
      expect(jobs(noPhone.body.data.appointmentId).find(j => j.recipient_role === 'customer' && j.channel === 'sms')?.reason).toBe('The customer has no phone number');
    } finally {
      await request(app).put('/api/settings').set(A.h).send({ bookingRules: { requirePhone: true } });
    }
    await rules(B, [['confirmed', 'customer', 'sms', true]]);
    // Switched on but no verified provider: the form does not ask, and a booking that agrees anyway is told "not sent".
    expect((await request(app).get(`/api/public/pages/${B.slug}`)).body.data.messaging).toEqual({ sms: false, whatsapp: false });
    const unconfigured = await publicBook(B, '09:00', { consent: { sms: true } });
    expect(unconfigured.body.data.messages).toEqual({ sms: 'not_sent' });
    await processNotificationJobs();
    const sms = jobs(unconfigured.body.data.appointmentId).find(j => j.channel === 'sms')!;
    expect([sms.status, sms.last_error]).toEqual(['not_configured', 'Text messages (SMS) are not set up for this business']);
    expect(mockProviders.sms.filter(m => m.orgId === B.orgId)).toHaveLength(0); // business B has no SMS provider
  });

  it('consent given on the booking form is recorded; unticking it later withdraws it; staff can record it too', async () => {
    const first = await publicBook(A, '12:00', { consent: { sms: true } });
    const customerId = (db.prepare('SELECT customer_id FROM appointments WHERE id = ?').get(first.body.data.appointmentId) as { customer_id: string }).customer_id;
    expect((await request(app).get(`/api/notifications/customers/${customerId}/consent`).set(A.h)).body.data.sms).toMatchObject({ status: 'granted', source: 'booking_page' });
    const staffSet = await request(app).put(`/api/notifications/customers/${customerId}/consent`).set(A.h).send({ whatsapp: 'granted' });
    expect(staffSet.body.data.whatsapp).toMatchObject({ status: 'granted', source: 'staff' });
    expect((await request(app).get(`/api/notifications/customers/${customerId}/consent`).set(B.h)).status).toBe(404);
  });
});

describe('failure handling', () => {
  it('temporary failures back off exponentially and stop after the limit; a timeout is "unknown" and only an admin retries it', async () => {
    await rules(A, [['confirmed', 'staff', 'sms', true]]);
    await request(app).put(`/api/notifications/staff/${A.staffA}`).set(A.h).send({ channels: ['sms'], events: ['confirmed'] });
    try {
    await processNotificationJobs(); // nothing else waiting uses up the failures below
    mockProviders.reset();
    const booked = await publicBook(A, '13:00');
    const job = () => jobs(booked.body.data.appointmentId).find(j => j.recipient_role === 'staff' && j.channel === 'sms')!;
    db.prepare('UPDATE notification_jobs SET max_attempts = 3 WHERE id = ?').run(job().id);
    mockProviders.failNext('sms', 'transient', 'transient', 'transient');
    let t = Date.now();
    await attemptJob(job().id, t);
    expect([job().status, job().attempts]).toEqual(['pending', 1]);
    expect(Date.parse(job().next_attempt_at) - t).toBeGreaterThanOrEqual(backoffMs(1) - 50);
    expect(await attemptJob(job().id, t + 1000)).toBe('not-claimed'); // not before its time
    t += backoffMs(1) + 1000; await attemptJob(job().id, t);
    expect(Date.parse(job().next_attempt_at) - t).toBeGreaterThanOrEqual(backoffMs(2) - 50); // doubled
    t += backoffMs(2) + 1000; await attemptJob(job().id, t);
    expect([job().status, job().attempts]).toEqual(['failed', 3]);
    expect(mockProviders.sms.filter(m => m.to === '+919876541001')).toHaveLength(0);
    expect(job().last_error).toMatch(/^Gave up after 3 attempts/);
    expect(backoffMs(2)).toBe(2 * backoffMs(1));

    await processNotificationJobs(); // the rest of that booking's messages
    const other = await publicBook(A, '13:30');
    const j2 = () => jobs(other.body.data.appointmentId).find(j => j.recipient_role === 'staff' && j.channel === 'sms')!;
    mockProviders.failNext('sms', 'timeout');
    await attemptJob(j2().id);
    expect(j2().status).toBe('unknown');
    await processNotificationJobs(Date.now() + 86_400_000);
    expect(j2().status).toBe('unknown'); // never retried on its own
    const retry = await request(app).post(`/api/notifications/jobs/${j2().id}/retry`).set(A.h);
    expect(retry.status).toBe(200);
    await processNotificationJobs();
    expect(j2().status).toBe('sent');
    expect((await request(app).post(`/api/notifications/jobs/${j2().id}/retry`).set(A.h)).status).toBe(409); // a sent message is not resent
    expect(db.prepare('SELECT outcome FROM notification_attempts WHERE job_id = ? ORDER BY attempt').pluck().all(j2().id)).toEqual(['unknown', 'sent']);
    } finally {
      await request(app).put(`/api/notifications/staff/${A.staffA}`).set(A.h).send({ channels: ['email'], events: ['confirmed', 'rescheduled', 'cancelled', 'reminder'] });
    }
  });

  it('two workers at once send each message once; a job cut off by a restart is "unknown"', async () => {
    const booked = await publicBook(A, '14:00', { consent: { sms: true, whatsapp: true } });
    await Promise.all([processNotificationJobs(), processNotificationJobs(), processNotificationJobs()]);
    const id = booked.body.data.appointmentId;
    expect(mockProviders.sms.filter(m => m.to === '+919876542001')).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) FROM notification_attempts WHERE job_id IN (SELECT id FROM notification_jobs WHERE appointment_id = ?)").pluck().get(id))
      .toBe(jobs(id).filter(j => j.status !== 'skipped').length);
    const later = await publicBook(A, '14:30', { consent: { sms: true } });
    const sms = jobs(later.body.data.appointmentId).find(j => j.channel === 'sms' && j.recipient_role === 'customer')!;
    db.prepare("UPDATE notification_jobs SET status = 'sending' WHERE id = ?").run(sms.id); // as if the server stopped mid-send
    expect(recoverInterruptedJobs()).toBeGreaterThanOrEqual(1);
    expect(await attemptJob(sms.id)).toBe('not-claimed');
    expect(jobs(later.body.data.appointmentId).find(j => j.id === sms.id)!.status).toBe('unknown');
  });
});

describe('booking lifecycle and calendars', () => {
  it('a move updates the same calendar event; repeated moves never duplicate it; cancelling cancels it', async () => {
    const booked = await publicBook(A, '15:00');
    const id = booked.body.data.appointmentId;
    await processNotificationJobs();
    for (const t of ['15:30', '16:00', '16:30']) {
      expect((await request(app).put(`/api/appointments/${id}`).set(A.h).send({ startTime: t })).status).toBe(200);
      await processNotificationJobs();
    }
    const events = [...mockProviders.calendar.values()].filter(e => e.id === googleEventId(A.orgId, id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ revisions: 4, status: 'confirmed' });
    expect(db.prepare('SELECT COUNT(*) FROM calendar_event_links WHERE appointment_id = ?').pluck().get(id)).toBe(1);
    await request(app).put(`/api/appointments/${id}`).set(A.h).send({ status: 'cancelled' });
    await processNotificationJobs();
    expect(mockProviders.calendar.get(`google:${googleEventId(A.orgId, id)}`)?.status).toBe('cancelled');
    expect(db.prepare('SELECT status FROM calendar_event_links WHERE appointment_id = ?').pluck().get(id)).toBe('cancelled');
  });

  it('moving a booking to another staff member tells the old one it is off their schedule and the new one they have it', async () => {
    await rules(A, [['confirmed', 'staff', 'email', true], ['cancelled', 'staff', 'email', true]]);
    const booked = await publicBook(A, '17:00');
    const id = booked.body.data.appointmentId;
    await processNotificationJobs();
    testOutbox.clear();
    expect((await request(app).put(`/api/appointments/${id}`).set(A.h).send({ staffId: A.staffB })).status).toBe(200);
    await processNotificationJobs();
    expect(testOutbox.messages.filter(m => m.to === `meera-a-${RUN}@example.com`).map(m => m.subject.split(':')[0])).toEqual(['Booking cancelled']);
    expect(testOutbox.messages.filter(m => m.to === `kabir-a-${RUN}@example.com`).map(m => m.subject.split(':')[0])).toEqual(['New booking']);
  });

  it('calendar files are valid: the same UID, a higher SEQUENCE after a move, CANCEL after cancellation; the download needs the manage link', async () => {
    const booked = await publicBook(A, '18:00');
    const token = booked.body.data.manageToken;
    const first = await request(app).get('/api/public/appointments/manage/ics').set('X-Booking-Token', token);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/calendar/);
    const uid = /UID:(.+)\r\n/.exec(first.text)![1];
    const seq1 = Number(/SEQUENCE:(\d+)/.exec(first.text)![1]);
    expect(first.text).toMatch(/^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/);
    expect(first.text).toMatch(/DTSTART:\d{8}T\d{6}Z\r\n/);
    expect(first.text.split('\r\n').every(l => Buffer.byteLength(l) <= 75)).toBe(true);
    await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', token).send({ date: day(10), startTime: '19:00' });
    const moved = (await request(app).get('/api/public/appointments/manage/ics').set('X-Booking-Token', token)).text;
    expect(/UID:(.+)\r\n/.exec(moved)![1]).toBe(uid);
    expect(Number(/SEQUENCE:(\d+)/.exec(moved)![1])).toBeGreaterThan(seq1);
    await request(app).post('/api/public/appointments/manage/cancel').set('X-Booking-Token', token).send({});
    const cancelled = (await request(app).get('/api/public/appointments/manage/ics').set('X-Booking-Token', token)).text;
    expect(cancelled).toMatch(/METHOD:CANCEL/);
    expect(cancelled).toMatch(/STATUS:CANCELLED/);
    expect((await request(app).get('/api/public/appointments/manage/ics')).status).toBe(401);
    // Escaping and folding of long text.
    const ics = buildIcs({ uid: 'x@y', sequence: 1, startMs: 0, endMs: 60_000, summary: 'A, B; C\\D', description: 'line1\nline2 ' + 'é'.repeat(80), cancelled: false });
    expect(ics).toContain('SUMMARY:A\\, B\\; C\\\\D');
    expect(ics.split('\r\n').every(l => Buffer.byteLength(l) <= 75)).toBe(true);
  });
});

describe('provider callbacks', () => {
  it('Twilio: signature required; delivered then a late "failed" keeps delivered; duplicates ignored; STOP withdraws consent', async () => {
    await request(app).put('/api/notifications/connections/sms').set(B.h).send({ provider: 'twilio', config: { accountSid: `AC${'0'.repeat(31)}1`, authToken: AUTH_TOKEN, from: '+15005550006' } });
    await request(app).post('/api/notifications/connections/sms/verify').set(B.h);
    await rules(B, [['confirmed', 'customer', 'sms', true]]);
    const booked = await publicBook(B, '10:00', { consent: { sms: true } });
    await processNotificationJobs();
    const job = jobs(booked.body.data.appointmentId).find(j => j.channel === 'sms')!;
    expect(job.status).toBe('sent');
    const path = `/api/webhooks/messaging/twilio/${B.orgId}/status`;
    const post = (params: Record<string, string>, sig?: string) => request(app).post(path).type('form')
      .set('X-Twilio-Signature', sig ?? twilioSignature(AUTH_TOKEN, `https://api.example.test${path}`, params)).send(params);
    expect((await post({ MessageSid: job.provider_message_id, MessageStatus: 'delivered' }, 'forged')).status).toBe(403);
    expect((await post({ MessageSid: job.provider_message_id, MessageStatus: 'delivered' })).status).toBe(204);
    expect((await post({ MessageSid: job.provider_message_id, MessageStatus: 'delivered' })).status).toBe(204); // duplicate
    await post({ MessageSid: job.provider_message_id, MessageStatus: 'failed', ErrorCode: '30005' });
    const after = jobs(booked.body.data.appointmentId).find(j => j.id === job.id)!;
    expect([after.status, after.delivered_at !== null]).toEqual(['delivered', true]);
    const inboundPath = `/api/webhooks/messaging/twilio/${B.orgId}/inbound`;
    const stop = { From: '+919876542001', Body: 'STOP', MessageSid: `SM${nanoid(10)}` };
    const reply = await request(app).post(inboundPath).type('form').set('X-Twilio-Signature', twilioSignature(AUTH_TOKEN, `https://api.example.test${inboundPath}`, stop)).send(stop);
    expect(reply.status).toBe(200);
    const customerId = (db.prepare('SELECT customer_id FROM appointments WHERE id = ?').get(booked.body.data.appointmentId) as { customer_id: string }).customer_id;
    expect((await request(app).get(`/api/notifications/customers/${customerId}/consent`).set(B.h)).body.data.sms).toMatchObject({ status: 'revoked', source: 'reply_stop' });
  });

  it('WhatsApp: the verification handshake, signed status reports moving forward to "read", duplicates ignored', async () => {
    await request(app).put('/api/notifications/connections/whatsapp').set(B.h).send({ provider: 'whatsapp_cloud', config: { phoneNumberId: '1234567890', accessToken: 'EAAG' + 'x'.repeat(40), appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN } });
    await request(app).post('/api/notifications/connections/whatsapp/verify').set(B.h);
    const hs = await request(app).get(`/api/webhooks/messaging/whatsapp/${B.orgId}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });
    expect([hs.status, hs.text]).toEqual([200, 'abc123']);
    expect((await request(app).get(`/api/webhooks/messaging/whatsapp/${B.orgId}`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' })).status).toBe(403);
    await rules(B, [['confirmed', 'customer', 'whatsapp', true]]);
    const booked = await publicBook(B, '11:00', { consent: { whatsapp: true } });
    await processNotificationJobs();
    const job = jobs(booked.body.data.appointmentId).find(j => j.channel === 'whatsapp')!;
    const report = (status: string) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: job.provider_message_id, status }] } }] }] });
    const send = (raw: string, secret = APP_SECRET) => request(app).post(`/api/webhooks/messaging/whatsapp/${B.orgId}`).set('Content-Type', 'application/json').set('X-Hub-Signature-256', whatsappSignature(secret, raw)).send(raw);
    expect((await send(report('read'), 'wrong-secret')).status).toBe(403);
    await send(report('read'));
    await send(report('delivered')); // arrives late: does not move it back
    await send(report('read'));      // duplicate
    expect(jobs(booked.body.data.appointmentId).find(j => j.id === job.id)!.status).toBe('read');
  });
});

describe('live adapters, against stand-in HTTP clients (nothing reaches a provider)', () => {
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}): ReturnType<Http> =>
    Promise.resolve({ status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });

  it('Twilio: accepted with the message id; 429 retried later; STOP and bad numbers fail; bad credentials flag the connection; a timeout is unknown', async () => {
    const cfg = { accountSid: `AC${'1'.repeat(32)}`, authToken: AUTH_TOKEN, from: '+15005550006' };
    let seen: { url: string; body?: string; headers: Record<string, string> } | null = null;
    setProviderHttp((url, init) => { seen = { url, body: init.body, headers: init.headers }; return answer(201, { sid: 'SM123', status: 'queued' }); });
    expect(await sendSms('twilio', A.orgId, cfg, { to: '+919876500000', body: 'Hi', statusCallbackUrl: 'https://api.example.test/cb' })).toEqual({ kind: 'accepted', id: 'SM123' });
    expect(seen!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`);
    expect(new URLSearchParams(seen!.body).get('StatusCallback')).toBe('https://api.example.test/cb');
    expect(seen!.headers.Authorization).toMatch(/^Basic /);
    setProviderHttp(() => answer(429, { code: 20429 }, { 'retry-after': '30' }));
    expect(await sendSms('twilio', A.orgId, cfg, { to: '+919876500000', body: 'Hi' })).toMatchObject({ kind: 'transient', retryAfterMs: 30_000 });
    setProviderHttp(() => answer(400, { code: 21610 }));
    expect(await sendSms('twilio', A.orgId, cfg, { to: '+919876500000', body: 'Hi' })).toMatchObject({ kind: 'permanent', optedOut: true });
    setProviderHttp(() => answer(400, { code: 21211 }));
    expect(await sendSms('twilio', A.orgId, cfg, { to: '+919876500000', body: 'Hi' })).toMatchObject({ kind: 'permanent', code: '21211' });
    setProviderHttp(() => answer(401, {}));
    expect(await sendSms('twilio', A.orgId, cfg, { to: '+919876500000', body: 'Hi' })).toMatchObject({ kind: 'permanent', connectionProblem: true });
    setProviderHttp(() => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    expect((await sendSms('twilio', A.orgId, cfg, { to: '+919876500000', body: 'Hi' })).kind).toBe('timeout');
  });

  it('WhatsApp: the template request; expired token, missing template and rate limits are told apart', async () => {
    const cfg = { phoneNumberId: '1234567890', accessToken: 'EAAGtoken', appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN };
    let body: any = null;
    setProviderHttp((url, init) => { body = JSON.parse(init.body!); expect(url).toBe('https://graph.facebook.com/v20.0/1234567890/messages'); return answer(200, { messages: [{ id: 'wamid.X' }] }); });
    expect(await sendWhatsApp('whatsapp_cloud', A.orgId, cfg, { to: '+919876500000', template: 'we360_booking_confirmed', language: 'hi', params: ['a', 'b'] })).toEqual({ kind: 'accepted', id: 'wamid.X' });
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919876500000', type: 'template', template: { name: 'we360_booking_confirmed', language: { code: 'hi' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } });
    setProviderHttp(() => answer(401, { error: { code: 190 } }));
    expect(await sendWhatsApp('whatsapp_cloud', A.orgId, cfg, { to: '+1', template: 't', language: 'en', params: [] })).toMatchObject({ kind: 'permanent', connectionProblem: true });
    setProviderHttp(() => answer(400, { error: { code: 132001 } }));
    expect(await sendWhatsApp('whatsapp_cloud', A.orgId, cfg, { to: '+1', template: 't', language: 'en', params: [] })).toMatchObject({ kind: 'permanent', code: '132001' });
    setProviderHttp(() => answer(400, { error: { code: 130429 } }));
    expect((await sendWhatsApp('whatsapp_cloud', A.orgId, cfg, { to: '+1', template: 't', language: 'en', params: [] })).kind).toBe('transient');
  });

  it('Google: our own event id makes creation idempotent (409 → update); Microsoft: a transactionId; both map auth errors', async () => {
    const event = { appointmentId: 'appt-1', summary: 'S', description: 'D', location: '', startUtc: '2026-11-01T04:30:00.000Z', endUtc: '2026-11-01T05:00:00.000Z', attendees: [], cancelled: false, sequence: 1 };
    const calls: string[] = [];
    setProviderHttp((url, init) => { calls.push(`${init.method} ${url}`); return calls.length === 1 ? answer(409, {}) : answer(200, { id: 'x' }); });
    expect(await syncCalendar('google', 'live', A.orgId, 'token', event, null)).toEqual({ kind: 'accepted', id: googleEventId(A.orgId, 'appt-1') });
    expect(calls).toEqual(['POST https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none', `PATCH https://www.googleapis.com/calendar/v3/calendars/primary/events/${googleEventId(A.orgId, 'appt-1')}?sendUpdates=none`]);
    let sent: any = null;
    setProviderHttp((_url, init) => { sent = JSON.parse(init.body!); return answer(201, { id: 'AAMkGraph' }); });
    expect(await syncCalendar('outlook', 'live', A.orgId, 'token', event, null)).toEqual({ kind: 'accepted', id: 'AAMkGraph' });
    expect(sent.transactionId).toBe(`we360-${A.orgId}-appt-1`);
    setProviderHttp(() => answer(401, {}));
    expect(await syncCalendar('outlook', 'live', A.orgId, 'token', event, 'AAMkGraph')).toMatchObject({ kind: 'permanent', connectionProblem: true });
    expect(await syncCalendar('google', 'live', A.orgId, null, event, null)).toMatchObject({ kind: 'permanent', connectionProblem: true });
    setProviderHttp(null);
  });
});

describe('settings, credentials, permissions, isolation, languages', () => {
  it('credentials are stored encrypted and never returned; only the last characters are shown; the mock is refused outside development', async () => {
    const token = 'c'.repeat(28) + 'd9e8';
    await request(app).put('/api/notifications/connections/sms').set(A.h).send({ provider: 'twilio', config: { accountSid: `AC${'2'.repeat(32)}`, authToken: token, from: '+15005550006' } });
    const settings = await request(app).get('/api/notifications/settings').set(A.h);
    expect(JSON.stringify(settings.body)).not.toContain(token);
    expect(settings.body.data.connections.sms).toMatchObject({ status: 'configured_unverified', provider: 'twilio', mock: true, hints: { authToken: '…d9e8' } });
    expect(JSON.stringify(db.prepare('SELECT * FROM messaging_connections WHERE organization_id = ?').all(A.orgId))).not.toContain(token);
    const bad = await request(app).put('/api/notifications/connections/sms').set(A.h).send({ provider: 'twilio', config: { accountSid: 'nope', authToken: token } });
    expect(bad.status).toBe(400);
    process.env.NOTIFICATIONS_PROVIDER_MODE = 'live';
    try {
      expect((await request(app).put('/api/notifications/connections/sms').set(A.h).send({ provider: 'mock' })).status).toBe(400);
    } finally {
      delete process.env.NOTIFICATIONS_PROVIDER_MODE;
    }
    await connect(A, 'sms');
  });

  it('only people who can change business settings manage notifications; managers may retry; each business sees only its own', async () => {
    const email = `mgr-${nanoid(5)}-${RUN}@example.com`.toLowerCase();
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)').run(`user-${nanoid(8)}`, A.orgId, email, bcrypt.hashSync('TestPass123', 4), 'Mgr', 'manager');
    const mgr = { Authorization: `Bearer ${sessionToken(await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' }))}` };
    expect((await rules({ ...A, h: mgr }, [['confirmed', 'customer', 'sms', true]])).status).toBe(403);
    expect((await request(app).put('/api/notifications/connections/whatsapp').set(mgr).send({ provider: 'mock' })).status).toBe(403);
    expect((await request(app).get('/api/notifications/recipients').set(mgr)).status).toBe(403);
    const booked = await publicBook(A, '20:00');
    const id = booked.body.data.appointmentId;
    expect((await request(app).get(`/api/notifications/appointments/${id}`).set(mgr)).status).toBe(200);
    expect((await request(app).get(`/api/notifications/appointments/${id}`).set(B.h)).status).toBe(404);
    const anyJob = jobs(id)[0];
    expect((await request(app).post(`/api/notifications/jobs/${anyJob.id}/retry`).set(B.h)).status).toBe(404);
    expect((await request(app).get('/api/notifications/settings')).status).toBe(401);
  });

  it('business recipients and staff preferences are validated', async () => {
    expect((await request(app).post('/api/notifications/recipients').set(A.h).send({ name: 'X', channels: ['sms'], events: ['confirmed'] })).body.error).toMatch(/phone number is needed/);
    expect((await request(app).post('/api/notifications/recipients').set(A.h).send({ name: 'X', email: 'bad', channels: ['email'], events: ['confirmed'] })).status).toBe(400);
    expect((await request(app).post('/api/notifications/recipients').set(A.h).send({ name: 'X', phone: '12', channels: ['sms'], events: ['confirmed'] })).body.error).toMatch(/valid phone/);
    expect((await request(app).put(`/api/notifications/staff/${A.staffA}`).set(B.h).send({ channels: ['email'], events: [] })).status).toBe(404);
    expect((await request(app).put('/api/notifications/settings/schedule').set(A.h).send({ reminderOffsets: [5] })).status).toBe(400);
    expect((await request(app).put('/api/notifications/settings/schedule').set(B.h).send({ businessCalendar: 'outlook' })).status).toBe(409); // not connected
  });

  it('a Hindi-speaking business sends Hindi text messages (counted in 70-character parts) and Hindi WhatsApp templates', async () => {
    await request(app).put('/api/settings/notifications').set(A.h).send({ bookingLanguage: 'hi' });
    try {
      await rules(A, [['confirmed', 'customer', 'sms', true], ['confirmed', 'customer', 'whatsapp', true]]);
      await connect(A, 'whatsapp');
      const booked = await publicBook(A, '21:00', { consent: { sms: true, whatsapp: true } });
      await processNotificationJobs();
      const sms = mockProviders.sms.find(m => m.body.includes(booked.body.data.bookingRef))!;
      expect(sms.body).toMatch(/पक्की है/);
      expect(sms.body).toMatch(/STOP/);
      expect(smsParts(sms.body)).toMatchObject({ encoding: 'UCS-2' });
      expect(smsParts(sms.body).parts).toBeLessThanOrEqual(6);
      expect(mockProviders.whatsapp.find(m => m.params.includes(booked.body.data.bookingRef))!.language).toBe('hi');
      expect(smsParts('a'.repeat(160))).toEqual({ encoding: 'GSM-7', parts: 1, length: 160 });
      expect(smsParts('a'.repeat(161)).parts).toBe(2);
    } finally {
      await request(app).put('/api/settings/notifications').set(A.h).send({ bookingLanguage: 'en' });
    }
  });
});

describe('the earlier notification settings and the rules', () => {
  it('always agree, whichever is saved', async () => {
    const view = async () => (await request(app).get('/api/notifications/settings').set(B.h)).body.data as { rules: Array<{ event: string; role: string; channel: string; enabled: boolean }>; reminderOffsets: number[] };
    const rule = (v: Awaited<ReturnType<typeof view>>, event: string, role: string) => v.rules.find(r => r.event === event && r.role === role && r.channel === 'email')!.enabled;
    await request(app).put('/api/settings/notifications').set(B.h).send({ remindersEnabled: true, reminderHoursBefore: 6, staffAlertsEnabled: true });
    let v = await view();
    expect([rule(v, 'reminder', 'customer'), rule(v, 'confirmed', 'staff'), rule(v, 'rescheduled', 'staff'), rule(v, 'cancelled', 'staff'), v.reminderOffsets]).toEqual([true, true, true, true, [360]]);
    await rules(B, [['reminder', 'customer', 'email', false], ['confirmed', 'staff', 'email', false], ['rescheduled', 'staff', 'email', false], ['cancelled', 'staff', 'email', false]]);
    expect((await request(app).get('/api/settings/notifications').set(B.h)).body.data).toMatchObject({ remindersEnabled: false, staffAlertsEnabled: false });
    v = await view();
    expect(rule(v, 'reminder', 'customer')).toBe(false);
    expect(rule(v, 'confirmed', 'customer')).toBe(true); // the customer's booking emails cannot be switched off
    expect((await rules(B, [['confirmed', 'customer', 'email', false]])).body.data.find((r: { event: string; role: string; channel: string }) => r.event === 'confirmed' && r.role === 'customer' && r.channel === 'email')).toMatchObject({ enabled: true, locked: true });
  });
});

describe('running live', () => {
  it('a calendar connected only to the development stand-in is never called; the job says why', async () => {
    const calls: string[] = [];
    setProviderHttp(url => { calls.push(url); return Promise.reject(new Error('no network in tests')); });
    process.env.NOTIFICATIONS_PROVIDER_MODE = 'live';
    try {
      const booked = await publicBook(A, '20:30');
      const job = () => jobs(booked.body.data.appointmentId).find(j => j.channel === 'google_calendar')!;
      expect(job()).toBeDefined();
      await attemptJob(job().id);
      expect([job().status, job().last_error]).toEqual(['not_configured', 'Google Calendar: only the development stand-in is connected']);
      expect(calls).toEqual([]);
    } finally {
      delete process.env.NOTIFICATIONS_PROVIDER_MODE;
      setProviderHttp(null);
    }
  });

  it('a channel set up only with the development stand-in is not offered to customers and nothing is promised', async () => {
    await connect(A, 'sms');
    await rules(A, [['confirmed', 'customer', 'sms', true]]);
    expect((await request(app).get(`/api/public/pages/${A.slug}`)).body.data.messaging.sms).toBe(true);
    process.env.NOTIFICATIONS_PROVIDER_MODE = 'live';
    try {
      expect((await request(app).get(`/api/public/pages/${A.slug}`)).body.data.messaging.sms).toBe(false);
      const booked = await publicBook(A, '21:30', { consent: { sms: true } });
      expect(booked.status).toBe(201);
      expect(booked.body.data.messages).toEqual({ sms: 'not_sent' });
    } finally {
      delete process.env.NOTIFICATIONS_PROVIDER_MODE;
    }
  });
});
