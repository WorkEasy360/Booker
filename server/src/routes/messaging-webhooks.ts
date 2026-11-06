import express, { Router } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import db from '../db/init';
import { toE164 } from '../lib/phone';
import { redactError } from '../services/email/notify';
import { connectionConfig, recordConsent } from '../services/notifications/settings';

// Delivery reports and replies from the messaging providers: /api/webhooks/messaging/{twilio,whatsapp}/:orgId/...
// Mounted before the JSON parser (WhatsApp signs the exact bytes). Nothing changes until the provider's signature
// checks out with that business's own credentials; each report is applied once (repeats are recorded and ignored);
// a status only moves forward (sent → delivered → read; a late "failed" never overrides "delivered"). A STOP reply
// withdraws the customer's consent for that channel. Answers carry no data.

const router = Router();
const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'ARRET', 'रोकें', 'बंद']);

function firstTime(provider: string, eventId: string): boolean {
  return db.prepare('INSERT OR IGNORE INTO messaging_webhook_events (provider, event_id) VALUES (?, ?)').run(provider, eventId).changes > 0;
}

/** Applies a delivery report to the job that sent the message (only within that business). */
function applyStatus(orgId: string, providerMessageId: string, status: 'sent' | 'delivered' | 'read' | 'failed', error?: string): void {
  const job = db.prepare('SELECT id, status FROM notification_jobs WHERE organization_id = ? AND provider_message_id = ?').get(orgId, providerMessageId) as
    { id: string; status: string } | undefined;
  if (!job) return;
  if (status === 'failed') {
    if ((RANK[job.status] ?? 0) >= RANK.delivered) return; // already delivered: a late failure report does not undo it
    db.prepare(`UPDATE notification_jobs SET status = 'failed', last_error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
      .run(redactError(error ?? 'The provider reported the message as not delivered'), job.id);
    return;
  }
  if ((RANK[status] ?? 0) <= (RANK[job.status] ?? 0)) return;
  db.prepare(`UPDATE notification_jobs SET status = ?, delivered_at = CASE WHEN ? IN ('delivered', 'read') THEN COALESCE(delivered_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE delivered_at END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(status, status, job.id);
}

function optOut(orgId: string, channel: 'sms' | 'whatsapp', from: string): void {
  const number = toE164(from.startsWith('+') ? from : `+${from}`);
  if (!number) return;
  const customers = db.prepare('SELECT id, phone FROM customers WHERE organization_id = ? AND phone IS NOT NULL').all(orgId) as Array<{ id: string; phone: string }>;
  for (const c of customers) if (toE164(c.phone) === number) recordConsent(orgId, c.id, channel, 'revoked', 'reply_stop');
}

// ─── Twilio (SMS) ────────────────────────────────────────────────────────────

/** Twilio's signature: base64 HMAC-SHA1 of the full URL followed by each POST parameter (sorted) as name+value. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function twilioVerified(req: express.Request, orgId: string, path: string): boolean {
  const cfg = connectionConfig(orgId, 'sms');
  const base = process.env.PUBLIC_API_URL?.replace(/\/$/, '');
  const presented = req.get('x-twilio-signature');
  if (!cfg?.authToken || !base || !presented) return false;
  const expected = Buffer.from(twilioSignature(cfg.authToken, `${base}${path}`, req.body as Record<string, string>));
  const got = Buffer.from(presented);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

router.post('/twilio/:orgId/status', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  const { orgId } = req.params;
  if (!twilioVerified(req, orgId, `/api/webhooks/messaging/twilio/${orgId}/status`)) { res.status(403).json({ error: 'Invalid signature' }); return; }
  const sid = String(req.body.MessageSid ?? '');
  const status = String(req.body.MessageStatus ?? '');
  if (sid && status && firstTime('twilio', `${sid}:${status}`)) {
    if (status === 'delivered' || status === 'sent' || status === 'read') applyStatus(orgId, sid, status);
    else if (status === 'undelivered' || status === 'failed') applyStatus(orgId, sid, 'failed', `The carrier reported the message as ${status}${req.body.ErrorCode ? ` (error ${req.body.ErrorCode})` : ''}`);
  }
  res.status(204).end();
});

router.post('/twilio/:orgId/inbound', express.urlencoded({ extended: false, limit: '32kb' }), (req, res) => {
  const { orgId } = req.params;
  if (!twilioVerified(req, orgId, `/api/webhooks/messaging/twilio/${orgId}/inbound`)) { res.status(403).json({ error: 'Invalid signature' }); return; }
  const word = String(req.body.Body ?? '').trim().toUpperCase();
  if (STOP_WORDS.has(word) && req.body.From && firstTime('twilio', `inbound:${req.body.MessageSid ?? `${req.body.From}:${word}`}`)) optOut(orgId, 'sms', String(req.body.From));
  res.type('text/xml').send('<Response/>');
});

// ─── WhatsApp (Meta Cloud API) ───────────────────────────────────────────────

router.get('/whatsapp/:orgId', (req, res) => {
  const cfg = connectionConfig(req.params.orgId, 'whatsapp');
  const q = req.query as Record<string, string | undefined>;
  if (q['hub.mode'] === 'subscribe' && cfg?.verifyToken && q['hub.verify_token'] === cfg.verifyToken && q['hub.challenge']) {
    res.type('text/plain').send(String(q['hub.challenge']).slice(0, 200));
    return;
  }
  res.status(403).json({ error: 'Verification failed' });
});

export function whatsappSignature(appSecret: string, raw: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
}

router.post('/whatsapp/:orgId', express.raw({ type: () => true, limit: '256kb' }), (req, res) => {
  const { orgId } = req.params;
  const cfg = connectionConfig(orgId, 'whatsapp');
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const presented = req.get('x-hub-signature-256') ?? '';
  if (!cfg?.appSecret) { res.status(403).json({ error: 'Invalid signature' }); return; }
  const expected = Buffer.from(whatsappSignature(cfg.appSecret, raw));
  if (Buffer.from(presented).length !== expected.length || !timingSafeEqual(Buffer.from(presented), expected)) { res.status(403).json({ error: 'Invalid signature' }); return; }
  let body: { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id?: string; status?: string; errors?: Array<{ code?: number; title?: string }> }>; messages?: Array<{ id?: string; from?: string; text?: { body?: string } }> } }> }> };
  try { body = JSON.parse(raw.toString('utf8')); } catch { res.status(400).json({ error: 'The request body is not valid JSON' }); return; }
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    for (const s of change.value?.statuses ?? []) {
      if (!s.id || !s.status || !firstTime('whatsapp', `${s.id}:${s.status}`)) continue;
      if (s.status === 'sent' || s.status === 'delivered' || s.status === 'read') applyStatus(orgId, s.id, s.status);
      else if (s.status === 'failed') applyStatus(orgId, s.id, 'failed', `WhatsApp reported the message as failed${s.errors?.[0]?.code ? ` (code ${s.errors[0].code})` : ''}`);
    }
    for (const m of change.value?.messages ?? []) {
      const word = (m.text?.body ?? '').trim().toUpperCase();
      if (m.from && STOP_WORDS.has(word) && firstTime('whatsapp', `inbound:${m.id ?? `${m.from}:${word}`}`)) optOut(orgId, 'whatsapp', m.from);
    }
  }
  res.status(200).json({ received: true });
});

export default router;
