import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

// Phone numbers: one rule for every form and API (public booking, customers, staff, workspaces, business profile).
// A number without a country code is read as Indian (the default region); any other country needs its +code.
// Validity comes from libphonenumber (real number ranges per country), so "12", "abc", a 20-digit string or a
// fictional 555 number are refused. Valid numbers are stored in one international format, e.g. "+91 98765 43210".

export const DEFAULT_PHONE_COUNTRY = 'IN' as const;
export const PHONE_EXAMPLE = '+91 98765 43210';
const ALLOWED = /^\+?[\d\s\-().]+$/;

export type PhoneResult = { ok: true; phone: string } | { ok: false; error: string };

/** Validates and normalizes one phone number. Empty input is the caller's business (optional or required). */
export function normalizePhone(input: string): PhoneResult {
  const value = input.trim();
  if (value.length > 30 || !ALLOWED.test(value)) {
    return { ok: false, error: `Use digits, spaces, dashes or brackets only, for example ${PHONE_EXAMPLE}` };
  }
  const parsed = parsePhoneNumberFromString(value, DEFAULT_PHONE_COUNTRY);
  if (!parsed || !parsed.isValid()) {
    return { ok: false, error: `Enter a valid phone number, for example ${PHONE_EXAMPLE} (other countries: start with + and the country code)` };
  }
  return { ok: true, phone: parsed.formatInternational() };
}

/** zod field: '' when blank (callers store NULL), otherwise the normalized number; invalid numbers fail validation. */
export const phoneField = () => z.string().max(40).transform((v, ctx) => {
  if (!v.trim()) return '';
  const result = normalizePhone(v);
  if (!result.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
    return z.NEVER;
  }
  return result.phone;
});

/**
 * The number in E.164 form (+919876543210), as messaging providers expect, or null when it is missing or invalid.
 * Mobile-only checks are left to the provider (it reports numbers that cannot receive messages).
 */
export function toE164(input: string | null | undefined): string | null {
  if (!input?.trim()) return null;
  const parsed = parsePhoneNumberFromString(input.trim(), DEFAULT_PHONE_COUNTRY);
  return parsed && parsed.isValid() ? parsed.number : null;
}
