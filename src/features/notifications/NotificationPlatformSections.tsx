import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, CalendarDays, FlaskConical, LayoutGrid, Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react';
import { Badge, Button, Input, Select, useToast } from '@/components/ui';
import {
  notificationPlatformApi, type BusinessRecipient, type BusinessRecipientInput, type MessageChannel, type NotificationEventName,
  type NotificationPlatformSettings,
} from '@/api/client';
import { formatDate } from '@/lib/utils';
import { CHANNEL_LABEL, EVENT_LABEL, connectionLabel, offsetLabel } from './notificationLabels';

// The notification platform's settings: what goes to whom on which channel, reminder times, business recipients, the
// business calendar, and each channel's real state. Every value is checked by the server; a channel that is not
// connected is shown as such and its messages are recorded as "Not set up", never as sent.

const EVENTS: NotificationEventName[] = ['confirmed', 'rescheduled', 'cancelled', 'reminder', 'status_changed'];
const CHANNELS: MessageChannel[] = ['email', 'sms', 'whatsapp'];
const OFFSET_PRESETS = [15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];

export function Section({ icon, title, description, children, id }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode; id?: string }) {
  return (
    <section className="mt-6 bg-surface rounded-xl border border-border p-5" data-section={id}>
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      </div>
      <p className="text-xs text-text-secondary mb-4">{description}</p>
      {children}
    </section>
  );
}

/** Shown while SMS, WhatsApp and calendar calls go to the development stand-in. */
export function ModeBanner({ data }: { data: NotificationPlatformSettings }) {
  if (data.providerMode !== 'mock') return null;
  return (
    <p role="status" data-provider-mode="mock" className="mt-4 flex items-start gap-2 text-sm p-3 rounded-lg bg-sky-50 text-sky-900 border border-sky-200">
      <FlaskConical className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
      Development mode: text messages, WhatsApp messages and calendar sync go to a stand-in on this server. Nothing is sent to anyone and no real calendar is changed.
    </p>
  );
}

/** Each channel's connection and its latest success and problem. */
export function DeliveryChannels({ data }: { data: NotificationPlatformSettings }) {
  const rows: Array<{ key: 'sms' | 'whatsapp' | 'google_calendar' | 'outlook_calendar'; state: { label: string; tone: string } }> = [
    { key: 'sms', state: connectionLabel(data.connections.sms) },
    { key: 'whatsapp', state: connectionLabel(data.connections.whatsapp) },
    { key: 'google_calendar', state: data.calendars.google.connected ? { label: data.calendars.google.mock ? 'Connected (development stand-in)' : 'Connected', tone: 'success' } : { label: 'Not connected', tone: 'default' } },
    { key: 'outlook_calendar', state: data.calendars.outlook.connected ? { label: data.calendars.outlook.mock ? 'Connected (development stand-in)' : 'Connected', tone: 'success' } : { label: 'Not connected', tone: 'default' } },
  ];
  return (
    <Section id="delivery-channels" icon={<Activity className="w-4 h-4 text-primary" aria-hidden="true" />} title="Delivery channels"
      description="Whether each channel is connected, its latest successful send and its latest problem. Connect or verify channels in Integrations.">
      <ul className="divide-y divide-border">
        {rows.map(({ key, state }) => {
          const s = data.summary[key];
          return (
            <li key={key} className="py-2.5 flex flex-wrap items-start justify-between gap-2" data-channel-status={key}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-primary">{CHANNEL_LABEL[key]}</p>
                <p className="text-xs text-text-muted">
                  {s?.lastSentAt ? `Last sent ${formatDate(s.lastSentAt, 'MMM d, h:mm a')}` : 'Nothing sent yet'}
                  {s?.lastError ? ` · Last problem${s.lastErrorAt ? ` ${formatDate(s.lastErrorAt, 'MMM d, h:mm a')}` : ''}: ${s.lastError}` : ''}
                </p>
              </div>
              <Badge size="sm" variant={state.tone as 'default' | 'success' | 'warning' | 'danger'}>{state.label}</Badge>
            </li>
          );
        })}
      </ul>
      <Link to="/integrations" className="inline-block mt-3 text-sm text-primary hover:underline">Set up channels in Integrations →</Link>
    </Section>
  );
}

