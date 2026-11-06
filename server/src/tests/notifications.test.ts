// Booking language, the business's own email texts, and the email side of the notification platform: staff alerts
// once per event, reminders per configured time (cancelled when the booking moves or is cancelled, skipped when late,
// never sent late), retries with backoff. Emails go to the in-memory test transport (a test inbox; nothing leaves the
// machine). Synthetic data, per-file test database. SMS, WhatsApp and calendars: notification-platform.test.ts.

import request from 'supertest';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { testOutbox } from '../services/email/notify';
import { processNotificationJobs, backoffMs } from '../services/notifications/worker';
import { templateProblem } from '../services/email/preferences';
import { instantToZoned } from '../services/zoned-time';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
const HOURS = Object.fromEntries(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].map(d => [d, { enabled: true, start: '00:00', end: '23:59' }]));
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });

interface Biz { orgId: string; h: Record<string, string>; serviceId: string; staffId: string; staffEmail: string; customerId: string; customerEmail: string }

async function business(label: string): Promise<Biz> {
  const s = await signUpAndSignIn(app, { name: `N ${label}`, email: `ntf-${label}-${RUN}@example.com`, company: `Notify ${label} ${RUN}`, password: 'StartPass123', timezone: TZ });
  const h = { Authorization: `Bearer ${sessionToken(s)}` };
  const serviceId = (await request(app).post('/api/services').set(h).send({ name: `Facial ${label}`, category: 'session', duration: 30, price: 500, maxAdvance: 365 })).body.data.id;
  const staffEmail = `stylist-${label}-${RUN}@example.com`;
  const staffId = (await request(app).post('/api/staff').set(h).send({ name: `Ravi ${label}`, email: staffEmail, serviceIds: [serviceId], workingHours: HOURS })).body.data.id;
  const customerEmail = `asha-${label}-${RUN}@example.com`;
  const customerId = (await request(app).post('/api/customers').set(h).send({ name: `Asha ${label}`, email: customerEmail })).body.data.id;
  return { orgId: s.body.data.user.organization_id, h, serviceId, staffId, staffEmail, customerId, customerEmail };
}

const prefs = (b: Biz, body: Record<string, unknown>) => request(app).put('/api/settings/notifications').set(b.h).send(body);
const book = (b: Biz, date: string, startTime: string) =>
  request(app).post('/api/appointments').set(b.h).send({ serviceId: b.serviceId, staffId: b.staffId, customerId: b.customerId, date, startTime });
const jobs = (apptId: string) => db.prepare('SELECT * FROM notification_jobs WHERE appointment_id = ? ORDER BY created_at, rowid').all(apptId) as Array<{ event: string; recipient_role: string; channel: string; status: string; reason: string | null; slot: string; offset_minutes: number | null }>;
const mailTo = (to: string) => testOutbox.messages.filter(m => m.to === to.toLowerCase());

/** An appointment written directly so its start and creation time can be placed around the reminder window. */
function insertAppointment(b: Biz, startsInMinutes: number, createdMinutesAgo: number, status = 'scheduled'): string {
  const start = instantToZoned(Date.now() + startsInMinutes * 60_000, TZ);
  const startTime = start.time.slice(0, 5);
  const [h, m] = startTime.split(':').map(Number);
  const endTotal = h * 60 + m + 30;
  const end = `${String(Math.floor(endTotal / 60)).padStart(2, '0')}:${String(endTotal % 60).padStart(2, '0')}`;
  const id = `appt-${nanoid(8)}`;
  const created = new Date(Date.now() - createdMinutesAgo * 60_000).toISOString();
  db.prepare(`INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, price, currency, timezone, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 30, 500, 'INR', ?, ?, ?)`)
    .run(id, `WE-${nanoid(8).toUpperCase()}`, b.orgId, b.serviceId, b.staffId, b.customerId, status, start.date, startTime, end, TZ, created, created);
  return id;
}

let A: Biz;
let B: Biz;
beforeAll(async () => {
  A = await business('a');
  B = await business('b');
});
beforeEach(() => testOutbox.clear());

