import { Router } from 'express';
import { z } from 'zod';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { can } from '../auth/permissions';
import { toE164 } from '../lib/phone';
import { redactError } from '../services/email/notify';
import { connectionStatus, connectMockCalendar, isMockConnection } from '../services/integrations/oauth';
import {
  connectionConfig, connectionRow, connectionView, consentFor, deleteConnection, deleteRecipient, listRecipients, listRules, orgSettings, providerMode,
  recordConsent, saveConnection, saveOrgSettings, saveRecipient, saveStaffSettings, setConnectionStatus, setRules, staffSettings, SWITCHABLE,
} from '../services/notifications/settings';
import { sendSms, sendWhatsApp, verifySms, verifyWhatsApp } from '../services/notifications/providers';
import { kickNotifications, retryJob } from '../services/notifications/worker';
import { EVENTS, MESSAGE_CHANNELS, type NotificationEvent } from '../services/notifications/types';

// Settings and delivery history of the notification platform. Credentials go in and are stored encrypted; they never
// come back out (only the last four characters of an id). Nothing here reports a provider as working unless it was
// verified, and in mock mode every answer says so.

const router = Router();
router.use(requireAuth);
const canManage = requirePermission('settings:write');
const org = (req: AuthRequest) => req.user!.orgId;

// ─── Overview ────────────────────────────────────────────────────────────────

function calendarStatus(orgId: string) {
  return Object.fromEntries((['google', 'microsoft'] as const).map(p => {
    const s = connectionStatus(orgId, p);
    return [p === 'google' ? 'google' : 'outlook', { connected: s.connected, mock: s.connected && isMockConnection(orgId, p), connectedAt: s.connectedAt ?? null }];
  }));
}

/** Per channel: the latest successful send and the latest problem (sanitized). */
function channelSummary(orgId: string) {
  const out: Record<string, { lastSentAt: string | null; lastError: string | null; lastErrorAt: string | null }> = {};
  for (const channel of [...MESSAGE_CHANNELS, 'google_calendar', 'outlook_calendar']) {
    const sent = db.prepare(`SELECT MAX(sent_at) FROM notification_jobs WHERE organization_id = ? AND channel = ? AND status IN ('sent', 'delivered', 'read')`).pluck().get(orgId, channel) as string | null;
    const err = db.prepare(`SELECT last_error, updated_at FROM notification_jobs WHERE organization_id = ? AND channel = ? AND status IN ('failed', 'unknown', 'not_configured')
      ORDER BY updated_at DESC LIMIT 1`).get(orgId, channel) as { last_error: string | null; updated_at: string } | undefined;
    out[channel] = { lastSentAt: sent ?? null, lastError: err?.last_error ?? null, lastErrorAt: err?.updated_at ?? null };
  }
  return out;
}

router.get('/settings', requirePermission('catalog:read'), (req: AuthRequest, res) => {
  const s = orgSettings(org(req));
  res.json({
    data: {
      providerMode: providerMode(),
      rules: listRules(org(req)),
      reminderOffsets: s.reminderOffsets,
      businessCalendar: s.businessCalendar,
      inviteStaffToCalendar: s.inviteStaffToCalendar,
      connections: { sms: connectionView(org(req), 'sms'), whatsapp: connectionView(org(req), 'whatsapp') },
      calendars: calendarStatus(org(req)),
      summary: channelSummary(org(req)),
      // Where providers send delivery reports and replies (entered in the provider's console); not secret.
      callbacks: {
        publicApiUrl: process.env.PUBLIC_API_URL?.replace(/\/+$/, '') || null,
        twilioStatus: `/api/webhooks/messaging/twilio/${org(req)}/status`,
        twilioInbound: `/api/webhooks/messaging/twilio/${org(req)}/inbound`,
        whatsapp: `/api/webhooks/messaging/whatsapp/${org(req)}`,
      },
    },
  });
});