/** Reminder times before each booking, for every reminder channel. */
export function ReminderTimes({ data, canEdit, onSaved }: { data: NotificationPlatformSettings; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState(String(OFFSET_PRESETS.find(o => !data.reminderOffsets.includes(o)) ?? 60));
  const [busy, setBusy] = useState(false);
  async function save(offsets: number[]) {
    setBusy(true);
    try {
      await notificationPlatformApi.saveSchedule({ reminderOffsets: offsets });
      toast.success('Reminder times saved');
      onSaved();
    } catch (e) { toast.error('Not saved', (e as Error).message); } finally { setBusy(false); }
  }
  const free = OFFSET_PRESETS.filter(o => !data.reminderOffsets.includes(o));
  return (
    <div className="mt-4" data-reminder-times>
      <p className="text-sm font-medium text-text-primary mb-2">Reminder times</p>
      <div className="flex flex-wrap gap-2 mb-3">
        {data.reminderOffsets.length === 0 && <span className="text-sm text-text-muted">No reminder times.</span>}
        {data.reminderOffsets.map(o => (
          <span key={o} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-muted text-sm text-text-primary" data-offset={o}>
            {offsetLabel(o)}
            {canEdit && data.reminderOffsets.length > 1 && (
              <button type="button" aria-label={`Remove ${offsetLabel(o)}`} disabled={busy} className="text-text-muted hover:text-red-600"
                onClick={() => save(data.reminderOffsets.filter(x => x !== o))}><X className="w-3.5 h-3.5" /></button>
            )}
          </span>
        ))}
      </div>
      {canEdit && data.reminderOffsets.length < 4 && free.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-48">
            <Select label="Add a reminder" value={adding} onChange={e => setAdding(e.target.value)} options={free.map(o => ({ value: String(o), label: offsetLabel(o) }))} />
          </div>
          <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={() => save([...data.reminderOffsets, Number(adding)])}>Add</Button>
        </div>
      )}
      <p className="text-xs text-text-muted mt-2">Up to 4 times. A reminder whose time has already passed when a booking is made or moved is not sent late.</p>
    </div>
  );
}

