# Integrations — Guide

Integrations (`/settings/integrations`) connects WorkEasy360 Booking to other systems. It is **Powered by WorkEasy Connect**, one shared connection service for all WorkEasy360 products: credentials, signatures and retries are handled by Connect. Only the owner can open it.

## Available integrations

Outgoing webhooks are available now: Booking sends appointment events to your own https address. **Ready-made Connectors** for Google Calendar, Google Sheets, Pabbly, Zoom and Zapier are **Coming Soon**; until then a compatible webhook can be used. Incoming API actions (create, reschedule or cancel an appointment) are enabled through WorkEasy Connect once tested.

## Sending booking events to a webhook

1. Go to **Settings → Integrations** (`/settings/integrations`).
2. Under **Incoming / Outgoing Webhooks & API**, enter the **Destination address (https)**.
3. Under **Events**, tick **Appointment Created**, **Appointment Rescheduled** or **Appointment Cancelled / Completed / No-show**.
4. Click **Add destination**.
5. Copy the **Signing secret — shown only once** and keep it safe.
6. Click **Send test** to check that the destination receives events.

Check the X-WorkEasy360-Signature header with the signing secret (HMAC-SHA256). Click **Remove** to stop sending to a destination.

## What is sent to a webhook

**Field Mapping & Destination** shows what Booking sends by default: the event ID, type, version and time; the organization reference; the appointment reference and status; the service and provider; and the appointment date, time and timezone. Internal notes, secure manage-booking links and tokens, and customer contact details (unless mapped) are never included by default.

## Checking webhook deliveries

**Transfer Activity** lists recent transfers as Delivered, Failed, Retrying or Pending. Temporary failures are retried automatically. Click the refresh button to update the list.

## Connections

**Connections** lists the authorized organization connections Booking reuses, such as the WhatsApp and SMS connections, with their status (Connected, Not verified, Error or Not connected). They are added and managed in WorkEasy Connect.

## Google Calendar, Google Sheets, Zoom and Zapier

Ready-made connectors for Google Calendar, Google Sheets, Pabbly, Zoom (video meetings) and Zapier are coming soon and are not available yet. Appointments are not synced to Google Calendar or Outlook automatically. Customers can add their own booking to Google Calendar, Outlook or Apple Calendar from the confirmation page. To send events to another app now, use a webhook.