const RulesSchema = z.object({
  rules: z.array(z.object({
    event: z.enum(EVENTS), role: z.enum(['customer', 'staff']), channel: z.enum(MESSAGE_CHANNELS), enabled: z.boolean(),
  })).max(60),
});
router.put('/settings/rules', canManage, (req: AuthRequest, res) => {
  const parsed = RulesSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
  if (parsed.data.rules.some(r => !SWITCHABLE.some(s => s.role === r.role && s.channel === r.channel))) { res.status(400).json({ error: 'Unknown rule' }); return; }
  setRules(org(req), parsed.data.rules);
  res.json({ data: listRules(org(req)) });
});

const ScheduleSchema = z.object({
  reminderOffsets: z.array(z.number().int().min(15, 'A reminder needs at least 15 minutes of notice').max(10_080, 'Reminders can be at most 7 days before'))
    .max(4, 'At most 4 reminder times').optional(),
  businessCalendar: z.enum(['google', 'outlook']).nullable().optional(),
  inviteStaffToCalendar: z.boolean().optional(),
}).strict();
router.put('/settings/schedule', canManage, (req: AuthRequest, res) => {
  const parsed = ScheduleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
  const cal = parsed.data.businessCalendar;
  if (cal && !connectionStatus(org(req), cal === 'google' ? 'google' : 'microsoft').connected) {
    res.status(409).json({ error: `Connect ${cal === 'google' ? 'Google Calendar' : 'the Outlook calendar'} in Integrations first.` });
    return;
  }
  res.json({ data: saveOrgSettings(org(req), parsed.data) });
});

// ─── Business recipients ─────────────────────────────────────────────────────

const RecipientSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  email: z.string().trim().max(254).email('Enter a valid email address').or(z.literal('')).optional(),
  phone: z.string().trim().max(40).optional(),
  channels: z.array(z.enum(MESSAGE_CHANNELS)).min(1, 'Choose at least one channel'),
  events: z.array(z.enum(EVENTS)).min(1, 'Choose at least one event'),
  active: z.boolean().default(true),
});
function parseRecipient(body: unknown): { ok: true; value: Parameters<typeof saveRecipient>[1] } | { ok: false; error: string } {
  const p = RecipientSchema.safeParse(body);
  if (!p.success) return { ok: false, error: p.error.errors[0]?.message ?? 'Validation error' };
  const email = p.data.email ? p.data.email.toLowerCase() : null;
  const phone = p.data.phone ? toE164(p.data.phone) : null;
  if (p.data.phone && !phone) return { ok: false, error: 'Enter a valid phone number, for example +91 98765 43210' };
  if (p.data.channels.includes('email') && !email) return { ok: false, error: 'Email is chosen, so an email address is needed' };
  if (p.data.channels.some(c => c !== 'email') && !phone) return { ok: false, error: 'SMS or WhatsApp is chosen, so a phone number is needed' };
  return { ok: true, value: { name: p.data.name, email, phone, channels: [...new Set(p.data.channels)], events: [...new Set(p.data.events)], active: p.data.active } };
}
router.get('/recipients', canManage, (req: AuthRequest, res) => { res.json({ data: listRecipients(org(req)) }); });
router.post('/recipients', canManage, (req: AuthRequest, res) => {
  const r = parseRecipient(req.body);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  if (listRecipients(org(req)).length >= 20) { res.status(409).json({ error: 'At most 20 business recipients' }); return; }
  res.status(201).json({ data: saveRecipient(org(req), r.value) });
});
router.put('/recipients/:id', canManage, (req: AuthRequest, res) => {
  const r = parseRecipient(req.body);
  if (!r.ok) { res.status(400).json({ error: r.error }); return; }
  const saved = saveRecipient(org(req), r.value, req.params.id);
  if (!saved) { res.status(404).json({ error: 'Recipient not found' }); return; }
  res.json({ data: saved });
});
router.delete('/recipients/:id', canManage, (req: AuthRequest, res) => {
  if (!deleteRecipient(org(req), req.params.id)) { res.status(404).json({ error: 'Recipient not found' }); return; }
  res.json({ data: { deleted: true } });
});

// ─── Staff preferences ───────────────────────────────────────────────────────

