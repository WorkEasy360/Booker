import React, { useEffect, useState } from 'react';
import { Calendar, Video, Mail, MessageSquare, CreditCard, Globe, Copy, Trash2, Send } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Badge, Button, Input, PageHeader, useToast } from '@/components/ui';
import { integrationsApi, notificationPlatformApi, type IntegrationStatus, type NotificationPlatformSettings, type WebhookDelivery, type WebhookEndpoint } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate } from '@/lib/utils';
import { MessagingConnections } from './MessagingConnections';

// What is really connected. Webhooks (and Zapier) work end to end. Accounts at other services connect only when the
// server has that service's app credentials; payments need the provider's webhook secret. SMS and WhatsApp connect with
// the business's own provider credentials (stored encrypted, never shown again) and count as connected only once
// verified. In development, messages and calendar calls go to a clearly marked stand-in. Nothing here claims a
// connection that has not been made.

const EVENT_LABEL: Record<string, string> = {
  'appointment.created': 'Booking made', 'appointment.status_changed': 'Status changed (confirmed, completed, cancelled, no-show)',
  'appointment.rescheduled': 'Booking moved', 'appointment.reassigned': 'Staff changed', 'appointment.deleted': 'Booking deleted',
};
const ACCOUNT_ICON = { google: Calendar, microsoft: Calendar, zoom: Video, mailchimp: Mail } as const;

function Section({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 bg-surface rounded-xl border border-border p-5">
      <div className="flex items-center gap-2 mb-1">{icon}<h2 className="text-sm font-semibold text-text-primary">{title}</h2></div>
      <p className="text-xs text-text-secondary mb-4">{description}</p>
      {children}
    </section>
  );
}

