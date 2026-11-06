import { nanoid } from 'nanoid';
import db from '../../db/init';
import { toE164 } from '../../lib/phone';
import { zonedToInstant } from '../zoned-time';
import { DEFAULT_TIMEZONE } from '../business-locale';
import { appUrl, sendDirect, redactError } from '../email/notify';
import { getPreferences } from '../email/preferences';
import { accessTokenFor, connectionStatus, isMockConnection } from '../integrations/oauth';
import {
  connectionConfig, connectionRow, consentFor, getRecipient, orgSettings, providerMode, recordConsent, ruleEnabled, setConnectionStatus,
} from './settings';
import { customerEmail, loadAppointmentInfo, smsText, teamEmail, whatsappMessage, type AppointmentInfo } from './messages';
import { sendSms, sendWhatsApp, smsParts, syncCalendar, type ProviderResult } from './providers';
import { appointmentIcs } from './ics';
import { reconcileReminders, REMINDER_GRACE_MS } from './planner';
import type { AttemptOutcome, JobRow, MessageChannel } from './types';

// Sends due notification jobs. A job is claimed with a conditional update (pending → sending), so two workers or two
// requests never send it twice. Before sending, the stored appointment is checked again: a reminder for a time the
// booking no longer has, or a confirmation for a booking cancelled meanwhile, is cancelled instead of sent. Temporary
// failures are retried with exponential backoff up to the job's limit; a provider that may have taken the message
// without answering leaves the job "unknown" (never retried on its own: a duplicate is worse than asking an admin).

