import { z } from 'zod';

/** True for YYYY-MM-DD strings that name a real calendar day (rejects 2026-02-30, 2026-13-01). */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const DateString = z.string().refine(isRealDate, 'Date must be a real calendar date in YYYY-MM-DD format');
export const TimeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM in 24-hour format');

/** True for IANA time zone names the runtime understands (e.g. Asia/Kolkata). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const TimeZoneString = z.string().trim().refine(isValidTimeZone, 'Choose a valid time zone such as Asia/Kolkata');

/** True for absolute https:// URLs without whitespace. */
export function isHttpsUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