function Webhooks({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const [events, setEvents] = useState<string[]>([]);
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<string[]>(['appointment.created']);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Record<string, WebhookDelivery[]>>({});

  const load = () => integrationsApi.webhooks().then(d => { setEvents(d.events); setEndpoints(d.endpoints); }).catch((e: Error) => setError(e.message));
  useEffect(() => { if (canManage) load(); }, [canManage]);
  if (!canManage) return <p className="text-sm text-text-muted">Only people who can change business settings can manage webhooks.</p>;

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await integrationsApi.addWebhook(url.trim(), chosen, '');
      setSecret(created.secret);
      setUrl('');
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function test(id: string) {
    try {
      const d = await integrationsApi.testWebhook(id);
      if (d.status === 'sent') toast.success('Test event delivered', `The address answered ${d.responseStatus}.`);
      else toast.warning('Test event not delivered', d.error ?? `Status: ${d.status}`);
      const deliveries = await integrationsApi.deliveries(id);
      setLog(l => ({ ...l, [id]: deliveries }));
    } catch (err) { toast.error('Test failed', (err as Error).message); }
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {secret && (
        <div role="status" className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-900">
          <p className="font-medium mb-1">Signing secret (shown only now)</p>
          <div className="flex items-center gap-2">
            <code className="break-all" data-webhook-secret>{secret}</code>
            <Button size="sm" variant="ghost" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => navigator.clipboard.writeText(secret).catch(() => undefined)}>Copy</Button>
          </div>
          <p className="text-xs mt-1">Use it to check the X-WorkEasy360-Signature header: HMAC-SHA256 of “timestamp.body”.</p>
        </div>
      )}
      {endpoints === null ? <p className="text-sm text-text-muted">Loading…</p> : endpoints.length === 0 ? (
        <p className="text-sm text-text-muted">No webhook addresses yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {endpoints.map(ep => (
            <li key={ep.id} className="py-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-text-primary break-all">{ep.url}</span>
                <div className="flex items-center gap-2">
                  <Badge variant={ep.active ? 'success' : 'default'} size="sm">{ep.active ? 'On' : 'Off'}</Badge>
                  <Button size="sm" variant="secondary" icon={<Send className="w-3.5 h-3.5" />} onClick={() => test(ep.id)}>Send test</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} aria-label={`Remove ${ep.url}`}
                    onClick={async () => { await integrationsApi.deleteWebhook(ep.id); toast.success('Webhook removed'); load(); }}>Remove</Button>
                </div>
              </div>
              <p className="text-xs text-text-muted">{ep.events.map(e => EVENT_LABEL[e] ?? e).join(' · ')}</p>
              {log[ep.id]?.length ? (
                <ul className="text-xs text-text-secondary space-y-0.5">
                  {log[ep.id].slice(0, 5).map(d => <li key={d.id}>{formatDate(d.createdAt, 'MMM d, h:mm a')} · {d.eventType} · {d.status}{d.responseStatus ? ` (${d.responseStatus})` : ''}{d.error ? ` · ${d.error}` : ''}</li>)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} noValidate className="space-y-3 border-t border-border pt-4">
        <Input label="Address (https)" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://hooks.zapier.com/hooks/catch/…" />
        <fieldset>
          <legend className="text-sm font-medium text-text-primary mb-1">Events</legend>
          <div className="grid sm:grid-cols-2 gap-1">
            {events.map(ev => (
              <label key={ev} className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" className="w-4 h-4 accent-primary" checked={chosen.includes(ev)}
                  onChange={e => setChosen(c => (e.target.checked ? [...c, ev] : c.filter(x => x !== ev)))} />
                {EVENT_LABEL[ev] ?? ev}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="sm" disabled={busy || !url.trim() || !chosen.length}>{busy ? 'Adding…' : 'Add webhook'}</Button>
      </form>
    </div>
  );
}

export default function IntegrationsPage() {
  usePageTitle('Integrations');
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('settings:write');
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [platform, setPlatform] = useState<NotificationPlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => Promise.all([integrationsApi.status(), notificationPlatformApi.settings()])
    .then(([st, pl]) => { setStatus(st); setPlatform(pl); })
    .catch((e: Error) => setError(e.message || 'Could not load integrations'));
  useEffect(() => { load(); }, []);
  const calendarKey = (p: string) => (p === 'google' ? 'google' : p === 'microsoft' ? 'outlook' : null);
  async function connectCalendarStandIn(p: 'google' | 'outlook') {
    try { await notificationPlatformApi.mockConnectCalendar(p); toast.success('Development stand-in connected', 'Choose it as the business calendar in Notifications.'); load(); }
    catch (e) { toast.error('Not connected', (e as Error).message); }
  }

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('connected')) toast.success('Connected');
    if (q.get('error')) toast.error('Not connected', q.get('error') ?? undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function connect(provider: string) {
    try { window.location.assign((await integrationsApi.connectUrl(provider)).url); } catch (e) { toast.error('Cannot connect', (e as Error).message); }
  }

  return (
    <div className="page-container">
      <PageHeader title="Integrations" description="Webhooks, Zapier, text messages, WhatsApp, calendars and payments" breadcrumbs={[{ label: 'Integrations' }]} />
      {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}

      <Section icon={<Globe className="w-4 h-4 text-primary" aria-hidden="true" />} title="Webhooks and Zapier"
        description="Send booking changes to your own address or to a Zapier “Catch Hook”. Each event is signed, retried if the address is down, and never sent to private network addresses.">
        <Webhooks canManage={canManage} />
      </Section>

      <Section icon={<Calendar className="w-4 h-4 text-primary" aria-hidden="true" />} title="Connected accounts"
        description="Accounts connect with the service's own sign-in. A connected Google or Outlook calendar can be chosen as the business calendar in Notifications: each booking is then created, moved and cancelled there. Zoom meeting links and Mailchimp list sync are not built yet: connecting those only stores access for later.">
        {!status ? <p className="text-sm text-text-muted">Loading…</p> : (
          <ul className="divide-y divide-border">
            {(Object.entries(status.accounts) as Array<[keyof IntegrationStatus['accounts'], IntegrationStatus['accounts']['google']]>).map(([p, a]) => {
              const Icon = ACCOUNT_ICON[p];
              const cal = calendarKey(p);
              const standIn = cal && platform?.calendars[cal].mock;
              return (
                <li key={p} className="py-3 flex flex-wrap items-center justify-between gap-2" data-integration={p}>
                  <span className="flex items-center gap-2 text-sm text-text-primary"><Icon className="w-4 h-4 text-text-muted" aria-hidden="true" />{a.name}</span>
                  {a.connected ? (
                    <span className="flex items-center gap-2">
                      <Badge variant="success" size="sm">{standIn ? 'Connected (development stand-in)' : `Connected${a.connectedAt ? ` ${formatDate(a.connectedAt, 'MMM d')}` : ''}`}</Badge>
                      {canManage && <Button size="sm" variant="ghost" onClick={async () => { await integrationsApi.disconnect(p); load(); }}>Disconnect</Button>}
                    </span>
                  ) : a.configured ? (
                    canManage ? <Button size="sm" variant="secondary" onClick={() => connect(p)}>Connect</Button> : <Badge size="sm">Not connected</Badge>
                  ) : (
                    <span className="flex items-center gap-2">
                      <Badge variant="default" size="sm">Not set up on this server</Badge>
                      {cal && canManage && platform?.providerMode === 'mock' && (
                        <Button size="sm" variant="ghost" onClick={() => connectCalendarStandIn(cal)}>Use the development stand-in</Button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section icon={<CreditCard className="w-4 h-4 text-primary" aria-hidden="true" />} title="Online payments"
        description="Customers cannot pay online yet: no payment account is connected. The server can already receive and verify payment notifications from these providers once their webhook secrets are set.">
        {!status ? <p className="text-sm text-text-muted">Loading…</p> : (
          <ul className="divide-y divide-border">
            {([['stripe', 'Stripe'], ['razorpay', 'Razorpay (UPI, cards, netbanking)'], ['paypal', 'PayPal']] as const).map(([p, label]) => (
              <li key={p} className="py-2.5 flex items-center justify-between gap-2 text-sm">
                <span className="text-text-primary">{label}</span>
                <Badge variant={status.payments[p] ? 'success' : 'default'} size="sm">{status.payments[p] ? 'Notifications configured' : 'Not set up on this server'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={<MessageSquare className="w-4 h-4 text-primary" aria-hidden="true" />} title="Text messages and WhatsApp"
        description="Booking messages by SMS (Twilio) and WhatsApp (WhatsApp Business Platform). Choose who gets them on the Notifications page; customers get them only after agreeing.">
        {!platform ? <p className="text-sm text-text-muted">Loading…</p> : <MessagingConnections data={platform} canManage={canManage} onChanged={load} />}
      </Section>
    </div>
  );
}
