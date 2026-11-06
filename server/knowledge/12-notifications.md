# Notifications — Guide

## What are notifications?

Notifications are the messages WorkEasy360 sends when a booking is made, moved, cancelled, confirmed or is coming up:
emails, text messages (SMS), WhatsApp messages and calendar updates. They go to the customer, the staff member the
booking is with, and anyone at the business you add as a business recipient. A booking is saved first; messages are
sent afterwards, so a provider problem never stops a booking.

## Accessing notifications

Go to **Notifications** (`/notifications`) from the left sidebar. Only people who can change business settings can
change these settings.

Note: You can also reach the notification settings from **Settings** → **Notifications** tab (`/settings/notifications`), which redirects you to the Notifications page.

## Booking emails to customers

These emails are always sent to the customer:
- **Booking confirmation** — after a booking is made online or by staff
- **Reschedule notice** — after the date or time changes
- **Cancellation notice** — after a booking is cancelled

Each email includes the booking reference, service, date, time, time zone, a link to manage the booking, and a
calendar file the customer can add to their calendar. Emails are only delivered when a server administrator has
configured email delivery (SMTP); the Notifications page shows whether it is configured.

## Reminders to customers

Turn on **Send reminder emails** under **Reminders to customers**, then choose the **Reminder times** (up to 4, for
example 1 day and 1 hour before). Text message (SMS) and WhatsApp reminders are switched on under **Who gets what**
and are sent only once that channel is connected on the Integrations page. A reminder is not sent late: if its time has already passed when the booking is made or moved, it is skipped. Reminders stop when a
booking is cancelled and move with the booking when it is rescheduled.

## Who gets what

The **Who gets what** table has a box for each event (booking confirmed, moved, cancelled, reminder, status changed)
and each channel (email, SMS, WhatsApp), for the customer and for the staff member. **Send staff alert emails** under
**Alerts to staff** is the same as the staff email boxes. Each staff member's own channels and events are set on their
profile under **Booking notifications**. **Business recipients** (for example the owner or front desk) get the
channels and events chosen for each of them.

## Text messages and WhatsApp

SMS and WhatsApp messages are sent only after the business connects a provider on the **Integrations** page: Twilio
for SMS, and the WhatsApp Business Platform for WhatsApp. Until a channel is connected, its messages are not sent and
are listed as "Not set up". Customers get them only if they agreed: the booking page asks (the boxes are not ticked
for them), staff can record a customer's agreement on the customer page, and a customer can reply STOP at any time.
On a development server, messages go to a built-in stand-in and nothing is sent to anyone.

## Business calendar

Under **Business calendar**, choose a connected Google Calendar or Outlook calendar. Each booking is then added to it,
updated when it moves (the same event, never a copy) and cancelled when it is cancelled. Connect the calendar account
first on the **Integrations** page.

## Checking what was sent

Open an appointment: the **Notifications** card lists every message and calendar update for that booking, with its
status. "Sent" means the provider accepted it; "Delivered" and "Read" appear only when the provider reports them.
**Retry** appears for failed messages and for ones whose outcome is unknown.

## Language and email texts

**Language for customers** sets English or Hindi for emails, text messages and WhatsApp messages. Under **Email
texts** you can change the subject and opening text of each booking email and preview it.
