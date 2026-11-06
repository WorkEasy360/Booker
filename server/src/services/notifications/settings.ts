import { nanoid } from 'nanoid';
import db from '../../db/init';
import { seal, open } from '../integrations/seal';
import { getPreferences, savePreferences, type Preferences } from '../email/preferences';
import type { NotificationEvent, RecipientRole, Channel, MessageChannel } from './types';

// What a business sends, to whom and how (migration 017): rules per event × recipient role × channel, reminder
// times, the business calendar, business recipients, staff preferences, customer consent for text messages, and the
// SMS / WhatsApp provider connections (credentials stored only encrypted, never returned).

// ─── Provider mode ───────────────────────────────────────────────────────────
// "mock": every SMS, WhatsApp and calendar call goes to an in-process mock and nothing leaves the machine (the default
// outside production). "live": the configured provider is called. Production defaults to live; development and tests
// must opt in explicitly, which this project never does.
export type ProviderMode = 'mock' | 'live';
export function providerMode(env = process.env): ProviderMode {
  const v = env.NOTIFICATIONS_PROVIDER_MODE?.trim();
  if (v === 'live' || v === 'mock') return v;
  return env.NODE_ENV === 'production' ? 'live' : 'mock';
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/** Customer booking emails (confirmation, reschedule, cancellation) always go out: they carry the manage link. */
export const ALWAYS_ON = new Set(['confirmed:customer:email', 'rescheduled:customer:email', 'cancelled:customer:email']);
/** The combinations a business can switch; the business role is set per recipient, the calendar in its own settings. */
export const SWITCHABLE: Array<{ role: 'customer' | 'staff'; channel: MessageChannel }> = [
  { role: 'customer', channel: 'email' }, { role: 'customer', channel: 'sms' }, { role: 'customer', channel: 'whatsapp' },
  { role: 'staff', channel: 'email' }, { role: 'staff', channel: 'sms' }, { role: 'staff', channel: 'whatsapp' },
];
const key = (e: string, r: string, c: string) => `${e}:${r}:${c}`;

/** Before a business saves its own rules: the behaviour it had (staff alerts and reminders from its earlier settings). */
function defaultRule(orgId: string, event: NotificationEvent, role: RecipientRole, channel: Channel): boolean {
  if (ALWAYS_ON.has(key(event, role, channel))) return true;
  const prefs = getPreferences(orgId);
  if (role === 'customer' && channel === 'email' && event === 'reminder') return prefs.remindersEnabled;
  if (role === 'staff' && channel === 'email' && ['confirmed', 'rescheduled', 'cancelled'].includes(event)) return prefs.staffAlertsEnabled;
  return false;
}

export function ruleEnabled(orgId: string, event: NotificationEvent, role: RecipientRole, channel: Channel): boolean {
  if (ALWAYS_ON.has(key(event, role, channel))) return true;
  const row = db.prepare('SELECT enabled FROM notification_rules WHERE organization_id = ? AND event = ? AND recipient_role = ? AND channel = ?')
    .get(orgId, event, role, channel) as { enabled: number } | undefined;
  return row ? !!row.enabled : defaultRule(orgId, event, role, channel);
}

export function listRules(orgId: string): Array<{ event: NotificationEvent; role: string; channel: string; enabled: boolean; locked: boolean }> {
  const out = [];
  for (const event of ['confirmed', 'rescheduled', 'cancelled', 'reminder', 'status_changed'] as NotificationEvent[]) {
    for (const { role, channel } of SWITCHABLE) {
      out.push({ event, role, channel, enabled: ruleEnabled(orgId, event, role, channel), locked: ALWAYS_ON.has(key(event, role, channel)) });
    }
  }
  return out;
}

export function setRules(orgId: string, rules: Array<{ event: NotificationEvent; role: RecipientRole; channel: Channel; enabled: boolean }>): void {
  const stmt = db.prepare(
    `INSERT INTO notification_rules (organization_id, event, recipient_role, channel, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id, event, recipient_role, channel) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  );
  db.transaction(() => { for (const r of rules) if (!ALWAYS_ON.has(key(r.event, r.role, r.channel))) stmt.run(orgId, r.event, r.role, r.channel, r.enabled ? 1 : 0); })();
  // The earlier on/off settings describe the same emails: keep them in agreement with the rules.
  savePreferences(orgId, {
    remindersEnabled: ruleEnabled(orgId, 'reminder', 'customer', 'email'),
    staffAlertsEnabled: (['confirmed', 'rescheduled', 'cancelled'] as const).some(e => ruleEnabled(orgId, e, 'staff', 'email')),
  });
}

/**
 * The earlier settings (one reminder time in hours, reminders on/off, staff alerts on/off) written through to the rules
 * and reminder times, so a value saved either way is the one that applies.
 */
export function applyPreferenceChanges(orgId: string, changes: Partial<Preferences>): void {
  const rules: Array<{ event: NotificationEvent; role: RecipientRole; channel: Channel; enabled: boolean }> = [];
  if (changes.remindersEnabled !== undefined) rules.push({ event: 'reminder', role: 'customer', channel: 'email', enabled: changes.remindersEnabled });
  if (changes.staffAlertsEnabled !== undefined) {
    for (const event of ['confirmed', 'rescheduled', 'cancelled'] as const) rules.push({ event, role: 'staff', channel: 'email', enabled: changes.staffAlertsEnabled });
  }
  if (rules.length) setRules(orgId, rules);
  if (changes.reminderHoursBefore !== undefined) saveOrgSettings(orgId, { reminderOffsets: [changes.reminderHoursBefore * 60] });
}

// ─── Reminder times, business calendar ───────────────────────────────────────

export interface OrgNotificationSettings { reminderOffsets: number[]; businessCalendar: 'google' | 'outlook' | null; inviteStaffToCalendar: boolean }

export function orgSettings(orgId: string): OrgNotificationSettings {
  const row = db.prepare('SELECT * FROM organization_notification_settings WHERE organization_id = ?').get(orgId) as
    { reminder_offsets: string; business_calendar: 'google' | 'outlook' | null; invite_staff_to_calendar: number } | undefined;
  if (!row) return { reminderOffsets: [getPreferences(orgId).reminderHoursBefore * 60], businessCalendar: null, inviteStaffToCalendar: false };
  return { reminderOffsets: JSON.parse(row.reminder_offsets) as number[], businessCalendar: row.business_calendar, inviteStaffToCalendar: !!row.invite_staff_to_calendar };
}

export function saveOrgSettings(orgId: string, changes: Partial<OrgNotificationSettings>): OrgNotificationSettings {
  const next = { ...orgSettings(orgId), ...changes };
  next.reminderOffsets = [...new Set(next.reminderOffsets)].sort((a, b) => b - a);
  db.prepare(
    `INSERT INTO organization_notification_settings (organization_id, reminder_offsets, business_calendar, invite_staff_to_calendar, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id) DO UPDATE SET reminder_offsets = excluded.reminder_offsets, business_calendar = excluded.business_calendar,
       invite_staff_to_calendar = excluded.invite_staff_to_calendar, updated_at = excluded.updated_at`
  ).run(orgId, JSON.stringify(next.reminderOffsets), next.businessCalendar, next.inviteStaffToCalendar ? 1 : 0);
  return next;
}

// ─── Business recipients ─────────────────────────────────────────────────────

export interface BusinessRecipient { id: string; name: string; email: string | null; phone: string | null; channels: MessageChannel[]; events: NotificationEvent[]; active: boolean }
const toRecipient = (r: Record<string, unknown>): BusinessRecipient => ({
  id: r.id as string, name: r.name as string, email: (r.email as string) ?? null, phone: (r.phone as string) ?? null,
  channels: JSON.parse(r.channels as string), events: JSON.parse(r.events as string), active: !!r.is_active,
});

export function listRecipients(orgId: string, activeOnly = false): BusinessRecipient[] {
  return (db.prepare(`SELECT * FROM business_notification_recipients WHERE organization_id = ? ${activeOnly ? 'AND is_active = 1' : ''} ORDER BY created_at`)
    .all(orgId) as Array<Record<string, unknown>>).map(toRecipient);
}

export function saveRecipient(orgId: string, input: Omit<BusinessRecipient, 'id'>, id?: string): BusinessRecipient | null {
  if (id) {
    const changed = db.prepare(
      'UPDATE business_notification_recipients SET name = ?, email = ?, phone = ?, channels = ?, events = ?, is_active = ? WHERE id = ? AND organization_id = ?'
    ).run(input.name, input.email, input.phone, JSON.stringify(input.channels), JSON.stringify(input.events), input.active ? 1 : 0, id, orgId).changes;
    if (!changed) return null;
  } else {
    id = `nrc-${nanoid(10)}`;
    db.prepare('INSERT INTO business_notification_recipients (id, organization_id, name, email, phone, channels, events, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, orgId, input.name, input.email, input.phone, JSON.stringify(input.channels), JSON.stringify(input.events), input.active ? 1 : 0);
  }
  return toRecipient(db.prepare('SELECT * FROM business_notification_recipients WHERE id = ?').get(id) as Record<string, unknown>);
}

export function deleteRecipient(orgId: string, id: string): boolean {
  return db.prepare('DELETE FROM business_notification_recipients WHERE id = ? AND organization_id = ?').run(id, orgId).changes > 0;
}

export function getRecipient(orgId: string, id: string): BusinessRecipient | null {
  const r = db.prepare('SELECT * FROM business_notification_recipients WHERE id = ? AND organization_id = ?').get(id, orgId) as Record<string, unknown> | undefined;
  return r ? toRecipient(r) : null;
}

// ─── Staff preferences ───────────────────────────────────────────────────────

export interface StaffNotificationSettings { channels: MessageChannel[]; events: NotificationEvent[] }
export const DEFAULT_STAFF_SETTINGS: StaffNotificationSettings = { channels: ['email'], events: ['confirmed', 'rescheduled', 'cancelled', 'reminder'] };

export function staffSettings(staffId: string): StaffNotificationSettings {
  const row = db.prepare('SELECT channels, events FROM staff_notification_settings WHERE staff_id = ?').get(staffId) as { channels: string; events: string } | undefined;
  return row ? { channels: JSON.parse(row.channels), events: JSON.parse(row.events) } : { ...DEFAULT_STAFF_SETTINGS };
}

export function saveStaffSettings(orgId: string, staffId: string, s: StaffNotificationSettings): StaffNotificationSettings {
  db.prepare(
    `INSERT INTO staff_notification_settings (staff_id, organization_id, channels, events, updated_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(staff_id) DO UPDATE SET channels = excluded.channels, events = excluded.events, updated_at = excluded.updated_at`
  ).run(staffId, orgId, JSON.stringify([...new Set(s.channels)]), JSON.stringify([...new Set(s.events)]));
  return staffSettings(staffId);
}

// ─── Customer consent for text messages ──────────────────────────────────────

export type ConsentSource = 'booking_page' | 'staff' | 'reply_stop' | 'manage_link';
export function consentFor(customerId: string): Record<'sms' | 'whatsapp', { status: 'granted' | 'revoked' | 'none'; source?: string; recordedAt?: string }> {
  const rows = db.prepare('SELECT channel, status, source, recorded_at FROM customer_contact_consent WHERE customer_id = ?').all(customerId) as
    Array<{ channel: 'sms' | 'whatsapp'; status: 'granted' | 'revoked'; source: string; recorded_at: string }>;
  const out = { sms: { status: 'none' as const }, whatsapp: { status: 'none' as const } } as ReturnType<typeof consentFor>;
  for (const r of rows) out[r.channel] = { status: r.status, source: r.source, recordedAt: r.recorded_at };
  return out;
}

export function recordConsent(orgId: string, customerId: string, channel: 'sms' | 'whatsapp', status: 'granted' | 'revoked', source: ConsentSource): void {
  db.prepare(
    `INSERT INTO customer_contact_consent (customer_id, organization_id, channel, status, source, recorded_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(customer_id, channel) DO UPDATE SET status = excluded.status, source = excluded.source, recorded_at = excluded.recorded_at`
  ).run(customerId, orgId, channel, status, source);
}

// ─── SMS and WhatsApp connections ────────────────────────────────────────────

export type ConnectionStatus = 'not_configured' | 'configured_unverified' | 'connected' | 'error';
export interface ConnectionView {
  channel: 'sms' | 'whatsapp'; status: ConnectionStatus; provider: string | null; mock: boolean;
  verifiedAt: string | null; lastError: string | null; hints: Record<string, string>; settings: Record<string, unknown>;
}

const bindConn = (orgId: string, channel: string) => `messaging:${orgId}:${channel}`;
/** Last four characters only, so an administrator can tell which account is set without seeing it. */
const hint = (v: unknown) => (typeof v === 'string' && v.length > 4 ? `…${v.slice(-4)}` : '••••');

export function connectionView(orgId: string, channel: 'sms' | 'whatsapp'): ConnectionView {
  const row = db.prepare('SELECT * FROM messaging_connections WHERE organization_id = ? AND channel = ?').get(orgId, channel) as
    { provider: string; config_enc: string; settings: string; status: ConnectionStatus; verified_at: string | null; last_error: string | null } | undefined;
  if (!row) return { channel, status: 'not_configured', provider: null, mock: false, verifiedAt: null, lastError: null, hints: {}, settings: {} };
  const config = connectionConfig(orgId, channel) ?? {};
  const secretFields = ['authToken', 'accessToken', 'appSecret', 'verifyToken'];
  return {
    channel, status: row.status, provider: row.provider, mock: row.provider === 'mock' || providerMode() === 'mock',
    verifiedAt: row.verified_at, lastError: row.last_error,
    hints: Object.fromEntries(Object.entries(config).map(([k, v]) => [k, secretFields.includes(k) ? hint(v) : String(v)])),
    settings: JSON.parse(row.settings),
  };
}

/** The decrypted provider configuration, for adapters only. */
export function connectionConfig(orgId: string, channel: 'sms' | 'whatsapp'): Record<string, string> | null {
  const row = db.prepare('SELECT config_enc FROM messaging_connections WHERE organization_id = ? AND channel = ?').get(orgId, channel) as { config_enc: string } | undefined;
  const plain = row ? open(bindConn(orgId, channel), row.config_enc) : null;
  return plain ? JSON.parse(plain) : null;
}

/** Verified, and able to send in the current mode (running live, the development stand-in sends nothing). */
export function connectionUsable(orgId: string, channel: 'sms' | 'whatsapp'): boolean {
  const row = connectionRow(orgId, channel);
  return !!row && row.status === 'connected' && !(providerMode() === 'live' && row.provider === 'mock');
}

export function connectionRow(orgId: string, channel: 'sms' | 'whatsapp'): { provider: string; status: ConnectionStatus; settings: Record<string, unknown> } | null {
  const row = db.prepare('SELECT provider, status, settings FROM messaging_connections WHERE organization_id = ? AND channel = ?').get(orgId, channel) as
    { provider: string; status: ConnectionStatus; settings: string } | undefined;
  return row ? { provider: row.provider, status: row.status, settings: JSON.parse(row.settings) } : null;
}

export function saveConnection(orgId: string, channel: 'sms' | 'whatsapp', provider: string, config: Record<string, string>, settings: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO messaging_connections (organization_id, channel, provider, config_enc, settings, status, verified_at, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, 'configured_unverified', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id, channel) DO UPDATE SET provider = excluded.provider, config_enc = excluded.config_enc, settings = excluded.settings,
       status = 'configured_unverified', verified_at = NULL, last_error = NULL, updated_at = excluded.updated_at`
  ).run(orgId, channel, provider, seal(bindConn(orgId, channel), JSON.stringify(config)), JSON.stringify(settings));
}

export function setConnectionStatus(orgId: string, channel: 'sms' | 'whatsapp', status: 'connected' | 'error', error?: string): void {
  db.prepare(
    `UPDATE messaging_connections SET status = ?, verified_at = CASE WHEN ? = 'connected' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE verified_at END,
       last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE organization_id = ? AND channel = ?`
  ).run(status, status, error ?? null, orgId, channel);
}

export function deleteConnection(orgId: string, channel: 'sms' | 'whatsapp'): boolean {
  return db.prepare('DELETE FROM messaging_connections WHERE organization_id = ? AND channel = ?').run(orgId, channel).changes > 0;
}
