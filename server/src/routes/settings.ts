import express, { Router } from 'express';
import { z } from 'zod';
import { phoneField } from '../lib/phone';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { TimeString, TimeZoneString, isHttpsUrl } from '../validation';
import { planZoneChange, applyZoneChange } from '../services/timezone-change';
import { emailTransportName } from '../services/email/notify';
import { CurrencySchema, SUPPORTED_CURRENCIES } from '../currency';
import { DEFAULT_TIMEZONE } from '../services/business-locale';
import { currentMedia, publicMedia, removeImage, saveImage } from '../services/media/media';
import { MAX_UPLOAD_BYTES } from '../services/media/image-check';
import { RULES, consume, sendRateLimited } from '../middleware/rate-limit';
import {
  getPreferences, savePreferences, listTemplates, saveTemplate, deleteTemplate, templateProblem, TEMPLATE_KINDS, PLACEHOLDERS,
  type TemplateKind,
} from '../services/email/preferences';
import { defaultTemplateText, renderAppointmentEmail } from '../services/email/templates';
import '../services/email/notifications';
import { applyPreferenceChanges } from '../services/notifications/settings';

const router = Router();
router.use(requireAuth);

// Units: minutes for durations/buffers, hours for notice, days for the advance window (0 = no limit).
// Unknown legacy keys are kept so older saved data still round-trips.
const BookingRulesSchema = z.object({
  minNoticeHours: z.number().min(0).max(720).optional(),
  maxAdvanceDays: z.number().int().min(0).max(730).optional(),
  sameDay: z.boolean().optional(),
  requirePhone: z.boolean().optional(),
  defaultDurationMinutes: z.number().int().positive().max(1440).optional(),
  defaultBufferMinutes: z.number().int().min(0).max(240).optional(),
}).passthrough();

// Business hours narrow every staff member's bookable hours (services/schedule.ts); {} means none are set.
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const BusinessDaySchema = z.object({
  enabled: z.boolean(),
  start: TimeString,
  end: TimeString,
}).refine(d => !d.enabled || d.end > d.start, { message: 'End time must be after start time', path: ['end'] });
const BusinessHoursSchema = z.object(
  Object.fromEntries(DAYS.map(d => [d, BusinessDaySchema.optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<typeof BusinessDaySchema>>,
).strict();

const OrgSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().email().max(254).optional(),
  phone: phoneField().optional(),
  website: z.string().max(200).optional(),
  address: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(60).optional(),
  timezone: TimeZoneString.optional(),
  currency: CurrencySchema.optional(),
  dateFormat: z.string().max(20).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  // A link to an image hosted elsewhere; inline data is not accepted.
  logo: z.string().max(2048).refine(v => v === '' || isHttpsUrl(v), 'Logo must be an https:// link').optional(),
  workingHours: BusinessHoursSchema.optional(),
  bookingRules: BookingRulesSchema.optional(),
  cancellationPolicy: z.string().max(2000).optional(),
});

function rowToOrg(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    website: row.website ?? null,
    address: row.address ?? null,
    city: row.city ?? null,
    country: row.country,
    timezone: row.timezone,
    currency: row.currency,
    dateFormat: row.date_format,
    timeFormat: row.time_format,
    logo: row.logo ?? null,
    workingHours: JSON.parse(row.working_hours as string ?? '{}'),
    bookingRules: JSON.parse(row.booking_rules as string ?? '{}'),
    cancellationPolicy: row.cancellation_policy ?? '',
    createdAt: row.created_at,
  };
}

router.get('/', requirePermission('catalog:read'), (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM organizations WHERE id = ?')
      .get(req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Organization not found' }); return; }
    const logo = currentMedia(req.user!.orgId, 'logo', req.user!.orgId);
    res.json({ data: { ...rowToOrg(row), logoUpload: logo ? publicMedia(logo) : null } });
  } catch (err) { next(err); }
});

