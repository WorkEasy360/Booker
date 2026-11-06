# Booking notifications: email, SMS, WhatsApp and calendars

How a booking change reaches the customer, the staff member, the business and calendars, what is verified, and what
live use needs. Code: `server/src/services/notifications/`, `server/src/routes/notifications.ts`,
`server/src/routes/messaging-webhooks.ts`, migration `017_notification_platform`. Tests:
`server/src/tests/notification-platform.test.ts`, `server/src/tests/notifications.test.ts`.

**Status (2026-10-24): verified against mock providers only.** No message has been sent through Twilio or Meta, and no
event has been written to a real Google or Microsoft calendar. Email is verified against the in-memory test transport
and a local SMTP catcher.

## How it works

1. A booking is created, moved, reassigned, cancelled, restored or has its status changed: on the booking page, the
   manage-booking page, the dashboard or the assistant. Every one of those paths records the change in the
   appointment history (migration 010).
2. In the **same database transaction** as that history entry, the planner (`planner.ts`) writes one
   `notification_jobs` row per recipient and channel (outbox pattern). If the booking change rolls back, no job exists.
   If it commits, the jobs exist. The booking never waits for a provider.
3. After the commit, a worker (`worker.ts`) claims due jobs one at a time with a conditional update (`pending` →
   `sending`), so two workers never send the same job. It re-reads the appointment, checks the job still applies, sends
   it, and records the outcome and an attempt row.
4. Customer booking emails (confirmation, reschedule, cancellation) stay on the existing email outbox
   (`EMAIL.md`): they are always sent, carry the manage link, and now attach the booking's `.ics` file.

Recipients and channels:

| Role | Email | SMS | WhatsApp | Calendar |
|---|---|---|---|---|
| Customer | Booking emails always; reminders and status changes by rule | By rule, **only with consent** | By rule, **only with consent** | `.ics` attachment, "Add to calendar" buttons |
| Staff member (the one booked) | By rule and their own preferences | By rule and their own preferences | By rule and their own preferences | Optional attendee on the business calendar event |
| Business recipients (owner, front desk) | Their own channels and events | Their own channels and events | Their own channels and events | — |
| Business calendar | — | — | — | Google Calendar or Outlook, created, updated and cancelled |

Events: `confirmed` (booking made or restored), `rescheduled`, `cancelled`, `reminder`, `status_changed` (customers
only when a booking is confirmed; staff and business when it is confirmed, completed or marked no-show). Reassigning a
booking sends the old staff member a cancellation and the new one a confirmation.

The customer is never sent the staff member's email or phone number. Staff and business messages name the customer
but leave out their contact details.

### Job states

| Status | Meaning |
|---|---|
| `pending` | Waiting: due now, scheduled (reminders), or waiting for a retry |
| `sending` | Claimed by the worker |
| `sent` | The provider accepted it (an email server accepted it; Twilio or Meta returned a message id; the calendar API accepted the event) |
| `delivered`, `read` | Reported by the provider's signed callback; never assumed |
| `failed` | Permanent error, or the retry limit was reached ("Gave up after N attempts") |
| `unknown` | Timed out or interrupted by a restart: it may have been sent, so it is **not** retried automatically |
| `not_configured` | The channel is not connected (or only the development stand-in is set up while running live) |
| `skipped` | Not sent, with the reason: no consent, consent withdrawn, no or invalid phone number, no email, a reminder time already past |
| `cancelled` | No longer applies: the booking was cancelled or moved first, or reminders were turned off |

