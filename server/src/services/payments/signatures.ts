import { createHmac, timingSafeEqual } from 'crypto';

// Webhook and payment signatures, checked on the server before any payment state changes. Implemented from each
// provider's published scheme; verified here only against signatures made the same way (no live account was used).
//  - Stripe:   header "Stripe-Signature: t=<unix>,v1=<hex>"; v1 = HMAC-SHA256(endpoint secret, "<t>.<raw body>");
//              timestamps older than the tolerance are refused (replay protection).
//  - Razorpay: webhook header "X-Razorpay-Signature" = hex HMAC-SHA256(webhook secret, raw body);
//              checkout result: razorpay_signature = hex HMAC-SHA256(key secret, "<order_id>|<payment_id>").
//  - PayPal:   no shared secret; PayPal's own API (verify-webhook-signature) must confirm each event (see paypal.ts).

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const STRIPE_TOLERANCE_SECONDS = 300;

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' | 'too_old' };

export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, now = Date.now()): SignatureCheck {
  if (!header) return { ok: false, reason: 'missing' };
  const parts = header.split(',').map(p => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d+$/.test(t) || !signatures.length) return { ok: false, reason: 'malformed' };
  if (Math.abs(now / 1000 - Number(t)) > STRIPE_TOLERANCE_SECONDS) return { ok: false, reason: 'too_old' };
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex');
  return signatures.some(s => safeEqualHex(s, expected)) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** For tests and documentation: the header Stripe would send for this body. */
export function stripeSignatureHeader(rawBody: Buffer | string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${sig}`;
}

export function verifyRazorpayWebhook(rawBody: Buffer, signature: string | undefined, secret: string): SignatureCheck {
  if (!signature) return { ok: false, reason: 'missing' };
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeEqualHex(signature, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** The checkout's return values (order id, payment id, signature) must have been signed with the key secret. */
export function verifyRazorpayPayment(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return safeEqualHex(signature, expected);
}

export function razorpaySignature(payload: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
