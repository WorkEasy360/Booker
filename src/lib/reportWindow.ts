// Date windows shared by the Dashboard and the Reports page, with the same rule as the server's report windows
// (server/src/routes/reports.ts, dateRangeBounds): the last N calendar days in the business's time zone, today
// included. Dates are YYYY-MM-DD strings; the arithmetic is done in UTC so no browser time zone can shift a day.

/** The date `days` days after (or before, when negative) a YYYY-MM-DD date. */
export function addDaysISO(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The last `days` calendar days ending on `today`, both ends included ("7 days" is today and the 6 days before). */
export function windowBounds(today: string, days: number): { from: string; to: string } {
  return { from: addDaysISO(today, -(Math.max(1, days) - 1)), to: today };
}

/** A YYYY-MM-DD date for display, without any time zone moving it to the previous or next day. */
export function dayLabel(date: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(locale, { ...options, timeZone: 'UTC' });
}
