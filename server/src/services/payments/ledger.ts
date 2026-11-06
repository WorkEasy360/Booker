import { nanoid } from 'nanoid';
import db from '../../db/init';
import type { PaymentEvent, Provider } from './events';

// Payment records and their states (tables payments and payment_events, migration 015_payments).
// Each provider event is applied once (its id is recorded first; a repeat is ignored). Events can arrive late or out of
// order, so a state only moves forward: created → pending → paid → partially_refunded → refunded, with failed and
// cancelled possible only before payment. A late "pending" or "failed" never undoes "paid"; a refund that arrives
// before "paid" still counts (a refund proves the payment happened). Refund totals only grow.

export type PaymentStatus = 'created' | 'pending' | 'paid' | 'failed' | 'cancelled' | 'partially_refunded' | 'refunded';
export type EventOutcome = 'applied' | 'ignored_duplicate' | 'ignored_unknown' | 'ignored_stale';

export interface PaymentRow {
  id: string; organization_id: string; appointment_id: string | null; provider: Provider; provider_payment_id: string;
  amount: number; currency: string; status: PaymentStatus; refunded_amount: number; created_at: string; updated_at: string;
}

const BEFORE_PAYMENT: PaymentStatus[] = ['created', 'pending', 'failed', 'cancelled'];

/** Records a payment the business started with a provider (amount in minor units). */
export function createPaymentRecord(input: { orgId: string; appointmentId: string | null; provider: Provider; providerPaymentId: string; amount: number; currency: string }): PaymentRow {
  const id = `pay-${nanoid(14)}`;
  db.prepare(
    `INSERT INTO payments (id, organization_id, appointment_id, provider, provider_payment_id, amount, currency, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`
  ).run(id, input.orgId, input.appointmentId, input.provider, input.providerPaymentId, input.amount, input.currency.toUpperCase());
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as PaymentRow;
}

/** The state after an event, or null when the event changes nothing (stale or out of order). */
function nextState(p: PaymentRow, e: PaymentEvent): { status: PaymentStatus; refunded: number } | null {
  switch (e.type) {
    case 'pending':
      return p.status === 'created' ? { status: 'pending', refunded: p.refunded_amount } : null;
    case 'failed':
    case 'cancelled':
      return p.status === 'created' || p.status === 'pending' ? { status: e.type, refunded: p.refunded_amount } : null;
    case 'paid':
      return BEFORE_PAYMENT.includes(p.status) ? { status: 'paid', refunded: p.refunded_amount } : null;
    case 'refund': {
      const total = Math.min(p.amount, Math.max(p.refunded_amount, e.refundedTotal ?? 0));
      if (total <= p.refunded_amount && !BEFORE_PAYMENT.includes(p.status)) return null;
      if (total <= 0) return null;
      return { status: total >= p.amount ? 'refunded' : 'partially_refunded', refunded: total };
    }
  }
}

/** Applies one verified provider event. Safe to call twice with the same event, and in any order. */
export function applyPaymentEvent(e: PaymentEvent): { outcome: EventOutcome; payment?: PaymentRow } {
  return db.transaction((): { outcome: EventOutcome; payment?: PaymentRow } => {
    const payment = db.prepare('SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ?').get(e.provider, e.providerPaymentId) as PaymentRow | undefined;
    const inserted = db.prepare(
      `INSERT OR IGNORE INTO payment_events (provider, event_id, payment_id, type, occurred_at, outcome) VALUES (?, ?, ?, ?, ?, 'applied')`
    ).run(e.provider, e.eventId, payment?.id ?? null, e.name, e.occurredAt).changes;
    if (!inserted) return { outcome: 'ignored_duplicate', payment };
    const record = (outcome: EventOutcome) => db.prepare('UPDATE payment_events SET outcome = ? WHERE provider = ? AND event_id = ?').run(outcome, e.provider, e.eventId);
    if (!payment) { record('ignored_unknown'); return { outcome: 'ignored_unknown' }; }
    const next = nextState(payment, e);
    if (!next) { record('ignored_stale'); return { outcome: 'ignored_stale', payment }; }
    db.prepare(
      `UPDATE payments SET status = ?, refunded_amount = ?, last_event_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(next.status, next.refunded, e.occurredAt, payment.id);
    return { outcome: 'applied', payment: db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id) as PaymentRow };
  }).immediate();
}

/** Payments of one appointment, newest first (amounts in minor units). */
export function paymentsFor(orgId: string, appointmentId: string) {
  return (db.prepare('SELECT * FROM payments WHERE organization_id = ? AND appointment_id = ? ORDER BY created_at DESC').all(orgId, appointmentId) as PaymentRow[])
    .map(p => ({ id: p.id, provider: p.provider, amount: p.amount, currency: p.currency, status: p.status, refundedAmount: p.refunded_amount, updatedAt: p.updated_at }));
}