// The business logo, sent as the request body itself (PNG, JPEG or WebP, checked from its bytes). Replaces the old one.
router.put('/logo', requirePermission('settings:write'), express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }), async (req: AuthRequest, res, next) => {
  try {
    const limit = consume([{ rule: RULES.uploadOrg, key: req.user!.orgId }]);
    if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await saveImage(req.user!.orgId, 'logo', req.user!.orgId, bytes, req.user!.sub);
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
    res.json({ data: result.media });
  } catch (err) { next(err); }
});

router.delete('/logo', requirePermission('settings:write'), async (req: AuthRequest, res, next) => {
  try {
    if (!(await removeImage(req.user!.orgId, 'logo', req.user!.orgId))) { res.status(404).json({ error: 'There is no uploaded logo' }); return; }
    res.json({ data: { removed: true } });
  } catch (err) { next(err); }
});

// ─── Notifications: reminders, staff alerts, language, email texts ───────────

const PreferencesSchema = z.object({
  bookingLanguage: z.enum(['en', 'hi']).optional(),
  remindersEnabled: z.boolean().optional(),
  reminderHoursBefore: z.number().int().min(1, 'Send reminders at least 1 hour before').max(168, 'Send reminders at most 7 days (168 hours) before').optional(),
  staffAlertsEnabled: z.boolean().optional(),
}).strict();

router.get('/notifications', requirePermission('catalog:read'), (req: AuthRequest, res) => {
  res.json({ data: getPreferences(req.user!.orgId) });
});

router.put('/notifications', requirePermission('settings:write'), (req: AuthRequest, res, next) => {
  try {
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
    const saved = db.transaction(() => {
      savePreferences(req.user!.orgId, parsed.data);
      applyPreferenceChanges(req.user!.orgId, parsed.data);
      return getPreferences(req.user!.orgId);
    })();
    res.json({ data: saved });
  } catch (err) { next(err); }
});

const TemplateSchema = z.object({ subject: z.string().max(400), intro: z.string().max(4000) });
const isKind = (k: string): k is TemplateKind => (TEMPLATE_KINDS as readonly string[]).includes(k);

/** Each kind of email: the business's own text if it set one, otherwise the built-in text in its language. */
router.get('/email-templates', requirePermission('catalog:read'), (req: AuthRequest, res) => {
  const lang = getPreferences(req.user!.orgId).bookingLanguage;
  const custom = new Map(listTemplates(req.user!.orgId).map(t => [t.kind, t]));
  res.json({
    data: {
      placeholders: PLACEHOLDERS,
      templates: TEMPLATE_KINDS.map(kind => {
        const own = custom.get(kind);
        return { kind, custom: !!own, ...(own ? { subject: own.subject, intro: own.intro, updatedAt: own.updatedAt } : defaultTemplateText(kind, lang)) };
      }),
    },
  });
});

function checkTemplate(res: import('express').Response, body: unknown): { subject: string; intro: string } | null {
  const parsed = TemplateSchema.safeParse(body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a subject and an opening text' }); return null; }
  const problem = templateProblem(parsed.data.subject, 'subject') ?? templateProblem(parsed.data.intro, 'intro');
  if (problem) { res.status(400).json({ error: problem, code: 'INVALID_TEMPLATE' }); return null; }
  return { subject: parsed.data.subject.trim(), intro: parsed.data.intro.trim() };
}

// A sample email with the given texts, so the business sees the result before saving. Nothing is sent.
router.post('/email-templates/preview', requirePermission('settings:write'), (req: AuthRequest, res) => {
  const kind = String((req.body as { kind?: unknown })?.kind ?? '');
  if (!isKind(kind)) { res.status(400).json({ error: 'Unknown email kind' }); return; }
  const texts = checkTemplate(res, req.body);
  if (!texts) return;
  const org = db.prepare('SELECT name, time_format FROM organizations WHERE id = ?').get(req.user!.orgId) as { name: string; time_format: string | null };
  const email = renderAppointmentEmail(kind, {
    language: getPreferences(req.user!.orgId).bookingLanguage, custom: texts,
    businessName: org.name, customerName: 'Asha Verma', bookingRef: 'WE-SAMPLE01', serviceName: 'Consultation', staffName: 'Ravi Kumar',
    date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10), startTime: '10:30', endTime: '11:00',
    timezone: DEFAULT_TIMEZONE, timeFormat: org.time_format === '24h' ? '24h' : '12h', manageUrl: 'https://example.com/book/lookup/manage',
    previous: kind === 'reschedule' ? { date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), startTime: '09:00', endTime: '09:30' } : undefined,
  });
  res.json({ data: { subject: email.subject, text: email.text } });
});

