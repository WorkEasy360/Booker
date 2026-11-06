// Email outbox: bounded retries with backoff, no duplicates after retries or restarts, superseded emails,
// recipient validation and honest status. In-memory transport plus a local SMTP server; nothing leaves the machine.

import request from 'supertest';
import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'net';
import app from '../index';
import db from '../db/init';
import {
  initEmail, sendAppointmentEmail, testOutbox, processDueEmails, recoverInterruptedEmails, RETRY_DELAYS_MS, isDeliverableAddress,
} from '../services/email/notify';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(30_000);

const RUN = Date.now().toString(36);
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173', EMAIL_FROM: 'Bookings <bookings@example.com>' } as NodeJS.ProcessEnv;
const EVERY_DAY = Object.fromEntries(
  ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '06:00', end: '22:00' }]),
);
const date = (() => { const d = new Date(); d.setDate(d.getDate() + 25); return d.toISOString().slice(0, 10); })();

let auth: Record<string, string> = {};
let serviceId = '';
let staffId = '';
let slot = 0;
const nextTime = () => { const m = 6 * 60 + 30 * slot++; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

async function newAppointment(label: string, email = `outbox-${label}-${RUN}@example.com`): Promise<string> {
  const customerId = (await request(app).post('/api/customers').set(auth).send({ name: `Outbox ${label}`, email })).body.data.id;
  const res = await request(app).post('/api/appointments').set(auth).send({ serviceId, staffId, customerId, date, startTime: nextTime() });
  expect(res.status).toBe(201);
  return res.body.data.id;
}

const outboxFor = (appointmentId: string) =>
  db.prepare('SELECT * FROM email_outbox WHERE appointment_id = ? ORDER BY created_at').all(appointmentId) as Array<Record<string, any>>;
const attemptsFor = (appointmentId: string) =>
  db.prepare('SELECT status FROM email_deliveries WHERE appointment_id = ? ORDER BY created_at').all(appointmentId) as Array<{ status: string }>;

beforeAll(async () => {
  initEmail(MEMORY_ENV);
  const s = await signUpAndSignIn(app, {
    name: 'Outbox Owner', email: `outbox-owner-${RUN}@example.com`, company: `Outbox Org ${RUN}`, password: 'TestPass123', confirmPassword: 'TestPass123',
  });
  auth = { Authorization: `Bearer ${sessionToken(s)}` };
  serviceId = (await request(app).post('/api/services').set(auth).send({ name: 'Outbox Service', category: 'consultation', duration: 30, price: 10, maxAdvance: 365 })).body.data.id;
  staffId = (await request(app).post('/api/staff').set(auth).send({ name: 'Outbox Staff', email: `outbox-staff-${RUN}@example.com`, serviceIds: [serviceId], workingHours: EVERY_DAY })).body.data.id;
});
beforeEach(() => {
  testOutbox.clear();
  initEmail(MEMORY_ENV);
  // Each test only sees its own retries: settle anything an earlier test left waiting.
  db.prepare("UPDATE email_outbox SET status = 'failed', last_error = 'settled between tests' WHERE status = 'pending'").run();
});

describe('retries', () => {
  it('a temporary failure is retried after the backoff and then reported as sent', async () => {
    testOutbox.failNextSends(1, 'transient');
    const id = await newAppointment('retry-once');
    const [job] = outboxFor(id);
    expect(job).toMatchObject({ kind: 'confirmation', status: 'pending', attempts: 1 });
    expect(testOutbox.messages).toHaveLength(0);
    const firstRetryAt = Date.parse(job.next_attempt_at);
    expect(firstRetryAt - Date.now()).toBeGreaterThan(RETRY_DELAYS_MS[0] - 5_000);

    // Not due yet: nothing happens.
    expect((await processDueEmails(firstRetryAt - 1_000)).attempted).toBe(0);
    const result = await processDueEmails(firstRetryAt + 1);
    expect(result).toMatchObject({ attempted: 1, sent: 1 });
    expect(testOutbox.messages).toHaveLength(1);
    expect(outboxFor(id)[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect(attemptsFor(id).map(a => a.status)).toEqual(['failed', 'sent']);
  });

  it('gives up after four attempts spaced 1, 5 and 15 minutes apart, and never claims delivery', async () => {
    testOutbox.failNextSends(10, 'transient');
    const id = await newAppointment('give-up');
    let job = outboxFor(id)[0];
    // The wait after each failed attempt, measured from the (simulated) moment that attempt ran.
    let attemptedAt = Date.parse(job.created_at);
    const gaps: number[] = [];
    for (let attempt = 1; attempt < 4; attempt++) {
      const due = Date.parse(job.next_attempt_at);
      gaps.push(Math.round((due - attemptedAt) / 60_000));
      attemptedAt = due + 1;
      await processDueEmails(attemptedAt);
      job = outboxFor(id)[0];
    }
    expect(gaps).toEqual([1, 5, 15]);
    expect(job).toMatchObject({ status: 'failed', attempts: 4 });
    expect((await processDueEmails(Date.now() + 24 * 3600_000)).attempted).toBe(0);
    expect(attemptsFor(id).map(a => a.status)).toEqual(['failed', 'failed', 'failed', 'failed']);
    expect(testOutbox.messages).toHaveLength(0);
  });

  it('a permanent failure (e.g. mailbox does not exist) is not retried', async () => {
    testOutbox.failNextSends(1, 'permanent');
    const id = await newAppointment('permanent');
    expect(outboxFor(id)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await processDueEmails(Date.now() + 3600_000)).attempted).toBe(0);
  });

  it('shows queued retries in the appointment email history with the next attempt time', async () => {
    testOutbox.failNextSends(1, 'transient');
    const id = await newAppointment('history');
    const list = (await request(app).get(`/api/appointments/${id}/emails`).set(auth)).body.data as Array<{ status: string; nextAttemptAt?: string }>;
    expect(list.map(x => x.status).sort()).toEqual(['failed', 'retrying']);
    expect(Date.parse(list.find(x => x.status === 'retrying')!.nextAttemptAt!)).toBeGreaterThan(Date.now());
  });
});

describe('no duplicates', () => {
  it('the confirmation for a booking is sent once, however often it is requested', async () => {
    const id = await newAppointment('once');
    expect(testOutbox.messages).toHaveLength(1);
    for (let i = 0; i < 3; i++) expect((await sendAppointmentEmail('confirmation', id)).status).toBe('sent');
    expect(testOutbox.messages).toHaveLength(1);
    expect(outboxFor(id)).toHaveLength(1);
  });

  it('a retry that is already queued is not queued again (e.g. the same event reported twice)', async () => {
    testOutbox.failNextSends(1, 'transient');
    const id = await newAppointment('queued-twice');
    expect((await sendAppointmentEmail('confirmation', id)).status).toBe('retrying');
    expect(outboxFor(id)).toHaveLength(1);
    await processDueEmails(Date.now() + RETRY_DELAYS_MS[0] + 1_000);
    expect(testOutbox.messages).toHaveLength(1);
  });

  it('an email interrupted by a restart is marked unknown and is never resent automatically', async () => {
    const id = await newAppointment('interrupted');
    testOutbox.clear();
    // Simulate a crash in the middle of a send: the row was claimed but its outcome was never written.
    db.prepare("UPDATE email_outbox SET status = 'sending' WHERE appointment_id = ?").run(id);
    expect(recoverInterruptedEmails()).toBe(1);
    expect(outboxFor(id)[0].status).toBe('unknown');
    expect((await processDueEmails(Date.now() + 24 * 3600_000)).attempted).toBe(0);
    expect(testOutbox.messages).toHaveLength(0);
    // After a restart the same event still maps to the same row, so it is not sent a second time.
    expect((await sendAppointmentEmail('confirmation', id)).status).toBe('failed');
    expect(testOutbox.messages).toHaveLength(0);
    const history = (await request(app).get(`/api/appointments/${id}/emails`).set(auth)).body.data as Array<{ status: string }>;
    expect(history.some(h => h.status === 'unknown')).toBe(true);
  });

  it('two workers processing at the same time send each due email once', async () => {
    testOutbox.failNextSends(1, 'transient');
    const id = await newAppointment('race');
    const due = Date.parse(outboxFor(id)[0].next_attempt_at) + 1;
    const [a, b] = await Promise.all([processDueEmails(due), processDueEmails(due)]);
    expect(a.sent + b.sent).toBe(1);
    expect(testOutbox.messages).toHaveLength(1);
  });

  it('each reschedule and cancellation is its own email, sent once', async () => {
    const id = await newAppointment('changes');
    testOutbox.clear();
    await request(app).put(`/api/appointments/${id}`).set(auth).send({ startTime: nextTime() }).expect(200);
    await request(app).put(`/api/appointments/${id}`).set(auth).send({ startTime: nextTime() }).expect(200);
    await request(app).put(`/api/appointments/${id}`).set(auth).send({ status: 'cancelled' }).expect(200);
    expect(testOutbox.messages.map(m => m.subject.split(':')[0])).toEqual(['Booking rescheduled', 'Booking rescheduled', 'Booking cancelled']);
    // Repeating a request that changes nothing sends nothing.
    await request(app).put(`/api/appointments/${id}`).set(auth).send({ status: 'cancelled' }).expect(200);
    expect(testOutbox.messages).toHaveLength(3);
  });

  it('a manual resend is a deliberate new email', async () => {
    const id = await newAppointment('resend');
    const resend = await request(app).post(`/api/appointments/${id}/emails`).set(auth).send({ kind: 'confirmation' });
    expect(resend.body.data.status).toBe('sent');
    expect(testOutbox.messages).toHaveLength(2);
  });

  it('every message carries a Message-ID tied to its outbox row, kept across retries', async () => {
    testOutbox.failNextSends(1, 'transient');
    const id = await newAppointment('msgid');
    const job = outboxFor(id)[0];
    await processDueEmails(Date.parse(job.next_attempt_at) + 1);
    expect(testOutbox.messages[0].messageId).toBe(`<${job.id}@example.com>`);
    expect(outboxFor(id)[0].provider_message_id).toBe(`<${job.id}@example.com>`);
  });
});

describe('emails that should no longer be sent', () => {
  it('a confirmation still waiting for a retry is dropped if the booking is cancelled meanwhile', async () => {
    testOutbox.failNextSends(1, 'transient');
    const id = await newAppointment('superseded');
    await request(app).put(`/api/appointments/${id}`).set(auth).send({ status: 'cancelled' }).expect(200);
    expect(testOutbox.messages.map(m => m.subject.split(':')[0])).toEqual(['Booking cancelled']);
    await processDueEmails(Date.now() + 3600_000);
    expect(testOutbox.messages.map(m => m.subject.split(':')[0])).toEqual(['Booking cancelled']);
    expect(outboxFor(id).map(o => o.status)).toEqual(['superseded', 'sent']);
  });

  it('a recipient address that is not a single plain mailbox is refused without contacting the mail server', async () => {
    const id = await newAppointment('badaddr');
    testOutbox.clear();
    const customerId = (db.prepare('SELECT customer_id FROM appointments WHERE id = ?').get(id) as { customer_id: string }).customer_id;
    db.prepare('UPDATE customers SET email = ? WHERE id = ?').run('victim@example.com\r\nBcc: list@example.com', customerId);
    const res = await sendAppointmentEmail('confirmation', id, undefined, { manual: true });
    expect(res).toEqual({ status: 'failed', error: 'Invalid recipient address' });
    expect(testOutbox.messages).toHaveLength(0);
    for (const bad of ['', 'no-at-sign', 'a@b', 'Jane <jane@example.com>', 'a@example.com,b@example.com', 'x'.repeat(250) + '@example.com']) {
      expect(isDeliverableAddress(bad)).toBe(false);
    }
    expect(isDeliverableAddress('jane.doe+booking@example.co.uk')).toBe(true);
  });

  it('emails skipped because email was not configured are not sent later when it is switched on', async () => {
    initEmail({ EMAIL_TRANSPORT: 'disabled' } as NodeJS.ProcessEnv);
    const id = await newAppointment('backlog');
    expect(outboxFor(id)[0].status).toBe('not_configured');
    initEmail(MEMORY_ENV);
    expect((await processDueEmails(Date.now() + 3600_000)).attempted).toBe(0);
    expect(testOutbox.messages).toHaveLength(0);
  });
});

describe('real SMTP responses', () => {
  const accepted: string[] = [];
  let rejectWith: number | null = null;
  let server: SMTPServer;
  let port = 0;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['AUTH', 'STARTTLS'],
      logger: false,
      onRcptTo(_address, _session, callback) {
        if (rejectWith) {
          const code = rejectWith;
          rejectWith = null;
          callback(Object.assign(new Error(code >= 500 ? 'Mailbox unavailable' : 'Try again later'), { responseCode: code }));
          return;
        }
        callback();
      },
      onData(stream, _session, callback) {
        let raw = '';
        stream.on('data', (c: Buffer) => { raw += c.toString(); });
        stream.on('end', () => { accepted.push(raw); callback(); });
      },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    initEmail(MEMORY_ENV);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const useSmtp = () => initEmail({
    EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false',
    EMAIL_FROM: 'Bookings <bookings@example.com>', PUBLIC_APP_URL: 'https://book.example.com',
  } as NodeJS.ProcessEnv);

  it('an SMTP 451 (try later) is retried and then delivered once, with the outbox Message-ID', async () => {
    useSmtp();
    rejectWith = 451;
    const id = await newAppointment('smtp451');
    const job = outboxFor(id)[0];
    expect(job.status).toBe('pending');
    expect(accepted).toHaveLength(0);
    await processDueEmails(Date.parse(job.next_attempt_at) + 1);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatch(new RegExp(`^Message-ID: <${job.id}@example\\.com>`, 'mi'));
    expect(outboxFor(id)[0].status).toBe('sent');
  });

  it('an SMTP 550 (no such mailbox) fails immediately without retries', async () => {
    useSmtp();
    rejectWith = 550;
    const before = accepted.length;
    const id = await newAppointment('smtp550');
    expect(outboxFor(id)[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect((await processDueEmails(Date.now() + 3600_000)).attempted).toBe(0);
    expect(accepted).toHaveLength(before);
  });
});
