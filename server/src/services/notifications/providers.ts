import { createHash } from 'crypto';

// Provider adapters for SMS (Twilio), WhatsApp (Meta WhatsApp Business Platform, Cloud API) and calendars (Google
// Calendar, Microsoft Graph), plus the mock provider used in development and tests. Every adapter returns one of four
// results; the worker decides what happens next:
//   accepted   the provider took the message/event (with its id)          → sent
//   transient  temporary problem (rate limit, 5xx, network refused)        → retried with backoff
//   permanent  will not work as it is (bad number, template, credentials)  → failed
//   timeout    no answer in time: the provider MAY have accepted it        → unknown (not retried on its own)
// Live adapters are implemented from the providers' published APIs and have been exercised only against stand-in
// HTTP clients here: no account, number or calendar was used.

export type ProviderResult =
  | { kind: 'accepted'; id: string }
  | { kind: 'transient'; error: string; retryAfterMs?: number }
  | { kind: 'permanent'; error: string; code?: string; connectionProblem?: boolean; optedOut?: boolean }
  | { kind: 'timeout'; error: string };

// ─── HTTP (replaceable in tests) ─────────────────────────────────────────────

export type Http = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; headers?: { get(name: string): string | null }; text(): Promise<string> }>;
const TIMEOUT_MS = 10_000;
let http: Http = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
export function setProviderHttp(client: Http | null): void { http = client ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' })); }

async function call(url: string, init: Parameters<Http>[1]): Promise<{ status: number; body: Record<string, unknown>; retryAfterMs?: number } | { timeout: true } | { network: string }> {
  try {
    const res = await http(url, init);
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    const ra = res.headers?.get('retry-after');
    return { status: res.status, body, retryAfterMs: ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined };
  } catch (e) {
    const name = (e as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') return { timeout: true };
    return { network: 'Could not reach the provider' };
  }
}

// ─── Mock provider (development and tests) ───────────────────────────────────

export type MockFailure = 'transient' | 'permanent' | 'timeout' | 'rate_limited' | 'auth_expired' | 'template_missing' | 'opted_out';
export interface MockSms { orgId: string; to: string; body: string; id: string }
export interface MockWhatsApp { orgId: string; to: string; template: string; language: string; params: string[]; id: string }
export interface MockCalendarEvent { provider: 'google' | 'outlook'; orgId: string; id: string; status: 'confirmed' | 'cancelled'; summary: string; start: string; end: string; attendees: string[]; revisions: number }

const failures: Record<'sms' | 'whatsapp' | 'calendar', MockFailure[]> = { sms: [], whatsapp: [], calendar: [] };
let seq = 0;
export const mockProviders = {
  sms: [] as MockSms[],
  whatsapp: [] as MockWhatsApp[],
  calendar: new Map<string, MockCalendarEvent>(),
  reset(): void { this.sms.length = 0; this.whatsapp.length = 0; this.calendar.clear(); failures.sms = []; failures.whatsapp = []; failures.calendar = []; },
  /** The next calls on this channel fail this way, one per entry. */
  failNext(channel: 'sms' | 'whatsapp' | 'calendar', ...modes: MockFailure[]): void { failures[channel].push(...modes); },
};
function mockFailure(channel: 'sms' | 'whatsapp' | 'calendar'): ProviderResult | null {
  const mode = failures[channel].shift();
  switch (mode) {
    case undefined: return null;
    case 'transient': return { kind: 'transient', error: 'Mock provider: temporarily unavailable (HTTP 503)' };
    case 'rate_limited': return { kind: 'transient', error: 'Mock provider: rate limited (HTTP 429)', retryAfterMs: 120_000 };
    case 'timeout': return { kind: 'timeout', error: 'Mock provider: no answer in time; it may have accepted the message' };
    case 'auth_expired': return { kind: 'permanent', error: 'Mock provider: credentials expired or revoked', code: 'auth', connectionProblem: true };
    case 'template_missing': return { kind: 'permanent', error: 'Mock provider: the message template is not approved or does not exist', code: 'template' };
    case 'opted_out': return { kind: 'permanent', error: 'Mock provider: the recipient has opted out', code: 'opted_out', optedOut: true };
    default: return { kind: 'permanent', error: 'Mock provider: rejected the request', code: 'rejected' };
  }
}
const mockId = (prefix: string) => `${prefix}_mock_${(++seq).toString(36)}_${Date.now().toString(36)}`;

// ─── SMS ─────────────────────────────────────────────────────────────────────

export interface SmsMessage { to: string; body: string; statusCallbackUrl?: string }
export interface TwilioConfig { accountSid: string; authToken: string; from?: string; messagingServiceSid?: string }

export async function sendSms(provider: string, orgId: string, cfg: Record<string, string>, msg: SmsMessage): Promise<ProviderResult> {
  if (provider === 'mock') {
    const fail = mockFailure('sms');
    if (fail) {
      // A timeout means the mock did take the message: the duplicate risk a real provider would have.
      if (fail.kind === 'timeout') mockProviders.sms.push({ orgId, to: msg.to, body: msg.body, id: mockId('SM') });
      return fail;
    }
    const id = mockId('SM');
    mockProviders.sms.push({ orgId, to: msg.to, body: msg.body, id });
    return { kind: 'accepted', id };
  }
  if (provider !== 'twilio') return { kind: 'permanent', error: 'Unknown SMS provider', connectionProblem: true };
  const c = cfg as unknown as TwilioConfig;
  const form = new URLSearchParams({ To: msg.to, Body: msg.body });
  if (c.messagingServiceSid) form.set('MessagingServiceSid', c.messagingServiceSid); else if (c.from) form.set('From', c.from);
  if (msg.statusCallbackUrl) form.set('StatusCallback', msg.statusCallbackUrl);
  const r = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if ('timeout' in r) return { kind: 'timeout', error: 'Twilio did not answer in time; the message may have been accepted' };
  if ('network' in r) return { kind: 'transient', error: r.network };
  if (r.status === 201 || r.status === 200) return typeof r.body.sid === 'string' ? { kind: 'accepted', id: r.body.sid } : { kind: 'transient', error: 'Twilio answered without a message id' };
  const code = String(r.body.code ?? '');
  if (r.status === 429) return { kind: 'transient', error: 'Twilio rate limit', retryAfterMs: r.retryAfterMs };
  if (r.status >= 500) return { kind: 'transient', error: `Twilio HTTP ${r.status}` };
  if (r.status === 401 || r.status === 403) return { kind: 'permanent', error: 'Twilio refused the credentials', code: 'auth', connectionProblem: true };
  if (code === '21610') return { kind: 'permanent', error: 'The recipient has replied STOP to this sender', code, optedOut: true };
  if (['21211', '21614', '21408', '21612'].includes(code)) return { kind: 'permanent', error: `Twilio cannot send to this number (code ${code})`, code };
  return { kind: 'permanent', error: `Twilio rejected the message (HTTP ${r.status}${code ? `, code ${code}` : ''})`, code };
}

/** Checks the credentials (live: GET the account; mock: always fine unless told to fail). */
export async function verifySms(provider: string, cfg: Record<string, string>): Promise<ProviderResult> {
  if (provider === 'mock') return mockFailure('sms') ?? { kind: 'accepted', id: 'mock-account' };
  const c = cfg as unknown as TwilioConfig;
  const r = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}.json`, {
    method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}` },
  });
  if ('timeout' in r || 'network' in r) return { kind: 'transient', error: 'Twilio could not be reached' };
  if (r.status === 200) return { kind: 'accepted', id: String(r.body.sid ?? c.accountSid) };
  return { kind: 'permanent', error: `Twilio refused the credentials (HTTP ${r.status})`, connectionProblem: true };
}

