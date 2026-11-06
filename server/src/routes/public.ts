import { Router } from 'express';
import { z } from 'zod';
import { phoneField } from '../lib/phone';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { getAvailableSlots, todayInTimezone, getOrgTimezone } from '../services/availability';
import { sendAppointmentEmail } from '../services/email/notify';
import { staffBookingProblem } from '../services/bookability';
import { DateString, TimeString, isRealDate } from '../validation';
import {
  verifyManageToken, issueManageToken, emailLinkExpiry, publicBookingView, sameEmail, loadManagedAppointment,
  LOOKUP_TOKEN_TTL_MS, type TokenCheck,
} from '../services/booking-access';
import { RULES, clientKey, consume, rateLimit, sendRateLimited } from '../middleware/rate-limit';
import { appointmentState, recordChanges, recordCreated } from '../services/appointment-history';
import { chooseResources, heldResources, holdResources, releaseResources } from '../services/resources';
import { zonedToInstant } from '../services/zoned-time';
import { currentMedia, mediaUrl, readImage, staffPhotoUrls } from '../services/media/media';
import { getPreferences } from '../services/email/preferences';
import { connectionUsable, consentFor, recordConsent, ruleEnabled } from '../services/notifications/settings';
import { appointmentIcs } from '../services/notifications/ics';
import { EVENTS } from '../services/notifications/types';

const router = Router();

// Generous ceiling on public reads (pages, staff, availability) per visitor network.
router.use((req, res, next) => {
  if (req.method !== 'GET') { next(); return; }
  const limit = consume([{ rule: RULES.publicReadIp, key: clientKey(req) }]);
  if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
  next();
});

/** SQL condition: service `s` has at least one active staff member of its own business assigned to it. */
const HAS_ACTIVE_STAFF = `EXISTS (SELECT 1 FROM json_each(s.staff_ids) js JOIN staff st ON st.id = js.value
  WHERE st.is_active = 1 AND st.organization_id = s.organization_id)`;

/**
 * A service is public only while it is active, has at least one active staff member assigned, and is listed on a
 * published booking page of its business. Unpublished or unstaffed services cannot be booked, and their staff
 * schedules cannot be read, by guessing ids.
 */
