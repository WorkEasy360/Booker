import { DEFAULT_TIMEZONE } from '../../lib/regional.ts'; // explicit extension: also imported by the Node unit tests

// The same rule as the API (server/src/services/appointment-status.ts): "completed" and "no-show" can be recorded only
// once the appointment has started, judged in the time zone it was booked in. The API enforces it; the page only uses
// it to offer the right buttons and say why the others are unavailable.

/** Whether the appointment's start time (date and HH:MM in its own time zone) has been reached at `now`. */
export function hasStarted(appointment: { date: string; startTime: string; timezone?: string | null }, now = new Date()): boolean {
  const zone = appointment.timezone || DEFAULT_TIMEZONE;
  let local: string;
  try {
    // sv-SE formats as "YYYY-MM-DD HH:MM:SS", which compares correctly as text.
    local = now.toLocaleString('sv-SE', { timeZone: zone, hour12: false });
  } catch {
    local = now.toLocaleString('sv-SE', { timeZone: DEFAULT_TIMEZONE, hour12: false });
  }
  return `${appointment.date} ${appointment.startTime.slice(0, 5)}` <= local.slice(0, 16);
}

/** Whether an outcome (completed or no-show) can be recorded now. */
export function canRecordOutcome(appointment: { status: string; date: string; startTime: string; timezone?: string | null }, now = new Date()): boolean {
  return (appointment.status === 'scheduled' || appointment.status === 'confirmed') && hasStarted(appointment, now);
}
