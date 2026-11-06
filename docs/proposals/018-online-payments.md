# Proposal: online payment at booking (Razorpay)

Status: **proposal, not implemented.** Written 2026-10-27 for the launch of 28 October. Nothing here is in the code.

## What exists today (checked in the code on 2026-10-27)

| Part | State |
|---|---|
| Payment records and provider events (`payments`, `payment_events`, migration 015) | Built. States `created → pending → paid → partially_refunded → refunded`, plus `failed`/`cancelled` before payment; forward-only; each provider event applied once (`server/src/services/payments/ledger.ts`) |
| Webhook receivers `/api/webhooks/payments/{stripe,razorpay,paypal}` | Built. Signature checked on the raw body before anything changes (Stripe with a 5-minute replay window, Razorpay HMAC-SHA256, PayPal through PayPal's verify API); 503 without the secret. Tested with locally made signatures only |
| Razorpay checkout signature check (`verifyRazorpayPayment`) | Built, unused |
| Creating a payment order on the server, linking it to a booking, a payment step for customers, admin view of payments, refunds | **Not built.** `createPaymentRecord` is called only by tests. Booking pages say to pay the business directly |

## Why it is not in this launch

Doing it correctly touches the booking flow itself, not only payments:

- An unpaid booking must hold its time without confirming it: confirmation emails, reminders, staff alerts, outgoing
  webhooks and calendar sync are all triggered when a booking is created today, and would have to wait for payment.
- An unpaid hold must expire and free the time; a payment that arrives after expiry, or for a time someone else took,
  must be refunded.
- The customer-facing booking page needs a payment step (Razorpay Checkout, with matching changes to the security
  headers), and the admin screens need payment status.
- Refunds on cancellation need a policy, and the cancellation policy settings are not enforced today.
- None of it can be tested against Razorpay's test mode here: there are no test keys, and webhooks need a public URL.

That is two to three days of careful work and testing. Shipping part of it the night before launch would put an
untested path into the booking flow, which the launch priority forbids.

## Recommended design

Provider: **Razorpay** (the business is in India, prices are in INR; one integration covers UPI, cards, netbanking and
wallets, and the webhook side already exists).

1. **Settings.** Per service: "Payment: at the business (default) / online, in full". Stored in a new table
   (existing tables are not altered). Server variables `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`; one merchant account per server (one client per server).
2. **Booking.** For an online-payment service the public booking creates the appointment as a **hold** (new table:
   appointment, payment, `expires_at` = now + 15 minutes), creates the Razorpay order on the server (`POST /v1/orders`;
   amount = the service price in paise from the database, never from the browser; currency from the business; receipt
   = appointment id), records it with `createPaymentRecord`, and returns only the order id, amount and key id. No
   confirmation, reminder, alert, webhook or calendar job is created while it is a hold.
3. **Checkout.** The booking page opens Razorpay Checkout with that order. Its success callback only tells the server
   to check: `POST /api/public/payments/razorpay/confirm` with the order id, payment id and signature.
4. **Server confirmation.** Signature checked (`verifyRazorpayPayment`), then the payment fetched from Razorpay
   (`GET /v1/payments/:id`): status `captured`, same order, same amount and currency. Only then the payment becomes
   `paid` and the hold becomes a confirmed booking, in one transaction; the usual confirmation, reminders and alerts
   start then. The `payment.captured` / `order.paid` webhook does the same if the browser never comes back; whichever
   arrives first wins, the other is a no-op (event ids and state checks already make this idempotent).
5. **Expiry.** The worker cancels holds past `expires_at` that are not paid (with a history entry), freeing the time.
   A payment that arrives for an expired or cancelled hold is marked for refund and shown to the admin; nothing is
   confirmed.
6. **Refunds.** First version: the admin refunds in the Razorpay Dashboard; the `refund.processed` webhook updates the
   record (already built). Automatic refunds come later, with a written policy.
7. **Admin.** Payment status, amount, Razorpay ids and refunds on the appointment; "Paid online" vs "At the business"
   in Appointments and Reports.

Tests: server-computed amount (a tampered amount is ignored), signature refusals, a fetched payment that is not
captured or has another amount, duplicate and out-of-order webhooks, confirm and webhook racing, hold expiry, a
payment after expiry, two customers paying for the same time, organisation isolation. Then Razorpay **test mode** end
to end on the deployed site (test keys and a webhook pointed at it). Live payments only after the Razorpay account is
activated (KYC) and you approve the first real transaction.

## Decisions needed

1. Which services require online payment; full amount or a deposit.
2. How long an unpaid hold lasts (proposed 15 minutes).
3. Refund rule when a customer cancels (and whether to enforce the cancellation deadline first).
4. Whether customers need GST invoices from the app, or Razorpay's receipts suffice.

## Until then

Booking pages keep saying "pay the business directly". If the client wants online payment on day one without code,
they can send Razorpay Payment Links or use a Razorpay Payment Page from their own Razorpay Dashboard; those payments
are not linked to bookings in the app.

## What the owner must provide

A Razorpay account in the client's name with KYC completed (live mode), test-mode keys for testing, the webhook
configured at `https://<site>/api/webhooks/payments/razorpay` with a secret, and written approval before the first live
transaction.
