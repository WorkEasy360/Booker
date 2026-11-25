import React, { useCallback, useEffect, useState } from 'react';
import { Mail, MessageCircle, MessageSquare, BellRing, Info } from 'lucide-react';
import { Button, Modal, useToast } from '@/components/ui';
import { notificationPlatformApi, notificationsApi, type MessageChannel } from '@/api/client';
import { Section, Toggle, Pill, SaveButton, Loading } from './ui';
import { CHANNEL_NAME, REMINDER_MINUTES, deriveNotifications, rulesFor, type SimpleNotifications } from './notificationState';

const ICON: Record<MessageChannel, React.ElementType> = { email: Mail, whatsapp: MessageCircle, sms: MessageSquare };

/**
 * 4.3 Notifications: email (the default channel), WhatsApp / SMS only through an existing shared WorkEasy360
 * connection, and one optional reminder fixed at 24 hours. This is the single place these are configured; Internal
 * Automation only displays them.
 */
export function NotificationsSection({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [loaded, setLoaded] = useState<SimpleNotifications | null>(null);
  const [form, setForm] = useState<SimpleNotifications | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [askPaid, setAskPaid] = useState<'sms' | 'whatsapp' | null>(null);

  const load = useCallback(() => {
    notificationPlatformApi.settings()
      .then(s => { const d = deriveNotifications(s); setLoaded(d); setForm(d); setError(null); })
      .catch((e: Error) => setError(e.message || 'Could not load notification settings'));
  }, []);
  useEffect(load, [load]);

  const setChannel = (c: MessageChannel, v: boolean) => setForm(f => (f ? { ...f, channels: { ...f.channels, [c]: v } } : f));

  function toggle(c: MessageChannel, v: boolean) {
    // A paid channel is switched on only after the business has seen how it is charged.
    if (v && c !== 'email') { setAskPaid(c); return; }
    setChannel(c, v);
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await notificationPlatformApi.saveRules(rulesFor(form));
      // One reminder, always 24 hours before; the email reminder follows the email switch.
      await notificationsApi.savePreferences({ remindersEnabled: form.reminder && form.channels.email, reminderHoursBefore: REMINDER_MINUTES / 60 });
      await notificationPlatformApi.saveSchedule({ reminderOffsets: [REMINDER_MINUTES] });
      toast.success('Notification settings saved');
      load();
    } catch (e) {
      toast.error('Notification settings were not saved', (e as Error).message);
    } finally { setSaving(false); }
  }

  const dirty = !!form && !!loaded && JSON.stringify(form) !== JSON.stringify(loaded);

  return (
    <Section id="notifications" title="Notifications"
      description="Customers get a confirmation, reschedule and cancellation update with their secure manage-booking link.">
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !form ? <Loading /> : (
        <div className="space-y-6">
          <div>
            <h3 className="text-sm font-semibold text-text-primary mb-3">Channels</h3>
            <ul className="divide-y divide-border border border-border rounded-xl">
              <ChannelRow channel="email" checked={form.channels.email}
                status={<Pill tone="green">Default</Pill>}
                hint={form.emailLocked
                  ? 'Booking emails are always sent when the customer gave an email, because they carry the manage-booking link.'
                  : 'Sent when the customer gave an email address.'}
                disabled={!canEdit || form.emailLocked} onChange={v => toggle('email', v)} />
              {(['whatsapp', 'sms'] as const).map(c => (
                <ChannelRow key={c} channel={c} checked={form.channels[c] && form.connected[c]}
                  status={form.connected[c] ? <Pill tone="green">Connected</Pill> : <Pill tone="gray">Not connected</Pill>}
                  hint={form.connected[c]
                    ? 'Uses your WorkEasy360 shared connection. Charged from the Consumption Wallet.'
                    : 'Not connected — uses your WorkEasy360 shared connection when available.'}
                  disabled={!canEdit || !form.connected[c]} onChange={v => toggle(c, v)} />
              ))}
            </ul>
          </div>

          <div className="flex items-start justify-between gap-4 p-4 rounded-xl bg-muted">
            <div className="flex items-start gap-3 min-w-0">
              <BellRing className="w-5 h-5 text-primary mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-text-primary">Reminder 24 hours before</p>
                <p className="text-sm text-text-secondary mt-0.5">
                  One reminder on every enabled channel. Skipped for bookings made less than 24 hours ahead.
                </p>
                {loaded?.reminderOffsetOther && form.reminder && (
                  <p className="text-xs text-amber-700 mt-1">A different reminder time was saved earlier; saving sets it to 24 hours.</p>
                )}
              </div>
            </div>
            <Toggle checked={form.reminder} disabled={!canEdit} label="Reminder 24 hours before" onChange={v => setForm(f => (f ? { ...f, reminder: v } : f))} />
          </div>

          <p className="flex items-start gap-2 text-xs text-text-muted">
            <Info className="w-4 h-4 shrink-0" aria-hidden="true" />
            Confirmation is always shown on screen. If a message cannot be sent, the appointment is kept and the failure is shown on its details.
          </p>

          {canEdit && (
            <div className="flex justify-end">
              <SaveButton type="button" busy={saving} disabled={!dirty && !loaded?.reminderOffsetOther} onClick={() => void save()} />
            </div>
          )}
        </div>
      )}

      <Modal isOpen={!!askPaid} onClose={() => setAskPaid(null)} size="sm"
        title={askPaid ? `Turn on ${CHANNEL_NAME[askPaid]} messages?` : ''}
        footer={<>
          <Button variant="secondary" onClick={() => setAskPaid(null)}>Cancel</Button>
          <button type="button" className="btn-primary" onClick={() => { if (askPaid) setChannel(askPaid, true); setAskPaid(null); }}>Turn on</button>
        </>}>
        <div className="space-y-2 text-sm text-text-secondary">
          <p>{askPaid ? CHANNEL_NAME[askPaid] : ''} messages are a paid channel. Rates and any included allowance follow the WorkEasy360 platform policy for your plan.</p>
          <p>Each message sent is charged to your organization&apos;s Consumption Wallet. If the balance is too low, the message is skipped and the appointment is kept.</p>
          <p>Customers are never charged for booking.</p>
        </div>
      </Modal>
    </Section>
  );
}

function ChannelRow({ channel, checked, status, hint, disabled, onChange }: {
  channel: MessageChannel; checked: boolean; status: React.ReactNode; hint: string; disabled: boolean; onChange: (v: boolean) => void;
}) {
  const Icon = ICON[channel];
  return (
    <li className="flex items-start gap-3 px-4 py-3.5">
      <span className="icon-tile w-9 h-9 bg-primary-light text-primary"><Icon className="w-[18px] h-[18px]" aria-hidden="true" /></span>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold text-text-primary">{CHANNEL_NAME[channel]}</p>
          {status}
        </div>
        <p className="text-sm text-text-secondary mt-0.5">{hint}</p>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} label={`${CHANNEL_NAME[channel]} notifications`} />
    </li>
  );
}
