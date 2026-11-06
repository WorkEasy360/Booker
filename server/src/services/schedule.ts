// When a staff member can be booked on a given business-local date. Shared by public availability, the admin
// availability used by the New Appointment form, and the server-side checks on every booking, so all three agree.
//
// Rules:
// - The staff member's weekly hours set the day's window.
// - The business's weekly hours (Settings > Working Hours), once saved, narrow it: a slot must be inside both. A day
//   the business has switched off is closed. While a business has saved no hours, staff hours alone apply.
// - Weekly breaks (schedule_breaks: per staff member, or for the whole business) cannot be booked.
// - Time off (staff) and closures (whole business, staff_id NULL) block whole days or part of each day.
// Existing appointments are never changed by any of these; they only stop new bookings.
import db from '../db/init';

export const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const dayName = (date: string) => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
export const toMinutes = (time: string) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
export const fromMinutes = (total: number) => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
const dayLabel = (day: string) => `${day.charAt(0).toUpperCase()}${day.slice(1)}s`;

interface DayHours { enabled?: boolean; start?: string; end?: string }
type WeekHours = Record<string, DayHours | undefined>;

export interface Blocked { start: number; end: number; reason: string }
export interface DaySchedule {
  /** Bookable window in minutes after midnight, or null when the day cannot be booked at all. */
  window: { start: number; end: number } | null;
  /** Why the whole day is unavailable (window null). */
  closedReason?: string;
  /** Periods inside the window that cannot be booked: breaks, part-day time off and closures. */
  blocked: Blocked[];
  /** The window's source, for messages: staff hours alone, or narrowed by business hours. */
  narrowedByBusiness: boolean;
}

function parseHours(raw: string | null | undefined): WeekHours {
  try { return (JSON.parse(raw ?? '{}') ?? {}) as WeekHours; } catch { return {}; }
}

/** The business's saved weekly hours, or null when none are saved. */
export function businessHours(orgId: string): WeekHours | null {
  const row = db.prepare('SELECT working_hours FROM organizations WHERE id = ?').get(orgId) as { working_hours: string | null } | undefined;
  const hours = parseHours(row?.working_hours);
  return Object.keys(hours).length ? hours : null;
}

interface TimeOffRow { staff_id: string | null; start_time: string | null; end_time: string | null; reason: string }

export function staffDaySchedule(staffId: string, date: string): DaySchedule {
  const staff = db.prepare('SELECT name, organization_id, working_hours FROM staff WHERE id = ?')
    .get(staffId) as { name: string; organization_id: string; working_hours: string | null } | undefined;
  const closed = (closedReason: string): DaySchedule => ({ window: null, closedReason, blocked: [], narrowedByBusiness: false });
  if (!staff) return closed('Staff member not found');

  const day = dayName(date);
  const own = parseHours(staff.working_hours)[day];
  if (!own?.enabled || !own.start || !own.end) return closed(`${staff.name} does not work on ${dayLabel(day)}`);
  let start = toMinutes(own.start), end = toMinutes(own.end);

  let narrowedByBusiness = false;
  const business = businessHours(staff.organization_id);
  if (business) {
    const biz = business[day];
    if (!biz?.enabled || !biz.start || !biz.end) return closed(`The business is closed on ${dayLabel(day)}`);
    const [bs, be] = [toMinutes(biz.start), toMinutes(biz.end)];
    if (bs > start || be < end) narrowedByBusiness = true;
    start = Math.max(start, bs);
    end = Math.min(end, be);
    if (end <= start) return closed(`${staff.name}'s hours are outside business hours on ${dayLabel(day)}`);
  }

  // Weekly breaks: the staff member's own and the whole business's.
  const breaks = db.prepare(
    'SELECT staff_id, start_time, end_time, label FROM schedule_breaks WHERE organization_id = ? AND weekday = ? AND (staff_id = ? OR staff_id IS NULL)'
  ).all(staff.organization_id, day, staffId) as Array<{ staff_id: string | null; start_time: string; end_time: string; label: string }>;
  const blocked: Blocked[] = breaks.map(b => ({
    start: toMinutes(b.start_time), end: toMinutes(b.end_time),
    reason: `${b.staff_id ? `${staff.name}'s break` : 'a business break'}${b.label ? ` (${b.label})` : ''}`,
  }));

  const off = db.prepare(
    `SELECT staff_id, start_time, end_time, reason FROM time_off
     WHERE organization_id = ? AND (staff_id = ? OR staff_id IS NULL) AND start_date <= ? AND end_date >= ?
     ORDER BY staff_id IS NOT NULL`
  ).all(staff.organization_id, staffId, date, date) as TimeOffRow[];
  for (const t of off) {
    const what = t.staff_id ? `${staff.name}'s time off` : 'a business closure';
    const label = t.reason ? `${what} (${t.reason})` : what;
    if (!t.start_time || !t.end_time) {
      return closed(t.staff_id ? `${staff.name} is on time off that day${t.reason ? ` (${t.reason})` : ''}` : `The business is closed that day${t.reason ? ` (${t.reason})` : ''}`);
    }
    blocked.push({ start: toMinutes(t.start_time), end: toMinutes(t.end_time), reason: label });
  }
  return { window: { start, end }, blocked, narrowedByBusiness };
}

/** Why this staff member cannot be booked from startTime to endTime on date, or null when the schedule allows it. */
export function scheduleProblem(staffId: string, staffName: string, date: string, startTime: string, endTime: string): string | null {
  const s = staffDaySchedule(staffId, date);
  if (!s.window) return s.closedReason ?? 'That day is not available';
  const [a, b] = [toMinutes(startTime), toMinutes(endTime)];
  if (b <= a || a < s.window.start || b > s.window.end) {
    const range = `${fromMinutes(s.window.start)}–${fromMinutes(s.window.end)}`;
    return s.narrowedByBusiness
      ? `That time is outside business hours for ${staffName} (${range})`
      : `That time is outside ${staffName}'s working hours (${range})`;
  }
  const clash = s.blocked.find(x => a < x.end && b > x.start);
  if (clash) return `That time overlaps ${clash.reason} (${fromMinutes(clash.start)}–${fromMinutes(clash.end)})`;
  return null;
}
