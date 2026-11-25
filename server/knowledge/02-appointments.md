# Appointments — Guide

Appointments (`/appointments`) is the first screen after you sign in. It shows today's figures, the appointment list, your booking link and quick actions. Owners and managers see every appointment; staff see only their own.

## The Appointments screen

- **Figures** at the top: Today's Appointments (compared with the same day last week), Upcoming, Completed this week, Cancelled this week and Total Customers.
- **List** with the tabs **Today**, **Upcoming** and **Past**. The arrows and the date button show another day. The search button finds appointments by customer name or phone.
- **Status filter**: click the **Status** column heading to show only Scheduled, Completed, Cancelled or No-show appointments.
- **Booking Link** card: copy your link or click **Preview Booking Page**.
- **Quick Actions**: Create New Appointment, Manage Availability, View Customers and Booking Settings.
- **List** and **Calendar** buttons at the top switch between the list and the calendar view.

## Creating an appointment

1. On Appointments, click **New Appointment** (`/appointments/new`).
2. In **Customer**, search by name, phone or email and choose the customer, or click **New customer** to add one.
3. In **Service and time**, choose the **Service** and, when more than one person offers it, the **Staff** member.
4. Choose the **Date**. Only free times are listed under **Available times**.
5. Click a time. If the day is full, click **Try next day**.
6. Optionally write an **Internal note**. It is never shown to the customer.
7. Check the **Review and save** summary and click **Save Appointment**.

The new appointment is Scheduled. The customer gets a booking confirmation by email when they have an email address, and by SMS or WhatsApp when those channels are on.

## Viewing the calendar

The **Calendar** view (`/appointments?view=calendar`) shows appointments by **Day** or **Week** (Day only on phones). Use the arrows to move, **Today** to come back, and click an appointment to open it. Click an empty hour to start a new appointment at that time. There is no separate Calendar menu: the calendar is part of Appointments.

## Rescheduling an appointment

1. Open the appointment from the list or the calendar.
2. Click **Reschedule**.
3. Choose a new **Date** and click one of the **Available times**.
4. Click **Confirm New Time**.

The same appointment moves to the new time and keeps its booking reference. The customer gets a reschedule update and the reminder is replaced. Only Scheduled appointments can be rescheduled, and never to a date in the past.

## Cancelling an appointment

1. Open the appointment.
2. Click **Cancel**.
3. In the **Cancel appointment?** window, click **Cancel Appointment**. Click **Keep It** to leave it as it is.

The time becomes free again, the reminder stops and the customer gets a cancellation update. The appointment stays in the history as Cancelled; appointments are never deleted.

## Editing an appointment

1. Open the appointment and click **Edit**.
2. Change the staff member, date, time or internal note.
3. Click **Save Changes**.

The customer and the service of an existing appointment cannot be changed. To book a different service, cancel the appointment and create a new one.

## Marking an appointment completed or no-show

1. Open the appointment after its start time.
2. Click **Complete** when the customer came, or **Mark No-show** when they did not.

Complete and Mark No-show become available after the start time, and only for Scheduled appointments.

## Completing several appointments at once

1. On Appointments, tick the appointments in the list.
2. At the bottom, click **Complete** or **Mark No-show**. The number in brackets shows how many can be updated.
3. Click **Clear** to untick them.

Only Scheduled appointments whose start time has passed are updated.

## Filtering appointments by status or searching

1. On Appointments, choose the **Today**, **Upcoming** or **Past** tab.
2. Click the **Status** column heading and choose Scheduled, Completed, Cancelled or No-show.
3. Click the search button and type a customer name, phone number or booking reference.

## Adding an internal note to an appointment

1. Open the appointment.
2. Under **Internal note**, write the note.
3. Click **Save note**.

The note is private: it is never shown to the customer or included in messages.

## Appointment statuses

- **Scheduled**: booked and coming up (every new appointment starts here).
- **Completed**: the appointment took place.
- **Cancelled**: cancelled by the business or by the customer; the time is free again.
- **No-show**: the customer did not come.

Only Scheduled appointments can be edited, rescheduled or cancelled.

## The appointment details page

Each appointment shows its date, time, service, staff member, customer, booking reference (for example WE-1A2B3C4D), timezone and location. It also shows:

- **Internal note**: write a private note and click **Save note**. It is never shown to the customer or included in messages.
- **Customer Emails**: which booking emails were sent, with a button to resend the confirmation or the cancellation.
- **Notifications**: SMS and WhatsApp messages and their delivery, with **Retry** for failed ones.
- **History**: who created, moved or changed the appointment and when. It cannot be edited.

## Double bookings and past times

A staff member cannot have two appointments at the same time, and times outside working hours, breaks and blocked dates are never offered. Appointments cannot be created in the past. If a time was taken while you were choosing, the message **That time slot is no longer available** appears: choose another time.
