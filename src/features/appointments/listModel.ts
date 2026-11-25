// Appointment list data shared by the List and Calendar views of the Appointments screen (one data set, one set of
// filters and actions for both views).

export type ListStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

export interface ListAppointment {
  id: string;
  bookingRef: string;
  customerId: string;
  serviceId: string;
  staffId: string;
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  timezone?: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  serviceName: string;
  serviceColor?: string;
  staffName: string;
  staffColor?: string;
}

export interface ListStaff { id: string; name: string; color?: string; photoUrl?: string | null; isActive?: boolean }

export type ListTab = 'today' | 'upcoming' | 'past';

export interface ListFilters {
  q: string;
  status: '' | ListStatus;
}

/** Earlier records may say "confirmed"; V4 shows them as Scheduled. */
export const statusOf = (a: { status: string }): string => (a.status === 'confirmed' ? 'scheduled' : a.status);

export function matchesFilters(a: ListAppointment, f: ListFilters): boolean {
  if (f.status && statusOf(a) !== f.status) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\D/g, '');
  return a.customerName.toLowerCase().includes(q)
    || (a.customerEmail ?? '').toLowerCase().includes(q)
    || (digits.length >= 3 && (a.customerPhone ?? '').replace(/\D/g, '').includes(digits))
    || a.bookingRef.toLowerCase().includes(q);
}

const byTime = (a: ListAppointment, b: ListAppointment) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime);

/** Today: every appointment on the chosen day. Upcoming: Scheduled ones after today. Past: before today, newest first. */
export function forTab(all: ListAppointment[], tab: ListTab, today: string, day: string): ListAppointment[] {
  if (tab === 'today') return all.filter(a => a.date === day).sort(byTime);
  if (tab === 'upcoming') return all.filter(a => a.date > today && statusOf(a) === 'scheduled').sort(byTime);
  return all.filter(a => a.date < today).sort((a, b) => b.date.localeCompare(a.date) || a.startTime.localeCompare(b.startTime));
}

/** "09:00 AM" (two-digit hour, as in the appointment list). */
export function clock(time: string): string {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h)) return time;
  const hour = h % 12 || 12;
  return `${String(hour).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Customer contact shown under the name: phone first, otherwise email. */
export const contactOf = (a: ListAppointment): string => a.customerPhone || a.customerEmail || '';

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing the date. */
export function weekStart(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(iso, -dow);
}

/** "Tue, 10 Nov 2026". */
export function longDay(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "10 Nov". */
export function shortDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Whether the appointment has started, compared in the business time zone ("now" given as YYYY-MM-DD HH:MM). */
export const hasStartedAt = (a: ListAppointment, nowLocal: string) => `${a.date} ${a.startTime.slice(0, 5)}` <= nowLocal;

/** "YYYY-MM-DD HH:MM" now in the time zone. */
export function nowIn(timeZone?: string): string {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone, hour12: false }).slice(0, 16);
  } catch {
    return new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
  }
}