const StaffSettingsSchema = z.object({ channels: z.array(z.enum(MESSAGE_CHANNELS)).max(3), events: z.array(z.enum(EVENTS)).max(5) });
function staffInOrg(req: AuthRequest): boolean {
  return !!db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(req.params.staffId, org(req));
}
router.get('/staff/:staffId', (req: AuthRequest, res) => {
  const own = req.user!.staffId === req.params.staffId;
  if (!staffInOrg(req) || (!own && !can(req.user!.role, 'staff:manage'))) { res.status(404).json({ error: 'Staff member not found' }); return; }
  res.json({ data: staffSettings(req.params.staffId) });
});
router.put('/staff/:staffId', requirePermission('staff:manage'), (req: AuthRequest, res) => {
  if (!staffInOrg(req)) { res.status(404).json({ error: 'Staff member not found' }); return; }
  const p = StaffSettingsSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.errors[0]?.message ?? 'Validation error' }); return; }
  res.json({ data: saveStaffSettings(org(req), req.params.staffId, p.data) });
});

// ─── Customer consent for SMS / WhatsApp ─────────────────────────────────────

function customerInOrg(req: AuthRequest): boolean {
  return !!db.prepare('SELECT 1 FROM customers WHERE id = ? AND organization_id = ?').get(req.params.customerId, org(req));
}
router.get('/customers/:customerId/consent', requirePermission('customers:read'), (req: AuthRequest, res) => {
  if (!customerInOrg(req)) { res.status(404).json({ error: 'Customer not found' }); return; }
  res.json({ data: consentFor(req.params.customerId) });
});
const ConsentSchema = z.object({ sms: z.enum(['granted', 'revoked']).optional(), whatsapp: z.enum(['granted', 'revoked']).optional() }).strict();
router.put('/customers/:customerId/consent', requirePermission('customers:write'), (req: AuthRequest, res) => {
  if (!customerInOrg(req)) { res.status(404).json({ error: 'Customer not found' }); return; }
  const p = ConsentSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: 'Choose granted or revoked' }); return; }
  for (const ch of ['sms', 'whatsapp'] as const) if (p.data[ch]) recordConsent(org(req), req.params.customerId, ch, p.data[ch]!, 'staff');
  res.json({ data: consentFor(req.params.customerId) });
});

// ─── SMS and WhatsApp connections ────────────────────────────────────────────

const TwilioSchema = z.object({
  accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/, 'The Account SID starts with AC followed by 32 characters'),
  authToken: z.string().trim().regex(/^[0-9a-fA-F]{32}$/, 'The Auth Token is 32 characters'),
  from: z.string().trim().optional(),
  messagingServiceSid: z.string().trim().regex(/^MG[0-9a-fA-F]{32}$/, 'The Messaging Service SID starts with MG').optional(),
}).refine(d => d.from || d.messagingServiceSid, { message: 'Enter a sender number or a Messaging Service SID' });
const WhatsAppSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{6,20}$/, 'The phone number ID is the number Meta shows for the business number'),
  accessToken: z.string().trim().min(20, 'Enter the access token').max(1000),
  appSecret: z.string().trim().min(16, 'Enter the app secret').max(200),
  verifyToken: z.string().trim().min(16, 'Choose a verify token of at least 16 characters').max(200),
  apiVersion: z.string().trim().regex(/^v\d+\.\d+$/).optional(),
});
const TemplatesSchema = z.record(z.string().regex(/^(customer|team)\.(confirmed|rescheduled|cancelled|reminder|status_changed)$/), z.string().regex(/^[a-z0-9_]{1,512}$/, 'Template names use lower-case letters, digits and _')).optional();
const ConnectionSchema = z.object({ provider: z.enum(['twilio', 'whatsapp_cloud', 'mock']), config: z.record(z.string()).default({}), templates: TemplatesSchema });

