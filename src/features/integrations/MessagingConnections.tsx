import React, { useState } from 'react';
import { MessageSquare, MessageCircle, ShieldCheck, Send, Trash2, FlaskConical } from 'lucide-react';
import { Badge, Button, Input, useToast } from '@/components/ui';
import { notificationPlatformApi, type MessagingConnection, type NotificationPlatformSettings } from '@/api/client';
import { formatDate } from '@/lib/utils';
import { connectionLabel } from '../notifications/notificationLabels';

// SMS (Twilio) and WhatsApp (WhatsApp Business Platform, Cloud API). Credentials are sent once, stored encrypted on the
// server and never shown again (only their last characters). A channel is "Connected" only after the provider (or,
// in development, the stand-in) accepted the credentials. Test messages in development go to the stand-in: nothing is
// sent, and the result says so.

const LABEL: Record<string, string> = {
  accountSid: 'Account SID', authToken: 'Auth Token', from: 'Sender number', messagingServiceSid: 'Messaging Service SID',
  phoneNumberId: 'Phone number ID', accessToken: 'Access token', appSecret: 'App secret', verifyToken: 'Verify token', apiVersion: 'API version',
};
const WHATSAPP_TEMPLATES: Array<{ key: string; name: string; use: string; params: string }> = [
  { key: 'customer.confirmed', name: 'we360_booking_confirmed', use: 'Customer: booking confirmed', params: 'customer name, service, date, time, business, reference' },
  { key: 'customer.rescheduled', name: 'we360_booking_rescheduled', use: 'Customer: booking moved', params: 'customer name, service, date, time, business, reference' },
  { key: 'customer.cancelled', name: 'we360_booking_cancelled', use: 'Customer: booking cancelled', params: 'customer name, service, date, time, business, reference' },
  { key: 'customer.reminder', name: 'we360_booking_reminder', use: 'Customer: reminder', params: 'customer name, service, date, time, business, reference' },
  { key: 'customer.status_changed', name: 'we360_booking_status', use: 'Customer: status changed', params: 'customer name, reference, status, business' },
  { key: 'team.confirmed', name: 'we360_team_booking_new', use: 'Staff / business: new booking', params: 'recipient name, service, customer name, date, time, reference' },
  { key: 'team.rescheduled', name: 'we360_team_booking_moved', use: 'Staff / business: booking moved', params: 'recipient name, service, customer name, date, time, reference' },
  { key: 'team.cancelled', name: 'we360_team_booking_cancelled', use: 'Staff / business: booking cancelled', params: 'recipient name, service, customer name, date, time, reference' },
  { key: 'team.reminder', name: 'we360_team_booking_reminder', use: 'Staff / business: reminder', params: 'recipient name, service, customer name, date, time, reference' },
  { key: 'team.status_changed', name: 'we360_team_booking_status', use: 'Staff / business: status changed', params: 'recipient name, reference, status, customer name' },
];

const FIELDS = {
  sms: [
    { key: 'accountSid', placeholder: 'AC…', secret: false },
    { key: 'authToken', placeholder: '32 characters', secret: true },
    { key: 'from', placeholder: '+1 555 010 0000 (or leave empty and use a Messaging Service)', secret: false },
    { key: 'messagingServiceSid', placeholder: 'MG… (optional)', secret: false },
  ],
  whatsapp: [
    { key: 'phoneNumberId', placeholder: 'From WhatsApp Manager → API setup', secret: false },
    { key: 'accessToken', placeholder: 'A system user access token', secret: true },
    { key: 'appSecret', placeholder: 'From the Meta app’s basic settings', secret: true },
    { key: 'verifyToken', placeholder: 'Any random text of 16+ characters; enter the same in Meta', secret: true },
  ],
} as const;

