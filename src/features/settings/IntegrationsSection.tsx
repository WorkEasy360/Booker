import React, { useCallback, useEffect, useState } from 'react';
import { Plug, Webhook, ArrowRightLeft, Activity, Copy, Send, Trash2, MessageCircle, MessageSquare, Calendar, Sheet, Video, Zap, Workflow, RefreshCw } from 'lucide-react';
import { Button, Input, ConfirmModal, useToast } from '@/components/ui';
import { integrationsApi, notificationPlatformApi, type NotificationPlatformSettings, type WebhookDelivery, type WebhookEndpoint } from '@/api/client';
import { formatDate } from '@/lib/utils';
import { Section, Pill, Loading } from './ui';

// 4.7 Integrations — powered by WorkEasy Connect. External connections, credentials, signatures and retries belong to
// the shared Connect service; Booking only exposes its supported events and shows this organization's activity.
// Ready-made connectors stay "Coming Soon" until they are released and tested.

/** Booking events offered to external destinations (the server's names → what the business sees). */
const EVENT_LABEL: Record<string, string> = {
  'appointment.created': 'Appointment Created',
  'appointment.rescheduled': 'Appointment Rescheduled',
  'appointment.status_changed': 'Appointment Cancelled / Completed / No-show',
};
const SUPPORTED = Object.keys(EVENT_LABEL);

/** Default minimal payload (V4 20.6). Customer contact fields need an explicit mapping; secrets are never sent. */
const PAYLOAD_FIELDS: Array<[string, string]> = [
  ['Event', 'ID, type, version and time'],
  ['Organization', 'Organization reference'],
  ['Appointment', 'Appointment reference and status'],
  ['Service / provider', 'Service and assigned provider'],
  ['When', 'Appointment date, time and timezone'],
];
const EXCLUDED = ['Internal notes', 'Secure manage-booking links and tokens', 'Customer contact details (unless mapped)'];

const COMING_SOON = [
  { name: 'Google Calendar', icon: Calendar },
  { name: 'Google Sheets', icon: Sheet },
  { name: 'Pabbly', icon: Workflow },
  { name: 'Zoom', icon: Video },
  { name: 'Zapier', icon: Zap },
];

