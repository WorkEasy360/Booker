import { z } from 'zod';
import { zonedToInstant } from './zoned-time';

// Appointment status changes, in one place. "Completed" and "no-show" are outcomes: they can be recorded only once
// the appointment has started (its date and start time, in the time zone it was booked in). Cancelled appointments
// can be brought back (the slot is checked again by the caller) but never marked completed or no-show; completed ones
// can be corrected (back to scheduled, or to no-show) but not cancelled.
//
// V4: only Scheduled / Completed / Cancelled / No-show. New bookings are Scheduled; there is no approval stage. Older
// clients may still send "confirmed": it is read as "scheduled" (normalizeStatus), and stored rows were migrated.

export const APPOINTMENT_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = typeof APPOINTMENT_STATUSES[number];

/** Statuses a new appointment may start in. */
export const INITIAL_STATUSES: AppointmentStatus[] = ['scheduled'];

/** The legacy "confirmed" status is the same as "scheduled". Other values are returned unchanged. */
export function normalizeStatus<T>(value: T): T | 'scheduled' {
  return value === 'confirmed' ? 'scheduled' : value;
}

/** A status sent by a client: one of the four statuses, with "confirmed" accepted as "scheduled". */
export const StatusInput = z.preprocess(normalizeStatus, z.enum(APPOINTMENT_STATUSES));

const ALLOWED: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['scheduled', 'completed', 'cancelled', 'no_show'],
  completed: ['completed', 'scheduled', 'no_show'],
  no_show: ['no_show', 'scheduled', 'completed'],
  cancelled: ['cancelled', 'scheduled'],
};
const OUTCOMES: AppointmentStatus[] = ['completed', 'no_show'];

const LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'scheduled', completed: 'completed', cancelled: 'cancelled', no_show: 'a no-show',
};

export type StatusProblem = { status: 409; code: 'INVALID_STATUS_CHANGE' | 'APPOINTMENT_NOT_STARTED'; error: string };

/** Why a change from one status to another is not allowed at time `now`, or null when it is. */
export function statusChangeProblem(
  from: string,
  to: AppointmentStatus,
  appointment: { date: string; startTime: string; timezone: string },
  now = Date.now(),
): StatusProblem | null {
  const normalized = normalizeStatus(from);
  const current = (APPOINTMENT_STATUSES as readonly string[]).includes(normalized) ? normalized as AppointmentStatus : 'scheduled';
  if (!ALLOWED[current].includes(to)) {
    return { status: 409, code: 'INVALID_STATUS_CHANGE', error: `A ${current === 'no_show' ? 'no-show' : current} appointment cannot be marked ${LABEL[to]}.` };
  }
  if (to !== current && OUTCOMES.includes(to) && zonedToInstant(appointment.date, appointment.startTime, appointment.timezone) > now) {
    return {
      status: 409, code: 'APPOINTMENT_NOT_STARTED',
      error: `This appointment has not started yet. It can be marked ${LABEL[to]} once it has started.`,
    };
  }
  return null;
}
