# Troubleshooting — Common Issues

## Login and authentication issues

### "Invalid email or password"
- Check that you're using the correct email address
- Check that Caps Lock is not on
- Passwords are case-sensitive
- If you've forgotten your password, use **Forgot password?** on the sign-in page; the reset link is emailed, works once and expires after 60 minutes

### No confirmation or password-reset email
- Check the spam folder, and use the newest email: requesting a new link replaces the previous one
- Request a new link from the "Check your email" page (sign-up) or from **Forgot password?** (sign-in); requests are limited to a few per hour per address
- If the page says "Email is not set up on this server", the server administrator must configure email

### "Missing or invalid authorization header" (API error)
- Your session may have expired; refresh the page and log in again
- Clear browser storage and log in again

### Can't access dashboard after login
- Make sure you have an active account with the correct role
- Contact your admin to verify your account status

---

## Appointment issues

### "This time slot is no longer available"
Someone else booked the same slot while you were filling out the form. Go back and select a different time.

### "Cannot create appointments in the past"
The date you selected is before today. Select today or a future date.

### "Cannot reschedule to a date in the past"
The new date you selected for rescheduling is in the past. Choose a future date.

### Appointment not showing in calendar
- Check the date filter in the calendar view
- Verify the appointment status (cancelled appointments may be hidden)
- Check that the staff member assigned to the appointment is not filtered out

### Service not available when creating appointment
- Check that the service is set to Active
- Verify that the service has staff members assigned to it

### Staff not available as an option
- The staff member may not be assigned to that service
- Check that the staff member is Active

---

## Customer issues

### "A customer with that email already exists"
A customer with that email is already in your database. Search for them in the Customers section and update their existing record.

### Customer not found in dropdown
Use the search function in the customers list, or search within the appointment creation form. If the customer doesn't exist, use "Add new customer".

---

## Booking page issues

### Customers see "Page not found" when visiting booking URL
The booking page must be published. Go to Booking Pages, find the page, and toggle it to Published.

### "A booking page with that slug already exists"
Choose a different URL slug. Every booking page needs a unique slug.

### Slug invalid characters
Slugs can only contain lowercase letters (a-z), numbers (0-9), and hyphens (-). No spaces, uppercase, or special characters.

### No services showing on booking page
Ensure the booking page has services assigned to it, and those services are marked Active.

---

## Services issues

### Service doesn't appear in appointment creation
Check that the service is set to Active.

### Wrong price or duration in appointment
The price and duration are taken from the service configuration. Update the service settings to change these values.

---

## Settings issues

### Two-factor authentication toggle doesn't work
2FA is not yet available in the current version. The toggle shows: "Two-factor authentication is not yet available."

### Can't change role permissions
Role permissions are managed at the organization level and cannot be changed from the Settings screen in the current version. Contact support.

### Language setting doesn't persist after refresh
The language preference is stored in the browser only (not saved to the server). This is a known limitation.

---

## Reports issues

### Revenue shows as $0
Revenue is counted only from appointments with status "confirmed" or "completed". Make sure to update appointment statuses after completion.

### Charts showing no data
Try selecting a wider date range (Last year). If no appointments exist in the system, reports will be empty.

### Export button shows a message instead of downloading
The export feature requires an export integration. Currently shows: "Connect an export integration in Settings to download reports." Full export is a planned feature.

---

## Calendar issues

### Appointment not showing in calendar
- Check the date/view in the calendar
- Verify the appointment status (filter settings may hide certain statuses)
- Make sure the appointment was successfully created (check the Appointments list)

---

## General troubleshooting steps

1. **Refresh the page** — many issues resolve with a simple page refresh
2. **Clear cache** — clear browser cache and cookies, then log in again
3. **Check network** — ensure you have a stable internet connection
4. **Try a different browser** — some issues are browser-specific
5. **Check the error message** — most errors include a specific message explaining what went wrong
6. **Contact support** — if none of the above helps, contact your system administrator
