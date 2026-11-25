# Troubleshooting — Guide

## Why is a time slot not available?

A time is offered only when it fits every rule. Check these in order:

- **Business hours**: the business is closed that day or at that time (Availability, Business hours).
- **Staff working hours**: the staff member does not work then. Their hours must also fall within the business hours.
- **Breaks**: the time falls in a gap between two time ranges.
- **Time off and closures**: a date exception blocks the day or the time period, for the staff member or the whole business.
- **Other appointments**: the staff member is already booked, or the whole service does not fit before the next appointment or the end of the day.
- **The past and the booking window**: past times are never offered, and the booking link offers days up to 30 days ahead.

## No times show on the booking link

Check that **Accept online bookings** is on in **Settings → Public Booking**, that the service is **Active** in **Settings → Services**, that at least one active team member has it under **Assigned services** in **Settings → Team**, and that their working hours in **Availability** include free time. A service nobody offers is not shown to customers.

## Customers see Booking page not found

Online booking is switched off, or the link was copied incompletely. Switch on **Accept online bookings** in **Settings → Public Booking** and copy the link again from the **Booking Link** card.

## Error: That time slot is no longer available

Someone booked the time while you were choosing. Choose another free time; the list of times updates.

## Error: Cannot create appointments in the past

The date or time has already passed in the business timezone. Choose a later time. Check the **Timezone** in **Settings → Business Details** if times look shifted.

## Error: That time is outside the staff member's working hours

The chosen time is outside that person's hours, or outside business hours, on that day. Check **Availability**, or choose a time from the **Available times** list.

## Complete or Mark No-show is greyed out

They become available after the appointment's start time, and only for Scheduled appointments.

## Edit, Reschedule or Cancel is greyed out

Only Scheduled appointments can be changed. Completed, Cancelled and No-show appointments are kept as they are.

## A customer did not get the confirmation email

Open the appointment and look at **Customer Emails**. The customer may have no email address, email may be switched off in **Settings → Notifications**, or the address may be wrong: correct it with **Edit Contact Details** on the customer and resend the confirmation from the appointment. Ask the customer to check their spam folder.

## SMS or WhatsApp messages are not sent

The channel must show **Connected** and be switched on in **Settings → Notifications**, the customer needs a valid phone number and must have agreed to that channel, and the Consumption Wallet needs enough balance. The appointment's **Notifications** card shows why a message was not sent.

## A staff member cannot sign in

Check **Login access** in **Settings → Team**: the status must be **Can log in**. If it says **Invited**, they have not accepted yet; send a new invitation. If they lost their authenticator app, click **Reset two-factor sign-in**. Inactive team members cannot be invited.

## I cannot see a menu or a Settings section

Your role decides what you see. Staff see only their own appointments and availability; Settings sections such as Team and Business Details need the owner. See Roles and Permissions.

## The password reset email did not arrive

Check the spam folder and use the newest email; each request replaces the previous link, which works once and expires after 60 minutes.
