import { createHash } from 'crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { nanoid } from 'nanoid';
import db from '../../db/init';
import {
  readEmailConfig, smtpTransportOptions, redactSmtpMessage, isRecipientAllowed, RecipientNotAllowedError, DEFAULT_RETRY_DELAYS_MS,
  type EmailConfig,
} from './config';
import { renderAppointmentEmail, renderInvitationEmail, renderAccountEmail, type EmailKind, type InvitationEmailData, type AccountEmailKind } from './templates';
import { issueManageToken, emailLinkExpiry } from '../booking-access';
import { DEFAULT_TIMEZONE } from '../business-locale';
import { getPreferences, getTemplate } from './preferences';
import { appointmentIcs } from '../notifications/ics';

// Booking emails go through an outbox (email_outbox) so that:
//  - every intended email is recorded before any attempt, under a unique dedupe key, so the same booking event can
//    never be queued twice;
//  - a row is claimed with a conditional update before sending, so two workers cannot send it twice;
//  - temporary failures (SMTP 4xx, connection problems) are retried with backoff, permanent ones are not;
//  - a send interrupted by a crash or restart is marked "unknown" and NOT retried automatically, because the provider
//    may already have accepted it: duplicates are worse than asking an admin to press Resend;
//  - "sent" is recorded only when the transport accepted the message.

export type DeliveryStatus = 'sent' | 'failed' | 'not_configured' | 'retrying';
export interface DeliveryResult { status: DeliveryStatus; error?: string; nextAttemptAt?: string }

export interface EmailAttachment { filename: string; content: string; contentType: string }
export interface OutboxMessage { to: string; from: string; subject: string; text: string; html: string; messageId?: string; attachments?: EmailAttachment[] }

/** Default wait before each retry (after the 1st, 2nd and 3rd failed attempt): four attempts over about 21 minutes. */
export const RETRY_DELAYS_MS = DEFAULT_RETRY_DELAYS_MS;

let config: EmailConfig | null = null;
let smtp: Transporter | null = null;
const outbox: OutboxMessage[] = [];
let failNext = 0;
let failMode: 'transient' | 'permanent' = 'transient';
/** The SMTP user name and password, removed from provider error messages before they are stored or logged. */
let smtpSecrets: Array<string | undefined> = [];

/** Validates configuration; called at startup so a bad SMTP setup is reported before any booking is made. */
export function initEmail(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  config = readEmailConfig(env);
  // TLS is decided in one place (config.ts): implicit TLS, required STARTTLS, or plaintext to a local catcher only.
  smtp = config.transport === 'smtp' ? nodemailer.createTransport(smtpTransportOptions(config)) : null;
  smtpSecrets = config.transport === 'smtp' ? [config.user, config.pass] : [];
  return config;
}

function getConfig(): EmailConfig {
  return config ?? initEmail();
}

export function emailTransportName(): EmailConfig['transport'] {
  return getConfig().transport;
}

// Test helpers for the in-memory transport.
export const testOutbox = {
  messages: outbox,
  clear() { outbox.length = 0; failNext = 0; failMode = 'transient'; },
  /** The next n sends fail: "transient" like an SMTP 451 (retried), "permanent" like a 550 (not retried). */
  failNextSends(n: number, mode: 'transient' | 'permanent' = 'transient') { failNext = n; failMode = mode; },
};

/** Removes the configured SMTP user name and password and any email address, and caps length, so provider errors can be stored and logged safely. */
export function redactError(message: string): string {
  // Some servers repeat the user name (or worse) in a sign-in error; neither may reach the log or the database.
  return redactSmtpMessage(message, smtpSecrets);
}

