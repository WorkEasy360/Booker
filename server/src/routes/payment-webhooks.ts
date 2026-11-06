import express, { Router } from 'express';
import { verifyStripeSignature, verifyRazorpayWebhook } from '../services/payments/signatures';
import { stripeEvent, razorpayEvent, paypalEvent, type PaymentEvent } from '../services/payments/events';
import { applyPaymentEvent } from '../services/payments/ledger';
import { paypalConfig, razorpayWebhookSecret, stripeWebhookSecret, verifyPaypalWebhook } from '../services/payments/providers';

// Payment provider webhooks: /api/webhooks/payments/{stripe,razorpay,paypal}. Mounted before the JSON parser, because
// signatures are computed over the exact bytes received. Nothing is changed until the signature checks out; each
// event is applied once. Answers carry no payment details. Without the provider's secret configured: 503.

const router = Router();
router.use(express.raw({ type: () => true, limit: '256kb' }));

const NOT_CONFIGURED = { error: 'Payments from this provider are not configured on this server', code: 'PAYMENTS_NOT_CONFIGURED' };
const BAD_SIGNATURE = { error: 'Invalid signature', code: 'INVALID_SIGNATURE' };

function parse(raw: Buffer): Record<string, unknown> | null {
  try { const v = JSON.parse(raw.toString('utf8')); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

function finish(res: express.Response, event: PaymentEvent | null): void {
  // Events that are not about payments are acknowledged so the provider does not keep retrying them.
  if (!event) { res.json({ data: { received: true, outcome: 'ignored_type' } }); return; }
  res.json({ data: { received: true, outcome: applyPaymentEvent(event).outcome } });
}

router.post('/stripe', (req, res, next) => {
  try {
    const secret = stripeWebhookSecret();
    if (!secret) { res.status(503).json(NOT_CONFIGURED); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyStripeSignature(raw, req.get('stripe-signature'), secret).ok) { res.status(400).json(BAD_SIGNATURE); return; }
    const body = parse(raw);
    if (!body) { res.status(400).json({ error: 'The request body is not valid JSON' }); return; }
    finish(res, stripeEvent(body));
  } catch (err) { next(err); }
});

router.post('/razorpay', (req, res, next) => {
  try {
    const secret = razorpayWebhookSecret();
    if (!secret) { res.status(503).json(NOT_CONFIGURED); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyRazorpayWebhook(raw, req.get('x-razorpay-signature'), secret).ok) { res.status(400).json(BAD_SIGNATURE); return; }
    const body = parse(raw);
    if (!body) { res.status(400).json({ error: 'The request body is not valid JSON' }); return; }
    // Razorpay sends the event id in a header; repeats of the same delivery carry the same id.
    finish(res, razorpayEvent(body, req.get('x-razorpay-event-id') ?? undefined));
  } catch (err) { next(err); }
});

router.post('/paypal', async (req, res, next) => {
  try {
    const cfg = paypalConfig();
    if (!cfg) { res.status(503).json(NOT_CONFIGURED); return; }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const body = parse(raw);
    if (!body) { res.status(400).json({ error: 'The request body is not valid JSON' }); return; }
    const headers = Object.fromEntries(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']
      .map(h => [h, req.get(h)]));
    if (!(await verifyPaypalWebhook(cfg, headers, body))) { res.status(400).json(BAD_SIGNATURE); return; }
    finish(res, paypalEvent(body));
  } catch (err) { next(err); }
});

export default router;
