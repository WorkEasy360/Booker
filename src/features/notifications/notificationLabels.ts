// Words for the notification platform's states, shared by the settings pages and the appointment's delivery history.
// The wording follows what actually happened: "Sent" means the provider accepted it, "Delivered" and "Read" only come
// from the provider's own report, a calendar event is "Synced" only when the calendar API accepted it, and anything
// handled by the development stand-in says so. Nothing is described as delivered or added that was not.

import type { ConnectionState, DeliveryChannel, JobStatus, NotificationEventName } from '@/api/client';

export type Tone = 'default' | 'info' | 'success' | 'warning' | 'danger';

export const EVENT_LABEL: Record<NotificationEventName, string> = {
  confirmed: 'Booking confirmed', rescheduled: 'Booking moved', cancelled: 'Booking cancelled', reminder: 'Reminder', status_changed: 'Status changed',
};
export const CHANNEL_LABEL: Record<DeliveryChannel, string> = {
  email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp', google_calendar: 'Google Calendar', outlook_calendar: 'Outlook calendar',
};

const isCalendar = (c: DeliveryChannel) => c === 'google_calendar' || c === 'outlook_calendar';
/** The development stand-in handled it: nothing reached a real provider. */
export const isMockProvider = (provider: string | null | undefined) => !!provider && (provider === 'mock' || provider.startsWith('mock-'));

export function jobStatusLabel(job: { status: JobStatus; channel: DeliveryChannel; provider: string | null; scheduledFor?: string | null; event?: NotificationEventName }, now = Date.now()): { label: string; tone: Tone } {
  const mock = isMockProvider(job.provider) ? ' (development stand-in)' : '';
  switch (job.status) {
    case 'pending':
      return job.scheduledFor && Date.parse(job.scheduledFor) > now ? { label: 'Scheduled', tone: 'info' } : { label: 'Waiting to send', tone: 'info' };
    case 'sending': return { label: 'Sending', tone: 'info' };
    case 'sent':
      if (isCalendar(job.channel)) return { label: (job.event === 'cancelled' ? 'Removed from calendar' : 'Synced to calendar') + mock, tone: 'success' };
      return { label: (job.channel === 'email' ? 'Sent' : 'Sent (accepted by provider)') + mock, tone: 'success' };
    case 'delivered': return { label: 'Delivered' + mock, tone: 'success' };
    case 'read': return { label: 'Read' + mock, tone: 'success' };
    case 'failed': return { label: 'Failed', tone: 'danger' };
    case 'skipped': return { label: 'Not sent', tone: 'default' };
    case 'cancelled': return { label: 'Cancelled', tone: 'default' };
    case 'unknown': return { label: 'Outcome unknown', tone: 'warning' };
    case 'not_configured': return { label: 'Not set up', tone: 'warning' };
  }
}

/** Failed, unknown and not-set-up messages can be tried again by someone allowed to send emails. */
export const canRetry = (status: JobStatus) => status === 'failed' || status === 'unknown' || status === 'not_configured';

export function connectionLabel(c: { status: ConnectionState; mock: boolean }): { label: string; tone: Tone } {
  switch (c.status) {
    case 'not_configured': return { label: 'Not set up', tone: 'default' };
    case 'configured_unverified': return { label: 'Saved, not verified', tone: 'warning' };
    case 'connected': return { label: c.mock ? 'Connected (development stand-in)' : 'Connected', tone: 'success' };
    case 'error': return { label: 'Problem', tone: 'danger' };
  }
}

/** "1 day before", "2 hours before", "30 minutes before". */
export function offsetLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'} before`;
  return `${minutes} minutes before`;
}
