import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

// Client-side checks for immediate feedback. The API applies the same rules (server/src/lib/phone.ts and zod's email
// check) and is the final authority: these never replace server validation.

export const PHONE_PLACEHOLDER = '+91 98765 43210';
const DEFAULT_PHONE_COUNTRY = 'IN' as const;
const PHONE_ALLOWED = /^\+?[\d\s\-().]+$/;
// One "@", something on both sides, a dot in the domain, no spaces: the same shape the API's email check accepts.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An error message for an invalid email, or '' when it is valid. Empty input is the caller's business. */
export function emailError(value: string): string {
  const v = value.trim();
  if (!v) return '';
  return EMAIL_SHAPE.test(v) && v.length <= 254 ? '' : 'Enter a valid email address, for example name@example.com';
}

/** An error message for an invalid phone number, or '' when it is valid. Empty input is the caller's business. */
export function phoneError(value: string): string {
  const v = value.trim();
  if (!v) return '';
  if (v.length > 30 || !PHONE_ALLOWED.test(v)) return `Use digits, spaces, dashes or brackets only, for example ${PHONE_PLACEHOLDER}`;
  const parsed = parsePhoneNumberFromString(v, DEFAULT_PHONE_COUNTRY);
  return parsed?.isValid() ? '' : `Enter a valid phone number, for example ${PHONE_PLACEHOLDER} (other countries: start with + and the country code)`;
}