function hashRecipient(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** A single plain mailbox: no display name, no line breaks, no list of recipients. */
export function isDeliverableAddress(email: string | null | undefined): boolean {
  if (!email || email.length > 254 || /[\r\n,;<>\s"]/.test(email)) return false;
  return /^[^@]+@[^@]+\.[^@]+$/.test(email);
}

const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

export interface AppointmentRow {
  id: string; organization_id: string; booking_ref: string; status: string; date: string; start_time: string; end_time: string;
  updated_at: string; created_at: string; location: string | null; customer_name: string; customer_email: string; service_name: string;
  staff_name: string; staff_email: string; org_name: string; org_timezone: string | null; appt_timezone: string | null; time_format: string | null;
}

/** An appointment with what its emails need (customer, staff, business). */
export function loadAppointment(appointmentId: string): AppointmentRow | undefined {
  return db.prepare(
    `SELECT a.id, a.organization_id, a.booking_ref, a.status, a.date, a.start_time, a.end_time, a.updated_at, a.created_at, a.location,
            c.name AS customer_name, c.email AS customer_email, s.name AS service_name, st.name AS staff_name, st.email AS staff_email,
            o.name AS org_name, o.timezone AS org_timezone, a.timezone AS appt_timezone, o.time_format
     FROM appointments a
     JOIN customers c ON c.id = a.customer_id
     JOIN services s ON s.id = a.service_id
     JOIN staff st ON st.id = a.staff_id
     JOIN organizations o ON o.id = a.organization_id
     WHERE a.id = ?`
  ).get(appointmentId) as AppointmentRow | undefined;
}

function record(row: AppointmentRow, kind: EmailKind, status: 'sent' | 'failed' | 'not_configured', transport: string, messageId?: string, error?: string) {
  db.prepare(
    `INSERT INTO email_deliveries (id, organization_id, appointment_id, kind, status, transport, recipient_hash, provider_message_id, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`mail-${nanoid(10)}`, row.organization_id, row.id, kind, status, transport, hashRecipient(row.customer_email), messageId ?? null, error ?? null);
}

interface OutboxRow {
  id: string; organization_id: string; appointment_id: string; kind: EmailKind; dedupe_key: string; previous: string | null;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'not_configured' | 'superseded' | 'unknown';
  attempts: number; next_attempt_at: string | null; last_error: string | null;
}

function outboxRow(id: string): OutboxRow {
  return db.prepare('SELECT * FROM email_outbox WHERE id = ?').get(id) as OutboxRow;
}

function setOutbox(id: string, fields: Partial<Pick<OutboxRow, 'status' | 'next_attempt_at' | 'last_error'>> & { provider_message_id?: string | null; sent_at?: string }) {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE email_outbox SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
    .run(...cols.map(c => (fields as Record<string, unknown>)[c] ?? null), id);
}

/** What a caller is told about an email that is already queued or finished. */
function resultOf(row: OutboxRow): DeliveryResult {
  switch (row.status) {
    case 'sent': return { status: 'sent' };
    case 'pending': return { status: 'retrying', error: row.last_error ?? undefined, nextAttemptAt: row.next_attempt_at ?? undefined };
    case 'sending': return { status: 'retrying' };
    case 'not_configured': return { status: 'not_configured' };
    case 'unknown': return { status: 'failed', error: row.last_error ?? 'Delivery outcome unknown' };
    default: return { status: 'failed', error: row.last_error ?? undefined };
  }
}

/** True when the booking changed so that this email would now be wrong (e.g. a confirmation for a cancelled booking). */
function superseded(kind: EmailKind, appointment: AppointmentRow): boolean {
  return kind === 'cancellation' ? appointment.status !== 'cancelled' : appointment.status === 'cancelled';
}

/** Temporary problems are worth retrying; everything else (bad address, rejected recipient, wrong credentials) is not. */
function isTransient(e: unknown): boolean {
  const err = e as { transient?: boolean; responseCode?: number; code?: string };
  if (typeof err.transient === 'boolean') return err.transient;
  if (typeof err.responseCode === 'number') return err.responseCode >= 400 && err.responseCode < 500;
  return ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE'].includes(err.code ?? '');
}

function messageIdFor(outboxId: string, from: string): string {
  const domain = /@([A-Za-z0-9.-]+)/.exec(from)?.[1] ?? 'workeasy360.local';
  return `<${outboxId}@${domain}>`;
}

/**
 * Makes one delivery attempt for a queued email. Claiming the row (pending → sending) is atomic,
 * so concurrent callers cannot send the same email twice.
 */
async function attemptDelivery(outboxId: string, now = Date.now()): Promise<DeliveryResult> {
  const claimed = db.prepare(
    `UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND status = 'pending'`
  ).run(outboxId).changes;
  const job = outboxRow(outboxId);
  if (!claimed) return resultOf(job);

  const row = loadAppointment(job.appointment_id);
  if (!row) { setOutbox(outboxId, { status: 'failed', last_error: 'Appointment no longer exists' }); return { status: 'failed', error: 'Appointment not found' }; }
  if (superseded(job.kind, row)) {
    setOutbox(outboxId, { status: 'superseded', last_error: `Not sent: the booking is now ${row.status}` });
    return { status: 'failed', error: 'The booking changed before this email could be sent' };
  }

  let cfg: EmailConfig;
  try { cfg = getConfig(); }
  catch (e) {
    const error = redactError((e as Error).message);
    record(row, job.kind, 'failed', 'invalid-config', undefined, error);
    setOutbox(outboxId, { status: 'failed', last_error: error });
    return { status: 'failed', error };
  }
  if (cfg.transport === 'disabled') {
    // Not retried: turning email on later must not send a backlog of old booking emails.
    record(row, job.kind, 'not_configured', 'disabled');
    setOutbox(outboxId, { status: 'not_configured' });
    console.log(`[email] ${job.kind} for ${row.id}: not sent (email is not configured)`);
    return { status: 'not_configured' };
  }
  if (!isDeliverableAddress(row.customer_email)) {
    const error = 'Invalid recipient address';
    record(row, job.kind, 'failed', cfg.transport, undefined, error);
    setOutbox(outboxId, { status: 'failed', last_error: error });
    return { status: 'failed', error };
  }

  const prefs = getPreferences(row.organization_id);
  const custom = getTemplate(row.organization_id, job.kind);
  const message = renderAppointmentEmail(job.kind, {
    language: prefs.bookingLanguage,
    custom: custom ? { subject: custom.subject, intro: custom.intro } : undefined,
    businessName: row.org_name,
    customerName: row.customer_name,
    bookingRef: row.booking_ref,
    serviceName: row.service_name,
    staffName: row.staff_name,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    // The zone the appointment is recorded in (the same as the business's after any zone change).
    timezone: row.appt_timezone ?? row.org_timezone ?? DEFAULT_TIMEZONE,
    timeFormat: row.time_format === '24h' ? '24h' : '12h',
    location: row.location ?? undefined,
    // Signed, expiring link bound to this appointment and address; kept in the fragment so it never reaches server logs.
    manageUrl: `${cfg.appUrl}/book/lookup/manage#token=${encodeURIComponent(issueManageToken(row.id, row.customer_email, emailLinkExpiry(row.date)))}`,
    previous: job.previous ? JSON.parse(job.previous) : undefined,
  });

  try {
    // A stable Message-ID lets mail systems recognise a resend of the same outbox email.
    // The booking's calendar file rides along, so the customer can add it (or update/cancel it) in any calendar app.
    const ics = appointmentIcs(row.id, { manageUrl: kindLinksManage(job.kind) ? manageUrlFor(cfg, row) : undefined });
    const attachments = ics ? [{ filename: ics.filename, content: ics.content, contentType: `text/calendar; charset=utf-8; method=${job.kind === 'cancellation' ? 'CANCEL' : 'PUBLISH'}` }] : undefined;
    const messageId = await deliver(cfg, row.customer_email, { ...message, attachments }, messageIdFor(outboxId, cfg.from));
    record(row, job.kind, 'sent', cfg.transport, messageId);
    setOutbox(outboxId, { status: 'sent', last_error: null, provider_message_id: messageId ?? null, sent_at: nowIso() });
    console.log(`[email] ${job.kind} for ${row.id}: sent via ${cfg.transport} (attempt ${job.attempts})`);
    return { status: 'sent' };
  } catch (e) {
    const error = redactError((e as Error).message || 'Unknown delivery error');
    record(row, job.kind, 'failed', cfg.transport, undefined, error);
    const delays = cfg.retryDelaysMs;
    if (isTransient(e) && job.attempts <= delays.length) {
      const nextAttemptAt = nowIso(now + delays[job.attempts - 1]);
      setOutbox(outboxId, { status: 'pending', next_attempt_at: nextAttemptAt, last_error: error });
      console.warn(`[email] ${job.kind} for ${row.id}: attempt ${job.attempts} failed via ${cfg.transport}, retrying at ${nextAttemptAt}: ${error}`);
      return { status: 'retrying', error, nextAttemptAt };
    }
    setOutbox(outboxId, { status: 'failed', last_error: error });
    console.warn(`[email] ${job.kind} for ${row.id}: FAILED via ${cfg.transport} after ${job.attempts} attempt(s): ${error}`);
    return { status: 'failed', error };
  }
}

/**
 * Queues a booking email to the appointment's customer and makes the first attempt right away.
 * Idempotent per booking event: the confirmation once per appointment; reschedule and cancellation once per change
 * (keyed by the appointment's updated_at). Manual resends are always new emails.
 * Never throws: the booking has already been saved, so callers report the returned status instead.
 */
export async function sendAppointmentEmail(
  kind: EmailKind,
  appointmentId: string,
  previous?: { date: string; startTime: string; endTime: string },
  opts: { manual?: boolean } = {},
): Promise<DeliveryResult> {
  const row = loadAppointment(appointmentId);
  if (!row) return { status: 'failed', error: 'Appointment not found' };
  // Booking events also alert the staff member when the business turned that on (queued once per event).
  if (!opts.manual && eventHook) {
    try { eventHook(kind, row, previous); } catch (e) { console.error('[email] staff alert could not be queued:', e instanceof Error ? e.message : e); }
  }
  const dedupeKey = opts.manual
    ? `resend:${kind}:${appointmentId}:${nanoid(10)}`
    : kind === 'confirmation' ? `confirmation:${appointmentId}` : `${kind}:${appointmentId}:${row.updated_at}`;
  const id = `out-${nanoid(12)}`;
  const queued = db.prepare(
    `INSERT OR IGNORE INTO email_outbox (id, organization_id, appointment_id, kind, dedupe_key, previous, status, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(id, row.organization_id, row.id, kind, dedupeKey, previous ? JSON.stringify(previous) : null).changes;
  if (!queued) {
    // The same event was already handled: report what happened instead of sending a second copy.
    return resultOf(db.prepare('SELECT * FROM email_outbox WHERE dedupe_key = ?').get(dedupeKey) as OutboxRow);
  }
  return attemptDelivery(id);
}

/** Retries emails whose next attempt is due. Safe to run from several places at once (rows are claimed). */
export async function processDueEmails(now = Date.now()): Promise<{ attempted: number; sent: number; retrying: number; failed: number }> {
  const due = db.prepare(
    `SELECT id FROM email_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50`
  ).all(nowIso(now)) as Array<{ id: string }>;
  const summary = { attempted: 0, sent: 0, retrying: 0, failed: 0 };
  for (const { id } of due) {
    const result = await attemptDelivery(id, now);
    summary.attempted++;
    if (result.status === 'sent') summary.sent++;
    else if (result.status === 'retrying') summary.retrying++;
    else summary.failed++;
  }
  return summary;
}

/** At startup: emails that were being sent when the server stopped have an unknown outcome and are not resent. */
export function recoverInterruptedEmails(): number {
  const n = db.prepare(
    `UPDATE email_outbox SET status = 'unknown', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       last_error = 'Delivery outcome unknown: the server stopped while sending. Not retried automatically, to avoid a duplicate; resend it if needed.'
     WHERE status = 'sending'`
  ).run().changes;
  if (n) console.warn(`[email] ${n} email(s) were interrupted by a restart; marked "unknown" and not resent automatically`);
  return n;
}

let worker: NodeJS.Timeout | null = null;
let running = false;

// ─── Hooks for reminders and staff alerts (services/email/notifications.ts) ─────────────────────────────────────────

type AppointmentEventHook = (kind: EmailKind, row: AppointmentRow, previous?: { date: string; startTime: string; endTime: string }) => void;
let eventHook: AppointmentEventHook | null = null;
let workerTask: ((now: number) => Promise<void>) | null = null;

export function registerAppointmentEventHook(fn: AppointmentEventHook | null): void { eventHook = fn; }
export function registerWorkerTask(fn: ((now: number) => Promise<void>) | null): void { workerTask = fn; }

export type DirectResult = { status: 'sent' | 'not_configured' | 'failed'; transport: string; error?: string; transient?: boolean; messageId?: string };

/**
 * Sends one message now through the configured transport, for notifications outside the booking outbox. Never throws.
 * Disabled email is "not_configured" (not retried); a recipient outside EMAIL_ALLOWED_RECIPIENTS is a permanent failure.
 */
export async function sendDirect(to: string, message: { subject: string; text: string; html: string; attachments?: EmailAttachment[] }, messageId?: string): Promise<DirectResult> {
  let cfg: EmailConfig;
  try { cfg = getConfig(); } catch (e) { return { status: 'failed', transport: 'invalid-config', error: redactError((e as Error).message) }; }
  if (cfg.transport === 'disabled') return { status: 'not_configured', transport: 'disabled' };
  if (!isDeliverableAddress(to)) return { status: 'failed', transport: cfg.transport, error: 'Invalid recipient address' };
  try {
    const id = await deliver(cfg, to, message, messageId ? messageIdFor(messageId, cfg.from) : undefined);
    return { status: 'sent', transport: cfg.transport, messageId: id };
  } catch (e) {
    return { status: 'failed', transport: cfg.transport, error: redactError((e as Error).message || 'Unknown delivery error'), transient: isTransient(e) };
  }
}

/** The app's address, for links in staff emails. */
export function appUrl(): string {
  return getConfig().appUrl ?? '';
}

/**
 * Background retries for the running server: booking emails, then account emails (with the account queue's 7-day
 * cleanup). Not used by tests, which call processDueEmails and processDueAccountEmails directly.
 */
export function startEmailWorker(intervalMs = getConfig().workerIntervalMs): void {
  if (worker) return;
  worker = setInterval(() => {
    if (running) return;
    running = true;
    (async () => {
      await processDueEmails().catch(e => console.error('[email] retry worker failed:', e instanceof Error ? e.message : e));
      if (workerTask) await workerTask(Date.now()).catch(e => console.error('[email] reminders and alerts failed:', e instanceof Error ? e.message : e));
      await processDueAccountEmails().catch(e => console.error('[email] account retry worker failed:', e instanceof Error ? e.message : e));
      try { pruneAccountEmailQueue(); } catch (e) { console.error('[email] account queue cleanup failed:', e instanceof Error ? e.message : e); }
    })().finally(() => { running = false; });
  }, intervalMs);
  worker.unref();
}

export function stopEmailWorker(): void {
  if (worker) clearInterval(worker);
  worker = null;
}

/**
 * Hands one message to the configured transport and returns the provider's message id.
 * Throws unless the transport accepted it; "sent" is never reported on a guess.
 * Every email goes through here, so EMAIL_ALLOWED_RECIPIENTS is enforced here, before any transport is touched: a
 * recipient outside it is a permanent failure (never retried) whose message names no address.
 */
const kindLinksManage = (kind: EmailKind) => kind !== 'cancellation';
function manageUrlFor(cfg: EmailConfig, row: AppointmentRow): string {
  return `${cfg.appUrl}/book/lookup/manage#token=${encodeURIComponent(issueManageToken(row.id, row.customer_email, emailLinkExpiry(row.date)))}`;
}

async function deliver(cfg: EmailConfig, to: string, message: { subject: string; text: string; html: string; attachments?: EmailAttachment[] }, messageId?: string): Promise<string | undefined> {
  if (!isRecipientAllowed(cfg.allowedRecipients, to)) throw new RecipientNotAllowedError();
  const subject = message.subject.replace(/[\r\n]+/g, ' ');
  if (cfg.transport === 'memory') {
    if (failNext > 0) {
      failNext--;
      const err = Object.assign(new Error(`Simulated ${failMode} delivery failure for ${to}`), { transient: failMode === 'transient' });
      throw err;
    }
    outbox.push({ to, from: cfg.from, subject, text: message.text, html: message.html, messageId, attachments: message.attachments });
    return messageId ?? `memory-${outbox.length}`;
  }
  const info = await smtp!.sendMail({
    from: cfg.from, to, subject, text: message.text, html: message.html, ...(messageId ? { messageId } : {}),
    ...(message.attachments?.length ? { attachments: message.attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })) } : {}),
  });
  if (info.rejected?.length || !info.accepted?.length) throw new Error('Recipient rejected by mail server');
  return info.messageId;
}

