// The Dashboard's two appointment lists. "Today" holds every appointment dated today; "Upcoming" starts tomorrow, so
// no appointment (and no customer name) appears in both. Pure functions, unit-tested in tests/unit/dashboard.test.ts.

interface ListedAppointment { date: string; startTime: string; status: string }

const ACTIVE = new Set(['scheduled', 'confirmed']);
const byStart = (a: ListedAppointment, b: ListedAppointment) => (a.date + a.startTime).localeCompare(b.date + b.startTime);

/** Today's appointments, earliest first. */
export function todaysAppointments<T extends ListedAppointment>(all: T[], today: string): T[] {
  return all.filter(a => a.date === today).sort(byStart);
}

/** Scheduled or confirmed appointments after today, earliest first. */
export function upcomingAppointments<T extends ListedAppointment>(all: T[], today: string): T[] {
  return all.filter(a => a.date > today && ACTIVE.has(a.status)).sort(byStart);
}
