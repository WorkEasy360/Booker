// Payment webhooks with test secrets only (no provider account, no network): signatures are required and checked over
// the exact bytes; each event is applied once; late and out-of-order events never move a payment backwards; refunds
// only grow; unknown payments and unrelated events are acknowledged without changes. PayPal's verification API is
// replaced by a stand-in. Without secrets configured, every endpoint answers 503.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { stripeSignatureHeader, verifyStripeSignature, verifyRazorpayWebhook, verifyRazorpayPayment, razorpaySignature, STRIPE_TOLERANCE_SECONDS } from '../services/payments/signatures';
import { createPaymentRecord, applyPaymentEvent } from '../services/payments/ledger';
import { setPaymentHttpClient } from '../services/payments/providers';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const STRIPE_SECRET = 'whsec_test_only_' + RUN;
const RAZORPAY_SECRET = 'rzp_webhook_test_only_' + RUN;
let orgId = '';

const statusOf = (id: string) => db.prepare('SELECT status, refunded_amount FROM payments WHERE id = ?').get(id) as { status: string; refunded_amount: number };
const stripePost = (event: Record<string, unknown>, secret = STRIPE_SECRET, at?: number) => {
  const body = JSON.stringify(event);
  return request(app).post('/api/webhooks/payments/stripe').set('Content-Type', 'application/json')
    .set('Stripe-Signature', stripeSignatureHeader(body, secret, at)).send(body);
};
let seq = 0;
const stripeEvent = (type: string, object: Record<string, unknown>, created = Math.floor(Date.now() / 1000)) =>
  ({ id: `evt_${RUN}_${++seq}`, type, created, data: { object } });

beforeAll(async () => {
  const s = await signUpAndSignIn(app, { name: 'Pay Owner', email: `pay-${RUN}@example.com`, company: `Pay ${RUN}`, password: 'StartPass123' });
  sessionToken(s);
  orgId = s.body.data.user.organization_id;
});
afterEach(() => {
  delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.PAYPAL_WEBHOOK_ID; delete process.env.PAYPAL_CLIENT_ID; delete process.env.PAYPAL_CLIENT_SECRET;
  setPaymentHttpClient(null);
});

describe('signatures', () => {
  it('Stripe: the right secret over the exact bytes, within 5 minutes', () => {
    const body = Buffer.from('{"id":"evt_1"}');
    const now = Date.now();
    expect(verifyStripeSignature(body, stripeSignatureHeader(body, 's3cret', Math.floor(now / 1000)), 's3cret', now)).toEqual({ ok: true });
    expect(verifyStripeSignature(body, stripeSignatureHeader(body, 'other', Math.floor(now / 1000)), 's3cret', now)).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), stripeSignatureHeader(body, 's3cret', Math.floor(now / 1000)), 's3cret', now).ok).toBe(false);
    const old = Math.floor(now / 1000) - STRIPE_TOLERANCE_SECONDS - 1;
    expect(verifyStripeSignature(body, stripeSignatureHeader(body, 's3cret', old), 's3cret', now)).toEqual({ ok: false, reason: 'too_old' });
    expect(verifyStripeSignature(body, 'v1=abc', 's3cret', now)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyStripeSignature(body, undefined, 's3cret', now)).toEqual({ ok: false, reason: 'missing' });
    // Several v1 values (during secret rotation): any one matching is enough.
    const good = stripeSignatureHeader(body, 's3cret', Math.floor(now / 1000));
    expect(verifyStripeSignature(body, `${good},v1=${'0'.repeat(64)}`, 's3cret', now).ok).toBe(true);
  });

  it('Razorpay: webhook body and checkout result', () => {
    const body = Buffer.from('{"event":"order.paid"}');
    expect(verifyRazorpayWebhook(body, razorpaySignature(body, 'k'), 'k').ok).toBe(true);
    expect(verifyRazorpayWebhook(body, razorpaySignature(body, 'x'), 'k').ok).toBe(false);
    expect(verifyRazorpayWebhook(body, 'not-hex', 'k').ok).toBe(false);
    expect(verifyRazorpayPayment('order_1', 'pay_1', razorpaySignature('order_1|pay_1', 'ks'), 'ks')).toBe(true);
    expect(verifyRazorpayPayment('order_1', 'pay_2', razorpaySignature('order_1|pay_1', 'ks'), 'ks')).toBe(false);
  });
});