/** Sends a staff invitation. The token goes only into this email, which is what proves the address belongs to them. */
export async function sendInvitationEmail(
  to: string,
  data: Omit<InvitationEmailData, 'acceptUrl'>,
  token: string,
): Promise<DeliveryResult> {
  let cfg: EmailConfig;
  try { cfg = getConfig(); }
  catch (e) { return { status: 'failed', error: redactError((e as Error).message) }; }
  if (cfg.transport === 'disabled') return { status: 'not_configured' };
  if (!isDeliverableAddress(to)) return { status: 'failed', error: 'Invalid recipient address' };
  try {
    // The token sits in the fragment, so it is never sent to a server or written to access logs.
    await deliver(cfg, to, renderInvitationEmail({ ...data, acceptUrl: `${cfg.appUrl}/accept-invite#token=${encodeURIComponent(token)}` }));
    console.log(`[email] staff invitation: sent via ${cfg.transport}`);
    return { status: 'sent' };
  } catch (e) {
    const error = redactError((e as Error).message || 'Unknown delivery error');
    console.warn(`[email] staff invitation: FAILED via ${cfg.transport}: ${error}`);
    return { status: 'failed', error };
  }
}

/** Every attempt for an appointment, plus emails still waiting for a retry or with an unknown outcome. */
export function listDeliveries(orgId: string, appointmentId: string) {
  const attempts = db.prepare(
    `SELECT id, kind, status, transport, error, created_at AS createdAt
     FROM email_deliveries WHERE organization_id = ? AND appointment_id = ?`
  ).all(orgId, appointmentId) as Array<{ id: string; kind: string; status: string; transport: string; error: string | null; createdAt: string; nextAttemptAt?: string }>;
  const open = db.prepare(
    `SELECT id, kind, status, last_error, next_attempt_at, updated_at FROM email_outbox
     WHERE organization_id = ? AND appointment_id = ? AND status IN ('pending', 'sending', 'unknown')`
  ).all(orgId, appointmentId) as Array<{ id: string; kind: string; status: string; last_error: string | null; next_attempt_at: string | null; updated_at: string }>;
  for (const o of open) {
    attempts.push({
      id: o.id, kind: o.kind, status: o.status === 'unknown' ? 'unknown' : 'retrying', transport: 'outbox',
      error: o.last_error, createdAt: o.updated_at, nextAttemptAt: o.status === 'pending' ? o.next_attempt_at ?? undefined : undefined,
    });
  }
  // Reminders to the customer and alerts to the staff member (services/email/notifications.ts).
  const notes = db.prepare(
    `SELECT id, kind, status, last_error, next_attempt_at, updated_at FROM notification_queue
     WHERE organization_id = ? AND appointment_id = ? AND status != 'skipped'`
  ).all(orgId, appointmentId) as Array<{ id: string; kind: string; status: string; last_error: string | null; next_attempt_at: string | null; updated_at: string }>;
  for (const n of notes) {
    attempts.push({
      id: n.id, kind: n.kind, status: n.status === 'pending' || n.status === 'sending' ? 'retrying' : n.status, transport: 'notifications',
      error: n.last_error, createdAt: n.updated_at, nextAttemptAt: n.status === 'pending' ? n.next_attempt_at ?? undefined : undefined,
    });
  }
  return attempts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── Account emails (sign-up confirmation, sign-in help, password reset, password changed) ─────────────────────────
// Every account email is recorded in account_email_queue (migration 009) in the same transaction that creates its
// request, and its first attempt starts at once in the background. Temporary failures are retried by the email worker
// from the queue, so a restart no longer loses them. The queue never holds a token, link, message or address: links
// are stored only as hashes, so every retry gets a NEW link from account-tokens.ts (with the original expiry) and the
// earlier link stops working (newest link wins). The requester is never told the outcome, so delivery cannot reveal
// whether an account exists. Logs name the kind of email only: no recipient, no link.
//
// Limits (the decisions in docs/proposals/009-account-email-queue.md):
//   - send deadline (expires_at): 1 hour after the request, 24 hours for the password-changed notice (it has no link),
//     and never later than the link's own expiry; a retry never extends that expiry;
//   - a row left in `sending` for STALE_SENDING_MS (the process stopped mid-attempt) is retried with a new link, so the
//     person can receive two emails; the first link then says a newer one was sent;
//   - finished rows (sent, failed, superseded, expired) are deleted 7 days after their last change; pending and sending
//     rows never are.

export const ACCOUNT_EMAIL_MAX_AGE_MS = 60 * 60_000;
export const PASSWORD_CHANGED_MAX_AGE_MS = 24 * 60 * 60_000;
export const ACCOUNT_QUEUE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const STALE_SENDING_MS = 5 * 60_000;
export const FINISHED_ACCOUNT_EMAIL_STATUSES = ['sent', 'failed', 'superseded', 'expired'] as const;

export type AccountEmailStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'superseded' | 'expired';
export interface AccountQueueRow {
  id: string; kind: AccountEmailKind; user_id: string | null; signup_request_id: string | null; password_reset_id: string | null;
  status: AccountEmailStatus; attempts: number; next_attempt_at: string | null; expires_at: string; changed_at: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}
export interface AccountEmailData { name?: string; company?: string; token?: string; changedAt?: string }
/** What a retry sends (a fresh link, or a link-free notice, and its recipient), or why nothing is sent. */
export type AccountEmailRetry = { send: true; to: string; data: AccountEmailData } | { send: false; outcome: 'superseded' | 'expired' };

const accountSends = new Set<Promise<void>>();
let prepareRetry: ((row: AccountQueueRow, now: number) => AccountEmailRetry) | null = null;

/** account-tokens.ts registers how a retry gets its recipient and a fresh link; this module never handles stored tokens. */
export function registerAccountEmailRetry(fn: (row: AccountQueueRow, now: number) => AccountEmailRetry): void {
  prepareRetry = fn;
}

/** Whether account emails can be sent at all (false while email is disabled or misconfigured). */
export function accountEmailAvailable(): boolean {
  try { return getConfig().transport !== 'disabled'; } catch { return false; }
}

/** Resolves once every account email started so far has had its first attempt (for tests). */
export async function accountEmailsSettled(): Promise<void> {
  await Promise.all([...accountSends]);
}

function accountRow(id: string): AccountQueueRow | undefined {
  return db.prepare('SELECT * FROM account_email_queue WHERE id = ?').get(id) as AccountQueueRow | undefined;
}

/**
 * Moves a row from one status to another; nothing happens if another caller changed it first. With `attempt`, only
 * the outcome of that attempt is recorded: a late result from an attempt that was given up on cannot overwrite a newer one.
 */
function moveAccountRow(id: string, from: AccountEmailStatus, to: AccountEmailStatus, now: number,
  fields: { next_attempt_at?: string | null; last_error?: string | null; attempt?: number } = {}): boolean {
  return db.prepare(
    `UPDATE account_email_queue SET status = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ? AND status = ? AND (? IS NULL OR attempts = ?)`
  ).run(to, fields.next_attempt_at ?? null, fields.last_error ?? null, nowIso(now), id, from, fields.attempt ?? null, fields.attempt ?? null).changes === 1;
}

/**
 * Records an account email in the queue. Call it inside the transaction that creates the request, then pass the
 * returned id to sendAccountEmail. The row starts as `sending` because its first attempt follows at once, so no worker
 * can claim it in the meantime.
 */
export function queueAccountEmail(
  kind: AccountEmailKind,
  ref: { userId?: string; signupRequestId?: string; passwordResetId?: string },
  opts: { linkExpiresAt?: string; changedAt?: string; now?: number } = {},
): string {
  const now = opts.now ?? Date.now();
  const maxAge = kind === 'password_changed' ? PASSWORD_CHANGED_MAX_AGE_MS : ACCOUNT_EMAIL_MAX_AGE_MS;
  const deadline = Math.min(now + maxAge, opts.linkExpiresAt ? Date.parse(opts.linkExpiresAt) : Infinity);
  const id = `acct-${nanoid(12)}`;
  db.prepare(
    `INSERT INTO account_email_queue (id, kind, user_id, signup_request_id, password_reset_id, status, attempts, expires_at, changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'sending', 1, ?, ?, ?, ?)`
  ).run(id, kind, ref.userId ?? null, ref.signupRequestId ?? null, ref.passwordResetId ?? null, nowIso(deadline), opts.changedAt ?? null, nowIso(now), nowIso(now));
  return id;
}

/** Newest link wins: pending retries of these requests are never sent. Call in the transaction that replaces or uses the links. */
function supersedeQueued(where: string, args: unknown[], now: number): number {
  const rows = db.prepare(`SELECT id, kind FROM account_email_queue WHERE status = 'pending' AND ${where}`).all(...args) as Array<{ id: string; kind: AccountEmailKind }>;
  let n = 0;
  for (const r of rows) {
    if (moveAccountRow(r.id, 'pending', 'superseded', now, { last_error: 'Not sent: the link was replaced or used, or is no longer valid' })) {
      n++;
      console.log(`[email] account ${r.kind}: superseded, not sent (the link was replaced or used, or is no longer valid)`);
    }
  }
  return n;
}
/** A new sign-up or "Send a new link" for this address replaces its unconfirmed requests. */
export const supersedeQueuedSignupEmails = (email: string, now = Date.now()) =>
  supersedeQueued('signup_request_id IN (SELECT id FROM signup_requests WHERE email = ? AND verified_at IS NULL AND superseded_at IS NULL)', [email], now);
/** A new reset request, a password change in Settings or a completed reset ends the account's open reset links. */
export const supersedeQueuedResetEmails = (userId: string, now = Date.now()) =>
  supersedeQueued('password_reset_id IN (SELECT id FROM password_resets WHERE user_id = ? AND used_at IS NULL AND superseded_at IS NULL)', [userId], now);
/** The request itself was used (the address confirmed, or the reset completed). */
export const supersedeQueuedEmailForSignupRequest = (signupRequestId: string, now = Date.now()) =>
  supersedeQueued('signup_request_id = ?', [signupRequestId], now);
export const supersedeQueuedEmailForPasswordReset = (passwordResetId: string, now = Date.now()) =>
  supersedeQueued('password_reset_id = ?', [passwordResetId], now);

function renderAccount(cfg: EmailConfig, kind: AccountEmailKind, data: AccountEmailData) {
  const path = kind === 'password_reset' ? '/reset-password' : '/verify-email';
  return renderAccountEmail(kind, {
    name: data.name,
    company: data.company,
    changedAt: data.changedAt,
    actionUrl: data.token ? `${cfg.appUrl}${path}#token=${encodeURIComponent(data.token)}` : undefined,
    signInUrl: `${cfg.appUrl}/login`,
    forgotUrl: `${cfg.appUrl}/forgot-password`,
  });
}

/** Records the outcome of attempt `attempt` of a row, and schedules the next attempt if one fits before the deadline. */
function settleAccountAttempt(id: string, attempt: number, kind: AccountEmailKind, cfg: EmailConfig, error: { message: string; transient: boolean } | null, now: number): void {
  const row = accountRow(id);
  if (!row || row.status !== 'sending' || row.attempts !== attempt) return;
  if (!error) {
    moveAccountRow(id, 'sending', 'sent', now, { attempt });
    console.log(`[email] account ${kind}: sent via ${cfg.transport}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
    return;
  }
  const delay = cfg.retryDelaysMs[attempt - 1];
  if (!error.transient || delay === undefined) {
    moveAccountRow(id, 'sending', 'failed', now, { last_error: error.message, attempt });
    console.warn(`[email] account ${kind}: FAILED via ${cfg.transport} after ${attempt} attempt(s): ${error.message}`);
  } else if (now + delay >= Date.parse(row.expires_at)) {
    // The next attempt would fall at or after the deadline: the email is given up, never sent late.
    moveAccountRow(id, 'sending', 'expired', now, { last_error: error.message, attempt });
    console.warn(`[email] account ${kind}: EXPIRED after attempt ${attempt} failed via ${cfg.transport}: no retry fits before its age limit; not sent: ${error.message}`);
  } else {
    moveAccountRow(id, 'sending', 'pending', now, { next_attempt_at: nowIso(now + delay), last_error: error.message, attempt });
    console.warn(`[email] account ${kind}: attempt ${attempt} failed via ${cfg.transport}, retrying in ${Math.round(delay / 1000)}s: ${error.message}`);
  }
}

/** Queue rows with an attempt running in this process: recovery never touches them, however long the attempt takes. */
const activeAccountAttempts = new Set<string>();

async function attemptAccountEmail(cfg: EmailConfig, kind: AccountEmailKind, to: string, data: AccountEmailData,
  queued: { id: string; attempt: number } | undefined, at?: number): Promise<void> {
  let error: { message: string; transient: boolean } | null = null;
  if (queued) activeAccountAttempts.add(queued.id);
  try {
    await deliver(cfg, to, renderAccount(cfg, kind, data));
  } catch (e) {
    error = { message: redactError((e as Error).message || 'Unknown delivery error'), transient: isTransient(e) };
  } finally {
    if (queued) activeAccountAttempts.delete(queued.id);
  }
  if (queued) { settleAccountAttempt(queued.id, queued.attempt, kind, cfg, error, at ?? Date.now()); return; }
  // Without a queue row (only tests call it that way) there is nothing to retry from.
  if (error) console.warn(`[email] account ${kind}: FAILED via ${cfg.transport} after 1 attempt(s): ${error.message}`);
  else console.log(`[email] account ${kind}: sent via ${cfg.transport}`);
}

/**
 * Starts the first attempt of a queued account email and returns at once. Links are built from PUBLIC_APP_URL, with
 * the token in the fragment so it never reaches a server or an access log.
 */
export function sendAccountEmail(kind: AccountEmailKind, to: string, data: AccountEmailData, queueId?: string): void {
  const notSent = (reason: string) => {
    console.warn(`[email] account ${kind}: not sent (${reason})`);
    if (queueId) moveAccountRow(queueId, 'sending', 'failed', Date.now(), { last_error: `Not sent: ${reason}`, attempt: 1 });
  };
  let cfg: EmailConfig;
  try { cfg = getConfig(); } catch { notSent('email settings are invalid'); return; }
  if (cfg.transport === 'disabled') { notSent('email is not configured'); return; }
  if (!isDeliverableAddress(to)) { notSent('not a plain email address'); return; }
  const first = attemptAccountEmail(cfg, kind, to, data, queueId ? { id: queueId, attempt: 1 } : undefined);
  accountSends.add(first);
  void first.finally(() => accountSends.delete(first));
}

/** Claims a due row (pending → sending) for one attempt. Atomic: of several callers, exactly one wins. */
export function claimAccountEmail(id: string, now = Date.now()): boolean {
  return db.prepare(
    `UPDATE account_email_queue SET status = 'sending', attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND status = 'pending' AND next_attempt_at <= ? AND expires_at > ?`
  ).run(nowIso(now), id, nowIso(now), nowIso(now)).changes === 1;
}

/**
 * A row still `sending` after STALE_SENDING_MS was interrupted (the process stopped mid-attempt): it goes back to
 * `pending` and its retry gets a new link. Rows in `sending` for less than that are left alone, so an attempt that is
 * still running is never started a second time.
 */
export function recoverInterruptedAccountEmails(now = Date.now(), staleMs = STALE_SENDING_MS): number {
  const cutoff = nowIso(now - staleMs);
  const stale = db.prepare(`SELECT id, kind FROM account_email_queue WHERE status = 'sending' AND updated_at <= ?`).all(cutoff) as Array<{ id: string; kind: AccountEmailKind }>;
  let n = 0;
  for (const r of stale) {
    if (activeAccountAttempts.has(r.id)) continue;
    const moved = db.prepare(
      `UPDATE account_email_queue SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND updated_at <= ?`
    ).run(nowIso(now), nowIso(now), r.id, cutoff).changes;
    if (moved) {
      n++;
      const link = r.kind === 'existing_account' || r.kind === 'password_changed' ? '' : ' with a new link';
      console.warn(`[email] account ${r.kind}: an interrupted attempt was found; it will be retried${link}`);
    }
  }
  return n;
}

/** Pending rows past their send deadline are never sent. */
function expireOverdueAccountEmails(now: number): number {
  const rows = db.prepare(`SELECT id, kind FROM account_email_queue WHERE status = 'pending' AND expires_at <= ?`).all(nowIso(now)) as Array<{ id: string; kind: AccountEmailKind }>;
  let n = 0;
  for (const r of rows) {
    if (moveAccountRow(r.id, 'pending', 'expired', now, { last_error: 'Not sent: past its age limit or its link expiry' })) {
      n++;
      console.warn(`[email] account ${r.kind}: EXPIRED, not sent (past its age limit or its link expiry)`);
    }
  }
  return n;
}

/** One attempt for a claimed row: a fresh link (or the link-free notice), then delivery. Returns the row's new status. */
async function retryAccountEmail(id: string, now: number): Promise<AccountEmailStatus> {
  const row = accountRow(id);
  if (!row || row.status !== 'sending') return 'superseded'; // deleted with its request in the meantime
  const attempt = row.attempts;
  const finish = (to: AccountEmailStatus, reason: string, log: string): AccountEmailStatus => {
    moveAccountRow(id, 'sending', to, now, { last_error: reason, attempt });
    console.warn(log);
    return to;
  };
  let cfg: EmailConfig;
  try { cfg = getConfig(); } catch { return finish('failed', 'Not sent: email settings are invalid', `[email] account ${row.kind}: not sent (email settings are invalid)`); }
  if (cfg.transport === 'disabled') return finish('failed', 'Not sent: email is not configured', `[email] account ${row.kind}: not sent (email is not configured)`);
  let prepared: AccountEmailRetry;
  try {
    if (!prepareRetry) throw new Error('No retry handler is registered');
    prepared = prepareRetry(row, now);
  } catch (e) {
    const error = redactError((e as Error).message || 'Unknown error');
    return finish('failed', error, `[email] account ${row.kind}: FAILED while preparing the retry: ${error}`);
  }
  if (!prepared.send) {
    return prepared.outcome === 'expired'
      ? finish('expired', 'Not sent: the link expired', `[email] account ${row.kind}: EXPIRED, not sent (the link expired)`)
      : finish('superseded', 'Not sent: the link was replaced or used, or is no longer valid',
        `[email] account ${row.kind}: superseded, not sent (the link was replaced or used, or is no longer valid)`);
  }
  if (!isDeliverableAddress(prepared.to)) return finish('failed', 'Not sent: not a plain email address', `[email] account ${row.kind}: not sent (not a plain email address)`);
  await attemptAccountEmail(cfg, row.kind, prepared.to, prepared.data, { id, attempt }, now);
  return accountRow(id)?.status ?? 'failed';
}

/** One worker run: recover interrupted rows, expire overdue ones, then retry the rows that are due. */
export async function processDueAccountEmails(now = Date.now()): Promise<{ attempted: number; sent: number; retrying: number; failed: number; expired: number; superseded: number }> {
  recoverInterruptedAccountEmails(now);
  const summary = { attempted: 0, sent: 0, retrying: 0, failed: 0, expired: expireOverdueAccountEmails(now), superseded: 0 };
  const due = db.prepare(
    `SELECT id FROM account_email_queue WHERE status = 'pending' AND next_attempt_at <= ? AND expires_at > ? ORDER BY next_attempt_at LIMIT 50`
  ).all(nowIso(now), nowIso(now)) as Array<{ id: string }>;
  for (const { id } of due) {
    if (!claimAccountEmail(id, now)) continue;
    summary.attempted++;
    const status = await retryAccountEmail(id, now);
    if (status === 'sent') summary.sent++;
    else if (status === 'pending') summary.retrying++;
    else if (status === 'expired') summary.expired++;
    else if (status === 'superseded') summary.superseded++;
    else summary.failed++;
  }
  return summary;
}

/** Deletes finished rows (sent, failed, superseded, expired) 7 days after their last change; never pending or sending ones. */
export function pruneAccountEmailQueue(now = Date.now()): number {
  const n = db.prepare(
    `DELETE FROM account_email_queue WHERE status IN ('sent', 'failed', 'superseded', 'expired') AND updated_at < ?`
  ).run(nowIso(now - ACCOUNT_QUEUE_RETENTION_MS)).changes;
  if (n) console.log(`[email] account queue: removed ${n} finished row(s) older than 7 days`);
  return n;
}
