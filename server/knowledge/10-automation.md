# Internal Automation — Guide

Internal Automation (`/settings/automation`) shows the built-in rules that run on every booking. They are read-only here: switch the channels and the reminder in **Settings → Notifications** with **Manage in Notifications**. There is no rule editor or workflow builder.

## The built-in rules

- **Booking confirmation**: when an appointment is booked.
- **Reschedule update**: when an appointment moves; its pending reminder is replaced.
- **Cancellation update**: when an appointment is cancelled; its pending reminder stops.
- **Reminder (optional)**: 24 hours before the appointment, skipped when booked later than that.

Each rule shows the channels it is sent by, or **No channel is on**. Appointments are always saved first; a failed message never undoes one.

## Changing what is sent automatically

1. Go to **Settings → Internal Automation** (`/settings/automation`).
2. Click **Manage in Notifications**.
3. Switch the channels or **Reminder 24 hours before** on or off.
4. Click **Save Changes**.

## Connecting other apps

Sending booking events to other systems is done in **Settings → Integrations** through WorkEasy Connect, not in Internal Automation.