function serviceIsPublic(serviceId: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM services s
     WHERE s.id = ? AND s.is_active = 1 AND ${HAS_ACTIVE_STAFF} AND EXISTS (
       SELECT 1 FROM booking_pages bp
       WHERE bp.organization_id = s.organization_id AND bp.is_published = 1
         AND (bp.service_id = s.id OR EXISTS (SELECT 1 FROM json_each(bp.service_ids) j WHERE j.value = s.id)))`
  ).get(serviceId);
}

const BOOKING_TOKEN_HEADER = 'x-booking-token';

function tokenError(res: import('express').Response, check: Extract<TokenCheck, { ok: false }>): void {
  res.status(401).json(check.reason === 'expired'
    ? { error: 'This booking link has expired. Look up your booking again with your reference and email address.', code: 'BOOKING_TOKEN_EXPIRED' }
    : { error: 'This booking link is not valid. Look up your booking with your reference and email address.', code: 'BOOKING_TOKEN_INVALID' });
}

/**
 * For availability requests made while rescheduling: the caller's own appointment must not block its new time.
 * Returns undefined when no token was sent, null when the token is bad (response already sent).
 */
function ownAppointmentFromToken(req: import('express').Request, res: import('express').Response, serviceId: string, staffId?: string): { id: string } | undefined | null {
  const header = req.get(BOOKING_TOKEN_HEADER);
  if (!header) return undefined;
  const check = verifyManageToken(header);
  if (!check.ok) { tokenError(res, check); return null; }
  const a = check.appointment;
  if (a.service_id !== serviceId || (staffId && staffId !== ANY_STAFF && a.staff_id !== staffId)) return undefined;
  return { id: a.id };
}

interface PublicServiceRow { organization_id: string; staff_ids: string; duration: number; buffer_before: number; buffer_after: number }

/** Active service + active staff in the same organization, with the staff member assigned to the service. */
function resolveServiceStaff(serviceId: string, staffId: string):
  | { ok: true; svc: Record<string, unknown> & PublicServiceRow; orgId: string }
  | { ok: false; status: number; error: string } {
  const svc = db.prepare('SELECT * FROM services WHERE id = ? AND is_active = 1').get(serviceId) as (Record<string, unknown> & PublicServiceRow) | undefined;
  if (!svc) return { ok: false, status: 404, error: 'Service not found or inactive' };
  const staff = db.prepare('SELECT organization_id FROM staff WHERE id = ? AND is_active = 1').get(staffId) as { organization_id: string } | undefined;
  if (!staff || staff.organization_id !== svc.organization_id) return { ok: false, status: 400, error: 'Staff member not found or inactive' };
  const assigned = JSON.parse(svc.staff_ids ?? '[]') as string[];
  if (!assigned.includes(staffId)) return { ok: false, status: 400, error: 'This staff member does not offer the selected service' };
  return { ok: true, svc, orgId: svc.organization_id };
}

export const ANY_STAFF = 'any';

/** Active staff in the service's organization who are assigned to the service. */
function assignedStaffIds(serviceId: string): string[] {
  const svc = db.prepare('SELECT staff_ids, organization_id FROM services WHERE id = ? AND is_active = 1')
    .get(serviceId) as { staff_ids: string; organization_id: string } | undefined;
  if (!svc) return [];
  const ids = JSON.parse(svc.staff_ids ?? '[]') as string[];
  if (!ids.length) return [];
  const rows = db.prepare(
    `SELECT id FROM staff WHERE id IN (${ids.map(() => '?').join(',')}) AND is_active = 1 AND organization_id = ? ORDER BY name`
  ).all(...ids, svc.organization_id) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

function slotsFor(serviceId: string, staffId: string, date: string, svc: PublicServiceRow) {
  return getAvailableSlots({
    date, serviceId, staffId,
    duration: svc.duration, bufferBefore: svc.buffer_before, bufferAfter: svc.buffer_after,
  });
}

/** Phone is required unless the organization explicitly turned the rule off. */
/** A channel is offered to customers when the business switched it on for them and its provider is verified. */
function offersMessages(orgId: string, channel: 'sms' | 'whatsapp'): boolean {
  return connectionUsable(orgId, channel) && EVENTS.some(e => ruleEnabled(orgId, e, 'customer', channel));
}

/** For each channel the customer agreed to on this booking: sent, will be sent, or not sent (no internal reasons). */
function customerMessageStatus(orgId: string, appointmentId: string, consent: { sms?: boolean; whatsapp?: boolean } | undefined) {
  const out: Partial<Record<'sms' | 'whatsapp', 'sent' | 'queued' | 'not_sent'>> = {};
  for (const channel of ['sms', 'whatsapp'] as const) {
    if (!consent?.[channel]) continue;
    const status = db.prepare(`SELECT status FROM notification_jobs WHERE appointment_id = ? AND event = 'confirmed' AND recipient_role = 'customer' AND channel = ?`)
      .pluck().get(appointmentId, channel) as string | undefined;
    if (!status) continue; // the business does not send this message
    const willSend = ['pending', 'sending'].includes(status) && connectionUsable(orgId, channel);
    out[channel] = ['sent', 'delivered', 'read'].includes(status) ? 'sent' : willSend ? 'queued' : 'not_sent';
  }
  return out;
}

function orgRequiresPhone(orgId: string): boolean {
  const row = db.prepare('SELECT booking_rules FROM organizations WHERE id = ?').get(orgId) as { booking_rules: string | null } | undefined;
  const rules = JSON.parse(row?.booking_rules ?? '{}') as { requirePhone?: boolean };
  return rules.requirePhone !== false;
}

// Public booking page info (no auth required)
router.get('/pages/:slug', (req, res, next) => {
  try {
    const row = db.prepare(
      `SELECT bp.*, o.name as org_name, o.timezone as org_timezone, o.logo as org_logo
       FROM booking_pages bp
       JOIN organizations o ON bp.organization_id = o.id
       WHERE bp.slug = ? AND bp.is_published = 1`
    ).get(req.params.slug) as Record<string, unknown> | undefined;

    if (!row) { res.status(404).json({ error: 'Booking page not found' }); return; }

    const serviceIds: string[] = JSON.parse(row.service_ids as string ?? '[]');
    // Only services someone can actually deliver: a service without an active staff member is not offered.
    const services = serviceIds.length
      ? db.prepare(
          `SELECT s.id, s.name, s.description, s.duration, s.price, s.currency, s.color, s.category
           FROM services s WHERE s.id IN (${serviceIds.map(() => '?').join(',')}) AND s.is_active = 1 AND s.organization_id = ?
             AND ${HAS_ACTIVE_STAFF}`
        ).all(...serviceIds, row.organization_id)
      : [];

    res.json({
      data: {
        id: row.id,
        title: row.title,
        description: row.description,
        slug: row.slug,
        type: row.type,
        orgName: row.org_name,
        // The uploaded logo; otherwise the logo address from Settings, only if it is https; otherwise null.
        logoUrl: uploadedLogoUrl(row.organization_id as string)
          ?? (typeof row.org_logo === 'string' && row.org_logo.startsWith('https://') ? row.org_logo : null),
        timezone: row.org_timezone,
        // The business's booking language: the page starts in it unless the visitor chose a language before.
        language: getPreferences(row.organization_id as string).bookingLanguage,
        theme: JSON.parse(row.theme as string ?? '{}'),
        formFields: JSON.parse(row.form_fields as string ?? '[]'),
        requirePhone: orgRequiresPhone(row.organization_id as string),
        // Whether the business sends customers text messages; the form then asks for consent (unticked by default).
        messaging: { sms: offersMessages(row.organization_id as string, 'sms'), whatsapp: offersMessages(row.organization_id as string, 'whatsapp') },
        services,
      },
    });
  } catch (err) { next(err); }
});

function uploadedLogoUrl(orgId: string): string | null {
  const logo = currentMedia(orgId, 'logo', orgId);
  return logo ? mediaUrl(logo.id) : null;
}

// Uploaded logos and staff photos, by their random id. Served as images only: the type recorded from the file's own
// bytes, no sniffing, no scripts, never as a page; ids are unique per upload, so the response can be cached for good.
router.get('/media/:id', async (req, res, next) => {
  try {
    const found = await readImage(req.params.id);
    if (!found) { res.status(404).json({ error: 'Not found' }); return; }
    const ext = found.row.content_type === 'image/jpeg' ? 'jpg' : found.row.content_type.slice(6);
    res.set({
      'Content-Type': found.row.content_type,
      'Content-Length': String(found.bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `inline; filename="${found.row.kind === 'logo' ? 'logo' : 'photo'}.${ext}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      ETag: `"${found.row.sha256}"`,
    });
    res.end(found.bytes);
  } catch (err) { next(err); }
});

