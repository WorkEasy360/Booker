import { nanoid } from 'nanoid';
import db from '../db/init';
import { queueWebhookEvent } from './integrations/webhooks';
import { planForChange } from './notifications/planner';
import { kickNotifications } from './notifications/worker';

// Change history of appointments: who created, moved, reassigned, cancelled, completed or deleted one, and when.
// Callers record inside the same transaction as the change, so a change and its history entry are saved together or
// not at all. The database refuses to edit or delete entries (migration 010_appointment_history).

export type HistorySource = 'dashboard' | 'assistant' | 'booking_page' | 'manage_link';

/** Who made a change: a signed-in user (from the dashboard or through the assistant) or the customer. */
export type HistoryActor =
  | { type: 'user'; userId: string; source: 'dashboard' | 'assistant' }
  | { type: 'customer'; source: 'booking_page' | 'manage_link' };

/** The fields the history follows, as stored on the appointment row. */
export interface AppointmentState {
  id: string; organization_id: string; booking_ref: string;
  status: string; date: string; start_time: string; staff_id: string;
}

type Action = 'created' | 'status_changed' | 'rescheduled' | 'reassigned' | 'deleted';

interface Entry {
  action: Action;
  from_status?: string | null; to_status?: string | null;
  from_date?: string | null; from_start_time?: string | null; to_date?: string | null; to_start_time?: string | null;
  from_staff_id?: string | null; to_staff_id?: string | null;
}

