# Scheduling rules: hours, breaks, time off, closures and time zones

Working hours, saved business hours, breaks, time off and closures are checked in one place
(`server/src/services/schedule.ts`) for every path: the times a public booking page offers, the times the New
Appointment form offers, the times the assistant lists, and every booking or reschedule the server accepts (public,
dashboard and assistant). Dashboard and assistant bookings are accepted only at the start times public booking would
offer (`staffSlotProblem` in `server/src/services/bookability.ts`); only the customer-facing booking rules (rule 7)
are left out for them.

## What makes a time bookable

A start time can be booked for a staff member when all of these hold:

1. The staff member is active and assigned to the service.
2. The time falls inside the staff member's working hours for that weekday.
3. If the business has saved its own hours (Settings > Working Hours), the time also falls inside them. A day the
   business has switched off is closed for everyone. While a business has never saved hours, staff hours alone apply.
4. It does not overlap a weekly break, either the staff member's own or one for the whole business.
5. It does not fall in the staff member's time off or a business closure. Whole days block the day; part-day periods
   block those hours.
6. It does not overlap another active appointment of the staff member (cancelled and no-show appointments do not
   count), and the booked service's buffer before and after stays clear of them: the gap kept next to an existing
   appointment is the service's buffer on that side plus its buffer on the other, using the booked service's buffers.
   Start times follow a 30-minute grid from the start of the day's window plus the buffer before, and the whole
   appointment with its buffers must fit inside the window. This applies to every booking path: public pages, the
   New Appointment form, dashboard reschedules (the Reschedule page offers only these times), the assistant, and
   direct API calls. Moving an appointment or bringing back a cancelled or no-show one is checked the same way; edits
   that leave an active appointment where it is (status, notes) are not, so appointments saved before these rules
   stay editable. New bookings also need an active service.
7. Public bookings also respect the booking rules: the business's minimum notice, advance window and same-day
   setting, combined with each service's own minimum notice and maximum advance (30 days by default); the stricter
   value wins. Public pages never offer a time that has already passed. Dashboard and assistant bookings skip these
   customer-facing rules (as before) and may use earlier times today, but not past dates; "today" is the business's
   date in its time zone.

Workspace working hours and time zones, and resources (availability rules, capacity) are saved but do not affect
bookable times; resources are not protected against double booking.

"Any available staff" offers a time when at least one eligible staff member is free then. The booking goes to the
first such staff member alphabetically. A service with no active, assigned staff is not shown on public pages and
cannot be booked.

Existing appointments are never moved or cancelled by any of these rules. Adding time off over existing appointments
reports them (see below) so the business can contact the customers.

## Managing time off, closures and breaks

The approved UI has no screens for these yet; the Staff profile still says "Time-off tracking is not implemented yet".
Until screens are approved, the API below is the way to manage them. All endpoints need a signed-in session (cookie
plus `X-CSRF-Token`, or a Bearer token).

| Request | Who | What |
|---|---|---|
| `GET /api/time-off?staffId=&from=&to=` | admin, manager | Time off and closures, optionally for one staff member and a date range |
| `POST /api/time-off` | admin | Body: `{ staffId?, startDate, endDate, startTime?, endTime?, reason? }`. Without `staffId` it closes the whole business. Without times it blocks whole days. Returns `conflicts`: active appointments inside the period, left unchanged |
| `DELETE /api/time-off/:id` | admin | Removes a period |
| `GET /api/time-off/breaks?staffId=` | admin, manager | Weekly breaks |
| `POST /api/time-off/breaks` | admin | Body: `{ staffId?, weekday, startTime, endTime, label? }`. Without `staffId` it is a break for the whole business |
| `DELETE /api/time-off/breaks/:id` | admin | Removes a break |

Staff time off and staff breaks need the staff management permission (admins). Business closures and business breaks
need the business settings permission (admins). Managers can read both so they can see why a time is unavailable.
Staff sign-ins cannot read or change them. Each business only ever sees its own records.

Dates are business-local `YYYY-MM-DD` (inclusive; the end date at most 366 days after the start date); times are
`HH:MM`, 24-hour (00:00–23:59). Weekdays are `monday` … `sunday`. A reason is at most 200 characters and a break label
at most 100. Unknown fields are refused. Reasons are shown to the business's own admins and managers only. Customers
just see that a time is not available.

## Time zones

- Appointments are stored as business-local date and times plus the zone they were recorded in.
- A new business starts in the time zone of the browser that signed it up; a browser in Asia/Kolkata (or the older
  Asia/Calcutta) gives Asia/Kolkata. API callers may also send a country (India gives Asia/Kolkata). Without a valid
  zone the business starts in America/New_York (see `server/src/services/business-locale.ts`). The zone can be changed
  in Settings > Language & Region.
- **Changing a business's zone keeps every appointment at the same instant.** Each appointment recorded in another
  zone is re-expressed in the new one: 10:00 in New York becomes 20:30 in Kolkata in January and 19:30 in July.
  Duration, staff and status are unchanged; an appointment that now runs past midnight is stored as 24:xx, like new
  ones. The change and the re-expression happen in one transaction; if two appointments of one staff member would sit
  at the same moment, nothing changes and the request is refused. Customers are not emailed: their appointment did
  not move.
- Working hours, breaks, time off and closures are local wall-clock times, so after a zone change they apply in the
  new zone.
- Daylight-saving days offer the same wall-clock times as any other day. Converting a time that a clock change skips
  moves it forward by the length of the jump (02:30 on the spring-forward night in New York becomes 03:30); a
  repeated hour resolves to its first occurrence (`server/src/services/zoned-time.ts`).
- Booking emails show times in the zone the appointment is recorded in, which after any change is the business's
  zone.

Tests: `server/src/tests/scheduling.test.ts` and `server/src/tests/booking-fixes.test.ts`.
