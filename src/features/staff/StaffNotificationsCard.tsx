import React, { useEffect, useState } from 'react';
import { BellRing } from 'lucide-react';
import { Button, useToast } from '@/components/ui';
import { notificationPlatformApi, type MessageChannel, type NotificationEventName, type StaffNotificationSettings } from '@/api/client';
import { CHANNEL_LABEL, EVENT_LABEL } from '../notifications/notificationLabels';

// How this staff member hears about their own bookings: which channels (to the email and phone on their profile) and
// which events. The business's rules on the Notifications page decide whether staff messages go out at all; customers
// never see these details.

const CHANNELS: MessageChannel[] = ['email', 'sms', 'whatsapp'];
const EVENTS: NotificationEventName[] = ['confirmed', 'rescheduled', 'cancelled', 'reminder', 'status_changed'];

export function StaffNotificationsCard({ staffId, hasPhone, canEdit }: { staffId: string; hasPhone: boolean; canEdit: boolean }) {
  const toast = useToast();
  const [value, setValue] = useState<StaffNotificationSettings | null>(null);
  const [saved, setSaved] = useState<StaffNotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    notificationPlatformApi.staffSettings(staffId).then(s => { setValue(s); setSaved(s); }).catch((e: Error) => setError(e.message));
  }, [staffId]);

  const toggle = <T extends string>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter(x => x !== v));
  async function save() {
    if (!value) return;
    setBusy(true);
    try {
      const s = await notificationPlatformApi.saveStaffSettings(staffId, value);
      setValue(s);
      setSaved(s);
      toast.success('Notification preferences saved');
    } catch (e) { toast.error('Not saved', (e as Error).message); } finally { setBusy(false); }
  }
  const dirty = JSON.stringify(value) !== JSON.stringify(saved);

  return (
    <div className="card p-5" data-staff-notifications>
      <div className="flex items-center gap-2 mb-1">
        <BellRing className="w-4 h-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-text-primary">Booking notifications</h3>
      </div>
      <p className="text-xs text-text-secondary mb-3">How this staff member hears about bookings with them. Sent only when the business switches staff messages on in Notifications.</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : !value ? <p className="text-sm text-text-muted">Loading…</p> : (
        <div className="space-y-3">
          <fieldset>
            <legend className="text-xs font-medium text-text-primary mb-1">Channels</legend>
            <div className="flex flex-wrap gap-3">
              {CHANNELS.map(c => (
                <label key={c} className="flex items-center gap-1.5 text-sm text-text-primary">
                  <input type="checkbox" className="w-4 h-4 accent-primary" checked={value.channels.includes(c)} disabled={!canEdit || busy}
                    onChange={e => setValue({ ...value, channels: toggle(value.channels, c, e.target.checked) })} />
                  {CHANNEL_LABEL[c]}
                </label>
              ))}
            </div>
            {!hasPhone && value.channels.some(c => c !== 'email') && <p className="text-xs text-amber-700 mt-1">No phone number on this profile: text and WhatsApp alerts will be recorded as not sent.</p>}
          </fieldset>
          <fieldset>
            <legend className="text-xs font-medium text-text-primary mb-1">Events</legend>
            <div className="flex flex-wrap gap-3">
              {EVENTS.map(ev => (
                <label key={ev} className="flex items-center gap-1.5 text-sm text-text-primary">
                  <input type="checkbox" className="w-4 h-4 accent-primary" checked={value.events.includes(ev)} disabled={!canEdit || busy}
                    onChange={e => setValue({ ...value, events: toggle(value.events, ev, e.target.checked) })} />
                  {EVENT_LABEL[ev]}
                </label>
              ))}
            </div>
          </fieldset>
          {canEdit && <Button size="sm" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>}
        </div>
      )}
    </div>
  );
}
