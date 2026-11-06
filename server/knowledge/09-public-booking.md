# Public Booking — Customer Guide

## What is public booking?

Public booking allows your customers to book appointments online without needing a WorkEasy360 account. Customers visit a booking page URL you share with them and complete a step-by-step booking wizard.

## How customers book an appointment (6 steps)

### Step 1: Select a Service
- The booking page shows all available services.
- Each service card shows: name, category, description, duration, location, and price.
- The customer taps/clicks a service to select it.
- A service must be selected to continue.

### Step 2: Choose a Provider (Staff Member)
- Shows "Any available staff" option plus individual staff member cards.
- Each staff card shows: name, title, and available days of the week.
- If only one staff member is available for the service, this step is automatically skipped.

### Step 3: Select a Date
- An interactive calendar shows the current month.
- Past dates are greyed out and cannot be selected.
- Today is highlighted with a ring.
- Click a date to select it.

### Step 4: Select a Time
- Shows all available time slots for the selected date, service, and staff.
- Slots are grouped into Morning (before 12:00) and Afternoon (12:00 and later).
- Available slots are shown in green; unavailable slots are greyed out as "Unavailable".
- Click a slot to select it.

### Step 5: Your Information
- **Full Name** (required)
- **Email Address** (required)
- **Phone Number** (required)
- Any custom questions set up in the booking page form fields
- A booking summary is shown on the right side of the screen.

### Step 6: Review & Confirm
- Shows a full summary of the booking: service, duration, date, time, provider, location, price, name, email.
- The cancellation policy is shown here if the service has one.
- Click **Confirm Booking** to complete the booking.

## After booking

The customer is taken to the confirmation page which shows:
- The **Booking Reference** (e.g., WE-ABC12345) — they should save this
- Appointment details (service, duration, date, time, provider, location, price)
- Links to add to Google Calendar, Apple Calendar, or Outlook (calendar integration stubs)
- A link to manage the booking
- A link to book another appointment

## Managing an existing booking

Customers can manage their booking at `/book/:slug/manage`.

1. Go to the manage page.
2. Enter the **Booking Reference** (format: WE-XXXXXXXX, e.g., WE-8328PTT8).
3. Click **Find My Booking**.

If found, the customer can:
- **Reschedule** — pick a new date and time (only for scheduled or confirmed appointments)
- **Cancel** — cancel the appointment (only for scheduled or confirmed appointments)

### Cancel booking
1. Click **Cancel Booking**.
2. Confirm in the modal.
3. The appointment status changes to "cancelled".

### Reschedule booking
1. Click **Reschedule**.
2. Pick a new date from the calendar.
3. Pick a new time slot.
4. Confirm.

## Booking validation and errors

| Error | Cause |
|---|---|
| "Select a service to continue." | Customer is on step 1 and hasn't chosen a service |
| "Select a date to continue." | No date selected on step 3 |
| "Select a time slot to continue." | No time slot selected on step 4 |
| "Enter your name to continue." | Name field empty on step 5 |
| "Enter your email to continue." | Email field empty on step 5 |
| "Enter your phone number to continue." | Phone field empty on step 5 |
| "That time slot is no longer available" | Someone else booked the same slot while the customer was completing the form |
| "Booking is already cancelled" | Trying to cancel an already-cancelled booking |
| "Completed bookings cannot be cancelled" | Trying to cancel a completed appointment |
| "No booking found with that reference." | Incorrect booking reference format or booking doesn't exist |

## Business rules for public booking

- Only active services are shown
- Only active staff members are shown as providers
- Past dates cannot be selected (calendar blocks them)
- Time slot availability is verified on the server when the booking is submitted
- If the slot becomes unavailable between steps 4 and 6, the booking is rejected with a 409 error

## How customers are handled

When a customer completes a booking:
- If no customer record exists with their email, a new customer is created automatically.
- If a customer with that email already exists in your database, the existing record is updated with the new booking count.

This means your customer list grows automatically as new people book.

## Booking confirmation reference format

All booking references follow the format: **WE-XXXXXXXX** where X is an uppercase letter or number. Examples: WE-ABC12345, WE-8328PTT8.

## Public API endpoints (no authentication required)

| Action | Method | URL |
|---|---|---|
| Get booking page info | GET | /api/public/pages/:slug |
| Get staff for a service | GET | /api/public/services/:id/staff |
| Get available slots | GET | /api/public/availability |
| Submit booking | POST | /api/public/book |
| Lookup booking by ref | GET | /api/public/appointments/:ref |
| Cancel booking | POST | /api/public/appointments/:ref/cancel |
