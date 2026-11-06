# Integrations — Guide

## What are integrations?

Integrations connect WorkEasy360 with outside services: webhooks and Zapier, text messages (SMS) and WhatsApp, and
Google Calendar or Outlook. Online payments (Stripe, PayPal, Razorpay), video meetings (Zoom, Google Meet) and
Mailchimp list sync are not implemented yet: customers pay the business directly. Go to **Integrations**
(`/integrations`) from the left sidebar. Only people who can change business settings can connect or remove them.

## What can be connected

- **Webhooks and Zapier**: booking changes are sent to your own address or a Zapier "Catch Hook", signed and retried.
- **Text messages and WhatsApp**: SMS through your own Twilio account and WhatsApp through the WhatsApp Business
  Platform. Enter the provider's credentials, then use **Verify**. A channel is "Connected" only after the provider
  accepts the credentials. Credentials are stored encrypted and never shown again.
- **Google Calendar and Outlook**: connect the account with **Connect** (when the server administrator has set this
  up), then choose it as the business calendar on the Notifications page. Bookings are then created, moved and
  cancelled in that calendar.

On a development server, text messages, WhatsApp and calendar updates go to a built-in stand-in marked "development
stand-in": nothing is sent to anyone and no real calendar is changed.

## What is not implemented yet

- Customers cannot pay online (Stripe, PayPal, Razorpay). The booking page tells customers to pay the business directly.
- No video meeting links are created (Zoom, Google Meet).
- Mailchimp list sync is not implemented yet.
- Busy times from a connected calendar are not imported (no two-way calendar sync).

## Calendar buttons on the booking confirmation

After booking, customers see **Add to calendar** with Google Calendar, Outlook and Apple Calendar (.ics file). These
open the customer's own calendar with the booking filled in, or download the calendar file; the customer saves it
there. The booking emails also include the calendar file.

## Report export

From the Reports page, the **Export** button shows: "Connect an export integration in Settings to download reports."
Report export is a planned feature.