/** Event × recipient × channel switches. Customer booking emails are always sent: they carry the manage link. */
export function RulesMatrix({ data, canEdit, onSaved }: { data: NotificationPlatformSettings; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const rule = (event: NotificationEventName, role: 'customer' | 'staff', channel: MessageChannel) => data.rules.find(r => r.event === event && r.role === role && r.channel === channel);
  async function toggle(event: NotificationEventName, role: 'customer' | 'staff', channel: MessageChannel, enabled: boolean) {
    setBusy(true);
    try {
      await notificationPlatformApi.saveRules([{ event, role, channel, enabled }]);
      toast.success('Saved');
      onSaved();
    } catch (e) { toast.error('Not saved', (e as Error).message); } finally { setBusy(false); }
  }
  const notConnected = (['sms', 'whatsapp'] as const).filter(c => data.connections[c].status !== 'connected');
  return (
    <Section id="rules" icon={<LayoutGrid className="w-4 h-4 text-primary" aria-hidden="true" />} title="Who gets what"
      description="For each booking event, which messages go to the customer and to the staff member it is with. Each staff member's own channels are set on their profile; business recipients are below.">
      {notConnected.length > 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2 mb-3">
          {notConnected.map(c => CHANNEL_LABEL[c]).join(' and ')} {notConnected.length === 1 ? 'is' : 'are'} not connected: messages switched on here are recorded as “Not set up” until {notConnected.length === 1 ? 'it is' : 'they are'} connected in Integrations.
        </p>
      )}
      <div className="overflow-x-auto">
        <table className="text-sm min-w-[560px] w-full" aria-label="Notification rules">
          <thead>
            <tr className="text-xs text-text-muted">
              <th className="text-left font-medium py-1" rowSpan={2}>Event</th>
              <th className="font-medium py-1 border-l border-border" colSpan={3}>Customer</th>
              <th className="font-medium py-1 border-l border-border" colSpan={3}>Staff member</th>
            </tr>
            <tr className="text-xs text-text-muted">
              {(['customer', 'staff'] as const).flatMap(role => CHANNELS.map((c, i) => <th key={`${role}-${c}`} className={`font-medium py-1 ${i === 0 ? 'border-l border-border' : ''}`}>{CHANNEL_LABEL[c]}</th>))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {EVENTS.map(event => (
              <tr key={event}>
                <td className="py-2 pr-2 text-text-primary">{EVENT_LABEL[event]}</td>
                {(['customer', 'staff'] as const).flatMap(role => CHANNELS.map((channel, i) => {
                  const r = rule(event, role, channel);
                  const label = `${EVENT_LABEL[event]}: ${CHANNEL_LABEL[channel]} to the ${role === 'customer' ? 'customer' : 'staff member'}`;
                  return (
                    <td key={`${role}-${channel}`} className={`text-center py-2 ${i === 0 ? 'border-l border-border' : ''}`}>
                      <input type="checkbox" className="w-4 h-4 accent-primary" aria-label={label} title={r?.locked ? 'Always sent: it carries the link to manage the booking' : label}
                        data-rule={`${event}:${role}:${channel}`} checked={!!r?.enabled} disabled={!canEdit || busy || !r || r.locked}
                        onChange={e => toggle(event, role, channel, e.target.checked)} />
                    </td>
                  );
                }))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-text-muted mt-2">
        Customer text and WhatsApp messages go only to customers who agreed to them (on the booking page or as recorded by staff); anyone can reply STOP.
        “Status changed” goes to customers only when a booking is confirmed, and to staff when it is confirmed, completed or marked no-show.
      </p>
    </Section>
  );
}

const EMPTY_RECIPIENT: BusinessRecipientInput = { name: '', email: '', phone: '', channels: ['email'], events: ['confirmed', 'rescheduled', 'cancelled'], active: true };

function RecipientForm({ initial, onCancel, onSubmit, busy }: {
  initial: BusinessRecipientInput; onCancel: () => void; onSubmit: (r: BusinessRecipientInput) => void; busy: boolean;
}) {
  const [r, setR] = useState<BusinessRecipientInput>(initial);
  const toggle = <T extends string>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter(x => x !== v));
  return (
    <form className="space-y-3 border border-border rounded-lg p-4" noValidate data-recipient-form
      onSubmit={e => { e.preventDefault(); onSubmit({ ...r, email: r.email?.trim() || undefined, phone: r.phone?.trim() || undefined }); }}>
      <Input id="recipient-name" label="Name" value={r.name} maxLength={100} onChange={e => setR({ ...r, name: e.target.value })} />
      <div className="grid sm:grid-cols-2 gap-3">
        <Input id="recipient-email" label="Email" type="email" value={r.email ?? ''} onChange={e => setR({ ...r, email: e.target.value })} />
        <Input id="recipient-phone" label="Phone (for SMS or WhatsApp)" type="tel" value={r.phone ?? ''} placeholder="+91 98765 43210" onChange={e => setR({ ...r, phone: e.target.value })} />
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-text-primary mb-1">Channels</legend>
        <div className="flex flex-wrap gap-4">
          {CHANNELS.map(c => (
            <label key={c} className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" className="w-4 h-4 accent-primary" checked={r.channels.includes(c)} onChange={e => setR({ ...r, channels: toggle(r.channels, c, e.target.checked) })} />
              {CHANNEL_LABEL[c]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-sm font-medium text-text-primary mb-1">Events</legend>
        <div className="flex flex-wrap gap-4">
          {EVENTS.map(ev => (
            <label key={ev} className="flex items-center gap-2 text-sm text-text-primary">
              <input type="checkbox" className="w-4 h-4 accent-primary" checked={r.events.includes(ev)} onChange={e => setR({ ...r, events: toggle(r.events, ev, e.target.checked) })} />
              {EVENT_LABEL[ev]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center gap-2 text-sm text-text-primary">
        <input type="checkbox" className="w-4 h-4 accent-primary" checked={r.active} onChange={e => setR({ ...r, active: e.target.checked })} />
        Active
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save recipient'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** People at the business (owner, front desk) who get booking messages, on their own channels and events. */
export function BusinessRecipients({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<BusinessRecipient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => notificationPlatformApi.recipients().then(setList).catch((e: Error) => setError(e.message));
  useEffect(() => { if (canEdit) load(); }, [canEdit]);

  async function submit(r: BusinessRecipientInput) {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === 'new') await notificationPlatformApi.addRecipient(r);
      else if (editing) await notificationPlatformApi.updateRecipient(editing, r);
      toast.success('Recipient saved');
      setEditing(null);
      await load();
      onSaved();
    } catch (e) { setFormError((e as Error).message); } finally { setBusy(false); }
  }
  async function remove(r: BusinessRecipient) {
    try {
      await notificationPlatformApi.deleteRecipient(r.id);
      toast.success(`${r.name} removed`);
      await load();
      onSaved();
    } catch (e) { toast.error('Not removed', (e as Error).message); }
  }

  return (
    <Section id="business-recipients" icon={<UserPlus className="w-4 h-4 text-primary" aria-hidden="true" />} title="Business recipients"
      description="The owner, front desk or anyone else at the business who should hear about bookings. Each recipient gets only the channels and events chosen for them.">
      {!canEdit ? <p className="text-sm text-text-muted">Only people who can change business settings can manage business recipients.</p>
        : error ? <p role="alert" className="text-sm text-red-600">{error}</p>
        : !list ? <p className="text-sm text-text-muted">Loading…</p> : (
          <div className="space-y-3">
            {list.length === 0 && editing !== 'new' && <p className="text-sm text-text-muted">No business recipients yet.</p>}
            <ul className="divide-y divide-border">
              {list.map(r => (
                <li key={r.id} className="py-3" data-recipient={r.name}>
                  {editing === r.id ? (
                    <>
                      {formError && <p role="alert" className="text-sm text-red-600 mb-2">{formError}</p>}
                      <RecipientForm busy={busy} onCancel={() => { setEditing(null); setFormError(null); }} onSubmit={submit}
                        initial={{ name: r.name, email: r.email ?? '', phone: r.phone ?? '', channels: r.channels, events: r.events, active: r.active }} />
                    </>
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-text-primary">{r.name} {!r.active && <Badge size="sm">Paused</Badge>}</p>
                        <p className="text-xs text-text-muted break-all">{[r.email, r.phone].filter(Boolean).join(' · ')}</p>
                        <p className="text-xs text-text-secondary">{r.channels.map(c => CHANNEL_LABEL[c]).join(', ')} · {r.events.map(e => EVENT_LABEL[e]).join(', ')}</p>
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" icon={<Pencil className="w-3.5 h-3.5" />} aria-label={`Edit ${r.name}`} onClick={() => { setEditing(r.id); setFormError(null); }}>Edit</Button>
                        <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} aria-label={`Remove ${r.name}`} onClick={() => remove(r)}>Remove</Button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {editing === 'new' ? (
              <>
                {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
                <RecipientForm initial={EMPTY_RECIPIENT} busy={busy} onCancel={() => { setEditing(null); setFormError(null); }} onSubmit={submit} />
              </>
            ) : list.length < 20 && (
              <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => { setEditing('new'); setFormError(null); }}>Add recipient</Button>
            )}
          </div>
        )}
    </Section>
  );
}

/** The business's own calendar: every booking is created, moved and cancelled there (connected accounts only). */
export function BusinessCalendar({ data, canEdit, onSaved }: { data: NotificationPlatformSettings; canEdit: boolean; onSaved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function save(changes: { businessCalendar?: 'google' | 'outlook' | null; inviteStaffToCalendar?: boolean }) {
    setBusy(true);
    try {
      await notificationPlatformApi.saveSchedule(changes);
      toast.success('Calendar setting saved');
      onSaved();
    } catch (e) { toast.error('Not saved', (e as Error).message); } finally { setBusy(false); }
  }
  const options = [
    { value: '', label: 'None' },
    { value: 'google', label: `Google Calendar${data.calendars.google.connected ? (data.calendars.google.mock ? ' (development stand-in)' : '') : ' (not connected)'}`, disabled: !data.calendars.google.connected },
    { value: 'outlook', label: `Outlook calendar${data.calendars.outlook.connected ? (data.calendars.outlook.mock ? ' (development stand-in)' : '') : ' (not connected)'}`, disabled: !data.calendars.outlook.connected },
  ];
  return (
    <Section id="business-calendar" icon={<CalendarDays className="w-4 h-4 text-primary" aria-hidden="true" />} title="Business calendar"
      description="Each booking is added to the connected calendar, updated when it moves (the same event, never a copy) and cancelled when it is cancelled. Customers add bookings to their own calendars from the confirmation page and the calendar file in their emails.">
      <div className="flex flex-wrap items-end gap-4">
        <div className="w-72">
          <Select label="Calendar" value={data.businessCalendar ?? ''} disabled={!canEdit || busy}
            onChange={e => save({ businessCalendar: (e.target.value || null) as 'google' | 'outlook' | null })} options={options} />
        </div>
        <label className="flex items-center gap-2 text-sm text-text-primary">
          <input type="checkbox" className="w-4 h-4 accent-primary" checked={data.inviteStaffToCalendar} disabled={!canEdit || busy || !data.businessCalendar}
            onChange={e => save({ inviteStaffToCalendar: e.target.checked })} data-setting="invite-staff" />
          Add the staff member to the event
        </label>
      </div>
      <p className="text-xs text-text-muted mt-2">The calendar does not email invitations; only the event is created. Connect a calendar account in Integrations.</p>
    </Section>
  );
}