router.put('/connections/:channel', canManage, (req: AuthRequest, res) => {
  const channel = req.params.channel;
  if (channel !== 'sms' && channel !== 'whatsapp') { res.status(404).json({ error: 'Unknown channel' }); return; }
  const p = ConnectionSchema.safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.errors[0]?.message ?? 'Validation error' }); return; }
  const { provider } = p.data;
  if (provider === 'mock' && providerMode() !== 'mock') { res.status(400).json({ error: 'The mock provider exists only in development' }); return; }
  if ((channel === 'sms' && provider === 'whatsapp_cloud') || (channel === 'whatsapp' && provider === 'twilio')) { res.status(400).json({ error: 'This provider does not offer this channel' }); return; }
  let config: Record<string, string> = {};
  if (provider === 'twilio') {
    const c = TwilioSchema.safeParse(p.data.config);
    if (!c.success) { res.status(400).json({ error: c.error.errors[0]?.message }); return; }
    if (c.data.from && !toE164(c.data.from)) { res.status(400).json({ error: 'The sender number must be a valid phone number' }); return; }
    config = Object.fromEntries(Object.entries({ ...c.data, from: c.data.from ? toE164(c.data.from)! : undefined }).filter(([, v]) => v)) as Record<string, string>;
  } else if (provider === 'whatsapp_cloud') {
    const c = WhatsAppSchema.safeParse(p.data.config);
    if (!c.success) { res.status(400).json({ error: c.error.errors[0]?.message }); return; }
    config = c.data as Record<string, string>;
  }
  saveConnection(org(req), channel, provider, config, { templates: p.data.templates ?? {} });
  res.json({ data: connectionView(org(req), channel) });
});

router.delete('/connections/:channel', canManage, (req: AuthRequest, res) => {
  const channel = req.params.channel;
  if (channel !== 'sms' && channel !== 'whatsapp') { res.status(404).json({ error: 'Unknown channel' }); return; }
  if (!deleteConnection(org(req), channel)) { res.status(404).json({ error: 'Not set up' }); return; }
  res.json({ data: { deleted: true } });
});

/** Checks the stored credentials with the provider (the mock in development). */
router.post('/connections/:channel/verify', canManage, async (req: AuthRequest, res, next) => {
  try {
    const channel = req.params.channel;
    if (channel !== 'sms' && channel !== 'whatsapp') { res.status(404).json({ error: 'Unknown channel' }); return; }
    const row = connectionRow(org(req), channel);
    if (!row) { res.status(404).json({ error: 'Not set up' }); return; }
    const provider = providerMode() === 'mock' ? 'mock' : row.provider;
    const cfg = connectionConfig(org(req), channel) ?? {};
    const r = channel === 'sms' ? await verifySms(provider, cfg) : await verifyWhatsApp(provider, cfg);
    if (r.kind === 'accepted') setConnectionStatus(org(req), channel, 'connected');
    else setConnectionStatus(org(req), channel, 'error', redactError(r.error));
    res.json({ data: connectionView(org(req), channel) });
  } catch (err) { next(err); }
});

/** One test message to a number the administrator enters (the mock provider in development: nothing is sent). */
router.post('/connections/:channel/test', canManage, async (req: AuthRequest, res, next) => {
  try {
    const channel = req.params.channel;
    if (channel !== 'sms' && channel !== 'whatsapp') { res.status(404).json({ error: 'Unknown channel' }); return; }
    const to = toE164(String((req.body as { to?: unknown })?.to ?? ''));
    if (!to) { res.status(400).json({ error: 'Enter a valid phone number, for example +91 98765 43210' }); return; }
    const row = connectionRow(org(req), channel);
    if (!row) { res.status(409).json({ error: 'Set up this channel first' }); return; }
    if (row.status !== 'connected') { res.status(409).json({ error: 'Verify the connection first' }); return; }
    const mode = providerMode();
    const provider = mode === 'mock' ? 'mock' : row.provider;
    const cfg = connectionConfig(org(req), channel) ?? {};
    const r = channel === 'sms'
      ? await sendSms(provider, org(req), cfg, { to, body: 'Test message from WorkEasy360. No reply needed.' })
      : await sendWhatsApp(provider, org(req), cfg, { to, template: 'hello_world', language: 'en_US', params: [] });
    res.json({ data: { mock: provider === 'mock', outcome: r.kind, providerMessageId: r.kind === 'accepted' ? r.id : null, error: r.kind === 'accepted' ? null : redactError(r.error) } });
  } catch (err) { next(err); }
});

