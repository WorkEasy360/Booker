import db from '../db/init';
import { staffDaySchedule } from './schedule';
import type { TimeSlot } from '../types';
import { DEFAULT_TIMEZONE } from './business-locale';
import { resourceChecker } from './resources';

interface SlotQuery {
  date: string;       // YYYY-MM-DD
  serviceId: string;
  staffId: string;
  duration: number;   // minutes
  bufferBefore: number;
  bufferAfter: number;
  // Admin routes pass true to bypass the public-facing minimum booking notice.
  skipMinNotice?: boolean;
  // When rescheduling, the appointment's own current slot must not count as busy.
  excludeAppointmentId?: string;
  // Staff-only checks pass true: rooms and other resources are then checked by the caller (services/resources.ts).
  ignoreResources?: boolean;
  // Bookings in a workspace use only that workspace's resources.
  workspaceId?: string | null;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(total: number): string {
  const h = Math.floor(total / 60).toString().padStart(2, '0');
  const m = (total % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}


/**
 * Returns true when the slot is at least minNoticeHours from now, measured in
 * the org's local timezone.  Both times are compared in local-time coordinates
 * to avoid DST edge cases (sv-SE locale gives "YYYY-MM-DD HH:mm:ss" — we
 * append 'Z' and compare as if it were UTC, which is correct because both
 * sides of the comparison use the same coordinate space).
 */
export function slotIsAfterMinNotice(
  slotDate: string,
  slotStart: string,
  orgTimezone: string,
  minNoticeHours: number,
): boolean {
  if (minNoticeHours <= 0) return true;

  const now = new Date();
  const nowOrgStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: orgTimezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(now);

  // Both timestamps treated as "fake UTC" for arithmetic — valid because they
  // are in the same local coordinate space.
  const nowMs  = new Date(nowOrgStr.replace(' ', 'T') + 'Z').getTime();
  const slotMs = new Date(`${slotDate}T${slotStart}:00Z`).getTime();

  return slotMs >= nowMs + minNoticeHours * 60 * 60 * 1000;
}

/** Calendar date (YYYY-MM-DD) as seen in the given IANA timezone right now. */
export function todayInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function slotIsInFuture(slotDate: string, slotStart: string, timezone: string): boolean {
  const nowLocal = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date()).replace(' ', 'T');
  return `${slotDate}T${slotStart}` > nowLocal;
}

export function getOrgTimezone(orgId: string): string {
  const row = db.prepare('SELECT timezone FROM organizations WHERE id = ?').get(orgId) as { timezone: string | null } | undefined;
  return row?.timezone ?? DEFAULT_TIMEZONE;
}

export function getAvailableSlots(query: SlotQuery): TimeSlot[] {
  const { date, staffId, duration, bufferBefore, bufferAfter, skipMinNotice = false } = query;

  const staffRow = db.prepare(
    'SELECT organization_id FROM staff WHERE id = ?'
  ).get(staffId) as { organization_id: string } | undefined;

  if (!staffRow) return [];

  // Read booking rules (minNoticeHours) from the organization
  const orgRow = db.prepare(
    'SELECT booking_rules, timezone FROM organizations WHERE id = ?'
  ).get(staffRow.organization_id) as { booking_rules: string; timezone: string } | undefined;

  const bookingRules = JSON.parse(orgRow?.booking_rules ?? '{}') as {
    minNoticeHours?: number;
    maxAdvanceDays?: number;
    sameDay?: boolean;
  };

  // Service-level rules (services.min_notice in hours, services.max_advance in days) combine with the
  // org-level rules; the stricter value wins. Admin routes bypass all of these via skipMinNotice.
  const svcRules = db.prepare('SELECT min_notice, max_advance FROM services WHERE id = ?')
    .get(query.serviceId) as { min_notice: number; max_advance: number } | undefined;

  const orgMinNotice = typeof bookingRules.minNoticeHours === 'number' ? bookingRules.minNoticeHours : 0;
  const minNoticeHours: number = skipMinNotice ? 0 : Math.max(orgMinNotice, svcRules?.min_notice ?? 0);

  const advanceLimits = [
    typeof bookingRules.maxAdvanceDays === 'number' && bookingRules.maxAdvanceDays > 0 ? bookingRules.maxAdvanceDays : undefined,
    svcRules && svcRules.max_advance > 0 ? svcRules.max_advance : undefined,
  ].filter((n): n is number => n !== undefined);
  const maxAdvanceDays = advanceLimits.length ? Math.min(...advanceLimits) : undefined;
  const orgTimezone = orgRow?.timezone ?? DEFAULT_TIMEZONE;

  // Staff hours narrowed by business hours, with breaks, time off and closures (services/schedule.ts).
  const schedule = staffDaySchedule(staffId, date);
  if (!schedule.window) return [];

  let dateBlocked = false;
  if (!skipMinNotice) {
    const today = todayInTimezone(orgTimezone);
    if (bookingRules.sameDay === false && date === today) dateBlocked = true;
    if (maxAdvanceDays !== undefined) {
      const limit = new Date(`${today}T12:00:00Z`);
      limit.setUTCDate(limit.getUTCDate() + maxAdvanceDays);
      if (date > limit.toISOString().split('T')[0]) dateBlocked = true;
    }
  }

  const dayStart = schedule.window.start;
  const dayEnd   = schedule.window.end;
  // Services that need a room or other resource: some resource of the pool must be free as well (services/resources.ts).
  const resourceFree = query.ignoreResources ? null
    : resourceChecker(staffRow.organization_id, query.serviceId, date, query.excludeAppointmentId, query.workspaceId);

  // Collect busy intervals from existing appointments for this staff/date
  const existingAppts = db
    .prepare(
      `SELECT start_time, end_time FROM appointments
       WHERE staff_id = ? AND date = ? AND status NOT IN ('cancelled','no_show') AND id != ?`
    )
    .all(staffId, date, query.excludeAppointmentId ?? '') as Array<{ start_time: string; end_time: string }>;

  const busyIntervals = existingAppts.map(a => ({
    start: toMinutes(a.start_time) - bufferBefore,
    end:   toMinutes(a.end_time)   + bufferAfter,
  }));

  const slots: TimeSlot[] = [];
  const slotStep  = 30; // candidate every 30 min
  const slotTotal = duration + bufferBefore + bufferAfter;

  for (let cursor = dayStart; cursor + slotTotal <= dayEnd; cursor += slotStep) {
    const slotStart = cursor + bufferBefore;
    const slotEnd   = slotStart + duration;
    const blockEnd  = slotEnd + bufferAfter;

    const overlaps    = busyIntervals.some(b => cursor < b.end && blockEnd > b.start)
      // Breaks, part-day time off and closures: the appointment itself must not overlap them.
      || schedule.blocked.some(b => slotStart < b.end && slotEnd > b.start);
    // Public booking must never offer a start time that has already passed, even with no minimum notice.
    const withinNotice = skipMinNotice
      || (slotIsAfterMinNotice(date, fromMinutes(slotStart), orgTimezone, minNoticeHours)
          && slotIsInFuture(date, fromMinutes(slotStart), orgTimezone));

    slots.push({
      start:     fromMinutes(slotStart),
      end:       fromMinutes(slotEnd),
      available: !overlaps && withinNotice && !dateBlocked && (!resourceFree || resourceFree(fromMinutes(slotStart), fromMinutes(slotEnd))),
    });
  }

  return slots;
}

/**
 * Free start times for each staff member who can take the service (active and assigned to it), by the rules of the
 * New Appointment form: staff and saved business hours, breaks, time off, closures, other appointments and buffers;
 * no minimum notice. The assistant uses this so it never offers a time the server would refuse.
 */
export function freeTimesByStaff(
  orgId: string, serviceId: string, date: string, onlyStaffId?: string,
): Array<{ staffId: string; staffName: string; times: string[] }> {
  const svc = db.prepare(
    'SELECT duration, buffer_before, buffer_after, staff_ids FROM services WHERE id = ? AND organization_id = ? AND is_active = 1'
  ).get(serviceId, orgId) as { duration: number; buffer_before: number; buffer_after: number; staff_ids: string | null } | undefined;
  if (!svc) return [];
  const assigned = (JSON.parse(svc.staff_ids ?? '[]') as string[]).filter(id => !onlyStaffId || id === onlyStaffId);
  if (!assigned.length) return [];
  const staff = db.prepare(
    `SELECT id, name FROM staff WHERE id IN (${assigned.map(() => '?').join(',')}) AND is_active = 1 AND organization_id = ? ORDER BY name`
  ).all(...assigned, orgId) as Array<{ id: string; name: string }>;
  return staff
    .map(s => ({
      staffId: s.id,
      staffName: s.name,
      times: getAvailableSlots({
        date, serviceId, staffId: s.id,
        duration: svc.duration, bufferBefore: svc.buffer_before, bufferAfter: svc.buffer_after,
        skipMinNotice: true,
      }).filter(t => t.available).map(t => t.start),
    }))
    .filter(s => s.times.length > 0);
}
