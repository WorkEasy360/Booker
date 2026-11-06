// Provider events turned into one shape the payment ledger understands. Only the fields needed for the payment's state
// are read; nothing else from the payload is kept (no card, account or customer data is stored).

export type Provider = 'stripe' | 'razorpay' | 'paypal';
export type PaymentEventType = 'pending' | 'paid' | 'failed' | 'cancelled' | 'refund';

export interface PaymentEvent {
  provider: Provider;
  eventId: string;
  /** The provider's id for the payment as recorded when it was created (PaymentIntent, Razorpay order, PayPal order). */
  providerPaymentId: string;
  type: PaymentEventType;
  /** For refunds: the total refunded so far, in minor units (paise, cents), as the provider reports it. */
  refundedTotal?: number;
  occurredAt: string;
  /** The provider's event name, for the record. */
  name: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? v as Json : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const int = (v: unknown): number | undefined => (Number.isInteger(v) && (v as number) >= 0 ? v as number : undefined);
const fromUnix = (v: unknown): string => (Number.isFinite(v) ? new Date((v as number) * 1000).toISOString() : new Date().toISOString());

/** Stripe: PaymentIntent events and charge refunds. Null for events that do not concern payments. */
export function stripeEvent(body: Json): PaymentEvent | null {
  const id = str(body.id);
  const type = str(body.type);
  const object = obj(obj(body.data).object);
  if (!id || !type) return null;
  const base = { provider: 'stripe' as const, eventId: id, occurredAt: fromUnix(body.created), name: type };
  const map: Record<string, PaymentEventType> = {
    'payment_intent.processing': 'pending', 'payment_intent.succeeded': 'paid',
    'payment_intent.payment_failed': 'failed', 'payment_intent.canceled': 'cancelled',
  };
  if (map[type]) {
    const intent = str(object.id);
    return intent ? { ...base, providerPaymentId: intent, type: map[type] } : null;
  }
  if (type === 'charge.refunded') {
    const intent = str(object.payment_intent);
    return intent ? { ...base, providerPaymentId: intent, type: 'refund', refundedTotal: int(object.amount_refunded) } : null;
  }
  return null;
}

/** Razorpay (UPI, cards, netbanking all arrive the same way): payment, order and refund events, keyed by order id. */
export function razorpayEvent(body: Json, eventId: string | undefined): PaymentEvent | null {
  const type = str(body.event);
  const payload = obj(body.payload);
  const payment = obj(obj(payload.payment).entity);
  const orderId = str(payment.order_id) ?? str(obj(obj(payload.order).entity).id);
  if (!type || !orderId || !eventId) return null;
  const base = { provider: 'razorpay' as const, eventId, providerPaymentId: orderId, occurredAt: fromUnix(body.created_at), name: type };
  switch (type) {
    case 'payment.authorized': return { ...base, type: 'pending' };
    case 'payment.captured': case 'order.paid': return { ...base, type: 'paid' };
    case 'payment.failed': return { ...base, type: 'failed' };
    case 'refund.processed': return { ...base, type: 'refund', refundedTotal: int(payment.amount_refunded) };
    default: return null;
  }
}

/** PayPal (Orders v2): approval, capture and refund events, keyed by the order id. */
export function paypalEvent(body: Json): PaymentEvent | null {
  const id = str(body.id);
  const type = str(body.event_type);
  const resource = obj(body.resource);
  if (!id || !type) return null;
  const orderId = str(obj(obj(resource.supplementary_data).related_ids).order_id) ?? (type === 'CHECKOUT.ORDER.APPROVED' ? str(resource.id) : null);
  if (!orderId) return null;
  const base = { provider: 'paypal' as const, eventId: id, providerPaymentId: orderId, occurredAt: str(body.create_time) ?? new Date().toISOString(), name: type };
  switch (type) {
    case 'CHECKOUT.ORDER.APPROVED': return { ...base, type: 'pending' };
    case 'PAYMENT.CAPTURE.COMPLETED': return { ...base, type: 'paid' };
    case 'PAYMENT.CAPTURE.DENIED': case 'PAYMENT.CAPTURE.DECLINED': return { ...base, type: 'failed' };
    case 'PAYMENT.CAPTURE.REFUNDED': {
      const total = obj(obj(resource.seller_payable_breakdown).total_refunded_amount).value;
      const minor = typeof total === 'string' && /^\d+(\.\d{1,2})?$/.test(total) ? Math.round(Number(total) * 100) : undefined;
      return { ...base, type: 'refund', refundedTotal: minor };
    }
    default: return null;
  }
}