describe('email texts', () => {
  it('only known placeholders, paired braces, a one-line subject and sensible lengths are accepted', () => {
    expect(templateProblem('Hello {customerName}, see you on {date} at {time}', 'intro')).toBeNull();
    expect(templateProblem('Hi {firstName}', 'intro')).toMatch(/Unknown placeholder \{firstName\}/);
    expect(templateProblem('Hi {customerName', 'intro')).toMatch(/Each \{ must be closed/);
    expect(templateProblem('Price } here', 'intro')).toMatch(/Each \{ must be closed/);
    expect(templateProblem('Line one\nLine two', 'subject')).toMatch(/single line/);
    expect(templateProblem('   ', 'subject')).toMatch(/Enter a subject/);
    expect(templateProblem('x'.repeat(151), 'subject')).toMatch(/150 characters/);
    expect(templateProblem('x'.repeat(1001), 'intro')).toMatch(/1000 characters/);
  });

  it('a business can set, preview and reset its own text; the email uses it, escaped', async () => {
    const list = await request(app).get('/api/settings/email-templates').set(A.h);
    expect(list.body.data.templates.map((t: { kind: string; custom: boolean }) => [t.kind, t.custom])).toEqual([
      ['confirmation', false], ['reschedule', false], ['cancellation', false], ['reminder', false],
    ]);
    const bad = await request(app).put('/api/settings/email-templates/confirmation').set(A.h).send({ subject: 'Hi {nope}', intro: 'x' });
    expect([bad.status, bad.body.code]).toEqual([400, 'INVALID_TEMPLATE']);
    const texts = { subject: 'See you soon, {customerName} ({bookingRef})', intro: 'Thanks for booking {serviceName} with {staffName}.\n<script>alert(1)</script> Bring your ID.' };
    const preview = await request(app).post('/api/settings/email-templates/preview').set(A.h).send({ kind: 'confirmation', ...texts });
    expect(preview.body.data.subject).toBe('See you soon, Asha Verma (WE-SAMPLE01)');
    expect(testOutbox.messages).toHaveLength(0); // a preview sends nothing
    expect((await request(app).put('/api/settings/email-templates/confirmation').set(A.h).send(texts)).status).toBe(200);

    const booked = await book(A, day(5), '10:00');
    expect(booked.status).toBe(201);
    const mail = mailTo(A.customerEmail)[0];
    expect(mail.subject).toBe(`See you soon, Asha a (${booked.body.data.bookingRef})`);
    expect(mail.text).toContain('Thanks for booking Facial a with Ravi a.\n<script>alert(1)</script> Bring your ID.');
    expect(mail.html).toContain('Thanks for booking Facial a with Ravi a.<br>&lt;script&gt;alert(1)&lt;/script&gt; Bring your ID.');
    expect(mail.html).not.toContain('<script>');
    expect(mail.text).toContain('/book/lookup/manage#token='); // the details and manage link always stay

    expect((await request(app).delete('/api/settings/email-templates/confirmation').set(A.h)).status).toBe(200);
    expect((await request(app).delete('/api/settings/email-templates/confirmation').set(A.h)).status).toBe(404);
  });

  it('each business has its own texts; only settings writers can change them', async () => {
    await request(app).put('/api/settings/email-templates/cancellation').set(A.h).send({ subject: 'A cancelled {bookingRef}', intro: 'Sorry.' });
    const theirs = (await request(app).get('/api/settings/email-templates').set(B.h)).body.data.templates.find((t: { kind: string }) => t.kind === 'cancellation');
    expect(theirs.custom).toBe(false);
    const email = `mgr-${nanoid(5)}-${RUN}@example.com`.toLowerCase();
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`user-${nanoid(8)}`, A.orgId, email, bcrypt.hashSync('TestPass123', 4), 'Manager', 'manager');
    const manager = { Authorization: `Bearer ${sessionToken(await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' }))}` };
    expect((await request(app).put('/api/settings/email-templates/cancellation').set(manager).send({ subject: 'x', intro: 'y' })).status).toBe(403);
    expect((await request(app).put('/api/settings/notifications').set(manager).send({ remindersEnabled: true })).status).toBe(403);
    expect((await request(app).get('/api/settings/notifications').set(manager)).status).toBe(200);
    await request(app).delete('/api/settings/email-templates/cancellation').set(A.h);
  });
});

describe('language', () => {
  it('a Hindi-speaking business sends booking emails in Hindi, and its booking page starts in Hindi', async () => {
    expect((await prefs(B, { bookingLanguage: 'hi' })).body.data.bookingLanguage).toBe('hi');
    const booked = await book(B, day(6), '11:00');
    const mail = mailTo(B.customerEmail)[0];
    expect(mail.subject).toMatch(/^बुकिंग की पुष्टि: Facial b, /);
    expect(mail.text).toMatch(/^नमस्ते Asha b,/);
    expect(mail.text).toContain('आपकी बुकिंग की पुष्टि हो गई है।');
    expect(mail.text).toContain(`संदर्भ संख्या: ${booked.body.data.bookingRef}`);
    expect(mail.html).toContain('<html lang="hi">');
    const templates = (await request(app).get('/api/settings/email-templates').set(B.h)).body.data.templates;
    expect(templates.find((t: { kind: string }) => t.kind === 'reminder').intro).toBe('यह आपके आने वाले अपॉइंटमेंट की याद दिलाने के लिए है।');
    await prefs(B, { bookingLanguage: 'en' });
  });

  it('settings are validated', async () => {
    expect((await prefs(A, { bookingLanguage: 'fr' })).status).toBe(400);
    expect((await prefs(A, { reminderHoursBefore: 0 })).status).toBe(400);
    expect((await prefs(A, { reminderHoursBefore: 169 })).status).toBe(400);
    expect((await prefs(A, { somethingElse: true })).status).toBe(400);
    expect((await request(app).get('/api/settings/notifications').set(A.h)).body.data)
      .toEqual({ bookingLanguage: 'en', remindersEnabled: false, reminderHoursBefore: 24, staffAlertsEnabled: false });
  });
});


describe('staff alerts (email jobs of the notification platform)', () => {
  it('off by default: nothing is planned for the staff member', async () => {
    const booked = await book(A, day(7), '09:00');
    expect(jobs(booked.body.data.id).filter(j => j.recipient_role === 'staff')).toEqual([]);
  });

  it('when on: one email per event to the staff member, with the old time when moved, and a calendar file attached', async () => {
    await prefs(A, { staffAlertsEnabled: true });
    try {
      const booked = await book(A, day(8), '09:00');
      const id = booked.body.data.id;
      await request(app).put(`/api/appointments/${id}`).set(A.h).send({ startTime: '10:00' });
      await request(app).put(`/api/appointments/${id}`).set(A.h).send({ status: 'cancelled' });
      expect(jobs(id).filter(j => j.recipient_role === 'staff').map(j => [j.event, j.channel, j.status])).toEqual([
        ['confirmed', 'email', 'pending'], ['rescheduled', 'email', 'pending'], ['cancelled', 'email', 'pending'],
      ]);
      // A manual resend of the customer email is not a new booking event.
      await request(app).post(`/api/appointments/${id}/emails`).set(A.h).send({ kind: 'cancellation' });
      expect(jobs(id).filter(j => j.recipient_role === 'staff')).toHaveLength(3);

      await processNotificationJobs();
      // The confirmation and the move were for a booking that is now cancelled: they are cancelled, not sent late.
      expect(jobs(id).filter(j => j.recipient_role === 'staff').map(j => j.status)).toEqual(['cancelled', 'cancelled', 'sent']);
      const alerts = mailTo(A.staffEmail);
      expect(alerts.map(m => m.subject.split(':')[0])).toEqual(['Booking cancelled']);
      expect(alerts[0].text).toContain(`/appointments/${id}`);
      expect(alerts[0].text).not.toContain(A.customerEmail); // the customer's contact details stay in the app
      expect(alerts[0].attachments?.[0]).toMatchObject({ filename: expect.stringMatching(/^booking-WE-.*\.ics$/), contentType: expect.stringContaining('method=CANCEL') });
      await processNotificationJobs();
      expect(mailTo(A.staffEmail)).toHaveLength(1); // nothing is sent twice
      const list = (await request(app).get(`/api/notifications/appointments/${id}`).set(A.h)).body.data as Array<{ role: string; status: string; reason: string | null }>;
      expect(list.filter(j => j.role === 'staff').map(j => j.status)).toEqual(['cancelled', 'cancelled', 'sent']);
      expect(list[0].reason).toBe('The booking was cancelled before this was sent');
    } finally {
      await prefs(A, { staffAlertsEnabled: false });
    }
  });

  it('each event is sent when it is still current; a temporary failure is retried with backoff; a permanent one is not', async () => {
    await prefs(A, { staffAlertsEnabled: true });
    try {
      const first = (await book(A, day(9), '09:00')).body.data.id;
      testOutbox.clear();
      testOutbox.failNextSends(1, 'transient');
      await processNotificationJobs();
      const row = db.prepare("SELECT status, attempts, next_attempt_at FROM notification_jobs WHERE appointment_id = ? AND recipient_role = 'staff'").get(first) as { status: string; attempts: number; next_attempt_at: string };
      expect([row.status, row.attempts]).toEqual(['pending', 1]);
      expect(Date.parse(row.next_attempt_at)).toBeGreaterThan(Date.now() + backoffMs(1) - 5_000);
      await processNotificationJobs(Date.now() + backoffMs(1) + 1000);
      expect(jobs(first).filter(j => j.recipient_role === 'staff')[0].status).toBe('sent');
      expect(db.prepare("SELECT outcome FROM notification_attempts WHERE job_id = (SELECT id FROM notification_jobs WHERE appointment_id = ? AND recipient_role = 'staff') ORDER BY attempt").pluck().all(first)).toEqual(['retry', 'sent']);

      const second = (await book(A, day(9), '11:00')).body.data.id;
      testOutbox.clear();
      testOutbox.failNextSends(1, 'permanent');
      await processNotificationJobs();
      expect(jobs(second).filter(j => j.recipient_role === 'staff')[0].status).toBe('failed');
    } finally {
      await prefs(A, { staffAlertsEnabled: false });
    }
  });
});

describe('reminders (scheduled jobs)', () => {
  it('off by default; when on, one reminder per configured time before the booking, to the customer', async () => {
    const id = insertAppointment(A, 14 * 60, 3 * 24 * 60); // the 12-hour reminder is due in 2 hours
    await processNotificationJobs();
    expect(jobs(id)).toEqual([]);
    await prefs(A, { remindersEnabled: true, reminderHoursBefore: 12 });
    try {
      await processNotificationJobs();
      expect(jobs(id).map(j => j.status)).toEqual(['pending']); // not before its time
      await processNotificationJobs(Date.now() + 2 * 3_600_000 + 60_000);
      const planned = jobs(id);
      expect(planned.map(j => [j.event, j.recipient_role, j.channel, j.status, j.offset_minutes])).toEqual([['reminder', 'customer', 'email', 'sent', 720]]);
      await processNotificationJobs();
      expect(jobs(id)).toHaveLength(1); // planned once, sent once
      const mail = mailTo(A.customerEmail).find(m => m.subject.startsWith('Reminder:'));
      expect(mail?.text).toContain('This is a reminder of your upcoming appointment.');
      expect(mail?.text).toContain('/book/lookup/manage#token=');
    } finally {
      await prefs(A, { remindersEnabled: false });
    }
  });

  it('several reminder times; late ones are skipped (never sent late); none for cancelled or started bookings', async () => {
    await prefs(A, { remindersEnabled: true });
    expect((await request(app).put('/api/notifications/settings/schedule').set(A.h).send({ reminderOffsets: [1440, 60] })).status).toBe(200);
    try {
      const both = insertAppointment(A, 30 * 60, 3 * 24 * 60);           // 24 h reminder due in 6 h, 1 h reminder in 29 h
      const bookedInside = insertAppointment(A, 6 * 60, 30);             // made 30 minutes ago, 6 h ahead: 24 h one is late
      const cancelled = insertAppointment(A, 7 * 60, 3 * 24 * 60, 'cancelled');
      const started = insertAppointment(A, -10, 3 * 24 * 60);
      await processNotificationJobs();
      expect(jobs(both).map(j => [j.offset_minutes, j.status])).toEqual([[1440, 'pending'], [60, 'pending']]);
      expect(jobs(bookedInside).map(j => [j.offset_minutes, j.status, j.reason])).toEqual([
        [1440, 'skipped', 'The booking was made or changed after this reminder time'], [60, 'pending', null],
      ]);
      for (const id of [cancelled, started]) expect(jobs(id)).toEqual([]);
      // At the 24-hour mark the first reminder goes; the 1-hour one waits for its own time.
      await processNotificationJobs(Date.now() + 6 * 3_600_000 + 60_000);
      expect(jobs(both).map(j => j.status)).toEqual(['sent', 'pending']);
    } finally {
      await request(app).put('/api/notifications/settings/schedule').set(A.h).send({ reminderOffsets: [720] });
      await prefs(A, { remindersEnabled: false });
    }
  });

  it('a reminder for a time the booking no longer has is cancelled; the new time gets its own; turning reminders off cancels pending ones', async () => {
    await prefs(A, { remindersEnabled: true, reminderHoursBefore: 12 });
    try {
      const booked = await book(A, day(2), '10:00');
      const id = booked.body.data.id;
      expect(jobs(id).filter(j => j.event === 'reminder').map(j => j.status)).toEqual(['pending']);
      await request(app).put(`/api/appointments/${id}`).set(A.h).send({ startTime: '11:00' });
      expect(jobs(id).filter(j => j.event === 'reminder').map(j => [j.slot.endsWith('T10:00'), j.status, j.reason])).toEqual([
        [true, 'cancelled', 'The booking was moved'], [false, 'pending', null],
      ]);
      await request(app).put(`/api/appointments/${id}`).set(A.h).send({ startTime: '12:00' });
      await request(app).put(`/api/appointments/${id}`).set(A.h).send({ startTime: '13:00' });
      expect(jobs(id).filter(j => j.event === 'reminder' && j.status === 'pending')).toHaveLength(1); // repeated moves: one live reminder
      await prefs(A, { remindersEnabled: false });
      const due = Date.parse((db.prepare("SELECT scheduled_for FROM notification_jobs WHERE appointment_id = ? AND event = 'reminder' AND status = 'pending'").pluck().get(id)) as string);
      await processNotificationJobs(due + 1000);
      expect(jobs(id).filter(j => j.event === 'reminder' && j.status === 'pending')).toEqual([]);
      expect(jobs(id).filter(j => j.event === 'reminder').at(-1)?.reason).toBe('Reminders were turned off');
      expect(mailTo(A.customerEmail).some(m => m.subject.startsWith('Reminder:'))).toBe(false);
    } finally {
      await prefs(A, { remindersEnabled: false });
    }
  });

  it('a reminder first picked up long after its time (the server was down) is skipped, not sent late', async () => {
    await prefs(A, { remindersEnabled: true, reminderHoursBefore: 12 });
    try {
      const id = insertAppointment(A, 16 * 60, 3 * 24 * 60); // the 12-hour reminder is due in 4 hours
      await processNotificationJobs();
      expect(jobs(id).map(j => j.status)).toEqual(['pending']);
      await processNotificationJobs(Date.now() + 4 * 3_600_000 + 20 * 60_000); // 20 minutes after its time
      expect(jobs(id).map(j => [j.status, j.reason])).toEqual([['skipped', 'This reminder time passed while reminders could not be sent']]);
      expect(mailTo(A.customerEmail).some(m => m.subject.startsWith('Reminder:'))).toBe(false);
    } finally {
      await prefs(A, { remindersEnabled: false });
    }
  });

  it('after an upgrade, a reminder the earlier queue already sent for this time is not sent again', async () => {
    const id = insertAppointment(A, 12 * 60 - 5, 3 * 24 * 60); // the 12-hour reminder was due 5 minutes ago
    db.prepare(`INSERT INTO notification_queue (id, organization_id, appointment_id, kind, dedupe_key, status, attempts, created_at, updated_at, sent_at)
                VALUES (?, ?, ?, 'reminder', ?, 'sent', 1, ?, ?, ?)`)
      .run(`nq-${nanoid(8)}`, A.orgId, id, `legacy-reminder:${id}`, new Date(Date.now() - 4 * 60_000).toISOString(), new Date(Date.now() - 4 * 60_000).toISOString(), new Date(Date.now() - 4 * 60_000).toISOString());
    await prefs(A, { remindersEnabled: true, reminderHoursBefore: 12 });
    try {
      await processNotificationJobs();
      expect(jobs(id).map(j => [j.status, j.reason])).toEqual([['skipped', 'This reminder was already sent before the update']]);
      expect(mailTo(A.customerEmail).some(m => m.subject.startsWith('Reminder:'))).toBe(false);
    } finally {
      await prefs(A, { remindersEnabled: false });
    }
  });

  it('cancelling a booking cancels its pending reminders', async () => {
    await prefs(A, { remindersEnabled: true, reminderHoursBefore: 12 });
    try {
      const id = (await book(A, day(3), '15:00')).body.data.id;
      await request(app).put(`/api/appointments/${id}`).set(A.h).send({ status: 'cancelled' });
      expect(jobs(id).filter(j => j.event === 'reminder').map(j => [j.status, j.reason])).toEqual([['cancelled', 'The booking was cancelled']]);
    } finally {
      await prefs(A, { remindersEnabled: false });
    }
  });

  it('with email turned off nothing is sent and the outcome says so', async () => {
    await prefs(B, { remindersEnabled: true, reminderHoursBefore: 4 });
    const id = insertAppointment(B, 5 * 60, 3 * 24 * 60); // due in 1 hour
    const before = process.env.EMAIL_TRANSPORT;
    try {
      const { initEmail } = await import('../services/email/notify');
      initEmail({ ...process.env, EMAIL_TRANSPORT: 'disabled' });
      await processNotificationJobs(Date.now() + 3_600_000 + 60_000);
      expect(jobs(id).map(j => j.status)).toEqual(['not_configured']);
      expect(mailTo(B.customerEmail)).toHaveLength(0);
    } finally {
      const { initEmail } = await import('../services/email/notify');
      initEmail({ ...process.env, EMAIL_TRANSPORT: before });
      await prefs(B, { remindersEnabled: false });
    }
  });
});