describe('Stripe webhooks', () => {
  it('without a configured secret the endpoint answers 503 and changes nothing', async () => {
    const res = await stripePost(stripeEvent('payment_intent.succeeded', { id: 'pi_x' }));
    expect([res.status, res.body.code]).toEqual([503, 'PAYMENTS_NOT_CONFIGURED']);
  });

  it('a bad or missing signature changes nothing', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
    const p = createPaymentRecord({ orgId, appointmentId: null, provider: 'stripe', providerPaymentId: `pi_bad_${RUN}`, amount: 50000, currency: 'inr' });
    const res = await stripePost(stripeEvent('payment_intent.succeeded', { id: p.provider_payment_id }), 'wrong-secret');
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_SIGNATURE']);
    const unsigned = await request(app).post('/api/webhooks/payments/stripe').set('Content-Type', 'application/json').send('{"id":"evt"}');
    expect(unsigned.status).toBe(400);
    expect(statusOf(p.id).status).toBe('created');
  });

  it('applies each event once, never backwards, and counts refunds up to the amount', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
    const p = createPaymentRecord({ orgId, appointmentId: null, provider: 'stripe', providerPaymentId: `pi_ok_${RUN}`, amount: 50000, currency: 'inr' });
    const paid = stripeEvent('payment_intent.succeeded', { id: p.provider_payment_id });
    expect((await stripePost(paid)).body.data.outcome).toBe('applied');
    expect((await stripePost(paid)).body.data.outcome).toBe('ignored_duplicate');
    // A "processing" or "failed" that arrives late does not undo the payment.
    expect((await stripePost(stripeEvent('payment_intent.processing', { id: p.provider_payment_id }))).body.data.outcome).toBe('ignored_stale');
    expect((await stripePost(stripeEvent('payment_intent.payment_failed', { id: p.provider_payment_id }))).body.data.outcome).toBe('ignored_stale');
    expect(statusOf(p.id)).toEqual({ status: 'paid', refunded_amount: 0 });
    await stripePost(stripeEvent('charge.refunded', { payment_intent: p.provider_payment_id, amount_refunded: 20000 }));
    expect(statusOf(p.id)).toEqual({ status: 'partially_refunded', refunded_amount: 20000 });
    // An older refund notice (smaller total) arriving later changes nothing; the full refund completes it.
    expect((await stripePost(stripeEvent('charge.refunded', { payment_intent: p.provider_payment_id, amount_refunded: 10000 }))).body.data.outcome).toBe('ignored_stale');
    await stripePost(stripeEvent('charge.refunded', { payment_intent: p.provider_payment_id, amount_refunded: 50000 }));
    expect(statusOf(p.id)).toEqual({ status: 'refunded', refunded_amount: 50000 });
    const events = db.prepare('SELECT outcome FROM payment_events WHERE payment_id = ? ORDER BY received_at, rowid').all(p.id) as Array<{ outcome: string }>;
    expect(events.map(e => e.outcome)).toEqual(['applied', 'ignored_stale', 'ignored_stale', 'applied', 'ignored_stale', 'applied']);
  });

  it('a refund that arrives before "paid" still counts; "paid" afterwards changes nothing', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
    const p = createPaymentRecord({ orgId, appointmentId: null, provider: 'stripe', providerPaymentId: `pi_ooo_${RUN}`, amount: 30000, currency: 'inr' });
    await stripePost(stripeEvent('charge.refunded', { payment_intent: p.provider_payment_id, amount_refunded: 30000 }));
    expect(statusOf(p.id).status).toBe('refunded');
    expect((await stripePost(stripeEvent('payment_intent.succeeded', { id: p.provider_payment_id }))).body.data.outcome).toBe('ignored_stale');
  });

  it('unknown payments and unrelated events are acknowledged without changes', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = STRIPE_SECRET;
    expect((await stripePost(stripeEvent('payment_intent.succeeded', { id: 'pi_unknown' }))).body.data.outcome).toBe('ignored_unknown');
    expect((await stripePost(stripeEvent('customer.created', { id: 'cus_1' }))).body.data.outcome).toBe('ignored_type');
  });

  it('the database refuses a refund larger than the payment', () => {
    const p = createPaymentRecord({ orgId, appointmentId: null, provider: 'stripe', providerPaymentId: `pi_cap_${RUN}`, amount: 1000, currency: 'inr' });
    expect(() => db.prepare('UPDATE payments SET refunded_amount = 1001 WHERE id = ?').run(p.id)).toThrow(/CHECK/);
    // The ledger itself caps the total at the amount.
    applyPaymentEvent({ provider: 'stripe', eventId: `evt_cap_${RUN}`, providerPaymentId: p.provider_payment_id, type: 'refund', refundedTotal: 999999, occurredAt: new Date().toISOString(), name: 'charge.refunded' });
    expect(statusOf(p.id)).toEqual({ status: 'refunded', refunded_amount: 1000 });
  });
});