export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 6 * 3_600_000;
export const backoffMs = (attempt: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
const ACTIVE = ['scheduled', 'confirmed'];
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

function fromProvider(r: ProviderResult, provider: string): AttemptOutcome {
  switch (r.kind) {
    case 'accepted': return { outcome: 'sent', providerMessageId: r.id, provider };
    case 'transient': return { outcome: 'retry', error: r.error, provider, retryAfterMs: r.retryAfterMs };
    case 'timeout': return { outcome: 'unknown', error: r.error, provider };
    case 'permanent': return { outcome: 'failed', error: r.error, provider };
  }
}

/** Why this job should not be sent any more, or null. */
function obsolete(job: JobRow, a: AppointmentInfo | undefined, now: number): string | null {
  if (!a) return job.channel.endsWith('_calendar') ? null : 'The appointment no longer exists';
  const active = ACTIVE.includes(a.status);
  if (job.event === 'reminder') {
    if (!active) return `The booking is ${a.status === 'no_show' ? 'a no-show' : a.status}`;
    if (`${a.date}T${a.start_time}` !== job.slot) return 'The booking was moved';
    if (zonedToInstant(a.date, a.start_time, a.timezone || DEFAULT_TIMEZONE) <= now) return 'The appointment has started';
    if (job.recipient_role !== 'business' && !ruleEnabled(a.organization_id, 'reminder', job.recipient_role, job.channel)) return 'Reminders were turned off';
    if (job.offset_minutes != null && !orgSettings(a.organization_id).reminderOffsets.includes(job.offset_minutes)) return 'This reminder time was removed';
    return null;
  }
  if (job.channel.endsWith('_calendar')) return null; // calendar jobs sync whatever the booking is now
  // A staff member the booking was moved away from still hears it is off their schedule; anyone else does not, once it is back.
  if (job.event === 'cancelled' && active && !(job.recipient_role === 'staff' && job.recipient_id !== a.staff_id)) return 'The booking was brought back before this was sent';
  if ((job.event === 'confirmed' || job.event === 'rescheduled' || job.event === 'status_changed') && a.status === 'cancelled') return 'The booking was cancelled before this was sent';
  return null;
}

interface Contact { name: string; email: string | null; phone: string | null; language: 'en' | 'hi' }

function contactFor(job: JobRow, a: AppointmentInfo): Contact | { problem: string } {
  const language = getPreferences(a.organization_id).bookingLanguage;
  if (job.recipient_role === 'customer') {
    if (job.channel === 'sms' || job.channel === 'whatsapp') {
      const consent = consentFor(a.customer_id)[job.channel];
      if (consent.status !== 'granted') return { problem: consent.status === 'revoked' ? 'The customer opted out' : 'The customer has not agreed to this channel' };
    }
    return { name: a.customer_name, email: a.customer_email, phone: a.customer_phone, language };
  }
  if (job.recipient_role === 'staff') {
    const s = db.prepare('SELECT name, email, phone, is_active FROM staff WHERE id = ? AND organization_id = ?').get(job.recipient_id, a.organization_id) as
      { name: string; email: string; phone: string | null; is_active: number } | undefined;
    if (!s || !s.is_active) return { problem: 'The staff member is no longer active' };
    return { name: s.name, email: s.email, phone: s.phone, language };
  }
  const r = getRecipient(a.organization_id, job.recipient_id);
  if (!r || !r.active) return { problem: 'The business recipient was removed or turned off' };
  return { name: r.name, email: r.email, phone: r.phone, language };
}

async function sendMessage(job: JobRow, a: AppointmentInfo, contact: Contact): Promise<AttemptOutcome> {
  const channel = job.channel as MessageChannel;
  const audience = job.recipient_role === 'customer' ? 'customer' : 'team';
  const previous = job.previous ? JSON.parse(job.previous) as { date: string; startTime: string; endTime: string } : undefined;
  if (channel === 'email') {
    if (!contact.email) return { outcome: 'skipped', error: 'No email address' };
    const base = appUrl();
    const message = audience === 'customer' ? customerEmail(job.event, a, base) : teamEmail(job.event, a, base, contact.name, previous);
    const ics = appointmentIcs(a.id);
    const attachments = ics ? [{ filename: ics.filename, content: ics.content, contentType: `text/calendar; charset=utf-8; method=${a.status === 'cancelled' ? 'CANCEL' : 'PUBLISH'}` }] : undefined;
    const r = await sendDirect(contact.email, { ...message, attachments }, job.id);
    if (r.status === 'sent') return { outcome: 'sent', providerMessageId: r.messageId, provider: `email:${r.transport}` };
    if (r.status === 'not_configured') return { outcome: 'not_configured', error: 'Email delivery is not configured on this server', provider: 'email' };
    return r.transient ? { outcome: 'retry', error: r.error ?? 'Temporary email problem', provider: `email:${r.transport}` }
      : { outcome: 'failed', error: r.error ?? 'Email was refused', provider: `email:${r.transport}` };
  }
  const to = toE164(contact.phone);
  if (!to) return { outcome: 'skipped', error: 'No valid phone number' };
  const conn = connectionRow(a.organization_id, channel);
  const label = channel === 'sms' ? 'Text messages (SMS)' : 'WhatsApp';
  if (!conn) return { outcome: 'not_configured', error: `${label} are not set up for this business`, provider: channel };
  if (conn.status === 'error') return { outcome: 'not_configured', error: `${label}: the connection has an error; check it in Integrations`, provider: channel };
  const mode = providerMode();
  if (mode === 'live' && conn.provider === 'mock') return { outcome: 'not_configured', error: `${label}: only the development mock is set up`, provider: channel };
  const provider = mode === 'mock' ? 'mock' : conn.provider;
  const cfg = connectionConfig(a.organization_id, channel) ?? {};
  let result: ProviderResult;
  if (channel === 'sms') {
    const body = smsText(job.event, audience, a, contact.language, contact.name);
    if (smsParts(body).parts > 6) return { outcome: 'failed', error: 'The text message is too long (more than 6 parts)', provider };
    const callback = process.env.PUBLIC_API_URL ? `${process.env.PUBLIC_API_URL.replace(/\/$/, '')}/api/webhooks/messaging/twilio/${a.organization_id}/status` : undefined;
    result = await sendSms(provider, a.organization_id, cfg, { to, body, statusCallbackUrl: callback });
  } else {
    const msg = whatsappMessage(job.event, audience, a, contact.language, contact.name, (conn.settings.templates ?? {}) as Record<string, string>);
    result = await sendWhatsApp(provider, a.organization_id, cfg, { to, ...msg });
  }
  if (result.kind === 'permanent' && result.connectionProblem) setConnectionStatus(a.organization_id, channel, 'error', result.error);
  if (result.kind === 'permanent' && result.optedOut && job.recipient_role === 'customer') recordConsent(a.organization_id, a.customer_id, channel, 'revoked', 'reply_stop');
  return fromProvider(result, provider);
}

async function syncCalendarJob(job: JobRow, a: AppointmentInfo | undefined): Promise<AttemptOutcome> {
  const provider = job.channel === 'google_calendar' ? 'google' : 'outlook';
  const oauthName = provider === 'google' ? 'google' : 'microsoft';
  const label = provider === 'google' ? 'Google Calendar' : 'Outlook calendar';
  const org = job.organization_id;
  if (!connectionStatus(org, oauthName).connected) return { outcome: 'not_configured', error: `${label} is not connected`, provider };
  const link = db.prepare('SELECT provider_event_id, sequence, status FROM calendar_event_links WHERE appointment_id = ? AND provider = ?')
    .get(job.appointment_id, provider) as { provider_event_id: string; sequence: number; status: string } | undefined;
  const cancelled = !a || !ACTIVE.includes(a.status);
  if (cancelled && !link) return { outcome: 'skipped', error: 'Nothing to remove: the event was never created' };
  const mode = providerMode();
  if (mode === 'live' && isMockConnection(org, oauthName)) return { outcome: 'not_configured', error: `${label}: only the development stand-in is connected`, provider };
  const token = mode === 'mock' ? null : await accessTokenFor(org, oauthName);
  const tz = a?.timezone || DEFAULT_TIMEZONE;
  const start = a ? zonedToInstant(a.date, a.start_time, tz) : 0;
  const end = a ? zonedToInstant(a.date, a.end_time === '24:00' ? '23:59' : a.end_time, tz) + (a.end_time === '24:00' ? 60_000 : 0) : 0;
  const staffEmail = a && orgSettings(org).inviteStaffToCalendar ? a.staff_email : null;
  const sequence = (link?.sequence ?? 0) + 1;
  const r = await syncCalendar(provider, mode, org, token, {
    appointmentId: job.appointment_id, cancelled, sequence,
    summary: a ? `${a.service_name} — ${a.customer_name}` : 'Cancelled booking',
    description: a ? `Booking ${a.booking_ref}\nStaff: ${a.staff_name}\nTime zone: ${tz}` : '',
    location: a?.location ?? '', startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(),
    attendees: staffEmail ? [staffEmail] : [],
  }, link?.provider_event_id ?? null);
  if (r.kind === 'accepted') {
    db.prepare(
      `INSERT INTO calendar_event_links (organization_id, appointment_id, provider, provider_event_id, sequence, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(appointment_id, provider) DO UPDATE SET provider_event_id = excluded.provider_event_id, sequence = excluded.sequence,
         status = excluded.status, updated_at = excluded.updated_at`
    ).run(org, job.appointment_id, provider, r.id, sequence, cancelled ? 'cancelled' : 'active', nowIso());
  }
  return fromProvider(r, mode === 'mock' ? `mock-${provider}` : provider);
}

function finish(job: JobRow, o: AttemptOutcome, startedAt: string, now: number): string {
  const error = 'error' in o ? redactError(o.error) : null;
  let status: string = o.outcome;
  let next: string | null = null;
  if (o.outcome === 'retry') {
    if (job.attempts < job.max_attempts) {
      status = 'pending';
      next = nowIso(now + Math.max(backoffMs(job.attempts), o.retryAfterMs ?? 0));
    } else status = 'failed';
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO notification_attempts (id, job_id, attempt, outcome, provider_status, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(`natt-${nanoid(12)}`, job.id, job.attempts, o.outcome, 'provider' in o ? o.provider ?? null : null, error, startedAt, nowIso());
    db.prepare(
      `UPDATE notification_jobs SET status = ?, next_attempt_at = ?, provider = COALESCE(?, provider), provider_message_id = COALESCE(?, provider_message_id),
         last_error = ?, reason = CASE WHEN ? IN ('skipped', 'cancelled', 'not_configured') THEN ? ELSE reason END,
         sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END, updated_at = ? WHERE id = ?`
    ).run(status, next, 'provider' in o ? o.provider ?? null : null, o.outcome === 'sent' ? o.providerMessageId ?? null : null,
      status === 'failed' && o.outcome === 'retry' ? `Gave up after ${job.attempts} attempts: ${error}` : (o.outcome === 'sent' ? null : error),
      status, error, status, nowIso(), nowIso(), job.id);
  })();
  return status;
}

/** One attempt at one job. */
export async function attemptJob(id: string, now = Date.now()): Promise<string> {
  const startedAt = nowIso();
  const claimed = db.prepare(
    `UPDATE notification_jobs SET status = 'sending', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`
  ).run(startedAt, id, nowIso(now)).changes;
  if (!claimed) return 'not-claimed';
  const job = db.prepare('SELECT * FROM notification_jobs WHERE id = ?').get(id) as JobRow;
  try {
    const a = loadAppointmentInfo(job.appointment_id);
    const stale = obsolete(job, a, now);
    if (stale) return finish(job, { outcome: 'cancelled', error: stale }, startedAt, now);
    // First picked up long after its time (the server was down): skipped, never sent late. Retries keep going.
    if (job.event === 'reminder' && job.attempts === 1 && job.scheduled_for && now - Date.parse(job.scheduled_for) > REMINDER_GRACE_MS) {
      return finish(job, { outcome: 'skipped', error: 'This reminder time passed while reminders could not be sent' }, startedAt, now);
    }
    if (job.channel === 'google_calendar' || job.channel === 'outlook_calendar') return finish(job, await syncCalendarJob(job, a), startedAt, now);
    const contact = contactFor(job, a!);
    if ('problem' in contact) return finish(job, { outcome: 'skipped', error: contact.problem }, startedAt, now);
    return finish(job, await sendMessage(job, a!, contact), startedAt, now);
  } catch (e) {
    // An unexpected error is treated like a temporary one: the job is not lost and is retried within its limit.
    return finish(job, { outcome: 'retry', error: (e as Error).message || 'Unexpected error', provider: job.channel }, startedAt, now);
  }
}

/** Plans missing reminders, then sends every due job (rows are claimed, so this is safe to run from several places). */
export async function processNotificationJobs(now = Date.now()): Promise<Record<string, number>> {
  reconcileReminders(now);
  const due = db.prepare(`SELECT id FROM notification_jobs WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 100`).pluck().all(nowIso(now)) as string[];
  const summary: Record<string, number> = {};
  for (const id of due) { const s = await attemptJob(id, now); summary[s] = (summary[s] ?? 0) + 1; }
  return summary;
}

/** At startup: jobs cut off mid-send have an unknown outcome and are not resent on their own. */
export function recoverInterruptedJobs(): number {
  return db.prepare(
    `UPDATE notification_jobs SET status = 'unknown', last_error = 'The server stopped while sending; not resent automatically to avoid a duplicate',
       updated_at = ? WHERE status = 'sending'`
  ).run(nowIso()).changes;
}

/** An administrator's retry of a failed, unknown or not-configured job: a few more attempts, starting now. */
export function retryJob(orgId: string, jobId: string): { ok: true; job: JobRow } | { ok: false; status: number; error: string } {
  const job = db.prepare('SELECT * FROM notification_jobs WHERE id = ? AND organization_id = ?').get(jobId, orgId) as JobRow | undefined;
  if (!job) return { ok: false, status: 404, error: 'Notification not found' };
  if (!['failed', 'unknown', 'not_configured'].includes(job.status)) return { ok: false, status: 409, error: `This notification is ${job.status} and cannot be retried` };
  db.prepare(
    `UPDATE notification_jobs SET status = 'pending', next_attempt_at = ?, max_attempts = MIN(10, attempts + 3), updated_at = ? WHERE id = ? AND status = ?`
  ).run(nowIso(), nowIso(), job.id, job.status);
  return { ok: true, job: db.prepare('SELECT * FROM notification_jobs WHERE id = ?').get(job.id) as JobRow };
}

/** Starts sending soon after a change is committed (outside tests, which run the worker themselves). */
export function kickNotifications(): void {
  if (process.env.NODE_ENV === 'test') return;
  setImmediate(() => { processNotificationJobs().catch(e => console.error('[notifications] worker failed:', e instanceof Error ? e.message : e)); });
}
