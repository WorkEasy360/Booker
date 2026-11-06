import db from '../db/init';
import { scheduleProblem, staffDaySchedule, toMinutes, fromMinutes } from './schedule';
import { getAvailableSlots } from './availability';
import { addMinutesToTime } from './zoned-time';

/**
 * Why a staff member cannot take this booking, or null when they can.
 * Checks active status, service assignment and the schedule: working hours narrowed by business hours, weekly
 * breaks, time off and business closures (services/schedule.ts). Public notice/advance rules are applied separately
 * by the availability service; admin bookings are intentionally exempt from those.
 */
export function staffBookingProblem(
  orgId: string, staffId: string, serviceId: string, date: string, startTime: string, endTime: string,
): string | null {
  const staff = db.prepare('SELECT name, is_active FROM staff WHERE id = ? AND organization_id = ?')
    .get(staffId, orgId) as { name: string; is_active: number } | undefined;
  if (!staff) return 'Staff member not found';
  if (!staff.is_active) return `${staff.name} is inactive and cannot take bookings`;

  const svc = db.prepare('SELECT staff_ids FROM services WHERE id = ? AND organization_id = ?')
    .get(serviceId, orgId) as { staff_ids: string } | undefined;
  if (!svc) return 'Service not found';
  if (!(JSON.parse(svc.staff_ids ?? '[]') as string[]).includes(staffId)) {
    return `${staff.name} does not offer this service`;
  }

  // Appointments ending exactly at midnight are stored as 24:00 by addMinutes; times compare as HH:MM.
  return scheduleProblem(staffId, staff.name, date, startTime, endTime);
}

export interface SlotProblem { status: 400 | 409; error: string }

/**
 * Why staff (the dashboard or the assistant) cannot book this service at this time, or null when they can.
 *
 * Public booking is the source of truth: a start time is bookable only if the shared availability service offers it,
 * i.e. it lies on the 30-minute grid that starts at the day's window plus the service's buffer before, the whole
 * appointment with its buffers fits inside the staff member's hours narrowed by business hours, it avoids breaks,
 * time off and closures, and the service's buffers stay clear of the staff member's other active appointments.
 * Customer-facing booking rules (minimum notice, advance window, same-day) do not apply to staff bookings, as before.
 *
 * Synchronous on purpose: call it again inside the write transaction so the check and the write are atomic.
 */
export function staffSlotProblem(input: {
  orgId: string; staffId: string; serviceId: string; date: string; startTime: string;
  /** Length to check; defaults to the service duration. Reschedules pass the appointment's own length. */
  durationMinutes?: number;
  /** The appointment being moved, whose current slot must not count as busy. */
  excludeAppointmentId?: string;
  /** New bookings need an active service; an existing appointment of a since-deactivated service can still move. */
  requireActiveService: boolean;
}): SlotProblem | null {
  const { orgId, staffId, serviceId, date, startTime } = input;
  const svc = db.prepare('SELECT duration, buffer_before, buffer_after, is_active FROM services WHERE id = ? AND organization_id = ?')
    .get(serviceId, orgId) as { duration: number; buffer_before: number; buffer_after: number; is_active: number } | undefined;
  if (!svc) return { status: 400, error: 'Service not found' };
  if (input.requireActiveService && !svc.is_active) return { status: 400, error: 'This service is inactive and cannot be booked' };

  const duration = input.durationMinutes ?? svc.duration;
  const endTime = addMinutesToTime(startTime, duration);
  const problem = staffBookingProblem(orgId, staffId, serviceId, date, startTime, endTime);
  if (problem) return { status: 400, error: problem };

  // The grid public booking uses: every 30 minutes from the start of the day's window plus the buffer before.
  const window = staffDaySchedule(staffId, date).window!;
  const first = window.start + (svc.buffer_before ?? 0);
  const offset = toMinutes(startTime) - first;
  if (offset < 0 || offset % 30 !== 0) {
    const earlier = first + Math.max(0, Math.floor(offset / 30)) * 30;
    const options = [earlier, earlier + 30].filter(m => m >= first).map(fromMinutes);
    return { status: 400, error: `Appointments for this service start every 30 minutes from ${fromMinutes(first)} that day. Choose ${options.join(' or ')}.` };
  }

  // Staff only: rooms and other resources are chosen and checked separately (services/resources.ts).
  const slot = getAvailableSlots({
    date, serviceId, staffId, duration,
    bufferBefore: svc.buffer_before ?? 0, bufferAfter: svc.buffer_after ?? 0,
    skipMinNotice: true, excludeAppointmentId: input.excludeAppointmentId, ignoreResources: true,
  }).find(s => s.start === startTime);
  const staffName = (db.prepare('SELECT name FROM staff WHERE id = ?').get(staffId) as { name: string }).name;
  if (!slot) {
    return { status: 400, error: `With its buffer times this service does not fit at ${startTime} within ${staffName}'s hours (${fromMinutes(window.start)}–${fromMinutes(window.end)}).` };
  }
  if (!slot.available) {
    const overlap = db.prepare(
      `SELECT 1 FROM appointments WHERE staff_id = ? AND date = ? AND status NOT IN ('cancelled','no_show') AND id != ?
         AND start_time < ? AND end_time > ? LIMIT 1`
    ).get(staffId, date, input.excludeAppointmentId ?? '', endTime, startTime);
    if (overlap) return { status: 409, error: 'This time slot is no longer available. Please choose another time.' };
    return { status: 400, error: `That time is too close to another appointment of ${staffName}: the buffer time this service keeps before and after would overlap it.` };
  }
  return null;
}
