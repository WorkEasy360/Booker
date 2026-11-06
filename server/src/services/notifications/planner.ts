import { nanoid } from 'nanoid';
import db from '../../db/init';
import { toE164 } from '../../lib/phone';
import { zonedToInstant } from '../zoned-time';
import { DEFAULT_TIMEZONE } from '../business-locale';
import { consentFor, listRecipients, orgSettings, ruleEnabled, staffSettings } from './settings';
import { loadAppointmentInfo, statusChangeRelevant, type AppointmentInfo } from './messages';
import { MESSAGE_CHANNELS, type Channel, type MessageChannel, type NotificationEvent, type RecipientRole } from './types';

// The one place that decides who is told what (migration 017). It is called from the appointment history recorder,
// inside the same transaction as every change (public booking, dashboard, assistant, customer link), so a change and its
// notification jobs are saved together, and nothing is planned for a change that was rolled back. Jobs only say what
// to send; the worker sends them after the commit. Cases that cannot be sent (no consent, no valid number, opted out)
// are recorded as skipped with the reason, so delivery status is never silently missing.

export interface Change {
  entryId: string;
  action: 'created' | 'status_changed' | 'rescheduled' | 'reassigned' | 'deleted';
  fromStatus?: string | null; toStatus?: string | null;
  fromDate?: string | null; fromStartTime?: string | null;
  fromStaffId?: string | null; toStaffId?: string | null;
}

const ACTIVE = ['scheduled', 'confirmed'];
export const REMINDER_GRACE_MS = 15 * 60_000;
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const slotOf = (a: { date: string; start_time: string }) => `${a.date}T${a.start_time}`;

interface NewJob {
  a: AppointmentInfo; event: NotificationEvent; role: RecipientRole; recipientId: string; channel: Channel; dedupe: string;
  status?: 'pending' | 'skipped'; reason?: string; scheduledFor?: string; previous?: unknown; offsetMinutes?: number;
}

