import { createHash, createHmac, timingSafeEqual } from 'crypto';
import db from '../db/init';
import { deriveKey } from '../auth/session';

// Customers manage a booking with a signed token instead of the booking reference alone.
// A token names one appointment, carries its expiry, and is bound to the customer's email address,
// so changing the customer's email invalidates links that were sent to the old address.
// Format: v1.<appointment id, base64url>.<expiry, unix seconds base36>.<HMAC-SHA256, base64url>

const VERSION = 'v1';
/** Tokens issued after looking a booking up by reference + email. */
export const LOOKUP_TOKEN_TTL_MS = 60 * 60_000;
/** Links in booking emails stay valid until a week after the appointment day. */
const EMAIL_LINK_DAYS_AFTER = 7;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sign(appointmentId: string, exp: number, email: string): string {
  return createHmac('sha256', deriveKey('booking-manage-v1'))
    .update(`${VERSION}|${appointmentId}|${exp}|${normalizeEmail(email)}`)
    .digest('base64url');
}

export function issueManageToken(appointmentId: string, customerEmail: string, expiresAtMs: number): string {
  const exp = Math.floor(expiresAtMs / 1000);
  return [VERSION, Buffer.from(appointmentId).toString('base64url'), exp.toString(36), sign(appointmentId, exp, customerEmail)].join('.');
}

export function emailLinkExpiry(appointmentDate: string): number {
  return Math.max(Date.parse(`${appointmentDate}T23:59:59Z`), Date.now()) + EMAIL_LINK_DAYS_AFTER * 86_400_000;
}

/** Compares two email addresses without revealing through timing how much of them matched. */
export function sameEmail(a: string, b: string): boolean {
  const ha = createHash('sha256').update(normalizeEmail(a)).digest();
  const hb = createHash('sha256').update(normalizeEmail(b)).digest();
  return timingSafeEqual(ha, hb);
}

export interface ManagedAppointment {
  id: string; organization_id: string; booking_ref: string; service_id: string; staff_id: string; status: string;
  date: string; start_time: string; end_time: string; duration: number; timezone: string;
  price: number; currency: string; location: string | null;
  customer_email: string; service_name: string; staff_name: string;
  org_name: string; org_phone: string | null; org_website: string | null;
}

export function loadManagedAppointment(appointmentId: string): ManagedAppointment | undefined {
  return db.prepare(
    `SELECT a.id, a.organization_id, a.booking_ref, a.service_id, a.staff_id, a.status, a.date, a.start_time, a.end_time,
            a.duration, a.timezone, a.price, a.currency, a.location,
            c.email AS customer_email, s.name AS service_name, st.name AS staff_name,
            o.name AS org_name, o.phone AS org_phone, o.website AS org_website
     FROM appointments a
     JOIN customers c ON c.id = a.customer_id
     JOIN services s ON s.id = a.service_id
     JOIN staff st ON st.id = a.staff_id
     JOIN organizations o ON o.id = a.organization_id
     WHERE a.id = ?`
  ).get(appointmentId) as ManagedAppointment | undefined;
}

export type TokenCheck =
  | { ok: true; appointment: ManagedAppointment; expiresAt: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' };

export function verifyManageToken(token: string | undefined | null): TokenCheck {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.trim().split('.');
  if (parts.length !== 4 || parts[0] !== VERSION || token.length > 512) return { ok: false, reason: 'invalid' };
  const appointmentId = Buffer.from(parts[1], 'base64url').toString('utf8');
  const exp = parseInt(parts[2], 36);
  if (!appointmentId || !Number.isSafeInteger(exp)) return { ok: false, reason: 'invalid' };

  const appointment = loadManagedAppointment(appointmentId);
  if (!appointment) return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(sign(appointmentId, exp, appointment.customer_email));
  const presented = Buffer.from(parts[3]);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { ok: false, reason: 'invalid' };
  // Expiry is reported only for genuine tokens, so the answer reveals nothing about forged ones.
  if (exp * 1000 <= Date.now()) return { ok: false, reason: 'expired' };
  return { ok: true, appointment, expiresAt: new Date(exp * 1000).toISOString() };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  return `${local.slice(0, 1)}•••@${domain}`;
}

/** What a verified customer sees: their booking, never other customers' data, internal notes or answers. */
export function publicBookingView(a: ManagedAppointment) {
  return {
    bookingRef: a.booking_ref,
    serviceId: a.service_id,
    staffId: a.staff_id,
    status: a.status,
    date: a.date,
    startTime: a.start_time,
    endTime: a.end_time,
    duration: a.duration,
    timezone: a.timezone,
    price: a.price,
    currency: a.currency,
    location: a.location ?? '',
    serviceName: a.service_name,
    staffName: a.staff_name,
    maskedEmail: maskEmail(a.customer_email),
    business: { name: a.org_name, phone: a.org_phone, website: a.org_website },
  };
}