/** GSM-7 messages hold 160 characters (153 per part when split); anything else (for example Hindi) 70 (67 per part). */
const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà^{}\\[~\]|€]*$/;
export function smsParts(body: string): { encoding: 'GSM-7' | 'UCS-2'; parts: number; length: number } {
  const gsm = GSM7.test(body);
  const length = [...body].length;
  const single = gsm ? 160 : 70, multi = gsm ? 153 : 67;
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', length, parts: length <= single ? 1 : Math.ceil(length / multi) };
}

// ─── WhatsApp (template messages: business-initiated messages must use approved templates) ───────────────────────

export interface WhatsAppTemplateMessage { to: string; template: string; language: string; params: string[] }
export interface WhatsAppConfig { phoneNumberId: string; accessToken: string; appSecret: string; verifyToken: string; apiVersion?: string }

export async function sendWhatsApp(provider: string, orgId: string, cfg: Record<string, string>, msg: WhatsAppTemplateMessage): Promise<ProviderResult> {
  if (provider === 'mock') {
    const fail = mockFailure('whatsapp');
    if (fail) {
      if (fail.kind === 'timeout') mockProviders.whatsapp.push({ orgId, ...msg, id: mockId('wamid') });
      return fail;
    }
    const id = mockId('wamid');
    mockProviders.whatsapp.push({ orgId, ...msg, id });
    return { kind: 'accepted', id };
  }
  if (provider !== 'whatsapp_cloud') return { kind: 'permanent', error: 'Unknown WhatsApp provider', connectionProblem: true };
  const c = cfg as unknown as WhatsAppConfig;
  const r = await call(`https://graph.facebook.com/${c.apiVersion || 'v20.0'}/${encodeURIComponent(c.phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: msg.to.replace(/^\+/, ''), type: 'template',
      template: { name: msg.template, language: { code: msg.language }, components: [{ type: 'body', parameters: msg.params.map(text => ({ type: 'text', text })) }] },
    }),
  });
  if ('timeout' in r) return { kind: 'timeout', error: 'WhatsApp did not answer in time; the message may have been accepted' };
  if ('network' in r) return { kind: 'transient', error: r.network };
  const id = (r.body.messages as Array<{ id?: string }> | undefined)?.[0]?.id;
  if (r.status === 200 && id) return { kind: 'accepted', id };
  const err = (r.body.error ?? {}) as { code?: number; message?: string };
  const code = String(err.code ?? '');
  if (r.status === 429 || ['130429', '131056', '80007', '4'].includes(code)) return { kind: 'transient', error: 'WhatsApp rate limit', retryAfterMs: r.retryAfterMs };
  if (r.status >= 500 || code === '131000' || code === '1') return { kind: 'transient', error: `WhatsApp temporary error (HTTP ${r.status})` };
  if (code === '190' || r.status === 401) return { kind: 'permanent', error: 'The WhatsApp access token has expired or was revoked', code, connectionProblem: true };
  if (['132000', '132001', '132007', '132012', '132015', '132016'].includes(code)) return { kind: 'permanent', error: `The WhatsApp template is missing, not approved or its values do not match (code ${code})`, code };
  if (code === '131050') return { kind: 'permanent', error: 'The recipient stopped marketing messages from this business', code, optedOut: true };
  return { kind: 'permanent', error: `WhatsApp rejected the message (HTTP ${r.status}${code ? `, code ${code}` : ''})`, code };
}

export async function verifyWhatsApp(provider: string, cfg: Record<string, string>): Promise<ProviderResult> {
  if (provider === 'mock') return mockFailure('whatsapp') ?? { kind: 'accepted', id: 'mock-number' };
  const c = cfg as unknown as WhatsAppConfig;
  const r = await call(`https://graph.facebook.com/${c.apiVersion || 'v20.0'}/${encodeURIComponent(c.phoneNumberId)}?fields=display_phone_number,verified_name`, {
    method: 'GET', headers: { Authorization: `Bearer ${c.accessToken}` },
  });
  if ('timeout' in r || 'network' in r) return { kind: 'transient', error: 'WhatsApp could not be reached' };
  if (r.status === 200) return { kind: 'accepted', id: String(r.body.id ?? c.phoneNumberId) };
  return { kind: 'permanent', error: `WhatsApp refused the credentials (HTTP ${r.status})`, connectionProblem: true };
}

