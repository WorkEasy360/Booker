import type { MessageChannel, NotificationEventName, NotificationPlatformSettings } from '@/api/client';

// The simplified notification model (V4 section 5): one switch per channel, one optional reminder fixed at 24 hours.
// Every enabled channel uses the same customer events and the same reminder timing; it maps onto the server's
// per-event rules for customers.

export const CUSTOMER_EVENTS: NotificationEventName[] = ['confirmed', 'rescheduled', 'cancelled'];
export const REMINDER_MINUTES = 24 * 60;
export const PAID_CHANNELS: Array<Exclude<MessageChannel, 'email'>> = ['whatsapp', 'sms'];
export const CHANNEL_NAME: Record<MessageChannel, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };

export interface SimpleNotifications {
  channels: Record<MessageChannel, boolean>;
  /** Customer booking emails the server always sends (they carry the manage link), so email cannot be turned off. */
  emailLocked: boolean;
  reminder: boolean;
  /** Reminder time saved earlier that is not 24 hours (corrected on the next save). */
  reminderOffsetOther: boolean;
  connected: Record<'sms' | 'whatsapp', boolean>;
}

export function deriveNotifications(s: NotificationPlatformSettings): SimpleNotifications {
  const rule = (event: NotificationEventName, channel: MessageChannel) =>
    s.rules.find(r => r.event === event && r.role === 'customer' && r.channel === channel);
  const on = (channel: MessageChannel) => CUSTOMER_EVENTS.some(e => rule(e, channel)?.enabled);
  const channels = { email: on('email'), sms: on('sms'), whatsapp: on('whatsapp') };
  return {
    channels,
    emailLocked: CUSTOMER_EVENTS.every(e => rule(e, 'email')?.locked),
    reminder: (['email', 'sms', 'whatsapp'] as MessageChannel[]).some(c => rule('reminder', c)?.enabled),
    reminderOffsetOther: !(s.reminderOffsets.length === 1 && s.reminderOffsets[0] === REMINDER_MINUTES),
    connected: { sms: s.connections.sms.status === 'connected', whatsapp: s.connections.whatsapp.status === 'connected' },
  };
}

/** Rules to save for the chosen state: the same events on every enabled channel; channels not connected stay off. */
export function rulesFor(state: { channels: Record<MessageChannel, boolean>; reminder: boolean; connected: Record<'sms' | 'whatsapp', boolean> }) {
  const rules: Array<{ event: NotificationEventName; role: 'customer'; channel: MessageChannel; enabled: boolean }> = [];
  for (const channel of ['email', 'sms', 'whatsapp'] as MessageChannel[]) {
    const enabled = state.channels[channel] && (channel === 'email' || state.connected[channel]);
    for (const event of CUSTOMER_EVENTS) rules.push({ event, role: 'customer', channel, enabled });
    rules.push({ event: 'reminder', role: 'customer', channel, enabled: enabled && state.reminder });
  }
  return rules;
}
