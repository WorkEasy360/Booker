// Booking email lifecycle. Uses the in-memory transport (jest.setup.js) and a real SMTP round trip
// to an in-process SMTP server; nothing leaves the machine.

import request from 'supertest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'net';
import app from '../index';
import db from '../db/init';
import { initEmail, sendAppointmentEmail, testOutbox, redactError } from '../services/email/notify';
import { readEmailConfig } from '../services/email/config';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]),
);
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173', EMAIL_FROM: 'Test <test@example.com>' };

function daysAhead(n: number): string {
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

let token = '';
let serviceId = '';
let staffId = '';
let customerId = '';
const auth = () => ({ Authorization: `Bearer ${token}` });
const date = daysAhead(9);
const customerEmail = `mail-cust-${RUN}@example.com`;

beforeAll(async () => {
  initEmail(MEMORY_ENV);
  const s = await signUpAndSignIn(app, {
    name: 'Mail Owner', email: `mail-owner-${RUN}@example.com`, company: `Mail Org ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  token = sessionToken(s);
  serviceId = (await request(app).post('/api/services').set(auth())
    .send({ name: 'Tom & Jerry <Deluxe>', category: 'consultation', duration: 45, price: 30, maxAdvance: 365, location: 'Room 4' })).body.data.id;
  staffId = (await request(app).post('/api/staff').set(auth())
    .send({ name: 'Mia Mailer', email: `mia-${RUN}@example.com`, serviceIds: [serviceId], workingHours: EVERY_DAY })).body.data.id;
  customerId = (await request(app).post('/api/customers').set(auth())
    .send({ name: 'Admin Booked', email: `admin-booked-${RUN}@example.com` })).body.data.id;
  await publishBookingPage(app, auth(), [serviceId], 'mail');
});

beforeEach(() => testOutbox.clear());

const book = (startTime: string, email = customerEmail) => request(app).post('/api/public/book').send({
  serviceId, staffId, date, startTime, customer: { name: 'Ola Mail', email, phone: '+91 98765 40100' },
});

describe('public booking lifecycle emails', () => {
  let ref = '';
  let manage = '';

  it('sends a confirmation with reference, service, time, time zone and manage link', async () => {
    const res = await book('10:00');
    expect(res.status).toBe(201);
    expect(res.body.data.email).toEqual({ status: 'sent' });
    ref = res.body.data.bookingRef;
    manage = res.body.data.manageToken;
    expect(testOutbox.messages).toHaveLength(1);
    const m = testOutbox.messages[0];
    expect(m.to).toBe(customerEmail);
    expect(m.subject).toContain('Booking confirmed');
    expect(m.subject).toContain(ref);
    expect(m.text).toContain('Tom & Jerry <Deluxe>');
    expect(m.text).toMatch(/10:00 AM–10:45 AM/);
    expect(m.text).toContain('Asia/Kolkata'); // the business's time zone (the Indian default for a new business)
    expect(m.text).toContain('Room 4');
    // The link carries a signed token (in the fragment), never just the reference.
    expect(m.text).toMatch(/http:\/\/localhost:5173\/book\/lookup\/manage#token=v1\.[\w-]+\.[0-9a-z]+\.[\w-]+/);
    expect(m.text).not.toContain('manage?ref=');
  });

  it('escapes user-supplied text in the HTML version', () => {
    // Re-render through a manual resend (the automatic confirmation is sent only once per booking).
    return sendAppointmentEmail('confirmation', (db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(ref) as { id: string }).id, undefined, { manual: true })
      .then(() => {
        const html = testOutbox.messages[0].html;
        expect(html).toContain('Tom &amp; Jerry &lt;Deluxe&gt;');
        expect(html).not.toContain('<Deluxe>');
      });
  });

  it('sends a reschedule email with the new and previous times', async () => {
    const res = await request(app).post('/api/public/appointments/manage/reschedule').set('X-Booking-Token', manage).send({ date, startTime: '14:00' });
    expect(res.status).toBe(200);
    expect(res.body.data.email.status).toBe('sent');
    const m = testOutbox.messages[0];
    expect(m.subject).toContain('Booking rescheduled');
    expect(m.text).toMatch(/New time: .*2:00 PM–2:45 PM/);
    expect(m.text).toMatch(/Previous time: .*10:00 AM–10:45 AM/);
  });

  it('sends a cancellation email', async () => {
    const res = await request(app).post('/api/public/appointments/manage/cancel').set('X-Booking-Token', manage).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.email.status).toBe('sent');
    expect(testOutbox.messages[0].subject).toContain('Booking cancelled');
    expect(testOutbox.messages[0].text).not.toContain('/manage');
  });

  it('records every attempt without storing the recipient address', () => {
    const appt = db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(ref) as { id: string };
    const rows = db.prepare('SELECT * FROM email_deliveries WHERE appointment_id = ? ORDER BY created_at').all(appt.id) as Array<Record<string, string>>;
    expect(rows.map(r => r.kind)).toEqual(expect.arrayContaining(['confirmation', 'reschedule', 'cancellation']));
    expect(rows.every(r => r.status === 'sent')).toBe(true);
    // Only a hash of the recipient is kept (the Message-ID's @domain is the sender's, not personal data).
    expect(JSON.stringify(rows)).not.toContain(customerEmail);
    expect(JSON.stringify(rows)).not.toContain(customerEmail.split('@')[0]);
  });
});

describe('admin changes', () => {
  let apptId = '';

  it('confirms admin-created appointments', async () => {
    const res = await request(app).post('/api/appointments').set(auth()).send({ serviceId, staffId, customerId, date, startTime: '16:00' });
    expect(res.status).toBe(201);
    expect(res.body.data.email.status).toBe('sent');
    apptId = res.body.data.id;
    expect(testOutbox.messages[0].to).toBe(`admin-booked-${RUN}@example.com`);
  });

  it('does not email for notes or status changes like completed', async () => {
    await request(app).put(`/api/appointments/${apptId}`).set(auth()).send({ internalNotes: 'x', status: 'confirmed' }).expect(200);
    expect(testOutbox.messages).toHaveLength(0);
  });

  it('emails on admin reschedule and cancellation', async () => {
    const r1 = await request(app).put(`/api/appointments/${apptId}`).set(auth()).send({ startTime: '17:00' });
    expect(r1.body.data.email.status).toBe('sent');
    const r2 = await request(app).put(`/api/appointments/${apptId}`).set(auth()).send({ status: 'cancelled' });
    expect(r2.body.data.email.status).toBe('sent');
    expect(testOutbox.messages.map(m => m.subject.split(':')[0])).toEqual(['Booking rescheduled', 'Booking cancelled']);
  });

  it('lists deliveries and can resend, but only for the matching state', async () => {
    const list = await request(app).get(`/api/appointments/${apptId}/emails`).set(auth());
    expect(list.body.data.length).toBeGreaterThanOrEqual(3);
    expect((await request(app).post(`/api/appointments/${apptId}/emails`).set(auth()).send({ kind: 'confirmation' })).status).toBe(400);
    const resend = await request(app).post(`/api/appointments/${apptId}/emails`).set(auth()).send({ kind: 'cancellation' });
    expect(resend.body.data.status).toBe('sent');
  });
});

describe('delivery failures and configuration', () => {
  it('keeps the booking and reports a temporary failure honestly (a retry is scheduled, nothing claimed as sent)', async () => {
    testOutbox.failNextSends(1);
    const res = await book('12:00', `fail-${RUN}@example.com`);
    expect(res.status).toBe(201);
    expect(res.body.data.email).toEqual({ status: 'retrying' }); // customers see the status only
    expect(testOutbox.messages).toHaveLength(0);
    const queued = db.prepare("SELECT o.status, o.next_attempt_at FROM email_outbox o JOIN appointments a ON a.id = o.appointment_id WHERE a.booking_ref = ?")
      .get(res.body.data.bookingRef) as { status: string; next_attempt_at: string };
    expect(queued.status).toBe('pending');
    expect(Date.parse(queued.next_attempt_at)).toBeGreaterThan(Date.now());
    const appt = db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(res.body.data.bookingRef) as { id: string };
    expect(appt).toBeTruthy();
    const row = db.prepare('SELECT status, error FROM email_deliveries WHERE appointment_id = ?').get(appt.id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('[email]');
    expect(row.error).not.toContain('@');
  });

  it('records not_configured and never claims delivery when email is disabled', async () => {
    initEmail({ EMAIL_TRANSPORT: 'disabled' });
    try {
      const res = await book('13:00', `disabled-${RUN}@example.com`);
      expect(res.status).toBe(201);
      expect(res.body.data.email).toEqual({ status: 'not_configured' });
      expect(testOutbox.messages).toHaveLength(0);
    } finally {
      initEmail(MEMORY_ENV);
    }
  });

  it('validates SMTP settings without echoing secret values', () => {
    expect(() => readEmailConfig({ EMAIL_TRANSPORT: 'smtp' })).toThrow(/EMAIL_FROM|SMTP_HOST|PUBLIC_APP_URL/);
    let message = '';
    try {
      readEmailConfig({ EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'super-secret-value', EMAIL_FROM: 'A <a@b.co>', PUBLIC_APP_URL: 'https://x.example' });
    } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/SMTP_USER and SMTP_PASS/);
    expect(message).not.toContain('super-secret-value');
    expect(() => readEmailConfig({ EMAIL_TRANSPORT: 'carrier-pigeon' })).toThrow();
    // Invalid choices are named, never echoed back.
    for (const env of [{ EMAIL_TRANSPORT: 'carrier-pigeon' }, { EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'h', EMAIL_FROM: 'A <a@b.co>', PUBLIC_APP_URL: 'https://x.example', SMTP_SECURE: 'carrier-pigeon' }]) {
      let text = '';
      try { readEmailConfig(env); } catch (e) { text = (e as Error).message; }
      expect(text).toMatch(/EMAIL_TRANSPORT: must be disabled, smtp or memory|SMTP_SECURE: must be true or false/);
      expect(text).not.toContain('carrier-pigeon');
    }
  });

  it('refuses the in-memory test transport in production, where it would report undelivered emails as sent', () => {
    expect(() => readEmailConfig({ EMAIL_TRANSPORT: 'memory', NODE_ENV: 'production' })).toThrow(/EMAIL_TRANSPORT=memory is for automated tests only/);
    expect(readEmailConfig({ EMAIL_TRANSPORT: 'memory', NODE_ENV: 'test' }).transport).toBe('memory');
    expect(readEmailConfig({ EMAIL_TRANSPORT: 'disabled', NODE_ENV: 'production' }).transport).toBe('disabled');
  });

  it('redacts addresses from provider errors', () => {
    expect(redactError('550 5.1.1 <jane.doe@corp.example>: Recipient rejected')).toBe('550 5.1.1 <[email]>: Recipient rejected');
  });
});

describe('real SMTP delivery to a local SMTP server', () => {
  const received: string[] = [];
  let server: SMTPServer;
  let port = 0;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      logger: false,
      onData(stream, _session, callback) {
        let raw = '';
        stream.on('data', (c: Buffer) => { raw += c.toString(); });
        stream.on('end', () => { received.push(raw); callback(); });
      },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    initEmail(MEMORY_ENV);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('delivers the confirmation over SMTP and records it as sent', async () => {
    initEmail({
      EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false',
      EMAIL_FROM: 'Bookings <bookings@example.com>', PUBLIC_APP_URL: 'https://book.example.com',
    });
    const res = await book('15:00', `smtp-${RUN}@example.com`);
    expect(res.status).toBe(201);
    expect(res.body.data.email).toEqual({ status: 'sent' });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(/^Subject: Booking confirmed/m);
    expect(received[0]).toContain(`smtp-${RUN}@example.com`);
    // Bodies are quoted-printable on the wire; decode soft line breaks and =XX escapes before checking.
    const body = received[0].replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    expect(body).toContain('https://book.example.com/book/lookup/manage#token=v1.');
  });

  it('reports failure when the SMTP server is unreachable', async () => {
    initEmail({
      EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false',
      EMAIL_FROM: 'Bookings <bookings@example.com>', PUBLIC_APP_URL: 'https://book.example.com',
    });
    const res = await book('18:00', `down-${RUN}@example.com`);
    expect(res.status).toBe(201);
    // A refused connection is temporary: the booking stands and the email is retried later, never reported as sent.
    expect(res.body.data.email.status).toBe('retrying');
  });

  it('a production configuration never continues in plaintext: without STARTTLS nothing is sent and the email is reported as failed', async () => {
    const before = received.length;
    initEmail({
      NODE_ENV: 'production', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false',
      SMTP_USER: 'test-smtp-user', SMTP_PASS: 'test-smtp-password-not-real',
      EMAIL_FROM: 'Bookings <bookings@example.com>', PUBLIC_APP_URL: 'https://book.example.com',
    });
    const res = await book('16:00', `prod-tls-${RUN}@example.com`);
    expect(res.status).toBe(201);
    // This test server offers no STARTTLS: the booking stands, the email is not delivered and not claimed as sent.
    expect(res.body.data.email).toEqual({ status: 'failed' }); // customers see the status only
    const appt = db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(res.body.data.bookingRef) as { id: string };
    const row = db.prepare('SELECT status, error FROM email_deliveries WHERE appointment_id = ?').get(appt.id) as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/STARTTLS/);
    expect(row.error).not.toMatch(/test-smtp-user|test-smtp-password-not-real/);
    expect(received).toHaveLength(before);
  });
});
