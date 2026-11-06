// Regional defaults of this deployment (India) and the business's chosen date format for display. The defaults apply
// only where nothing is stored; each business sets its own time zone, currency and date format in Settings. The API
// has the same defaults (server/src/services/business-locale.ts).

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_CURRENCY = 'INR';
export const DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';
/** Locale for month and weekday names in charts and headings (Indian English: "24 Oct"). */
export const DISPLAY_LOCALE = 'en-IN';

/** The date formats a business can choose (Settings > Language & Region), as date-fns patterns. */
const DATE_PATTERNS: Record<string, string> = {
  'DD/MM/YYYY': 'dd/MM/yyyy',
  'MM/DD/YYYY': 'MM/dd/yyyy',
  'YYYY-MM-DD': 'yyyy-MM-dd',
};

let dateFormat = DEFAULT_DATE_FORMAT;

/** Called when the business's settings load or change; unknown values keep the current format. */
export function setDateDisplayFormat(value: string | null | undefined): void {
  if (value && DATE_PATTERNS[value]) dateFormat = value;
}

/** The date-fns pattern for the business's date format. */
export function dateDisplayPattern(): string {
  return DATE_PATTERNS[dateFormat];
}