describe('Razorpay webhooks (UPI, cards, netbanking)', () => {
  const post = (body: Record<string, unknown>, eventId: string, secret = RAZORPAY_SECRET) => {
    const raw = JSON.stringify(body);
    return request(app).post('/api/webhooks/payments/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', razorpaySignature(raw, secret)).set('X-Razorpay-Event-Id', eventId).send(raw);
  };
  it('verifies, applies once per event id, and handles refunds', async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = RAZORPAY_SECRET;
    const p = createPaymentRecord({ orgId, appointmentId: null, provider: 'razorpay', providerPaymentId: `order_${RUN}`, amount: 75000, currency: 'INR' });
    const paid = { event: 'payment.captured', created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: 'pay_1', order_id: p.provider_payment_id, method: 'upi' } } } };
    expect((await post(paid, 'rzp_evt_1', 'wrong')).status).toBe(400);
    expect((await post(paid, 'rzp_evt_1')).body.data.outcome).toBe('applied');
    expect((await post(paid, 'rzp_evt_1')).body.data.outcome).toBe('ignored_duplicate');
    const refund = { event: 'refund.processed', payload: { payment: { entity: { id: 'pay_1', order_id: p.provider_payment_id, amount_refunded: 25000 } }, refund: { entity: { id: 'rfnd_1' } } } };
    await post(refund, 'rzp_evt_2');
    expect(statusOf(p.id)).toEqual({ status: 'partially_refunded', refunded_amount: 25000 });
    expect((await post({ event: 'payment.failed', payload: { payment: { entity: { order_id: p.provider_payment_id } } } }, 'rzp_evt_3')).body.data.outcome).toBe('ignored_stale');
  });
});

describe('PayPal webhooks', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/cert', 'paypal-transmission-id': 't1',
    'paypal-transmission-sig': 'sig', 'paypal-transmission-time': new Date().toISOString(),
  };
  it('applies an event only when PayPal (here a stand-in) confirms it', async () => {
    process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST'; process.env.PAYPAL_CLIENT_ID = 'client'; process.env.PAYPAL_CLIENT_SECRET = 'secret';
    let verdict = 'FAILURE';
    const calls: string[] = [];
    setPaymentHttpClient(async url => {
      calls.push(url);
      return url.endsWith('/v1/oauth2/token')
        ? { status: 200, json: async () => ({ access_token: 'token' }) }
        : { status: 200, json: async () => ({ verification_status: verdict }) };
    });
    const p = createPaymentRecord({ orgId, appointmentId: null, provider: 'paypal', providerPaymentId: `PPORDER${RUN}`, amount: 2500, currency: 'USD' });
    const event = { id: `WH-EVT-${RUN}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: new Date().toISOString(), resource: { supplementary_data: { related_ids: { order_id: p.provider_payment_id } } } };
    const send = () => request(app).post('/api/webhooks/payments/paypal').set(headers).set('Content-Type', 'application/json').send(JSON.stringify(event));
    expect((await send()).status).toBe(400);
    expect(statusOf(p.id).status).toBe('created');
    verdict = 'SUCCESS';
    expect((await send()).body.data.outcome).toBe('applied');
    expect(statusOf(p.id).status).toBe('paid');
    expect(calls.every(u => u.startsWith('https://api-m.sandbox.paypal.com/'))).toBe(true);
    // Without PayPal's headers nothing is asked or applied.
    expect((await request(app).post('/api/webhooks/payments/paypal').set('Content-Type', 'application/json').send(JSON.stringify(event))).status).toBe(400);
  });
});