function ConnectionCard({ channel, conn, data, canManage, onChanged }: {
  channel: 'sms' | 'whatsapp'; conn: MessagingConnection; data: NotificationPlatformSettings; canManage: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<Record<string, string>>(conn.settings.templates ?? {});
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const state = connectionLabel(conn);
  const isSms = channel === 'sms';
  const title = isSms ? 'Text messages (SMS) · Twilio' : 'WhatsApp · WhatsApp Business Platform (Cloud API)';
  const base = data.callbacks.publicApiUrl ?? 'https://<your public API address>';

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const save = () => run(async () => {
    const cleanTemplates = Object.fromEntries(Object.entries(templates).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
    await notificationPlatformApi.saveConnection(channel, isSms ? 'twilio' : 'whatsapp_cloud',
      Object.fromEntries(Object.entries(config).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])), isSms ? undefined : cleanTemplates);
    setConfig({});
    setEditing(false);
    toast.success('Saved. Verify the connection next.');
    onChanged();
  });
  const connectStandIn = () => run(async () => {
    await notificationPlatformApi.saveConnection(channel, 'mock', {});
    const v = await notificationPlatformApi.verifyConnection(channel);
    toast.success(v.status === 'connected' ? 'Development stand-in connected' : 'Stand-in saved');
    onChanged();
  });
  const verify = () => run(async () => {
    const v = await notificationPlatformApi.verifyConnection(channel);
    if (v.status === 'connected') toast.success(v.mock ? 'Verified with the development stand-in' : 'Verified with the provider');
    else toast.warning('Not verified', v.lastError ?? undefined);
    onChanged();
  });
  const test = () => run(async () => {
    const r = await notificationPlatformApi.testConnection(channel, testTo);
    const where = r.mock ? 'the development stand-in (nothing was sent)' : 'the provider';
    setTestResult(r.outcome === 'accepted' ? `Accepted by ${where}${r.providerMessageId ? ` · id ${r.providerMessageId}` : ''}.`
      : r.outcome === 'timeout' ? `No answer from ${where} in time; it may or may not have been accepted.`
      : `Not accepted by ${where}: ${r.error ?? r.outcome}`);
    onChanged();
  });
  const remove = () => run(async () => {
    await notificationPlatformApi.deleteConnection(channel);
    toast.success('Removed. Messages on this channel are now recorded as “Not set up”.');
    onChanged();
  });

  return (
    <div className="border border-border rounded-lg p-4 space-y-3" data-messaging={channel}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          {isSms ? <MessageSquare className="w-4 h-4 text-text-muted" aria-hidden="true" /> : <MessageCircle className="w-4 h-4 text-text-muted" aria-hidden="true" />}
          {title}
        </span>
        <Badge size="sm" variant={state.tone === 'info' ? 'info' : state.tone} >{state.label}</Badge>
      </div>

      {conn.status !== 'not_configured' && (
        <dl className="text-xs text-text-secondary grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-text-muted">Provider</dt><dd>{conn.provider === 'mock' ? 'Development stand-in' : isSms ? 'Twilio' : 'Meta WhatsApp Cloud API'}</dd>
          {Object.entries(conn.hints).map(([k, v]) => <React.Fragment key={k}><dt className="text-text-muted">{LABEL[k] ?? k}</dt><dd className="break-all">{v}</dd></React.Fragment>)}
          {conn.verifiedAt && <><dt className="text-text-muted">Verified</dt><dd>{formatDate(conn.verifiedAt, 'MMM d, h:mm a')}</dd></>}
          {conn.lastError && <><dt className="text-text-muted">Last problem</dt><dd className="text-red-700">{conn.lastError}</dd></>}
        </dl>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {testResult && <p role="status" className="text-sm text-text-primary bg-muted rounded-lg px-3 py-2" data-test-result>{testResult}</p>}

      {canManage && !editing && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => { setEditing(true); setError(null); }}>{conn.status === 'not_configured' ? 'Set up' : 'Change credentials'}</Button>
          {data.providerMode === 'mock' && (
            <Button size="sm" variant="ghost" icon={<FlaskConical className="w-3.5 h-3.5" />} disabled={busy} onClick={connectStandIn}>Use the development stand-in</Button>
          )}
          {conn.status !== 'not_configured' && <Button size="sm" variant="secondary" icon={<ShieldCheck className="w-3.5 h-3.5" />} disabled={busy} onClick={verify}>Verify</Button>}
          {conn.status !== 'not_configured' && <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} disabled={busy} onClick={remove}>Remove</Button>}
        </div>
      )}
      {canManage && conn.status === 'connected' && !editing && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-60">
            <Input id={`${channel}-test-to`} label={conn.mock ? 'Test number (development stand-in: nothing is sent)' : 'Send a test to'} type="tel" value={testTo}
              placeholder="+91 98765 43210" onChange={e => setTestTo(e.target.value)} />
          </div>
          <Button size="sm" variant="secondary" icon={<Send className="w-3.5 h-3.5" />} disabled={busy || !testTo.trim()} onClick={test}>{conn.mock ? 'Send a test to the stand-in' : 'Send test'}</Button>
        </div>
      )}

      {canManage && editing && (
        <form className="space-y-3" noValidate onSubmit={e => { e.preventDefault(); save(); }} data-connection-form={channel}>
          {conn.status !== 'not_configured' && <p className="text-xs text-text-muted">Enter all credentials again: saved ones are never shown.</p>}
          {FIELDS[channel].map(f => (
            <Input key={f.key} id={`${channel}-${f.key}`} label={LABEL[f.key]} type={f.secret ? 'password' : 'text'} autoComplete="off"
              placeholder={f.placeholder} value={config[f.key] ?? ''} onChange={e => setConfig(c => ({ ...c, [f.key]: e.target.value }))} />
          ))}
          {!isSms && (
            <details className="text-sm">
              <summary className="cursor-pointer text-text-secondary">Template names (only if yours differ from the defaults)</summary>
              <div className="grid sm:grid-cols-2 gap-2 mt-2">
                {WHATSAPP_TEMPLATES.map(t => (
                  <Input key={t.key} id={`wa-template-${t.key}`} label={t.use} placeholder={t.name} value={templates[t.key] ?? ''}
                    onChange={e => setTemplates(m => ({ ...m, [t.key]: e.target.value }))} />
                ))}
              </div>
            </details>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setEditing(false); setConfig({}); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}

      <details className="text-xs text-text-secondary">
        <summary className="cursor-pointer">What you need and how to set it up</summary>
        {isSms ? (
          <ol className="list-decimal pl-5 mt-2 space-y-1">
            <li>A Twilio account with an SMS-capable number (for India, a DLT-registered sender and templates), or a Messaging Service.</li>
            <li>The Account SID and Auth Token from the Twilio Console.</li>
            <li>In the number’s or Messaging Service’s settings, set the incoming-message webhook to <code className="break-all">{base}{data.callbacks.twilioInbound}</code> so STOP replies are honoured. Delivery reports come to <code className="break-all">{base}{data.callbacks.twilioStatus}</code> automatically.</li>
            <li>Save, then Verify. Customers get texts only after agreeing on the booking page (or as recorded by staff).</li>
          </ol>
        ) : (
          <ol className="list-decimal pl-5 mt-2 space-y-1">
            <li>A Meta Business account, a WhatsApp Business Account and a registered business phone number.</li>
            <li>The phone number ID, a system-user access token with whatsapp_business_messaging permission, and the app secret.</li>
            <li>These message templates approved in WhatsApp Manager (category Utility), in English (en) and, for Hindi businesses, Hindi (hi):
              <ul className="list-disc pl-5 mt-1">{WHATSAPP_TEMPLATES.map(t => <li key={t.key}><code>{t.name}</code> — {t.use} ({t.params})</li>)}</ul>
            </li>
            <li>In the Meta app’s WhatsApp webhook settings: callback URL <code className="break-all">{base}{data.callbacks.whatsapp}</code>, the same verify token as above, and subscribe to “messages”.</li>
            <li>Save, then Verify. Customers get WhatsApp messages only after agreeing on the booking page (or as recorded by staff).</li>
          </ol>
        )}
      </details>
    </div>
  );
}

export function MessagingConnections({ data, canManage, onChanged }: { data: NotificationPlatformSettings; canManage: boolean; onChanged: () => void }) {
  return (
    <div className="space-y-4">
      {data.providerMode === 'mock' && (
        <p role="status" className="flex items-start gap-2 text-sm p-3 rounded-lg bg-sky-50 text-sky-900 border border-sky-200" data-provider-mode="mock">
          <FlaskConical className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          Development mode: this server sends text and WhatsApp messages to a stand-in. Real credentials can be saved and are kept encrypted, but no message reaches Twilio or Meta.
        </p>
      )}
      <ConnectionCard channel="sms" conn={data.connections.sms} data={data} canManage={canManage} onChanged={onChanged} />
      <ConnectionCard channel="whatsapp" conn={data.connections.whatsapp} data={data} canManage={canManage} onChanged={onChanged} />
    </div>
  );
}