/** Development only: a stand-in calendar connection, clearly marked, so calendar sync can be tried against the mock. */
router.post('/calendars/:provider/mock-connect', canManage, (req: AuthRequest, res) => {
  const p = req.params.provider;
  if (p !== 'google' && p !== 'outlook') { res.status(404).json({ error: 'Unknown calendar' }); return; }
  if (providerMode() !== 'mock') { res.status(400).json({ error: 'The mock calendar exists only in development' }); return; }
  connectMockCalendar(org(req), p === 'google' ? 'google' : 'microsoft', req.user!.sub);
  res.json({ data: calendarStatus(org(req)) });
});

// ─── Delivery history and retry ──────────────────────────────────────────────

router.get('/appointments/:id', requirePermission('appointments:read', 'appointments:read_own'), (req: AuthRequest, res) => {
  const appt = db.prepare('SELECT staff_id FROM appointments WHERE id = ? AND organization_id = ?').get(req.params.id, org(req)) as { staff_id: string } | undefined;
  const ownOnly = !can(req.user!.role, 'appointments:read');
  if (!appt || (ownOnly && appt.staff_id !== req.user!.staffId)) { res.status(404).json({ error: 'Appointment not found' }); return; }
  const jobs = db.prepare(`SELECT * FROM notification_jobs WHERE organization_id = ? AND appointment_id = ? ORDER BY created_at, rowid`).all(org(req), req.params.id) as Array<Record<string, unknown>>;
  const attempts = db.prepare(`SELECT job_id, attempt, outcome, provider_status, error, started_at, finished_at FROM notification_attempts
    WHERE job_id IN (SELECT id FROM notification_jobs WHERE organization_id = ? AND appointment_id = ?) ORDER BY attempt`).all(org(req), req.params.id) as Array<Record<string, unknown>>;
  const staffNames = new Map((db.prepare('SELECT id, name FROM staff WHERE organization_id = ?').all(org(req)) as Array<{ id: string; name: string }>).map(s => [s.id, s.name]));
  const recipientNames = new Map(listRecipients(org(req)).map(r => [r.id, r.name]));
  const label = (j: Record<string, unknown>) => j.recipient_role === 'customer' ? 'Customer'
    : j.recipient_role === 'staff' ? `Staff: ${staffNames.get(j.recipient_id as string) ?? 'removed staff member'}`
      : j.recipient_role === 'business' ? `Business: ${recipientNames.get(j.recipient_id as string) ?? 'removed recipient'}` : 'Business calendar';
  res.json({
    data: jobs.map(j => ({
      id: j.id, event: j.event as NotificationEvent, role: j.recipient_role, recipient: label(j), channel: j.channel, status: j.status, reason: j.reason,
      attempts: j.attempts, maxAttempts: j.max_attempts, scheduledFor: j.scheduled_for, nextAttemptAt: j.status === 'pending' ? j.next_attempt_at : null,
      provider: j.provider, lastError: j.last_error, createdAt: j.created_at, sentAt: j.sent_at, deliveredAt: j.delivered_at,
      history: attempts.filter(a => a.job_id === j.id).map(a => ({ attempt: a.attempt, outcome: a.outcome, provider: a.provider_status, error: a.error, at: a.finished_at })),
    })),
  });
});

router.post('/jobs/:id/retry', requirePermission('emails:send'), (req: AuthRequest, res) => {
  const r = retryJob(org(req), req.params.id);
  if (!r.ok) { res.status(r.status).json({ error: r.error }); return; }
  kickNotifications();
  res.json({ data: { id: r.job.id, status: r.job.status, maxAttempts: r.job.max_attempts } });
});

router.get('/summary', requirePermission('catalog:read'), (req: AuthRequest, res) => { res.json({ data: channelSummary(org(req)) }); });

export default router;
