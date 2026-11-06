# Integrations, payments, reminders and messaging: what exists

> **Update 2026-10-24.** Booking notifications by email, SMS (Twilio), WhatsApp (Cloud API), reminders, the business
> calendar (Google, Outlook) and "Add to calendar" are built and verified against mock providers only; see
> `NOTIFICATIONS.md`, which replaces the SMS, WhatsApp, reminder and calendar parts of this document. Webhooks,
> Zapier, OAuth account connections and payment webhooks were added on 2026-10-24 (migrations 015 and 016). The
> tables below describe 2026-10-23 and are kept for the record.

Status as of 2026-10-23, from the code, not from the screens. The Integrations page lists ten services and itself says
"Integrations are not implemented yet. No external service is connected". The server has no code for any of them: no
OAuth flow, no API client, no webhook endpoint, no stored credentials. The only built-in external delivery is email
over SMTP: booking emails to customers and staff sign-in invitations.

## Classification

| Catalog entry | Status | What the screen does today |
|---|---|---|
| Google Calendar | Placeholder | Card marked "Not available yet"; no button |
| Microsoft Outlook | Placeholder | Card marked "Not available yet"; no button |
| Zoom | Placeholder | Card marked "Not available yet"; no button |
| Google Meet | Placeholder | Card marked "Not available yet"; no button |
| Mailchimp | Placeholder | Card marked "Not available yet"; no button |
| Twilio SMS | Placeholder | Card marked "Not available yet"; no button |
| Stripe | Placeholder | Card marked "Not available yet"; no button |
| PayPal | Placeholder | Card marked "Not available yet"; no button |
| Zapier | Placeholder | Card marked "Not available yet"; no button |
| Webhooks | Placeholder | Card marked "Not available yet"; no button |

Each one is blocked by two things: credentials from the provider, and an approved settings screen to connect,
configure and disconnect it (the brief forbids new integration screens without approval). None of them is
"partial": there is no half-built server code to finish.

Related features outside the catalog:

| Feature | Status |
|---|---|
| Booking emails (confirmation, reschedule, cancellation) | **Implemented.** SMTP with an outbox, retries without duplicates, delivery log. Verified against a local SMTP catcher in the tests, never against a real provider. See `EMAIL.md` |
| Account emails (sign-up confirmation, password reset) | **Implemented.** Same SMTP settings; sent in the background with in-memory retries. Verified against local SMTP servers in the tests, never against a real provider. See `EMAIL.md`, `SECURITY.md` |
| "Add to calendar" buttons on the booking confirmation | Placeholder. They show "Calendar integration is not yet connected." |
| Appointment reminders | Not implemented. The Notifications page lists them under "Planned notifications (not sent)" |
| SMS, WhatsApp | Not implemented |
| Online payment (Stripe, PayPal, Razorpay) | Not implemented. The booking page and confirmation say "pay the business directly". There are no payment webhooks |
| Subscriptions / plans billing | Not implemented |
| Recurring bookings, group bookings | Not implemented |
| Two-way calendar sync, busy-time import | Not implemented |
| Report export | Placeholder. The Export button explains that an export integration is needed |
| In-app assistant | Local knowledge search only; no external AI service. It answers that these features are not available (`server/src/tests/assistant-honesty.test.ts`) |

## What each would need

None of the variables below is read by the current code. They are the names proposed for the implementation, so
that credentials can be requested from the providers in advance. Every secret belongs in `server/.env` (never in
the web app build) and must never be logged.

General requirements for any integration:
- A per-business connection record (provider, account id, encrypted tokens, status, connected by, connected at) and a
  migration for it. Tokens encrypted with a key held outside the database (for example `INTEGRATIONS_ENCRYPTION_KEY`).
- An approved screen to connect, show status and disconnect. Only admins should be able to change connections.
- Webhook endpoints that verify the provider's signature over the raw request body, reject replays (timestamp and
  event id stored once), and are idempotent, following the email outbox pattern.
- Tests against the provider's sandbox or recorded fixtures. A "connected" or "paid" status must only ever come from a
  provider response.

### Google Calendar and Google Meet
- Google Cloud project with the Calendar API, an OAuth consent screen (verification is needed for external users),
  and an OAuth client of type "Web application".
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://<app-domain>/api/integrations/google/callback`.
- Scopes: `calendar.events` (write appointments); `calendar.readonly` or free/busy only if busy times should block
  slots. Meet links come from `conferenceData.createRequest` on the event, so Meet needs no separate credentials.
