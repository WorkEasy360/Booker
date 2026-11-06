import { createHmac, randomBytes } from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import { nanoid } from 'nanoid';
import db from '../../db/init';
import { seal, open } from './seal';

// Outgoing webhooks: a business registers an address (its own server, or a Zapier "Catch Hook") and chooses events.
// Each appointment change is queued in the same transaction as the change (so it is never lost or sent for a change
// that was rolled back), then delivered by the worker: signed, with a timeout, without following redirects, and
// retried with backoff. Addresses on private networks are refused (unless WEBHOOKS_ALLOW_PRIVATE_NETWORK=1, for local
// testing only), and production requires https.
//
// Signature header: X-WorkEasy360-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

export const WEBHOOK_EVENTS = [
  'appointment.created', 'appointment.status_changed', 'appointment.rescheduled', 'appointment.reassigned', 'appointment.deleted',
] as const;
export type WebhookEvent = typeof WEBHOOK_EVENTS[number] | 'ping';

export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
export const TIMEOUT_MS = 10_000;
const KEEP_FINISHED_MS = 30 * 86_400_000;
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

export interface EndpointRow { id: string; organization_id: string; url: string; secret_enc: string; events: string; description: string; is_active: number; created_at: string }

export function publicEndpoint(e: EndpointRow) {
  return { id: e.id, url: e.url, events: JSON.parse(e.events) as string[], description: e.description, active: !!e.is_active, createdAt: e.created_at };
}

/** Why an address cannot be used for webhooks (format and scheme only; the network check happens when sending). */
export function endpointUrlProblem(raw: string, production = process.env.NODE_ENV === 'production'): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Enter a full address, for example https://example.com/hooks/bookings'; }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !production)) return 'The address must start with https://';
  if (u.username || u.password) return 'The address must not contain a user name or password';
  if (u.hash) return 'The address must not contain a # fragment';
  return null;
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

async function networkProblem(url: string): Promise<string | null> {
  if (process.env.WEBHOOKS_ALLOW_PRIVATE_NETWORK === '1' && process.env.NODE_ENV !== 'production') return null;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  try {
    const addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
    if (!addresses.length) return 'The address could not be found';
    if (addresses.some(a => isPrivateAddress(a.address))) return 'The address is on a private network and cannot receive webhooks';
    return null;
  } catch {
    return 'The address could not be found';
  }
}

