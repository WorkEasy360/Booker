// Time-zone choices for businesses and workspaces. No imports, so the Node unit tests can load it directly.

export const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Toronto', 'America/Vancouver', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
  'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland',
];

/** Older IANA names some browsers still list, mapped to the current ones. */
const TIMEZONE_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon', 'Europe/Kiev': 'Europe/Kyiv', 'Atlantic/Faeroe': 'Atlantic/Faroe',
};

/**
 * Every zone the browser knows (so a business anywhere can pick its own), always including the common list above and
 * the value currently saved, in alphabetical order.
 */
export function timeZoneOptions(current?: string): { value: string; label: string }[] {
  let known: string[] = [];
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    known = supported ? supported('timeZone') : [];
  } catch { /* older browser: the common list only */ }
  const zones = new Set([...TIMEZONES, ...known.map(z => TIMEZONE_ALIASES[z] ?? z)]);
  if (current) zones.add(current);
  return [...zones].sort().map(tz => ({ value: tz, label: tz }));
}
