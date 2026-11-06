import db from '../../db/init';

// A business's notification settings and its own email texts (migration 014_notification_settings). Without a row,
// the business has the original behaviour: English, no reminders, no staff alerts, built-in texts.

export type BookingLanguage = 'en' | 'hi';
export const TEMPLATE_KINDS = ['confirmation', 'reschedule', 'cancellation', 'reminder'] as const;
export type TemplateKind = typeof TEMPLATE_KINDS[number];

/** Values a template may use, written {name}. */
export const PLACEHOLDERS = ['customerName', 'businessName', 'serviceName', 'staffName', 'date', 'time', 'bookingRef'] as const;
export type Placeholder = typeof PLACEHOLDERS[number];

export interface Preferences {
  bookingLanguage: BookingLanguage;
  remindersEnabled: boolean;
  reminderHoursBefore: number;
  staffAlertsEnabled: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = { bookingLanguage: 'en', remindersEnabled: false, reminderHoursBefore: 24, staffAlertsEnabled: false };

export function getPreferences(orgId: string): Preferences {
  const row = db.prepare('SELECT * FROM organization_preferences WHERE organization_id = ?').get(orgId) as
    | { booking_language: BookingLanguage; reminders_enabled: number; reminder_hours_before: number; staff_alerts_enabled: number }
    | undefined;
  if (!row) return { ...DEFAULT_PREFERENCES };
  return {
    bookingLanguage: row.booking_language,
    remindersEnabled: !!row.reminders_enabled,
    reminderHoursBefore: row.reminder_hours_before,
    staffAlertsEnabled: !!row.staff_alerts_enabled,
  };
}

export function savePreferences(orgId: string, changes: Partial<Preferences>): Preferences {
  const next = { ...getPreferences(orgId), ...changes };
  db.prepare(
    `INSERT INTO organization_preferences (organization_id, booking_language, reminders_enabled, reminder_hours_before, staff_alerts_enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id) DO UPDATE SET booking_language = excluded.booking_language, reminders_enabled = excluded.reminders_enabled,
       reminder_hours_before = excluded.reminder_hours_before, staff_alerts_enabled = excluded.staff_alerts_enabled, updated_at = excluded.updated_at`
  ).run(orgId, next.bookingLanguage, next.remindersEnabled ? 1 : 0, next.reminderHoursBefore, next.staffAlertsEnabled ? 1 : 0);
  return next;
}

export interface CustomTemplate { kind: TemplateKind; subject: string; intro: string; updatedAt: string }

export function getTemplate(orgId: string, kind: TemplateKind): CustomTemplate | null {
  const row = db.prepare('SELECT kind, subject, intro, updated_at FROM email_templates WHERE organization_id = ? AND kind = ?').get(orgId, kind) as
    | { kind: TemplateKind; subject: string; intro: string; updated_at: string } | undefined;
  return row ? { kind: row.kind, subject: row.subject, intro: row.intro, updatedAt: row.updated_at } : null;
}

export function listTemplates(orgId: string): CustomTemplate[] {
  return TEMPLATE_KINDS.map(k => getTemplate(orgId, k)).filter((t): t is CustomTemplate => !!t);
}

export function saveTemplate(orgId: string, kind: TemplateKind, subject: string, intro: string, userId: string): CustomTemplate {
  db.prepare(
    `INSERT INTO email_templates (organization_id, kind, subject, intro, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id, kind) DO UPDATE SET subject = excluded.subject, intro = excluded.intro,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).run(orgId, kind, subject, intro, userId);
  return getTemplate(orgId, kind)!;
}

export function deleteTemplate(orgId: string, kind: TemplateKind): boolean {
  return db.prepare('DELETE FROM email_templates WHERE organization_id = ? AND kind = ?').run(orgId, kind).changes > 0;
}

/**
 * Why a template text cannot be used, or null. Placeholders are {name} with a known name; braces must pair up;
 * the subject is one line. Texts are plain text: they are escaped when put into the HTML email.
 */
export function templateProblem(text: string, field: 'subject' | 'intro'): string | null {
  const max = field === 'subject' ? 150 : 1000;
  if (!text.trim()) return field === 'subject' ? 'Enter a subject.' : 'Enter the opening text.';
  if (text.length > max) return `${field === 'subject' ? 'The subject' : 'The opening text'} must be ${max} characters or fewer.`;
  if (field === 'subject' && /[\r\n]/.test(text)) return 'The subject must be a single line.';
  const stripped = text.replace(/\{(\w+)\}/g, (_m, name: string) => (PLACEHOLDERS.includes(name as Placeholder) ? '' : `\u0000${name}\u0000`));
  const unknown = /\u0000(\w+)\u0000/.exec(stripped);
  if (unknown) return `Unknown placeholder {${unknown[1]}}. You can use: ${PLACEHOLDERS.map(p => `{${p}}`).join(', ')}.`;
  if (/[{}]/.test(stripped)) return 'Each { must be closed by a } around a placeholder name, for example {customerName}.';
  return null;
}

/** Fills {placeholders} with values (all known names; unknown ones were refused when saving). */
export function fillTemplate(text: string, values: Record<Placeholder, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in values ? values[name as Placeholder] : m));
}