Retries: temporary failures (rate limits, HTTP 5xx, network errors) back off exponentially, 1 minute × 2^(attempt−1)
up to 6 hours, and stop after `max_attempts` (6 by default; the provider's `Retry-After` is honoured when longer).
Admins (permission `emails:send`) can retry `failed`, `unknown` and `not_configured` jobs from the appointment page.
A retry adds up to three attempts. A sent message cannot be retried.

Idempotency: each job has a unique dedupe key (`event:historyEntry:role:recipient:channel`; reminders
`reminder:appointment:slot:offset:role:recipient:channel`), so a change is planned once even if recorded twice.
Calendar events use our own event id (Google) or a `transactionId` (Microsoft Graph), so a retried creation never
makes a second event. Provider callbacks are stored by event id: a duplicate does nothing, and a status only moves
forward (a late "failed" after "delivered" is ignored).

### Reminders

Reminder times are set per business (up to 4, 15 minutes to 7 days before; default: the earlier "hours before"
setting). Jobs are planned when a booking is made and re-planned when it moves. A worker pass also plans reminders for
active bookings in the next 8 days, so bookings made before reminders were switched on get them too. Reminders are
durable rows, not timers, and survive restarts. A reminder for a time the booking no longer has is cancelled. None is
sent after a cancellation. A reminder whose time had already passed when the booking was made or moved is `skipped`.
A reminder found more than 15 minutes late (for example, after the server was down) is also `skipped`: none is ever
sent late.

## Settings (Notifications page)

- **Who gets what:** one switch per event × customer/staff × email/SMS/WhatsApp. Customer booking emails are always on.
  The earlier "Send reminder emails" and "Send staff alert emails" switches are the same settings as the matching boxes.
- **Reminder times**, **Business recipients** (up to 20; each with their own channels and events), **Business
  calendar** (Google or Outlook, only once connected; optionally add the staff member to the event).
- **Language for customers:** English or Hindi for emails, SMS and WhatsApp templates.
- **Delivery channels:** each channel's connection, latest success and latest problem (sanitized).
- On a staff profile: that person's channels and events. On a customer: SMS and WhatsApp consent, with source and date.
- On an appointment: every job with its attempts, and Retry where allowed.

Consent: the booking form shows SMS and WhatsApp boxes, unticked, only for channels the business switched on and
connected. Ticking records consent (`booking_page`). Leaving a box unticked withdraws earlier consent. Staff can
record agreement or withdrawal. A STOP reply (SMS or WhatsApp) withdraws it automatically (`reply_stop`), and so does
a provider "opted out" error.

## Provider mode

`NOTIFICATIONS_PROVIDER_MODE=mock` sends every SMS, WhatsApp and calendar call to an in-process stand-in: nothing
leaves the machine. This is the default whenever `NODE_ENV` is not `production`. `live` calls the configured
providers and is the default in production. This project's development and test setups never set `live`.

In mock mode:
- the pages show a "Development mode" banner;
- "Use the development stand-in" connects SMS, WhatsApp or a calendar to the stand-in;
- test messages say "development stand-in: nothing is sent";
- the delivery history labels stand-in results as such.

In live mode the stand-in cannot be chosen, and a channel still set to it is reported as `not_configured`.

## SMS: Twilio

Needed for live use (none of these are available in this project):
- A Twilio account with an SMS-capable sender number, or a Messaging Service.
- For India: a DLT-registered entity, sender ID (header) and content templates matching the texts below. Unregistered
  texts are blocked by Indian carriers.
- The **Account SID** (`AC` + 32 hex characters) and **Auth Token** (32 hex characters). Enter them in Integrations →
  Text messages and WhatsApp → SMS, then **Verify** (it reads the account with the credentials).
- Incoming-message webhook on the number or Messaging Service: `<PUBLIC_API_URL>/api/webhooks/messaging/twilio/<organization id>/inbound`,
  so STOP replies withdraw consent. Delivery reports are requested per message at
  `<PUBLIC_API_URL>/api/webhooks/messaging/twilio/<organization id>/status`. The page shows both addresses.

Behaviour:
- Numbers are normalised to E.164 (Indian numbers without `+91` are accepted).
- Texts are counted in GSM-7 (160/153 characters per part) or UCS-2 (70/67, for Hindi). A text of more than 6 parts
  is not sent.
- Customer texts end with "Reply STOP to opt out." (Hindi: "बंद करने के लिए STOP लिखें।").
- Callbacks need a valid `X-Twilio-Signature` (HMAC-SHA1 of the public URL and the sorted parameters with the Auth
  Token). Without `PUBLIC_API_URL`, callbacks are refused and no delivery report is requested.
- Error mapping:

  | Twilio response | Result |
  |---|---|
  | 21610 | Opted out: consent withdrawn |
  | 21211, 21614, 21408, 21612 | Bad or unreachable number: `failed` |
  | 401, 403 | Connection marked "Problem" |
  | 429, 5xx | Retried with backoff |
  | Timeout | `unknown` |

## WhatsApp: WhatsApp Business Platform (Cloud API)

Needed for live use (none of these are available in this project):
- A Meta Business account, a WhatsApp Business Account and a registered business phone number.
- The **phone number ID**, a **system-user access token** with `whatsapp_business_messaging`, the Meta app's **app
  secret**, and a **verify token** you choose (16+ characters). Enter them in Integrations → WhatsApp, then
  **Verify** (it reads the phone number with the token).
- Webhook in the Meta app: callback URL `<PUBLIC_API_URL>/api/webhooks/messaging/whatsapp/<organization id>`, the
  same verify token, subscribed to `messages`. Callbacks need a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw
  body with the app secret).