router.put('/email-templates/:kind', requirePermission('settings:write'), (req: AuthRequest, res, next) => {
  try {
    if (!isKind(req.params.kind)) { res.status(404).json({ error: 'Unknown email kind' }); return; }
    const texts = checkTemplate(res, req.body);
    if (!texts) return;
    res.json({ data: saveTemplate(req.user!.orgId, req.params.kind, texts.subject, texts.intro, req.user!.sub) });
  } catch (err) { next(err); }
});

/** Back to the built-in text. */
router.delete('/email-templates/:kind', requirePermission('settings:write'), (req: AuthRequest, res) => {
  if (!isKind(req.params.kind)) { res.status(404).json({ error: 'Unknown email kind' }); return; }
  if (!deleteTemplate(req.user!.orgId, req.params.kind)) { res.status(404).json({ error: 'This email already uses the built-in text' }); return; }
  res.json({ data: { reset: true } });
});

router.get('/currencies', requirePermission('catalog:read'), (_req: AuthRequest, res) => {
  res.json({ data: SUPPORTED_CURRENCIES });
});

router.get('/email-status', requirePermission('catalog:read'), (_req: AuthRequest, res) => {
  const transport = emailTransportName();
  res.json({ data: { transport, sending: transport === 'smtp' } });
});

router.put('/', requirePermission('settings:write'), (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id, timezone FROM organizations WHERE id = ?')
      .get(req.user!.orgId) as { id: string; timezone: string | null } | undefined;
    if (!existing) { res.status(404).json({ error: 'Organization not found' }); return; }

    const data = OrgSchema.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [];

    const map: Record<string, string> = {
      name: 'name', email: 'email', phone: 'phone', website: 'website',
      address: 'address', city: 'city', country: 'country', timezone: 'timezone',
      currency: 'currency', logo: 'logo', cancellationPolicy: 'cancellation_policy',
      dateFormat: 'date_format', timeFormat: 'time_format',
    };

    for (const [key, col] of Object.entries(map)) {
      const v = (data as Record<string, unknown>)[key];
      if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); }
    }

    if (data.workingHours !== undefined) { sets.push('working_hours = ?'); vals.push(JSON.stringify(data.workingHours)); }
    if (data.bookingRules !== undefined) { sets.push('booking_rules = ?'); vals.push(JSON.stringify(data.bookingRules)); }

    // A new time zone keeps every appointment at the same absolute instant: each one is re-expressed in the new zone
    // in the same transaction as the setting (services/timezone-change.ts).
    const oldZone = existing.timezone ?? DEFAULT_TIMEZONE;
    const zoneChanges = data.timezone && data.timezone !== oldZone ? planZoneChange(db, req.user!.orgId, oldZone, data.timezone) : [];
    try {
      db.transaction(() => {
        if (zoneChanges.length) applyZoneChange(db, zoneChanges, data.timezone!);
        if (sets.length) db.prepare(`UPDATE organizations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.user!.orgId);
      }).immediate();
    } catch (e) {
      if ((e as Error).message?.includes('APPOINTMENT_OVERLAP')) {
        res.status(409).json({ error: 'The time zone was not changed: two appointments of the same staff member overlap at the same moment. Reschedule one of them first.' });
        return;
      }
      throw e;
    }

    const row = db.prepare('SELECT * FROM organizations WHERE id = ?').get(req.user!.orgId) as Record<string, unknown>;
    res.json({ data: rowToOrg(row), appointmentsReexpressed: zoneChanges.length });
  } catch (err) { next(err); }
});

export default router;
