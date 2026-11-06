# Frequently Asked Questions (FAQ)

## General

**Q: What is WorkEasy360?**
A: WorkEasy360 is a web-based appointment scheduling and business management platform. It helps service businesses manage bookings, staff, services, and customers.

**Q: Do customers need to create an account to book?**
A: No. Customers can book appointments through public booking pages without creating an account. They just need to provide their name, email, and phone number.

**Q: Is WorkEasy360 available as a mobile app?**
A: WorkEasy360 runs in any modern web browser on desktop and mobile. There is no separate app to install.

---

## Appointments

**Q: How do I create an appointment?**
A: Go to Appointments → New Appointment (`/appointments/new`). Select the service, staff member, date, time, and customer, then click Create Appointment.

**Q: Can I book an appointment in the past?**
A: No. The system prevents creating appointments in the past. The date field minimum is today's date.

**Q: How do I reschedule an appointment?**
A: Open the appointment detail page, click Reschedule, and select a new date and time.

**Q: What booking reference format does WorkEasy360 use?**
A: All booking references start with WE- followed by 8 uppercase alphanumeric characters (e.g., WE-ABC12345, WE-8328PTT8).

**Q: What happens when two people try to book the same time slot?**
A: The system uses a transaction with a conflict check. Only one booking will succeed. The second person will see "This time slot is no longer available."

**Q: How do I cancel an appointment?**
A: Open the appointment detail page and click Cancel. You can also cancel from the public manage page by entering the booking reference.

**Q: What appointment statuses are available?**
A: Scheduled, Confirmed, Completed, Cancelled, No-show.

---

## Services

**Q: How do I add a new service?**
A: Go to Services → New Service (`/services/new`), fill in the name, duration, price, and other details, then click Create Service.

**Q: How do I set the price for a service?**
A: In the service form, enter the price in the Price field (minimum 0 for free services). The currency can be set to USD, EUR, GBP, or CAD.

**Q: What is the difference between buffer time and duration?**
A: Duration is the length of the appointment itself. Buffer Before and After add extra reserved time before/after the appointment that is not booked for anything else — used for preparation or cleanup.

**Q: Can I offer free services?**
A: Yes. Set the price to 0.

**Q: How do I add custom questions to a service?**
A: In the service form, scroll to Custom Questions and click Add Field. Set the label, type (text, dropdown, etc.), and whether it is required.

---

## Staff

**Q: How do I add a new staff member?**
A: Go to Staff → New Staff (`/staff/new`), fill in the name, email, working hours, and other details, then click Create Staff.

**Q: Can a staff member have different working hours than the business?**
A: Yes. Each staff member has their own working hours schedule. Set them in the Working Hours section of the staff form. Once the business has saved its own hours (Settings → Working Hours), staff can only be booked when both are open.

**Q: How do I assign a staff member to a service?**
A: Either edit the staff member and check the services, or edit the service and check the staff member — both achieve the same result.

---

## Booking Pages

**Q: How do I create a public booking link for customers?**
A: Go to Booking Pages → New Booking Page, set a URL slug (e.g., "my-clinic"), configure the page, and publish it. The link will be `/book/your-slug`.

**Q: My customers see "Page not found" on the booking page.**
A: The booking page must be published. Go to Booking Pages, find the page, and enable the Published toggle.

**Q: Can I have multiple booking pages?**
A: Yes. You can create as many booking pages as needed, each with its own unique slug and configuration.

**Q: Can I embed the booking page on my website?**
A: You can link to the booking page URL from your website. Embedding via iframe is possible but depends on your setup.

---

## Settings

**Q: How do I change my password?**
A: Go to Settings → Security (`/settings/security`), enter your current password and new password in the Change Password section.

**Q: I forgot my password. How do I reset it?**
A: On the sign-in page, click **Forgot password?** below the password field and enter your email address. If the address has an account that can sign in, an email arrives with a link to choose a new password. The link works once and expires after 60 minutes; asking again replaces the earlier link. Saving the new password signs you out on every device, and you then sign in with the new password. Owners, managers and staff all use this.

**Q: Is two-factor authentication available?**
A: Two-factor authentication is not yet available in the current version.

**Q: Can I change role permissions?**
A: Role permissions cannot be changed from the Settings screen. Contact support to modify them.

**Q: Where do I set my business's opening hours?**
A: Go to Settings → Working Hours (`/settings/hours`), set the days and times you are open, and click Save Changes. Saved business hours limit every staff member's bookable times.

---

## Reports

**Q: How is revenue calculated?**
A: Revenue is the sum of prices from appointments with status "Confirmed" or "Completed" only. Scheduled, Cancelled, and No-show appointments are not included.

**Q: Can I export report data?**
A: Report export requires an export integration. The export feature is in development.

---

## Public Booking

**Q: How does a customer look up their existing booking?**
A: Go to `/book/:slug/manage`, enter the booking reference (WE-XXXXXXXX format), and click Find My Booking.

**Q: Can customers cancel their own appointments?**
A: Yes, from the manage booking page. They can cancel appointments that are in Scheduled or Confirmed status. Completed appointments cannot be cancelled.

**Q: What if a customer books but doesn't have an account?**
A: Customers don't need accounts. Their information is stored as a customer record in your database automatically when they book.

---

## Technical

**Q: What browsers are supported?**
A: Any modern browser — Chrome, Firefox, Safari, Edge. Internet Explorer is not supported.

**Q: Is there an API?**
A: Yes. WorkEasy360 has a REST API at `/api/`. See the API documentation for endpoint details.

**Q: What is the session/token expiry?**
A: Login tokens expire after 7 days by default. Log in again after expiry.
