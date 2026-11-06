# Appointments — Complete Guide

## What are appointments?

Appointments are bookings that record a specific date, time, service, staff member, and customer. Every appointment has a unique booking reference starting with WE- (e.g., WE-ABC12345).

## Viewing appointments

Go to **Appointments** (`/appointments`) to see all appointments. You can filter by:
- **Date** — filter to a specific day
- **Staff** — filter by a staff member
- **Status** — filter by appointment status (scheduled, confirmed, completed, cancelled, no-show)
- **Customer** — filter by customer

Go to **Calendar** (`/calendar`) for a visual day/week/month view of all appointments.

## Appointment statuses

| Status | Meaning |
|---|---|
| scheduled | Appointment has been booked but not confirmed |
| confirmed | Appointment confirmed by the business |
| completed | Appointment took place |
| cancelled | Appointment was cancelled |
| no_show | Customer did not show up |

## Creating a new appointment (dashboard)

1. Go to **Appointments** → **New Appointment** (`/appointments/new`) or click the **+ New Appointment** button.
2. **Service & Staff card:**
   - Select a **Service** from the dropdown (shows active services with duration and price)
   - Select a **Staff Member** (options are filtered to staff assigned to the chosen service)
3. **Date & Time card:**
   - Pick a **Date** (cannot be in the past)
   - Choose a **Time Slot** (only the free start times for that staff member and date are shown)
   - The calculated end time is shown automatically based on service duration
4. **Customer card:**
   - Select an existing customer from the dropdown, OR
   - Choose **Add new customer** and fill in:
     - Full Name (required)
     - Email (required)
     - Phone (optional)
5. **Details card (optional):**
   - Location — auto-filled from service, can be changed
   - Customer-facing notes — visible to the customer in their confirmation
   - Internal notes — private notes for staff only
6. Click **Create Appointment**.

### Appointment creation errors
- "Please fill in service, staff, date, and time." — one of the required fields is missing
- "Appointments cannot be created in the past." — the selected date is before today
- "Please select or add a customer." — no customer selected
- "Please provide at least a name and email for the new customer." — new customer form incomplete

### Server-side business rules
- Date cannot be before today's date (server-enforced)
- The end time is always computed from the service duration — you cannot manually set it
- If the time slot is already taken by the same staff member, you get: "This time slot is no longer available. Please choose another time."
- Price, currency, and location are taken from the service record automatically

## Rescheduling an appointment

1. Open the appointment details page (`/appointments/:id`).
2. Click **Reschedule**.
3. Select a new date and time.
4. Confirm the reschedule.

Reschedule rules:
- Cannot reschedule to a date in the past
- Only the free start times for that date are offered: the same times a new booking could use (working hours,
  business hours, breaks, time off, closures, other appointments and the service's buffer times)

## Cancelling an appointment

1. Open the appointment.
2. Click **Cancel Appointment**.
3. Confirm cancellation.

## Checking available time slots, and why a time slot is not available

Available times appear in the **New Appointment** form (`/appointments/new`) after you choose a service, staff member and date, and on public booking pages. There is no separate availability screen. API clients can call `/api/appointments/availability` with `date` (YYYY-MM-DD), `serviceId` and `staffId`.

A time slot is not available when:
- it is outside the staff member's working hours, or the staff member does not work that day
- it is outside the business hours saved in Settings → Working Hours, or the business is closed that day
- it overlaps a weekly break, the staff member's time off, or a business closure
- it overlaps another appointment of the same staff member, including the service's buffer times
- for public bookings only: it is too soon (minimum notice), too far ahead (advance booking window), same-day booking is off, or the time has passed

## Appointment booking reference

Every appointment gets a unique booking reference formatted as **WE-XXXXXXXX** (e.g., WE-8328PTT8). Customers can use this reference to look up and manage their booking at `/book/:slug/manage`.

## Appointment fields (full list)

| Field | Description |
|---|---|
| Service | Which service is being provided |
| Staff | Which staff member will provide the service |
| Customer | Who the appointment is for |
| Date | The appointment date (YYYY-MM-DD) |
| Start Time | When the appointment begins (HH:MM) |
| End Time | Calculated automatically from service duration |
| Duration | Taken from the service's duration setting |
| Status | Current status (see status table above) |
| Location | Where the appointment takes place |
| Notes | Customer-visible notes |
| Internal Notes | Staff-only notes |
| Booking Reference | Unique ID starting with WE- |
| Price | Taken from the service price |
| Workspace | Optional location/branch assignment |

## Conflict detection

The system prevents double-booking a staff member. If you try to book a slot where the same staff member already has a non-cancelled appointment at the same date and overlapping time, the booking will be rejected with: "This time slot is no longer available."

Two appointments at exactly the same start time for different staff members are allowed.

## Finding an appointment by booking reference

From the public booking page: go to `/book/:slug/manage`, enter the booking reference (e.g., WE-ABC12345).

From the dashboard: use the search or filter in the Appointments list, or search by customer.

## Appointment API endpoints

| Action | Method | URL |
|---|---|---|
| List appointments | GET | /api/appointments |
| Get one appointment | GET | /api/appointments/:id |
| Create appointment | POST | /api/appointments |
| Update appointment | PUT | /api/appointments/:id |
| Delete appointment | DELETE | /api/appointments/:id |
| Check availability | GET | /api/appointments/availability |

All endpoints require authentication (Bearer token).
