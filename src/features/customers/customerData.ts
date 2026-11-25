import { ApiError, customersApi } from '@/api/client';
import { emailError, phoneError } from '@/lib/validation';

/** A customer as the simplified app uses it: name and at least one contact method. */
export interface CustomerRecord {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  totalBookings?: number;
  lastBookingDate?: string | null;
  createdAt?: string;
}

export interface ContactInput { name: string; phone: string; email: string }
export type ContactErrors = Partial<Record<'name' | 'phone' | 'email' | 'contact', string>>;

/** V4 4.1: Name, and Phone or Email (the other optional). */
export function validateContact(v: ContactInput): ContactErrors {
  const errors: ContactErrors = {};
  if (!v.name.trim()) errors.name = 'Enter the customer’s name.';
  else if (/[<>]/.test(v.name)) errors.name = 'The name must not contain < or >.';
  const pe = phoneError(v.phone);
  if (pe) errors.phone = pe;
  const ee = emailError(v.email);
  if (ee) errors.email = ee;
  if (!v.phone.trim() && !v.email.trim()) errors.contact = 'Add a phone number or an email address (at least one).';
  return errors;
}

/** Body for create/update: empty contact fields are sent as null so a removed one is cleared. */
export function contactBody(v: ContactInput) {
  return { name: v.name.trim(), phone: v.phone.trim() || null, email: v.email.trim().toLowerCase() || null };
}

export function normalizeCustomer(raw: unknown): CustomerRecord {
  const c = raw as Record<string, unknown>;
  return {
    id: String(c.id),
    name: String(c.name ?? ''),
    phone: (c.phone as string | null | undefined) || null,
    email: (c.email as string | null | undefined) || null,
    totalBookings: typeof c.totalBookings === 'number' ? c.totalBookings : undefined,
    lastBookingDate: (c.lastBookingDate as string | null | undefined) ?? null,
    createdAt: c.createdAt as string | undefined,
  };
}

const digits = (s: string) => s.replace(/\D/g, '');

/** Customers whose phone or email matches the given contact details (used to point at the existing record on a 409). */
export async function findMatches(v: { phone: string; email: string }, exceptId?: string): Promise<CustomerRecord[]> {
  const found = new Map<string, CustomerRecord>();
  const email = v.email.trim().toLowerCase();
  const phone = digits(v.phone);
  const queries = [email, v.phone.trim()].filter(Boolean);
  for (const q of queries) {
    try {
      const rows = (await customersApi.list(q)).map(normalizeCustomer);
      for (const r of rows) {
        const sameEmail = !!email && r.email?.toLowerCase() === email;
        const samePhone = !!phone && phone.length >= 6 && !!r.phone && digits(r.phone).endsWith(phone.slice(-10));
        if ((sameEmail || samePhone) && r.id !== exceptId) found.set(r.id, r);
      }
    } catch { /* a failed lookup only means we cannot point at the match */ }
  }
  return [...found.values()];
}

/** Explains a refused save; `matches` are the existing customers involved, when they could be found. */
export interface SaveConflict { kind: 'exists' | 'conflict'; message: string; matches: CustomerRecord[] }

export async function conflictFrom(err: unknown, v: ContactInput, exceptId?: string): Promise<SaveConflict | null> {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const matches = await findMatches(v, exceptId);
  if (err.code === 'CUSTOMER_MATCH_CONFLICT' || matches.length > 1) {
    return {
      kind: 'conflict',
      message: 'The phone number and the email address belong to different existing customers. Open the right customer and update their details there, or use different contact details.',
      matches,
    };
  }
  return { kind: 'exists', message: 'A customer with these contact details already exists.', matches };
}