export function IntegrationsSection() {
  return (
    <div className="space-y-6">
      <div className="panel px-5 py-4 flex items-center gap-3 bg-gradient-to-r from-primary-light to-white">
        <span className="icon-tile w-10 h-10 bg-primary text-white"><Plug className="w-5 h-5" aria-hidden="true" /></span>
        <div>
          <p className="text-base font-semibold text-text-primary">Powered by WorkEasy Connect</p>
          <p className="text-sm text-text-secondary">One shared connection service for all WorkEasy360 products. Credentials, signatures and retries are handled by Connect.</p>
        </div>
      </div>
      <Connections />
      <Webhooks />
      <Section id="mapping" title="Field Mapping & Destination" description="What Booking sends to an external destination by default.">
        <div className="grid md:grid-cols-2 gap-5">
          <div>
            <p className="text-sm font-semibold text-text-primary mb-2">Included</p>
            <ul className="space-y-1.5">
              {PAYLOAD_FIELDS.map(([k, v]) => (
                <li key={k} className="flex gap-2 text-sm"><span className="w-36 shrink-0 font-medium text-text-primary">{k}</span><span className="text-text-secondary">{v}</span></li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary mb-2">Never included by default</p>
            <ul className="space-y-1.5">
              {EXCLUDED.map(x => <li key={x} className="text-sm text-text-secondary">• {x}</li>)}
            </ul>
            <p className="text-xs text-text-muted mt-3">Events can arrive more than once or out of order: each carries a stable event ID and version so the destination can ignore repeats.</p>
          </div>
        </div>
      </Section>
      <Section id="coming-soon" title="Ready-made Connectors" description="Native connectors become available here once released and tested. A compatible webhook can be used meanwhile.">
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {COMING_SOON.map(c => (
            <li key={c.name} className="rounded-xl border border-dashed border-border bg-muted/60 p-4 text-center" aria-disabled="true">
              <c.icon className="w-6 h-6 mx-auto text-text-muted" aria-hidden="true" />
              <p className="text-sm font-semibold text-text-primary mt-2">{c.name}</p>
              <span className="inline-block mt-1.5"><Pill tone="amber">Coming Soon</Pill></span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/** Organization connections already authorized in WorkEasy360 (read-only here). */
function Connections() {
  const [data, setData] = useState<NotificationPlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { notificationPlatformApi.settings().then(setData).catch((e: Error) => setError(e.message)); }, []);
  const rows = data ? ([
    ['WhatsApp', MessageCircle, data.connections.whatsapp.status],
    ['SMS', MessageSquare, data.connections.sms.status],
  ] as const) : [];
  return (
    <Section id="connections" title="Connections" description="Authorized organization connections reused by Booking. They are added and managed in WorkEasy Connect.">
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !data ? <Loading /> : (
        <ul className="divide-y divide-border border border-border rounded-xl">
          {rows.map(([name, Icon, status]) => (
            <li key={name} className="flex items-center gap-3 px-4 py-3">
              <Icon className="w-5 h-5 text-primary" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium text-text-primary">{name}</span>
              <Pill tone={status === 'connected' ? 'green' : status === 'error' ? 'red' : 'gray'}>
                {status === 'connected' ? 'Connected' : status === 'error' ? 'Error' : status === 'configured_unverified' ? 'Not verified' : 'Not connected'}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function deliveryLabel(d: WebhookDelivery): { text: string; tone: 'green' | 'red' | 'blue' | 'gray' } {
  if (d.status === 'sent') return { text: 'Delivered', tone: 'green' };
  if (d.status === 'failed') return { text: 'Failed', tone: 'red' };
  if (d.status === 'pending' || d.status === 'retrying') return { text: d.attempts > 0 ? 'Retrying' : 'Pending', tone: 'blue' };
  return { text: d.status, tone: 'gray' };
}

/** Outgoing webhooks (shared Connect component) with each destination's transfer activity. */
function Webhooks() {
  const toast = useToast();
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null);
  const [events, setEvents] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [chosen, setChosen] = useState<string[]>(SUPPORTED);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<WebhookEndpoint | null>(null);
  const [activity, setActivity] = useState<Record<string, WebhookDelivery[] | 'loading' | { error: string }>>({});

  const load = useCallback(() => integrationsApi.webhooks()
    .then(d => { setEvents(d.events.filter(e => SUPPORTED.includes(e))); setEndpoints(d.endpoints); setError(null); })
    .catch((e: Error) => setError(e.message)), []);
  useEffect(() => { void load(); }, [load]);

  const loadActivity = useCallback((id: string) => {
    setActivity(a => ({ ...a, [id]: 'loading' }));
    integrationsApi.deliveries(id).then(list => setActivity(a => ({ ...a, [id]: list })))
      .catch((e: Error) => setActivity(a => ({ ...a, [id]: { error: e.message } })));
  }, []);
  useEffect(() => { endpoints?.forEach(ep => loadActivity(ep.id)); }, [endpoints, loadActivity]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!/^https:\/\//i.test(url.trim())) { setError('Enter an https:// address.'); return; }
    if (!chosen.length) { setError('Choose at least one event.'); return; }
    setBusy(true); setError(null);
    try {
      const created = await integrationsApi.addWebhook(url.trim(), chosen, 'Booking');
      setSecret(created.secret);
      setUrl('');
      toast.success('Destination added');
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function test(id: string) {
    try {
      const d = await integrationsApi.testWebhook(id);
      if (d.status === 'sent') toast.success('Test event delivered', `The destination answered ${d.responseStatus}. No real appointment was created.`);
      else toast.warning('Test event not delivered', d.error ?? `Status: ${d.status}`);
    } catch (err) { toast.error('Test failed', (err as Error).message); }
    loadActivity(id);
  }

  async function remove() {
    if (!removing) return;
    try {
      await integrationsApi.deleteWebhook(removing.id);
      toast.success('Destination removed');
      setRemoving(null);
      await load();
    } catch (err) { toast.error('Destination was not removed', (err as Error).message); }
  }

  return (
    <>
      <Section id="webhooks" title="Incoming / Outgoing Webhooks & API" description="Send supported Booking events to an external destination over a signed https webhook.">
        <div className="space-y-5">
          {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
          {secret && (
            <div role="status" className="p-3 rounded-lg bg-primary-light border border-primary/30 text-sm text-text-primary">
              <p className="font-semibold mb-1">Signing secret — shown only once</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="break-all text-xs" data-webhook-secret>{secret}</code>
                <Button size="sm" variant="ghost" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => navigator.clipboard.writeText(secret).then(() => toast.success('Secret copied')).catch(() => undefined)}>Copy</Button>
              </div>
              <p className="text-xs text-text-secondary mt-1">Check the X-WorkEasy360-Signature header with it (HMAC-SHA256).</p>
            </div>
          )}
          {endpoints === null ? <Loading /> : endpoints.length === 0 ? (
            <p className="text-sm text-text-muted">No destinations yet.</p>
          ) : (
            <ul className="divide-y divide-border border border-border rounded-xl">
              {endpoints.map(ep => (
                <li key={ep.id} className="px-4 py-3.5 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Webhook className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
                    <span className="flex-1 min-w-0 text-sm font-medium text-text-primary break-all">{ep.url}</span>
                    <Pill tone={ep.active ? 'green' : 'gray'}>{ep.active ? 'Enabled' : 'Disabled'}</Pill>
                    <Button size="sm" variant="secondary" icon={<Send className="w-3.5 h-3.5" />} onClick={() => test(ep.id)}>Send test</Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="w-3.5 h-3.5" />} aria-label={`Remove ${ep.url}`} onClick={() => setRemoving(ep)}>Remove</Button>
                  </div>
                  <p className="text-xs text-text-muted">{ep.events.map(e => EVENT_LABEL[e] ?? e).join(' · ')}</p>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={add} noValidate className="space-y-3 border-t border-border pt-4">
            <Input label="Destination address (https)" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://example.com/hooks/booking" />
            <fieldset>
              <legend className="text-sm font-medium text-text-primary mb-1.5">Events</legend>
              <div className="grid sm:grid-cols-2 gap-1.5">
                {(events.length ? events : SUPPORTED).map(ev => (
                  <label key={ev} className="flex items-center gap-2 text-sm text-text-primary">
                    <input type="checkbox" className="w-4 h-4 accent-primary" checked={chosen.includes(ev)}
                      onChange={e => setChosen(c => (e.target.checked ? [...c, ev] : c.filter(x => x !== ev)))} />
                    {EVENT_LABEL[ev] ?? ev}
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="btn-primary" disabled={busy || !url.trim()}>{busy ? 'Adding…' : 'Add destination'}</button>
          </form>
          <p className="text-xs text-text-muted">Incoming API actions (create, reschedule or cancel an appointment) use the same checks as manual booking and are enabled through WorkEasy Connect once tested.</p>
        </div>
      </Section>

      <Section id="activity" title="Transfer Activity" description="Recent transfers from Booking. Temporary failures are retried automatically.">
        {!endpoints ? <Loading /> : endpoints.length === 0 ? <p className="text-sm text-text-muted">No transfers yet.</p> : (
          <div className="space-y-5">
            {endpoints.map(ep => {
              const a = activity[ep.id];
              return (
                <div key={ep.id}>
                  <div className="flex items-center gap-2 mb-2">
                    <ArrowRightLeft className="w-4 h-4 text-primary" aria-hidden="true" />
                    <p className="flex-1 min-w-0 text-sm font-semibold text-text-primary truncate">{ep.url}</p>
                    <button type="button" onClick={() => loadActivity(ep.id)} aria-label="Refresh activity" className="p-1.5 rounded-lg text-text-muted hover:text-primary hover:bg-muted"><RefreshCw className="w-4 h-4" aria-hidden="true" /></button>
                  </div>
                  {a === undefined || a === 'loading' ? <Loading /> : 'error' in a ? <p className="text-sm text-red-600">{a.error}</p> : a.length === 0 ? (
                    <p className="text-sm text-text-muted flex items-center gap-1.5"><Activity className="w-4 h-4" aria-hidden="true" />Nothing sent yet.</p>
                  ) : (
                    <ul className="divide-y divide-border border border-border rounded-xl text-sm">
                      {a.slice(0, 10).map(d => {
                        const l = deliveryLabel(d);
                        return (
                          <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                            <span className="w-36 text-text-secondary">{formatDate(d.createdAt, 'MMM d, h:mm a')}</span>
                            <span className="flex-1 min-w-[10rem] text-text-primary">{EVENT_LABEL[d.eventType] ?? (d.eventType === 'ping' ? 'Test event' : d.eventType)}</span>
                            {d.attempts > 1 && <span className="text-xs text-text-muted">{d.attempts} attempts</span>}
                            <Pill tone={l.tone}>{l.text}</Pill>
                            {d.error && <span className="basis-full text-xs text-red-600 break-words">{d.error}</span>}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <ConfirmModal isOpen={!!removing} onClose={() => setRemoving(null)} onConfirm={() => void remove()}
        title="Remove this destination?" message={`Booking stops sending events to ${removing?.url ?? ''}. Appointments are not affected.`}
        confirmLabel="Remove" />
    </>
  );
}