- These templates approved in WhatsApp Manager, category **Utility**, in `en` and, for businesses using Hindi, `hi`.
  If your approved names differ, enter them under "Template names" on the WhatsApp card. Variables are body
  parameters, in this order:

| Template | Sent to | Body variables | Suggested English text |
|---|---|---|---|
| `we360_booking_confirmed` | Customer: booking made | {{1}} name, {{2}} service, {{3}} date, {{4}} time, {{5}} business, {{6}} reference | Hi {{1}}, your booking for {{2}} on {{3}} at {{4}} with {{5}} is confirmed. Reference: {{6}}. |
| `we360_booking_rescheduled` | Customer: moved | same | Hi {{1}}, your booking for {{2}} with {{5}} has moved to {{3}} at {{4}}. Reference: {{6}}. |
| `we360_booking_cancelled` | Customer: cancelled | same | Hi {{1}}, your booking for {{2}} on {{3}} at {{4}} with {{5}} has been cancelled. Reference: {{6}}. |
| `we360_booking_reminder` | Customer: reminder | same | Hi {{1}}, a reminder of your booking for {{2}} on {{3}} at {{4}} with {{5}}. Reference: {{6}}. |
| `we360_booking_status` | Customer: confirmed by the business | {{1}} name, {{2}} reference, {{3}} status, {{4}} business | Hi {{1}}, your booking {{2}} is now {{3}}. {{4}} |
| `we360_team_booking_new` | Staff / business: new booking | {{1}} recipient, {{2}} service, {{3}} customer, {{4}} date, {{5}} time, {{6}} reference | Hi {{1}}, new booking: {{2}} with {{3}} on {{4}} at {{5}}. Reference: {{6}}. |
| `we360_team_booking_moved` | Staff / business: moved | same | Hi {{1}}, booking moved: {{2}} with {{3}} is now on {{4}} at {{5}}. Reference: {{6}}. |
| `we360_team_booking_cancelled` | Staff / business: cancelled | same | Hi {{1}}, booking cancelled: {{2}} with {{3}} on {{4}} at {{5}}. Reference: {{6}}. |
| `we360_team_booking_reminder` | Staff / business: reminder | same | Hi {{1}}, reminder: {{2}} with {{3}} on {{4}} at {{5}}. Reference: {{6}}. |
| `we360_team_booking_status` | Staff / business: status changed | {{1}} recipient, {{2}} reference, {{3}} status, {{4}} customer | Hi {{1}}, booking {{2}} ({{4}}) is now {{3}}. |

Parameters are trimmed, have line breaks and tabs replaced, and are limited in length, as Meta requires. The test
message on the Integrations page uses Meta's sample `hello_world` template (`en_US`).

Error mapping:

| Meta response | Result |
|---|---|
| 190 (token expired or revoked) | Connection marked "Problem" |
| 132xxx (template missing, not approved or parameter mismatch) | `failed`, named in the history |
| 130429, 131056 | Rate limit: retried |
| 131050 | Opted out: consent withdrawn |
| 5xx, network | Retried |
| Timeout | `unknown` |

Delivery statuses `sent` → `delivered` → `read` come from the webhook. `failed` from the webhook is applied only if
the message was not already delivered.

## Calendars: Google Calendar and Microsoft Outlook

Needed for live use: OAuth app credentials on the server and a business that connects its account (Integrations →
Connected accounts → Connect).

| Provider | Server variables | Redirect URI | Scopes (minimal for writing events) |
|---|---|---|---|
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `<PUBLIC_APP_URL>/api/integrations/google/callback` | `https://www.googleapis.com/auth/calendar.events` |
| Microsoft | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | `<PUBLIC_APP_URL>/api/integrations/microsoft/callback` | `Calendars.ReadWrite`, `offline_access` |

Then choose the calendar as the business calendar on the Notifications page.