function insert(appt: AppointmentState, actor: HistoryActor, e: Entry): void {
  const userId = actor.type === 'user' ? actor.userId : null;
  // The name at the time of the change, so the entry still reads correctly if the sign-in is renamed or removed.
  const actorName = userId
    ? (db.prepare('SELECT name FROM users WHERE id = ? AND organization_id = ?').get(userId, appt.organization_id) as { name: string } | undefined)?.name ?? null
    : null;
  const id = `hist-${nanoid(12)}`;
  db.prepare(
    `INSERT INTO appointment_history
      (id, organization_id, appointment_id, booking_ref, action, from_status, to_status, from_date, from_start_time,
       to_date, to_start_time, from_staff_id, to_staff_id, actor_type, actor_user_id, actor_name, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, appt.organization_id, appt.id, appt.booking_ref, e.action,
    e.from_status ?? null, e.to_status ?? null, e.from_date ?? null, e.from_start_time ?? null,
    e.to_date ?? null, e.to_start_time ?? null, e.from_staff_id ?? null, e.to_staff_id ?? null,
    actor.type, userId, actorName, actor.source,
  );
  // The business's webhooks (and Zapier) get the same change, queued in the same transaction.
  queueWebhookEvent(appt.organization_id, `appointment.${e.action}`, () => webhookData(appt.id, e, actor));
  // Notifications to everyone concerned (customer, staff, business, calendar), planned in the same transaction.
  planForChange(appt.id, {
    entryId: id, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, fromDate: e.from_date, fromStartTime: e.from_start_time,
    fromStaffId: e.from_staff_id, toStaffId: e.to_staff_id,
  });
  kickNotifications();
}

/** What a webhook receives about a change: the booking as it is now, what changed and who changed it. */
function webhookData(appointmentId: string, e: Entry, actor: HistoryActor) {
  const a = db.prepare(
    `SELECT a.id, a.booking_ref, a.status, a.date, a.start_time, a.end_time, a.timezone, s.id AS service_id, s.name AS service_name,
            st.id AS staff_id, st.name AS staff_name, c.name AS customer_name, c.email AS customer_email
     FROM appointments a JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id JOIN customers c ON c.id = a.customer_id
     WHERE a.id = ?`
  ).get(appointmentId) as Record<string, string> | undefined;
  return {
    appointment: a ? {
      id: a.id, bookingRef: a.booking_ref, status: a.status, date: a.date, startTime: a.start_time, endTime: a.end_time, timezone: a.timezone,
      service: { id: a.service_id, name: a.service_name }, staff: { id: a.staff_id, name: a.staff_name },
      customer: { name: a.customer_name, email: a.customer_email },
    } : { id: appointmentId },
    change: {
      action: e.action, fromStatus: e.from_status ?? null, toStatus: e.to_status ?? null,
      from: e.from_date ? { date: e.from_date, startTime: e.from_start_time ?? null } : null,
      to: e.to_date ? { date: e.to_date, startTime: e.to_start_time ?? null } : null,
      fromStaffId: e.from_staff_id ?? null, toStaffId: e.to_staff_id ?? null,
    },
    actor: { type: actor.type, source: actor.source },
  };
}

/** Records a new appointment as it was saved. */
export function recordCreated(appt: AppointmentState, actor: HistoryActor): void {
  insert(appt, actor, {
    action: 'created', to_status: appt.status, to_date: appt.date, to_start_time: appt.start_time, to_staff_id: appt.staff_id,
  });
}

/** Records what changed between two states of one appointment: status, time and staff, one entry each. */
export function recordChanges(before: AppointmentState, after: AppointmentState, actor: HistoryActor): void {
  if (before.status !== after.status) {
    insert(after, actor, { action: 'status_changed', from_status: before.status, to_status: after.status });
  }
  if (before.date !== after.date || before.start_time !== after.start_time) {
    insert(after, actor, {
      action: 'rescheduled',
      from_date: before.date, from_start_time: before.start_time, to_date: after.date, to_start_time: after.start_time,
    });
  }
  if (before.staff_id !== after.staff_id) {
    insert(after, actor, { action: 'reassigned', from_staff_id: before.staff_id, to_staff_id: after.staff_id });
  }
}

/** Records that an appointment was deleted; the entry outlives the appointment. */
export function recordDeleted(before: AppointmentState, actor: HistoryActor): void {
  insert(before, actor, {
    action: 'deleted', from_status: before.status, from_date: before.date, from_start_time: before.start_time, from_staff_id: before.staff_id,
  });
}

/** The appointment fields the history needs, or undefined when it does not exist in this organization. */
export function appointmentState(id: string, orgId?: string): AppointmentState | undefined {
  return (orgId
    ? db.prepare('SELECT id, organization_id, booking_ref, status, date, start_time, staff_id FROM appointments WHERE id = ? AND organization_id = ?').get(id, orgId)
    : db.prepare('SELECT id, organization_id, booking_ref, status, date, start_time, staff_id FROM appointments WHERE id = ?').get(id)
  ) as AppointmentState | undefined;
}

export interface HistoryEntry {
  id: string;
  action: Action;
  fromStatus: string | null; toStatus: string | null;
  fromDate: string | null; fromStartTime: string | null; toDate: string | null; toStartTime: string | null;
  fromStaff: { id: string; name: string | null } | null;
  toStaff: { id: string; name: string | null } | null;
  actor: { type: 'user' | 'customer' | 'system'; name: string | null; source: HistorySource | 'system' };
  createdAt: string;
}

/** One organization's history of one appointment, oldest first. Staff names are read from that organization only. */
export function listHistory(orgId: string, appointmentId: string): HistoryEntry[] {
  const rows = db.prepare(
    `SELECT h.*, fs.name AS from_staff_name, ts.name AS to_staff_name
     FROM appointment_history h
     LEFT JOIN staff fs ON fs.id = h.from_staff_id AND fs.organization_id = h.organization_id
     LEFT JOIN staff ts ON ts.id = h.to_staff_id AND ts.organization_id = h.organization_id
     WHERE h.organization_id = ? AND h.appointment_id = ?
     ORDER BY h.created_at, h.rowid`
  ).all(orgId, appointmentId) as Array<Record<string, string | null>>;
  return rows.map(r => ({
    id: r.id!,
    action: r.action as Action,
    fromStatus: r.from_status, toStatus: r.to_status,
    fromDate: r.from_date, fromStartTime: r.from_start_time, toDate: r.to_date, toStartTime: r.to_start_time,
    fromStaff: r.from_staff_id ? { id: r.from_staff_id, name: r.from_staff_name } : null,
    toStaff: r.to_staff_id ? { id: r.to_staff_id, name: r.to_staff_name } : null,
    actor: { type: r.actor_type as HistoryEntry['actor']['type'], name: r.actor_name, source: r.source as HistoryEntry['actor']['source'] },
    createdAt: r.created_at!,
  }));
}
