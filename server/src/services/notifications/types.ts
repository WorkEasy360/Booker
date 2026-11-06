// Shared vocabulary of the notification platform (migration 017_notification_platform).

export const EVENTS = ['confirmed', 'rescheduled', 'cancelled', 'reminder', 'status_changed'] as const;
export type NotificationEvent = typeof EVENTS[number];

export const ROLES = ['customer', 'staff', 'business', 'business_calendar'] as const;
export type RecipientRole = typeof ROLES[number];

export const MESSAGE_CHANNELS = ['email', 'sms', 'whatsapp'] as const;
export type MessageChannel = typeof MESSAGE_CHANNELS[number];
export const CALENDAR_CHANNELS = ['google_calendar', 'outlook_calendar'] as const;
export type CalendarChannel = typeof CALENDAR_CHANNELS[number];
export type Channel = MessageChannel | CalendarChannel;

export type JobStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped' | 'cancelled' | 'unknown' | 'not_configured';

/** What one delivery attempt came to. */
export type AttemptOutcome =
  | { outcome: 'sent'; providerMessageId?: string; provider: string }
  | { outcome: 'retry'; error: string; provider: string; retryAfterMs?: number }
  | { outcome: 'failed'; error: string; provider: string }
  | { outcome: 'unknown'; error: string; provider: string }
  | { outcome: 'not_configured'; error: string; provider: string }
  | { outcome: 'skipped' | 'cancelled'; error: string; provider?: string };

export interface JobRow {
  id: string; organization_id: string; appointment_id: string; event: NotificationEvent; recipient_role: RecipientRole;
  recipient_id: string; channel: Channel; dedupe_key: string; status: JobStatus; reason: string | null; attempts: number;
  max_attempts: number; next_attempt_at: string | null; scheduled_for: string | null; appointment_version: string; slot: string;
  previous: string | null; offset_minutes: number | null; provider: string | null; provider_message_id: string | null;
  last_error: string | null; created_at: string; updated_at: string; sent_at: string | null; delivered_at: string | null;
}

/** Statuses after which nothing more happens on its own. */
export const FINAL: JobStatus[] = ['sent', 'delivered', 'read', 'failed', 'skipped', 'cancelled', 'unknown', 'not_configured'];
