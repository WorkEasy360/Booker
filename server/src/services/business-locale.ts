import { isValidTimeZone } from '../validation';

export const INDIA_TIMEZONE = 'Asia/Kolkata';
// This deployment's regional defaults (India). They apply only where nothing is stored: a new business, or a value
// missing from an older row. Every business can change its own time zone, currency and date format in Settings.
/** Used when nothing better is known (API callers that send neither a time zone nor a country). */
export const DEFAULT_TIMEZONE = INDIA_TIMEZONE;
export const DEFAULT_COUNTRY = 'IN';
export const DEFAULT_CURRENCY = 'INR';
export const DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';

const INDIA_NAMES = new Set(['in', 'ind', 'india', 'bharat']);
/** Older IANA names some browsers still report, mapped to the current ones. */
const TIMEZONE_ALIASES: Record<string, string> = { 'Asia/Calcutta': INDIA_TIMEZONE };

/**
 * Time zone and country for a newly created business.
 * - India has one time zone, so an Indian business (by its country, or a sign-up from a browser on Indian time) gets
 *   Asia/Kolkata.
 * - Anywhere else the business gets the time zone of the browser that signed it up, so its times stay correct.
 * - Without either, the deployment default (Asia/Kolkata) applies.
 * The new business starts with the deployment's currency and date format (INR, DD/MM/YYYY) and, when no country is
 * known, the deployment's country (IN).
 * Each business can change its zone afterwards in Settings > Language & Region.
 */
export function newBusinessLocale(input: { timezone?: string; country?: string }): { timezone: string; country: string | null } {
  const browserZone = input.timezone && isValidTimeZone(input.timezone) ? (TIMEZONE_ALIASES[input.timezone] ?? input.timezone) : null;
  const country = input.country?.trim() || null;
  const indian = country ? INDIA_NAMES.has(country.toLowerCase()) : browserZone === INDIA_TIMEZONE;
  if (indian) return { timezone: INDIA_TIMEZONE, country: country ?? 'IN' };
  return { timezone: browserZone ?? DEFAULT_TIMEZONE, country };
}
