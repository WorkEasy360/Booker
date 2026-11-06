import type { Language } from './messages';

// Dates written out in the chosen language (Hindi month and day names come from the browser's Intl data).

const LOCALE: Record<Language, string> = { en: 'en-IN', hi: 'hi-IN' };

/** A YYYY-MM-DD date in full, e.g. "Wednesday, 4 November 2026" / "बुधवार, 4 नवंबर 2026". */
export function longDate(date: string, lang: Language): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** A YYYY-MM-DD date in short form, e.g. "4 Nov 2026" / "4 नव॰ 2026". */
export function shortDate(date: string, lang: Language): string {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}