- Push notifications (optional, for changes made in Google): a verified https domain and a watch channel per
  calendar, renewed before expiry.
- Test: connect a test Google account, book, confirm the event appears with the right time zone, reschedule and
  cancel, revoke access in Google and confirm the app shows the connection as broken rather than failing silently.

### Microsoft Outlook (Microsoft 365 / Outlook.com)
- App registration in Microsoft Entra ID; `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT=common`,
  redirect URI `https://<app-domain>/api/integrations/microsoft/callback`.
- Graph scopes `Calendars.ReadWrite`, `offline_access`. Change notifications need a public https endpoint and
  subscription renewal (at most about three days for calendar events).
- Test as for Google, with a work and a personal account.

### Zoom
- Zoom Marketplace app. A user-level OAuth app (`ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, redirect URI
  `https://<app-domain>/api/integrations/zoom/callback`) lets each business connect its own account. Server-to-server
  OAuth (`ZOOM_ACCOUNT_ID` as well) only suits one Zoom account for everyone.
- Scope `meeting:write`. Webhook secret token `ZOOM_WEBHOOK_SECRET_TOKEN` for the endpoint validation challenge and
  signature checks.
- Test: book an online service, confirm a meeting is created with the right start time and duration, and that the
  join link reaches the confirmation email only when the meeting really exists.

### Mailchimp
- OAuth app (`MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET`, redirect URI
  `https://<app-domain>/api/integrations/mailchimp/callback`).
- Only customers who gave marketing consent may be synced. The booking form has no marketing-consent field today, so
  this also needs an approved change to the booking page.
- Test: sync a consenting test customer into a test audience; a customer without consent must not appear.

### Twilio SMS (and WhatsApp)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (or `TWILIO_MESSAGING_SERVICE_SID`); status callback
  `https://<app-domain>/api/webhooks/twilio/status`, verified with `X-Twilio-Signature`.
- India: sender ID and every message template must be registered on a DLT platform before delivery. WhatsApp needs a
  WhatsApp Business sender and approved templates.
- Phone numbers must be stored in E.164 format with consent to receive messages.
- Test with Twilio test credentials (no real messages), then one real number you own.

### Stripe, PayPal and Razorpay
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`; webhook `https://<app-domain>/api/webhooks/stripe` verified
  with `Stripe-Signature`. Use Checkout or Payment Intents; a booking is "paid" only after the
  `checkout.session.completed` / `payment_intent.succeeded` webhook.
- PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENV=sandbox|live`; webhook
  `https://<app-domain>/api/webhooks/paypal`, verified through PayPal's verify-webhook-signature API.
- Razorpay (businesses in India, not in the catalog): `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`; webhook `https://<app-domain>/api/webhooks/razorpay`, verified with the
  `X-Razorpay-Signature` HMAC-SHA256 of the raw body. The checkout `razorpay_signature` must also be verified on the
  server.
- All three need: a payment state on appointments (migration), what happens to an unpaid hold (expiry frees the slot),
  refunds on cancellation, idempotent webhook handling, amounts in the smallest currency unit, and approved changes to
  the booking and confirmation screens.
- Test only in sandbox/test mode with the providers' test cards and simulated webhooks. Never charge real customers
  during testing.

### Zapier and Webhooks
- Outgoing webhooks: per-business endpoint URL and signing secret (generated by the app, shown once), events such as
  `appointment.created`, `appointment.rescheduled`, `appointment.cancelled`, an `X-WorkEasy360-Signature` HMAC
  header with a timestamp, retries through an outbox like the email one, and refusal of private-network target
  addresses (SSRF protection).
- Zapier: a Zapier developer platform app using the same events (REST hooks) and an API key or OAuth per business.
- Test: point a webhook at a local receiver, check signature, retries and that a cancelled-then-recreated booking
  produces events in order.

## Calendar files without an integration

The "Add to calendar" buttons could work without any provider account: an `.ics` file download (Apple Calendar,
Outlook) and a Google Calendar "add event" link built from the booking. This changes what the existing buttons do,
so it needs approval even though the screen would look the same.