- **Create:** Google uses a deterministic event id derived from the business and appointment, so a retry gets
  "409 already exists" and updates instead. Microsoft Graph uses a `transactionId` for the same effect.
- **Update** on move, reassignment or status change: the same event, patched.
- **Cancel** on cancellation: Google event status `cancelled`; Graph event deleted.
- Each change has a job of its own. The mapping appointment → provider event id is kept in `calendar_event_links`.
- Google is called with `sendUpdates=none`: attendees (the staff member, if chosen) get no email from Google.
- Times are sent in UTC. Access tokens are refreshed with the stored refresh token and re-encrypted. An expired or
  revoked grant marks the job `failed` with a connection problem.

Not built: two-way sync (importing busy times from the business calendar) and creating events in each staff member's
own calendar.

## Calendar file (.ics) and "Add to calendar"

- Every customer booking email has `booking-<reference>.ics` attached (RFC 5545):
  - `UID <appointment id>@workeasy360`, stable across moves;
  - `SEQUENCE` grows with every change;
  - `DTSTART`/`DTEND` in UTC;
  - summary "Service — Business"; description with the reference, staff name and time zone; location;
  - `METHOD:PUBLISH`, or `METHOD:CANCEL` with `STATUS:CANCELLED` for a cancellation;
  - text escaped and lines folded at 75 octets.
- `GET /api/public/appointments/manage/ics` returns the same file. It needs the manage token (`X-Booking-Token`).
- The confirmation and manage-booking pages have "Google Calendar" and "Outlook" links. These open the customer's own
  calendar with the event filled in. They also have "Apple Calendar (.ics file)", which downloads the file through the
  manage token. The page never says the booking "was added": only the customer can save it.

A downloaded or attached `.ics` is a copy the customer imports; it is not synced. Only the business calendar (above)
is synced by the server.

## Environment variables

| Variable | Meaning |
|---|---|
| `NOTIFICATIONS_PROVIDER_MODE` | `mock` or `live`. Default: `live` in production, `mock` otherwise. Leave unset in development and staging |
| `PUBLIC_API_URL` | Public https address of the API, for example `https://api.example.com`. Needed for Twilio delivery reports and signature checks, and shown as the webhook addresses to enter at Twilio and Meta |

Provider credentials are entered per business in the app, not in `.env`. They are stored encrypted (AES-256-GCM, with
a key derived from `JWT_SECRET` and bound to the business and channel), never returned (only the last four characters
of secrets are shown), and never logged. Changing `JWT_SECRET` makes stored provider credentials unreadable: they
must be entered again.

## Security

- Settings, connections and recipients need `settings:write`. Staff preferences need `staff:manage`. Consent needs
  `customers:read`/`customers:write`. Delivery history needs `appointments:read`, or `appointments:read_own` for a
  staff member's own bookings. Retry needs `emails:send`. Every query is scoped to the business.
- Webhooks are mounted before the JSON body parser, so signatures are checked over the raw body. Unsigned or
  wrongly signed callbacks get 403 and change nothing.
- Errors stored and shown are passed through the same redaction as email errors: no tokens, passwords or URLs with
  credentials.

## What is verified and what is not

| Feature | Status |
|---|---|
| Fan-out, consent, contact checks, retries, backoff, `unknown`, restart recovery, concurrency, reminders, lifecycle, reassignment, tenant isolation, permissions | IMPLEMENTED — MOCK VERIFIED (server tests) |
| Twilio and Meta request building and error mapping | IMPLEMENTED — MOCK VERIFIED (stand-in HTTP clients in tests; no request reached a provider) |
| Twilio and Meta webhook signatures, duplicates, forward-only status, STOP | IMPLEMENTED — MOCK VERIFIED |
| Google and Graph create / update / cancel, idempotent create | IMPLEMENTED — MOCK VERIFIED |
| `.ics` file, "Add to calendar" links | PASS — VERIFIED LOCALLY |
| Live SMS, WhatsApp, Google or Outlook | BLOCKED — EXTERNAL AUTHORIZATION REQUIRED (accounts, credentials, DLT registration, approved templates, OAuth apps) |

Before the first live use, on staging:
1. Send one message per channel to a number you own.
2. Check the delivery report arrives and verifies.
3. Reply STOP and check consent is withdrawn.
4. Book, move and cancel against a test calendar.
5. Check that each change updates one event.