// ─── Calendars ───────────────────────────────────────────────────────────────

export interface CalendarEvent {
  appointmentId: string; summary: string; description: string; location: string; startUtc: string; endUtc: string;
  attendees: string[]; cancelled: boolean; sequence: number;
}

/** Google event ids must be base32hex (a–v, 0–9), 5–1024 characters: one fixed id per appointment makes creation idempotent. */
export function googleEventId(orgId: string, appointmentId: string): string {
  const digest = createHash('sha256').update(`we360:${orgId}:${appointmentId}`).digest();
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  let out = '';
  for (const byte of digest.subarray(0, 20)) out += alphabet[byte & 31] + alphabet[byte >> 5];
  return `we360${out}`;
}

/**
 * Creates, updates or cancels the event for an appointment. `existingId` is the provider's id from an earlier sync.
 * Creation is idempotent: Google takes our own event id (a repeat answers 409), Microsoft a transactionId.
 */
export async function syncCalendar(provider: 'google' | 'outlook', mode: 'mock' | 'live', orgId: string, accessToken: string | null,
  event: CalendarEvent, existingId: string | null): Promise<ProviderResult> {
  if (mode === 'mock') {
    const fail = mockFailure('calendar');
    if (fail) return fail;
    const id = existingId ?? (provider === 'google' ? googleEventId(orgId, event.appointmentId) : `AAMk_mock_${event.appointmentId}`);
    const prev = mockProviders.calendar.get(`${provider}:${id}`);
    if (!prev && event.cancelled) return { kind: 'accepted', id };
    mockProviders.calendar.set(`${provider}:${id}`, {
      provider, orgId, id, status: event.cancelled ? 'cancelled' : 'confirmed', summary: event.summary, start: event.startUtc, end: event.endUtc,
      attendees: event.attendees, revisions: (prev?.revisions ?? 0) + 1,
    });
    return { kind: 'accepted', id };
  }
  if (!accessToken) return { kind: 'permanent', error: 'The calendar is not connected', connectionProblem: true };
  const auth = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const mapError = (r: { status: number }, name: string): ProviderResult =>
    r.status === 401 || r.status === 403 ? { kind: 'permanent', error: `${name} refused access; reconnect the calendar`, connectionProblem: true }
      : r.status === 429 || r.status >= 500 ? { kind: 'transient', error: `${name} HTTP ${r.status}` }
        : { kind: 'permanent', error: `${name} rejected the event (HTTP ${r.status})` };
  if (provider === 'google') {
    const id = existingId ?? googleEventId(orgId, event.appointmentId);
    const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
    const body = JSON.stringify({
      id, summary: event.summary, description: event.description, location: event.location,
      start: { dateTime: event.startUtc }, end: { dateTime: event.endUtc }, status: event.cancelled ? 'cancelled' : 'confirmed',
      attendees: event.attendees.map(email => ({ email })), sequence: event.sequence,
    });
    // sendUpdates=none: attendees are not emailed by Google from this integration.
    let r = existingId ? await call(`${base}/${id}?sendUpdates=none`, { method: 'PATCH', headers: auth, body }) : await call(`${base}?sendUpdates=none`, { method: 'POST', headers: auth, body });
    if ('timeout' in r) return { kind: 'timeout', error: 'Google Calendar did not answer in time' };
    if ('network' in r) return { kind: 'transient', error: r.network };
    if (r.status === 409 && !existingId) {
      // Created by an earlier attempt whose answer was lost: update it instead.
      r = await call(`${base}/${id}?sendUpdates=none`, { method: 'PATCH', headers: auth, body });
      if ('timeout' in r) return { kind: 'timeout', error: 'Google Calendar did not answer in time' };
      if ('network' in r) return { kind: 'transient', error: r.network };
    }
    return r.status === 200 || r.status === 201 ? { kind: 'accepted', id } : mapError(r, 'Google Calendar');
  }
  const base = 'https://graph.microsoft.com/v1.0/me/events';
  const payload = {
    subject: event.summary, body: { contentType: 'text', content: event.description }, location: { displayName: event.location },
    start: { dateTime: event.startUtc.replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: event.endUtc.replace(/Z$/, ''), timeZone: 'UTC' },
    attendees: event.attendees.map(address => ({ emailAddress: { address }, type: 'required' })),
  };
  if (event.cancelled) {
    if (!existingId) return { kind: 'accepted', id: 'none' };
    const r = await call(`${base}/${encodeURIComponent(existingId)}`, { method: 'DELETE', headers: auth });
    if ('timeout' in r) return { kind: 'timeout', error: 'Microsoft Graph did not answer in time' };
    if ('network' in r) return { kind: 'transient', error: r.network };
    return r.status === 204 || r.status === 404 ? { kind: 'accepted', id: existingId } : mapError(r, 'Microsoft Graph');
  }
  const r = existingId
    ? await call(`${base}/${encodeURIComponent(existingId)}`, { method: 'PATCH', headers: auth, body: JSON.stringify(payload) })
    : await call(base, { method: 'POST', headers: auth, body: JSON.stringify({ ...payload, transactionId: `we360-${orgId}-${event.appointmentId}` }) });
  if ('timeout' in r) return { kind: 'timeout', error: 'Microsoft Graph did not answer in time' };
  if ('network' in r) return { kind: 'transient', error: r.network };
  const id = typeof r.body.id === 'string' ? r.body.id : existingId;
  return (r.status === 200 || r.status === 201) && id ? { kind: 'accepted', id } : mapError(r, 'Microsoft Graph');
}