function insertJob(j: NewJob): void {
  const due = j.scheduledFor ?? nowIso();
  db.prepare(
    `INSERT OR IGNORE INTO notification_jobs
      (id, organization_id, appointment_id, event, recipient_role, recipient_id, channel, dedupe_key, status, reason, next_attempt_at,
       scheduled_for, appointment_version, slot, previous, offset_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`njob-${nanoid(14)}`, j.a.organization_id, j.a.id, j.event, j.role, j.recipientId, j.channel, j.dedupe, j.status ?? 'pending', j.reason ?? null,
    j.status === 'skipped' ? null : due, j.scheduledFor ?? null, j.a.updated_at, slotOf(j.a), j.previous ? JSON.stringify(j.previous) : null,
    j.offsetMinutes ?? null, nowIso(), nowIso());
}

/** Why a customer cannot get this channel, or null. Email needs an address; text messages a valid number and consent. */
function customerProblem(a: AppointmentInfo, channel: MessageChannel): string | null {
  if (channel === 'email') return a.customer_email ? null : 'The customer has no email address';
  if (!a.customer_phone) return 'The customer has no phone number';
  if (!toE164(a.customer_phone)) return 'The customer\'s phone number is not valid';
  const consent = consentFor(a.customer_id)[channel];
  if (consent.status === 'revoked') return `The customer opted out of ${channel === 'sms' ? 'text messages' : 'WhatsApp messages'}`;
  if (consent.status !== 'granted') return `The customer has not agreed to ${channel === 'sms' ? 'text messages' : 'WhatsApp messages'}`;
  return null;
}

function contactProblem(channel: MessageChannel, email: string | null, phone: string | null, who: string): string | null {
  if (channel === 'email') return email ? null : `${who} has no email address`;
  if (!phone) return `${who} has no phone number`;
  return toE164(phone) ? null : `${who}'s phone number is not valid`;
}

interface Target { role: RecipientRole; recipientId: string; channel: MessageChannel; problem: string | null }

/** Everyone who should hear about this event, by channel. `staffIds` lets a staff change tell the old and new staff. */
function targets(a: AppointmentInfo, event: NotificationEvent, opts: { staffIds?: string[]; includeCustomer?: boolean; toStatus?: string } = {}): Target[] {
  const out: Target[] = [];
  const org = a.organization_id;
  if (opts.includeCustomer !== false && (event !== 'status_changed' || statusChangeRelevant('customer', opts.toStatus ?? a.status))) {
    for (const channel of MESSAGE_CHANNELS) {
      // Booking emails to the customer (confirmed, moved, cancelled) go through the email outbox (services/email/notify.ts).
      if (channel === 'email' && ['confirmed', 'rescheduled', 'cancelled'].includes(event)) continue;
      if (ruleEnabled(org, event, 'customer', channel)) out.push({ role: 'customer', recipientId: a.customer_id, channel, problem: customerProblem(a, channel) });
    }
  }
  const teamRelevant = event !== 'status_changed' || statusChangeRelevant('team', opts.toStatus ?? a.status);
  if (teamRelevant) {
    for (const staffId of opts.staffIds ?? [a.staff_id]) {
      const s = db.prepare('SELECT id, name, email, phone, is_active FROM staff WHERE id = ? AND organization_id = ?').get(staffId, org) as
        { id: string; name: string; email: string; phone: string | null; is_active: number } | undefined;
      if (!s || !s.is_active) continue;
      const prefs = staffSettings(s.id);
      if (!prefs.events.includes(event)) continue;
      for (const channel of prefs.channels) {
        if (ruleEnabled(org, event, 'staff', channel)) out.push({ role: 'staff', recipientId: s.id, channel, problem: contactProblem(channel, s.email, s.phone, s.name) });
      }
    }
    for (const r of listRecipients(org, true)) {
      if (!r.events.includes(event)) continue;
      for (const channel of r.channels) out.push({ role: 'business', recipientId: r.id, channel, problem: contactProblem(channel, r.email, r.phone, r.name) });
    }
  }
  return out;
}

function fanOut(a: AppointmentInfo, event: NotificationEvent, entryId: string, opts: Parameters<typeof targets>[2] & { previous?: unknown } = {}): void {
  for (const t of targets(a, event, opts)) {
    insertJob({
      a, event, role: t.role, recipientId: t.recipientId, channel: t.channel,
      dedupe: `${event}:${entryId}:${t.role}:${t.recipientId}:${t.channel}`,
      status: t.problem ? 'skipped' : 'pending', reason: t.problem ?? undefined, previous: opts.previous,
    });
  }
}

/** The business calendar follows every change; the worker syncs the event to the appointment as it is then. */
function calendarJob(a: AppointmentInfo, entryId: string, event: NotificationEvent): void {
  const cal = orgSettings(a.organization_id).businessCalendar;
  if (!cal) return;
  insertJob({ a, event, role: 'business_calendar', recipientId: 'org', channel: cal === 'google' ? 'google_calendar' : 'outlook_calendar', dedupe: `calendar:${entryId}:${cal}` });
}

/** Pending reminders for another time (or for a booking no longer active) will not be sent. */
export function cancelObsoleteReminders(a: { id: string; date: string; start_time: string; status: string }, reason: string): number {
  const keepSlot = ACTIVE.includes(a.status) ? slotOf(a) : '';
  return db.prepare(
    `UPDATE notification_jobs SET status = 'cancelled', reason = ?, next_attempt_at = NULL, updated_at = ?
     WHERE appointment_id = ? AND event = 'reminder' AND status = 'pending' AND slot != ?`
  ).run(reason, nowIso(), a.id, keepSlot).changes;
}

/**
 * Plans the reminders of an active booking: one per configured time before the start, recipient and channel. Each has
 * a key with the booking's time, so planning again (or after a restart) adds nothing. A reminder whose time has
 * already passed when it is planned (a booking made inside the window) is recorded as skipped, never sent late.
 */
export function planReminders(a: AppointmentInfo, now = Date.now()): void {
  if (!ACTIVE.includes(a.status)) return;
  const start = zonedToInstant(a.date, a.start_time, a.timezone || DEFAULT_TIMEZONE);
  if (start <= now) return;
  const changed = Date.parse(a.updated_at);
  // The earlier reminder queue (migration 014) may have sent this booking's reminder just before an upgrade.
  const earlierSent = db.prepare(
    `SELECT MAX(COALESCE(sent_at, updated_at)) FROM notification_queue WHERE appointment_id = ? AND kind = 'reminder' AND status IN ('sent', 'sending', 'unknown') AND created_at >= ?`
  ).pluck().get(a.id, a.updated_at) as string | null;
  for (const offset of orgSettings(a.organization_id).reminderOffsets) {
    const due = start - offset * 60_000;
    for (const t of targets(a, 'reminder')) {
      // A little lateness is the worker's interval; beyond that a reminder is skipped, never sent late.
      const late = now - due > REMINDER_GRACE_MS
        ? (changed > due ? 'The booking was made or changed after this reminder time' : 'This reminder time passed while reminders could not be sent')
        : null;
      const alreadySent = t.role === 'customer' && t.channel === 'email' && earlierSent && due <= Date.parse(earlierSent) + REMINDER_GRACE_MS
        ? 'This reminder was already sent before the update' : null;
      const skip = t.problem ?? late ?? alreadySent;
      insertJob({
        a, event: 'reminder', role: t.role, recipientId: t.recipientId, channel: t.channel,
        dedupe: `reminder:${a.id}:${slotOf(a)}:${offset}:${t.role}:${t.recipientId}:${t.channel}`,
        status: skip ? 'skipped' : 'pending', reason: skip ?? undefined,
        scheduledFor: nowIso(Math.max(due, now)), offsetMinutes: offset,
      });
    }
  }
}

/** Called for every recorded appointment change, inside its transaction. */
export function planForChange(appointmentId: string, c: Change): void {
  const a = loadAppointmentInfo(appointmentId);
  if (!a) return;
  const active = ACTIVE.includes(a.status);
  switch (c.action) {
    case 'created':
      if (!active) return;
      fanOut(a, 'confirmed', c.entryId);
      calendarJob(a, c.entryId, 'confirmed');
      planReminders(a);
      return;
    case 'rescheduled': {
      const previous = c.fromDate && c.fromStartTime ? { date: c.fromDate, startTime: c.fromStartTime, endTime: c.fromStartTime } : undefined;
      cancelObsoleteReminders(a, 'The booking was moved');
      if (!active) return;
      fanOut(a, 'rescheduled', c.entryId, { previous });
      calendarJob(a, c.entryId, 'rescheduled');
      planReminders(a);
      return;
    }
    case 'reassigned':
      cancelObsoleteReminders({ ...a, status: 'reassigned' }, 'The booking moved to another staff member');
      if (!active) return;
      if (c.fromStaffId) fanOut(a, 'cancelled', c.entryId, { staffIds: [c.fromStaffId], includeCustomer: false });
      fanOut(a, 'confirmed', `${c.entryId}:new-staff`, { includeCustomer: false });
      calendarJob(a, c.entryId, 'rescheduled');
      planReminders(a);
      return;
    case 'status_changed': {
      const to = c.toStatus ?? a.status;
      const from = c.fromStatus ?? '';
      if (to === 'cancelled') {
        cancelObsoleteReminders(a, 'The booking was cancelled');
        fanOut(a, 'cancelled', c.entryId);
        calendarJob(a, c.entryId, 'cancelled');
      } else if (ACTIVE.includes(to) && !ACTIVE.includes(from)) {
        fanOut(a, 'confirmed', c.entryId); // brought back
        calendarJob(a, c.entryId, 'confirmed');
        planReminders(a);
      } else if (to === 'confirmed' || to === 'completed' || to === 'no_show') {
        if (!ACTIVE.includes(to)) cancelObsoleteReminders(a, `The booking is ${to === 'no_show' ? 'a no-show' : 'completed'}`);
        fanOut(a, 'status_changed', c.entryId, { toStatus: to });
      }
      return;
    }
    case 'deleted':
      cancelObsoleteReminders({ ...a, status: 'deleted' }, 'The booking was deleted');
      if (active) fanOut(a, 'cancelled', c.entryId, { includeCustomer: false });
      calendarJob({ ...a, status: 'cancelled' }, c.entryId, 'cancelled');
      return;
  }
}

/**
 * Safety net for the schedule: active bookings of the next 8 days get their reminders planned (nothing is added twice).
 * Covers bookings made before reminders were turned on and anything a crash interrupted.
 */
export function reconcileReminders(now = Date.now()): void {
  const from = new Date(now - 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now + 8 * 86_400_000).toISOString().slice(0, 10);
  const ids = db.prepare("SELECT id FROM appointments WHERE status IN ('scheduled', 'confirmed') AND date BETWEEN ? AND ?").pluck().all(from, to) as string[];
  for (const id of ids) {
    const a = loadAppointmentInfo(id);
    if (a) planReminders(a, now);
  }
}