// Get staff for a service
router.get('/services/:id/staff', (req, res, next) => {
  try {
    const svc = serviceIsPublic(req.params.id) ? db
      .prepare('SELECT staff_ids, organization_id FROM services WHERE id = ? AND is_active = 1')
      .get(req.params.id) as { staff_ids: string; organization_id: string } | undefined : undefined;

    if (!svc) { res.status(404).json({ error: 'Service not found' }); return; }

    const staffIds: string[] = JSON.parse(svc.staff_ids ?? '[]');
    if (!staffIds.length) {
      res.json({ data: [] });
      return;
    }

    const staff = db.prepare(
      `SELECT id, name, title, bio, color FROM staff
       WHERE id IN (${staffIds.map(() => '?').join(',')}) AND is_active = 1 AND organization_id = ?`
    ).all(...staffIds, svc.organization_id) as Array<{ id: string }>;
    const photos = staffPhotoUrls(svc.organization_id);

    res.json({ data: staff.map(s => ({ ...s, photoUrl: photos.get(s.id) ?? null })) });
  } catch (err) { next(err); }
});

// Available slots
// Which days in a range have at least one bookable slot, so calendars can disable the rest.
router.get('/availability/days', (req, res, next) => {
  try {
    const { serviceId, staffId, from, to } = req.query as Record<string, string | undefined>;
    if (!serviceId || !staffId || !from || !to) {
      res.status(400).json({ error: 'serviceId, staffId, from and to are required' });
      return;
    }
    const own = ownAppointmentFromToken(req, res, serviceId);
    if (own === null) return;
    if (!own && !serviceIsPublic(serviceId)) { res.status(404).json({ error: 'Service not found' }); return; }
    if (!isRealDate(from) || !isRealDate(to) || to < from) {
      res.status(400).json({ error: 'from and to must be real dates (YYYY-MM-DD) with to on or after from' });
      return;
    }
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span > 62) { res.status(400).json({ error: 'Range must be 62 days or fewer' }); return; }

    let candidates: string[];
    if (staffId === ANY_STAFF) {
      candidates = assignedStaffIds(serviceId);
      if (!candidates.length) { res.status(404).json({ error: 'No staff available for this service' }); return; }
    } else {
      const resolved = resolveServiceStaff(serviceId, staffId);
      if (!resolved.ok) { res.status(resolved.status).json({ error: resolved.error }); return; }
      candidates = [staffId];
    }
    const svc = db.prepare('SELECT duration, buffer_before, buffer_after FROM services WHERE id = ?').get(serviceId) as PublicServiceRow;

    const days: Array<{ date: string; available: boolean }> = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
      const date = new Date(t).toISOString().slice(0, 10);
      const available = candidates.some(id => getAvailableSlots({
        date, serviceId, staffId: id,
        duration: svc.duration, bufferBefore: svc.buffer_before, bufferAfter: svc.buffer_after,
        excludeAppointmentId: own?.id,
      }).some(s => s.available));
      days.push({ date, available });
    }
    res.json({ data: days });
  } catch (err) { next(err); }
});