export function createEndpoint(orgId: string, input: { url: string; events: string[]; description?: string }, userId: string): { endpoint: ReturnType<typeof publicEndpoint>; secret: string } {
  const id = `whk-${nanoid(12)}`;
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  db.prepare(
    `INSERT INTO webhook_endpoints (id, organization_id, url, secret_enc, events, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, input.url, seal(id, secret), JSON.stringify([...new Set(input.events)]), input.description ?? '', userId);
  return { endpoint: publicEndpoint(db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(id) as EndpointRow), secret };
}

export function listEndpoints(orgId: string) {
  return (db.prepare('SELECT * FROM webhook_endpoints WHERE organization_id = ? ORDER BY created_at').all(orgId) as EndpointRow[]).map(publicEndpoint);
}

/** Revokes an endpoint: it and its undelivered events are removed at once. */
export function deleteEndpoint(orgId: string, id: string): boolean {
  return db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND organization_id = ?').run(id, orgId).changes > 0;
}

export function listDeliveriesFor(orgId: string, endpointId: string) {
  return db.prepare(
    `SELECT id, event_type AS eventType, status, attempts, response_status AS responseStatus, last_error AS error, created_at AS createdAt,
            delivered_at AS deliveredAt, next_attempt_at AS nextAttemptAt
     FROM webhook_deliveries WHERE organization_id = ? AND endpoint_id = ? ORDER BY created_at DESC LIMIT 50`
  ).all(orgId, endpointId);
}

/** Queues an event for every active endpoint of the business that subscribed to it. Call inside the change's transaction. */
export function queueWebhookEvent(orgId: string, type: WebhookEvent, data: unknown | (() => unknown), onlyEndpointId?: string): number {
  const endpoints = (db.prepare('SELECT id, events FROM webhook_endpoints WHERE organization_id = ? AND is_active = 1').all(orgId) as Array<{ id: string; events: string }>)
    .filter(e => (onlyEndpointId ? e.id === onlyEndpointId : (JSON.parse(e.events) as string[]).includes(type)));
  if (!endpoints.length) return 0;
  const eventId = `evt_${nanoid(16)}`;
  // Built only when someone subscribed (it holds the customer's name and email address).
  const payload = JSON.stringify({ id: eventId, type, createdAt: nowIso(), data: typeof data === 'function' ? (data as () => unknown)() : data });
  const insert = db.prepare(
    `INSERT INTO webhook_deliveries (id, endpoint_id, organization_id, event_id, event_type, payload, status, next_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  );
  // Due now by the worker's own clock (JavaScript time), so an immediate run always picks it up.
  const due = nowIso();
  for (const e of endpoints) insert.run(`dlv-${nanoid(14)}`, e.id, orgId, eventId, type, payload, due);
  return endpoints.length;
}

export function signatureHeader(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSeconds},v1=${createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex')}`;
}

interface DeliveryRow { id: string; endpoint_id: string; organization_id: string; event_type: string; payload: string | null; attempts: number }

function finishDelivery(id: string, status: string, fields: { code?: number | null; error?: string | null; next?: string | null } = {}): void {
  db.prepare(
    `UPDATE webhook_deliveries SET status = ?, response_status = ?, last_error = ?, next_attempt_at = ?,
       delivered_at = CASE WHEN ? = 'sent' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE delivered_at END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(status, fields.code ?? null, fields.error ?? null, fields.next ?? null, status, id);
}

/** One delivery attempt. Claimed first, so two workers never send the same delivery. */
async function attempt(id: string, now: number): Promise<string> {
  if (!db.prepare(`UPDATE webhook_deliveries SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'pending'`).run(id).changes) return 'not-claimed';
  const d = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as DeliveryRow;
  const endpoint = db.prepare('SELECT * FROM webhook_endpoints WHERE id = ?').get(d.endpoint_id) as EndpointRow | undefined;
  const secret = endpoint ? open(endpoint.id, endpoint.secret_enc) : null;
  if (!endpoint || !endpoint.is_active || !secret || !d.payload) {
    finishDelivery(id, 'failed', { error: !secret ? 'The endpoint secret cannot be read; create the endpoint again' : 'The endpoint is no longer active' });
    return 'failed';
  }
  const retry = (error: string, code?: number) => {
    if (d.attempts <= RETRY_DELAYS_MS.length) { finishDelivery(id, 'pending', { code, error, next: nowIso(now + RETRY_DELAYS_MS[d.attempts - 1]) }); return 'retrying'; }
    finishDelivery(id, 'failed', { code, error });
    return 'failed';
  };
  const blocked = await networkProblem(endpoint.url);
  if (blocked) { finishDelivery(id, 'failed', { error: blocked }); return 'failed'; }
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json', 'User-Agent': 'WorkEasy360-Webhooks/1',
        'X-WorkEasy360-Event': d.event_type, 'X-WorkEasy360-Delivery': d.id, 'X-WorkEasy360-Signature': signatureHeader(secret, d.payload),
      },
      body: d.payload,
    });
    await res.arrayBuffer().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) { finishDelivery(id, 'sent', { code: res.status }); return 'sent'; }
    if (res.status === 410) {
      // The receiver says the hook is gone for good: stop sending to it.
      db.prepare('UPDATE webhook_endpoints SET is_active = 0 WHERE id = ?').run(endpoint.id);
      finishDelivery(id, 'failed', { code: 410, error: 'The receiver answered 410 Gone; the endpoint was turned off' });
      return 'failed';
    }
    return retry(`The receiver answered HTTP ${res.status}`, res.status);
  } catch (e) {
    return retry((e as Error).name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} seconds` : 'Could not connect to the address');
  }
}

/** Sends due deliveries; drops payloads of deliveries finished more than 30 days ago. */
export async function processWebhookDeliveries(now = Date.now()): Promise<Record<string, number>> {
  const due = db.prepare(`SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50`).all(nowIso(now)) as Array<{ id: string }>;
  const summary: Record<string, number> = {};
  for (const { id } of due) { const o = await attempt(id, now); summary[o] = (summary[o] ?? 0) + 1; }
  db.prepare(`UPDATE webhook_deliveries SET payload = NULL WHERE status IN ('sent', 'failed') AND payload IS NOT NULL AND updated_at < ?`).run(nowIso(now - KEEP_FINISHED_MS));
  return summary;
}

export function recoverInterruptedWebhooks(): number {
  return db.prepare(`UPDATE webhook_deliveries SET status = 'unknown', last_error = 'The server stopped while sending; not resent automatically' WHERE status = 'sending'`).run().changes;
}

export { networkProblem as webhookNetworkProblem };
