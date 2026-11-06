// "Add to calendar" links for the customer's own calendar. They open Google Calendar or Outlook with the booking filled
// in; the customer saves it there. Nothing is added by WorkEasy360 and no invitation is sent, so the page never says
// the booking "was added". The .ics file (Apple Calendar and others) comes from the server with the manage link.

export interface CalendarEventInput {
  title: string;
  details: string;
  location?: string;
  /** Business-local date YYYY-MM-DD and times HH:MM in the business's IANA time zone. */
  date: string;
  start: string;
  end: string;
  timeZone: string;
}

/** The UTC instant of a wall-clock date and time in an IANA time zone (handles daylight saving changes). */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant;
  };
  // Two passes settle the offset on either side of a daylight saving change.
  let guess = asUtc - offsetAt(asUtc);
  guess = asUtc - offsetAt(guess);
  return guess;
}

const compact = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function span(e: CalendarEventInput): { startMs: number; endMs: number } {
  const startMs = zonedTimeToUtc(e.date, e.start, e.timeZone);
  let endMs = zonedTimeToUtc(e.date, e.end, e.timeZone);
  if (endMs <= startMs) endMs += 86_400_000; // ends after midnight
  return { startMs, endMs };
}

export function googleCalendarUrl(e: CalendarEventInput): string {
  const { startMs, endMs } = span(e);
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${compact(startMs)}/${compact(endMs)}`, details: e.details, ctz: e.timeZone });
  if (e.location) q.set('location', e.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

export function outlookCalendarUrl(e: CalendarEventInput): string {
  const { startMs, endMs } = span(e);
  const q = new URLSearchParams({
    path: '/calendar/action/compose', rru: 'addevent', subject: e.title, body: e.details,
    startdt: new Date(startMs).toISOString(), enddt: new Date(endMs).toISOString(),
  });
  if (e.location) q.set('location', e.location);
  return `https://outlook.live.com/calendar/0/deeplink/compose?${q.toString()}`;
}