router.get('/availability', (req, res, next) => {
  try {
    const { date, serviceId, staffId } = req.query as Record<string, string | undefined>;
    if (!date || !serviceId || !staffId) {
      res.status(400).json({ error: 'date, serviceId, and staffId are required' });
      return;
    }
    if (!isRealDate(date)) { res.status(400).json({ error: 'date must be a real calendar date (YYYY-MM-DD)' }); return; }
    const own = ownAppointmentFromToken(req, res, serviceId, staffId);
    if (own === null) return;
    if (!own && !serviceIsPublic(serviceId)) { res.status(404).json({ error: 'Service not found' }); return; }

    if (staffId === ANY_STAFF) {
      // A start time is offered when at least one assigned staff member is free then.
      const candidates = assignedStaffIds(serviceId);
      if (!candidates.length) { res.status(404).json({ error: 'No staff available for this service' }); return; }
      const svc = db.prepare('SELECT duration, buffer_before, buffer_after FROM services WHERE id = ?').get(serviceId) as PublicServiceRow;
      const merged = new Map<string, { start: string; end: string; available: boolean }>();
      for (const id of candidates) {
        for (const s of slotsFor(serviceId, id, date, svc)) {
          const prev = merged.get(s.start);
          merged.set(s.start, prev ? { ...prev, available: prev.available || s.available } : { ...s });
        }
      }
      res.json({ data: [...merged.values()].sort((a, b) => a.start.localeCompare(b.start)) });
      return;
    }

    const resolved = resolveServiceStaff(serviceId, staffId);
    if (!resolved.ok) { res.status(resolved.status).json({ error: resolved.error }); return; }
    res.json({ data: getAvailableSlots({
      date, serviceId, staffId,
      duration: resolved.svc.duration, bufferBefore: resolved.svc.buffer_before, bufferAfter: resolved.svc.buffer_after,
      excludeAppointmentId: own?.id,
    }) });
  } catch (err) { next(err); }
});

const BookingSchema = z.object({
  pageSlug: z.string().optional(),
  serviceId: z.string().min(1),
  staffId: z.string().min(1),
  date: DateString,
  startTime: TimeString,
  // Ignored: bookings always use the business time zone.
  timezone: z.string().optional(),
  customer: z.object({
    name: z.string()
      .min(1, 'Name is required')
      .max(100, 'Name must be 100 characters or fewer')
      .refine(s => s.trim().length > 0, 'Name cannot be all whitespace')
      .refine(s => !/[<>]/.test(s), 'Name must not contain HTML characters'),
    email: z.string().trim().toLowerCase().email('Enter a valid email address').max(254),
    phone: phoneField().optional(),
  }),
  notes: z.string().max(2000).optional(),
  /** The customer's own choice on the booking form; absent when the form did not ask. */
  consent: z.object({ sms: z.boolean().optional(), whatsapp: z.boolean().optional() }).strict().optional(),
  customerAnswers: z.array(z.object({
    fieldId: z.string().max(64),
    answer: z.string().max(1000),
  })).max(50).optional(),
});

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

// Every booking sends an email to the address given, so bookings are limited per network and per recipient.
const bookLimit = rateLimit(req => {
  const email = (req.body as { customer?: { email?: unknown } } | undefined)?.customer?.email;
  return [
    { rule: RULES.bookIp, key: clientKey(req) },
    { rule: RULES.bookEmail, key: typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : null },
  ];
});

// Create a booking (public — no auth)
router.post('/book', bookLimit, async (req, res, next) => {
  try {
    const data = BookingSchema.parse(req.body);

    if (!data.pageSlug && !serviceIsPublic(data.serviceId)) {
      res.status(400).json({ error: 'Service not found or inactive' });
      return;
    }
    // With a page, the page must be published and list the service before anything else is looked at.
    if (data.pageSlug) {
      const page = db.prepare('SELECT service_ids, service_id FROM booking_pages WHERE slug = ? AND is_published = 1')
        .get(data.pageSlug) as { service_ids: string; service_id: string | null } | undefined;
      if (!page) { res.status(404).json({ error: 'Booking page not found' }); return; }
      if (!(JSON.parse(page.service_ids ?? '[]') as string[]).includes(data.serviceId) && page.service_id !== data.serviceId) {
        res.status(400).json({ error: 'Service is not available on this booking page' });
        return;
      }
    }

    if (data.staffId === ANY_STAFF) {
      // Assign the first assigned staff member (alphabetical) who is free at the requested time.
      const svcRow = db.prepare('SELECT duration, buffer_before, buffer_after FROM services WHERE id = ? AND is_active = 1')
        .get(data.serviceId) as PublicServiceRow | undefined;
      if (!svcRow) { res.status(400).json({ error: 'Service not found or inactive' }); return; }
      const free = assignedStaffIds(data.serviceId)
        .find(id => slotsFor(data.serviceId, id, data.date, svcRow).find(s => s.start === data.startTime)?.available);
      if (!free) { res.status(409).json({ error: 'That time slot is no longer available' }); return; }
      data.staffId = free;
    }

    const resolved = resolveServiceStaff(data.serviceId, data.staffId);
    if (!resolved.ok) { res.status(resolved.status === 404 ? 400 : resolved.status).json({ error: resolved.error }); return; }
    const svc = resolved.svc;
    const orgId = resolved.orgId;

    if (data.date < todayInTimezone(getOrgTimezone(orgId))) {
      res.status(400).json({ error: 'Cannot book a date in the past' });
      return;
    }

    if (orgRequiresPhone(orgId) && !data.customer.phone) {
      res.status(400).json({ error: 'A phone number is required to book' });
      return;
    }

    // Answers are only accepted for questions defined on the booking page; stored as {question, answer}.
    let storedAnswers: Array<{ question: string; answer: string }> = [];
    if (data.customerAnswers?.length && !data.pageSlug) {
      res.status(400).json({ error: 'Answers can only be submitted through a booking page' });
      return;
    }

    // If pageSlug provided, enforce that this service belongs to that booking page
    if (data.pageSlug) {
      const page = db
        .prepare('SELECT service_ids, service_id, organization_id, form_fields FROM booking_pages WHERE slug = ? AND is_published = 1')
        .get(data.pageSlug) as { service_ids: string; service_id: string | null; organization_id: string; form_fields: string } | undefined;
      if (!page || page.organization_id !== orgId) { res.status(404).json({ error: 'Booking page not found' }); return; }
      const pageServiceIds = JSON.parse(page.service_ids ?? '[]') as string[];
      if (!pageServiceIds.includes(data.serviceId) && page.service_id !== data.serviceId) {
        res.status(400).json({ error: 'Service is not available on this booking page' });
        return;
      }
      const fields = JSON.parse(page.form_fields ?? '[]') as Array<{ id: string; label: string; required?: boolean }>;
      const byId = new Map((data.customerAnswers ?? []).map(a => [a.fieldId, a.answer.trim()]));
      for (const id of byId.keys()) {
        if (!fields.some(f => f.id === id)) { res.status(400).json({ error: 'Unknown question in answers' }); return; }
      }
      const missing = fields.filter(f => f.required && !byId.get(f.id));
      if (missing.length) {
        res.status(400).json({ error: `Please answer: ${missing.map(f => f.label).join(', ')}` });
        return;
      }
      storedAnswers = fields
        .filter(f => byId.get(f.id))
        .map(f => ({ question: f.label, answer: byId.get(f.id)! }));
    }

    const endTime = addMinutes(data.startTime, svc.duration as number);

    // Early availability check — fast reject for clearly unavailable slots before entering the transaction
    const slots = getAvailableSlots({
      date: data.date,
      serviceId: data.serviceId,
      staffId: data.staffId,
      duration: svc.duration as number,
      bufferBefore: svc.buffer_before as number,
      bufferAfter: svc.buffer_after as number,
    });
    const requested = slots.find(s => s.start === data.startTime);
    if (!requested?.available) {
      res.status(409).json({ error: 'That time slot is no longer available' });
      return;
    }

    // Generate IDs outside the transaction; unused IDs are harmless if the transaction rolls back
    const bookingRef = 'WE-' + nanoid(8).toUpperCase();
    const id = `appt-${nanoid(8)}`;
    const newCustomerId = `cust-${nanoid(8)}`;

    // Atomically re-check conflict + upsert customer + insert appointment.
    // The re-check inside the transaction is the true concurrency guard — the early check
    // above is just a fast-path rejection for obviously-unavailable slots.
    type BookResult = { bookingRef: string; appointmentId: string } | 'conflict' | { problem: string };

    const result: BookResult = db.transaction((): BookResult => {
      // Half-open interval conflict: existingStart < newEnd AND existingEnd > newStart
      const conflict = db.prepare(
        `SELECT COUNT(*) as c FROM appointments
         WHERE staff_id = ? AND date = ? AND status NOT IN ('cancelled','no_show')
           AND start_time < ? AND end_time > ?`
      ).get(data.staffId, data.date, endTime, data.startTime) as { c: number };

      if (conflict.c > 0) return 'conflict';
      // A service that needs a room or other resource takes a free one of its pool, checked under the same lock.
      const resources = chooseResources({ orgId, serviceId: data.serviceId, date: data.date, startTime: data.startTime, endTime });
      if ('error' in resources) return { problem: resources.error };

      // Upsert customer (email is the dedup key within the org)
      const existingCust = db
        .prepare('SELECT id FROM customers WHERE organization_id = ? AND email = ?')
        .get(orgId, data.customer.email.toLowerCase()) as { id: string } | undefined;
      const customerId = existingCust ? existingCust.id : newCustomerId;

      if (!existingCust) {
        db.prepare(
          `INSERT INTO customers (id, organization_id, name, email, phone, tags)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(customerId, orgId, data.customer.name.trim(),
              data.customer.email.toLowerCase(),
              data.customer.phone || null, '[]');
      }
      // Consent before the booking is recorded, so its notifications are planned with the customer's latest choice.
      for (const channel of ['sms', 'whatsapp'] as const) {
        const choice = data.consent?.[channel];
        if (choice === true) recordConsent(orgId, customerId, channel, 'granted', 'booking_page');
        else if (choice === false && consentFor(customerId)[channel].status === 'granted') recordConsent(orgId, customerId, channel, 'revoked', 'booking_page');
      }

      db.prepare(
        `INSERT INTO appointments
          (id, booking_ref, organization_id, service_id, staff_id, customer_id,
           resource_ids, status, date, start_time, end_time, duration, timezone,
           price, currency, location, notes, internal_notes, customer_answers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, bookingRef, orgId, data.serviceId, data.staffId, customerId,
        '[]', 'scheduled',
        data.date, data.startTime, endTime, svc.duration,
        getOrgTimezone(orgId),
        svc.price, svc.currency, svc.location,
        data.notes ?? '', '',
        JSON.stringify(storedAnswers),
      );

      db.prepare(
        `UPDATE customers SET total_bookings = total_bookings + 1, last_booking_date = ? WHERE id = ?`
      ).run(data.date, customerId);
      holdResources(id, orgId, resources.ids);
      recordCreated(appointmentState(id)!, { type: 'customer', source: 'booking_page' });

      return { bookingRef, appointmentId: id };
    }).immediate();

    if (result === 'conflict') {
      res.status(409).json({ error: 'That time slot is no longer available' });
      return;
    }
    if ('problem' in result) { res.status(409).json({ error: result.problem }); return; }

    // The booking is committed; email is attempted afterwards and its real outcome is reported.
    const email = await sendAppointmentEmail('confirmation', result.appointmentId);

    res.status(201).json({
      data: {
        email: { status: email.status },
        messages: customerMessageStatus(orgId, result.appointmentId, data.consent),
        bookingRef: result.bookingRef,
        appointmentId: result.appointmentId,
        date: data.date,
        startTime: data.startTime,
        endTime,
        serviceName: svc.name,
        staffName: (db.prepare('SELECT name FROM staff WHERE id = ?').get(data.staffId) as { name: string }).name,
        duration: svc.duration,
        // Lets the person who just booked open "manage booking" without looking it up again.
        manageToken: issueManageToken(result.appointmentId, data.customer.email, emailLinkExpiry(data.date)),
      },
    });
  } catch (err) { next(err); }
});

// ─── Customer self-service ────────────────────────────────────────────────────
// A booking reference alone grants nothing. Customers prove they own a booking with reference + email
// (or by opening the signed link from their booking email) and then act with a short-lived manage token.

const LookupSchema = z.object({
  ref: z.string().trim().min(1).max(32),
  email: z.string().trim().max(254).email('Enter the email address you booked with'),
});

// Only failed lookups count, per network and per booking reference, so guessing is slow but customers are not blocked.
const lookupLimit = rateLimit(req => {
  const ref = (req.body as { ref?: unknown } | undefined)?.ref;
  return [
    { rule: RULES.lookupIp, key: clientKey(req) },
    { rule: RULES.lookupRef, key: typeof ref === 'string' ? ref.trim().toUpperCase().slice(0, 32) : null },
  ];
}, { countIf: status => status === 404 });

router.post('/appointments/lookup', lookupLimit, (req, res, next) => {
  try {
    const parsed = LookupSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Booking reference and email are required' }); return; }
    const row = db.prepare(
      'SELECT a.id, c.email FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.booking_ref = ?'
    ).get(parsed.data.ref.toUpperCase()) as { id: string; email: string } | undefined;

    // Same answer for an unknown reference and a wrong email, so neither can be probed separately.
    if (!row || !sameEmail(row.email, parsed.data.email)) {
      res.status(404).json({ error: "We couldn't find a booking with that reference and email address." });
      return;
    }
    const appointment = loadManagedAppointment(row.id)!;
    const expiresAt = Date.now() + LOOKUP_TOKEN_TTL_MS;
    res.json({
      data: {
        token: issueManageToken(row.id, row.email, expiresAt),
        expiresAt: new Date(expiresAt).toISOString(),
        appointment: publicBookingView(appointment),
      },
    });
  } catch (err) { next(err); }
});

const MANAGE_LINK_SENT = "If the reference and email address match a booking that can still be changed, we've emailed a link to manage it to the address on the booking.";

// Every request may send an email, so every request counts (per network and per booking reference).
const manageLinkLimit = rateLimit(req => {
  const ref = (req.body as { ref?: unknown } | undefined)?.ref;
  return [
    { rule: RULES.manageLinkIp, key: clientKey(req) },
    { rule: RULES.manageLinkRef, key: typeof ref === 'string' ? ref.trim().toUpperCase().slice(0, 32) : null },
  ];
});

/**
 * Emails the manage link again, only to the address stored on the booking and only for bookings the customer can still
 * change. The answer is the same whether or not anything matched, and it does not wait for the email.
 */
router.post('/appointments/manage-link', manageLinkLimit, (req, res, next) => {
  try {
    const parsed = LookupSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Booking reference and email are required' }); return; }
    const row = db.prepare(
      `SELECT a.id, a.status, a.date, a.start_time, a.timezone, c.email
       FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.booking_ref = ?`
    ).get(parsed.data.ref.toUpperCase()) as { id: string; status: string; date: string; start_time: string; timezone: string; email: string } | undefined;
    if (row && sameEmail(row.email, parsed.data.email) && !customerChangeProblem(row, 'cancelled')) {
      // The confirmation carries the signed manage link; a manual send is a new email, not de-duplicated.
      void sendAppointmentEmail('confirmation', row.id, undefined, { manual: true });
    }
    res.status(202).json({ data: { message: MANAGE_LINK_SENT } });
  } catch (err) { next(err); }
});

/** The booking's calendar file (.ics), for "Add to calendar". A file only: nothing is added to any calendar by the server. */
router.get('/appointments/manage/ics', (req, res, next) => {
  try {
    const check = verifyManageToken(req.get(BOOKING_TOKEN_HEADER));
    if (!check.ok) { tokenError(res, check); return; }
    const ics = appointmentIcs(check.appointment.id);
    if (!ics) { res.status(404).json({ error: 'Booking not found' }); return; }
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${ics.filename}"`, 'Cache-Control': 'no-store' });
    res.send(ics.content);
  } catch (err) { next(err); }
});

router.get('/appointments/manage', (req, res, next) => {
  try {
    const check = verifyManageToken(req.get(BOOKING_TOKEN_HEADER));
    if (!check.ok) { tokenError(res, check); return; }
    res.json({ data: { ...publicBookingView(check.appointment), tokenExpiresAt: check.expiresAt } });
  } catch (err) { next(err); }
});

const manageLimit = rateLimit(req => [{ rule: RULES.manageIp, key: clientKey(req) }]);

/**
 * Why the customer cannot cancel or move this booking online, or null. Only scheduled and confirmed bookings that have
 * not started can be changed: outcomes (completed, no-show) are recorded by the business, and a missed booking stays
 * on record instead of being moved or cancelled afterwards.
 */
function customerChangeProblem(a: { status: string; date: string; start_time: string; timezone: string }, change: 'cancelled' | 'rescheduled'): string | null {
  if (a.status === 'cancelled') return change === 'cancelled' ? 'Booking is already cancelled' : 'Cancelled bookings cannot be rescheduled';
  if (a.status === 'completed') return `Completed bookings cannot be ${change}`;
  if (a.status === 'no_show') return `This booking was marked as missed, so it can no longer be ${change}. Please make a new booking or contact the business.`;
  if (zonedToInstant(a.date, a.start_time, a.timezone) <= Date.now()) {
    return `This appointment has already started, so it can no longer be ${change} online. Please contact the business.`;
  }
  return null;
}

/** Verifies the manage token and applies the per-booking change limit. Sends the error response itself. */
function authorizeChange(req: import('express').Request, res: import('express').Response) {
  const check = verifyManageToken(req.get(BOOKING_TOKEN_HEADER));
  if (!check.ok) { tokenError(res, check); return null; }
  const limit = consume([{ rule: RULES.manageBooking, key: check.appointment.id }]);
  if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return null; }
  return check.appointment;
}

router.post('/appointments/manage/cancel', manageLimit, async (req, res, next) => {
  try {
    const appt = authorizeChange(req, res);
    if (!appt) return;
    const problem = customerChangeProblem(appt, 'cancelled');
    if (problem) { res.status(400).json({ error: problem }); return; }

    // Checked again under the write lock; the change and its history entry are saved together.
    const changed = db.transaction((): boolean => {
      const before = appointmentState(appt.id);
      if (!before || customerChangeProblem({ ...before, timezone: appt.timezone }, 'cancelled')) return false;
      db.prepare(
        `UPDATE appointments SET status = 'cancelled', updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         WHERE id = ? AND status = ?`
      ).run(appt.id, before.status);
      recordChanges(before, appointmentState(appt.id)!, { type: 'customer', source: 'manage_link' });
      return true;
    }).immediate();
    if (!changed) { res.status(409).json({ error: 'This booking was changed by someone else. Reload it and try again.' }); return; }

    const email = await sendAppointmentEmail('cancellation', appt.id);
    res.json({ data: { bookingRef: appt.booking_ref, status: 'cancelled', email: { status: email.status } } });
  } catch (err) { next(err); }
});

const RescheduleSchema = z.object({ date: DateString, startTime: TimeString });

router.post('/appointments/manage/reschedule', manageLimit, async (req, res, next) => {
  try {
    const parsed = RescheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'date and startTime are required' });
      return;
    }
    const { date, startTime } = parsed.data;

    const existing = authorizeChange(req, res);
    if (!existing) return;
    const problem = customerChangeProblem(existing, 'rescheduled');
    if (problem) { res.status(400).json({ error: problem }); return; }

    const today = todayInTimezone(getOrgTimezone(existing.organization_id));
    if (date < today) {
      res.status(400).json({ error: 'Cannot reschedule to a date in the past' });
      return;
    }

    const svc = db
      .prepare('SELECT duration, buffer_before, buffer_after FROM services WHERE id = ?')
      .get(existing.service_id) as { duration: number; buffer_before: number; buffer_after: number } | undefined;
    if (!svc) { res.status(400).json({ error: 'Service not found' }); return; }

    const endTime = addMinutes(startTime, svc.duration);
    if (staffBookingProblem(existing.organization_id, existing.staff_id, existing.service_id, date, startTime, endTime)) {
      res.status(409).json({ error: 'That time is not available. Please choose another time.' });
      return;
    }

    const requested = getAvailableSlots({
      date,
      serviceId: existing.service_id,
      staffId: existing.staff_id,
      duration: svc.duration,
      bufferBefore: svc.buffer_before,
      bufferAfter: svc.buffer_after,
      excludeAppointmentId: existing.id,
    }).find(s => s.start === startTime);
    if (!requested?.available) {
      res.status(409).json({ error: 'That time slot is no longer available' });
      return;
    }

    // Re-check and write under the write lock so two reschedules cannot claim the same slot.
    const moved = db.transaction((): 'moved' | 'changed' | 'taken' => {
      const before = appointmentState(existing.id);
      if (!before || customerChangeProblem({ ...before, timezone: existing.timezone }, 'rescheduled')) return 'changed';
      const clash = db.prepare(
        `SELECT 1 FROM appointments
         WHERE staff_id = ? AND date = ? AND id != ? AND status NOT IN ('cancelled','no_show')
           AND start_time < ? AND end_time > ?`
      ).get(existing.staff_id, date, existing.id, endTime, startTime);
      if (clash) return 'taken';
      const resources = chooseResources({
        orgId: existing.organization_id, serviceId: existing.service_id, date, startTime, endTime,
        excludeAppointmentId: existing.id, keep: heldResources(existing.id),
      });
      if ('error' in resources) return 'taken';
      releaseResources(existing.id);
      db.prepare(
        `UPDATE appointments SET date = ?, start_time = ?, end_time = ?, status = 'scheduled',
         updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE id = ? AND status = ?`
      ).run(date, startTime, endTime, existing.id, before.status);
      holdResources(existing.id, existing.organization_id, resources.ids);
      recordChanges(before, appointmentState(existing.id)!, { type: 'customer', source: 'manage_link' });
      return 'moved';
    }).immediate();
    if (moved === 'changed') { res.status(409).json({ error: 'This booking was changed by someone else. Reload it and try again.' }); return; }
    if (moved === 'taken') { res.status(409).json({ error: 'That time slot is no longer available' }); return; }

    const email = await sendAppointmentEmail('reschedule', existing.id, { date: existing.date, startTime: existing.start_time, endTime: existing.end_time });
    res.json({ data: { bookingRef: existing.booking_ref, status: 'scheduled', date, startTime, endTime, email: { status: email.status } } });
  } catch (err) { next(err); }
});

export default router;
