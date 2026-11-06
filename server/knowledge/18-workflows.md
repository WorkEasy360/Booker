# Cross-Feature Workflows — Step-by-Step Guides

## Workflow 1: Complete business setup from scratch

This workflow takes a new WorkEasy360 account from empty to ready to accept bookings.

**Estimated time: 20-30 minutes**

1. **Sign up** at `/signup` with your name, email, company name, and password, confirm the link emailed to you, then sign in.
2. Go to **Settings → Business** (`/settings/business`) and fill in your business name, email, phone, website, and address. Save.
3. Go to **Settings → Hours** (`/settings/hours`) and configure your operating days and hours. Save.
4. Go to **Settings → Booking** (`/settings/booking`) and set your minimum notice, advance booking window, and buffer times. Save.
5. Create your first **Workspace**: Go to **Workspaces → New Workspace** (`/workspaces/new`), enter the name and address. Save.
6. Create your **Services**: Go to **Services → New Service** (`/services/new`) for each service you offer. Fill in name, duration, price. Save.
7. Add **Staff**: Go to **Staff → New Staff** (`/staff/new`) for each team member. Set working hours and assign services. Save.
8. Create your **Booking Page**: Go to **Booking Pages → New Booking Page** (`/booking-pages/new`). Set a slug (e.g., "my-business"). Configure the page. Click **Create & Publish**.
9. **Share the link**: Give customers the URL — `https://yourapp.com/book/my-business`.

---

## Workflow 2: Accept your first online booking

Once setup is complete, customers can self-book:

1. Customer visits `/book/your-slug`
2. They select a service
3. They choose a staff member (or "Any available")
4. They pick a date and time
5. They enter their name, email, and phone
6. They review and confirm
7. They receive a booking reference (WE-XXXXXXXX)
8. The booking appears in your **Appointments** list and **Calendar**

---

## Workflow 3: Manually create an appointment for a customer

When a customer calls or requests booking by phone/email:

1. Go to **Appointments → New Appointment** (`/appointments/new`)
2. Select the **Service** from the dropdown
3. Select the **Staff Member** (filtered to staff assigned to the service)
4. Pick the **Date** (today or future)
5. Select the **Time Slot**
6. In the Customer field:
   - Search for the customer and select them, OR
   - Choose "Add new customer" and fill in their name and email
7. Optionally add notes or location details
8. Click **Create Appointment**
9. A booking reference (WE-XXXXXXXX) is generated

---

## Workflow 4: Manage a customer reschedule

When a customer requests to change their appointment time:

**If the customer is contacting you directly:**
1. Find the appointment in **Appointments** or **Calendar**
2. Open the appointment detail page
3. Click **Reschedule**
4. Select the new date and time
5. Confirm — the booking ref remains the same

**If the customer is self-managing:**
1. Customer visits `/book/:slug/manage`
2. They enter their booking reference
3. They click **Reschedule**
4. They select a new date and time
5. They confirm the change

---

## Workflow 5: Complete the day's appointments

At the end of each working day:

1. Go to **Calendar** (`/calendar`) and view today's appointments
2. For each appointment:
   - If the customer arrived and the service was delivered: update the status to **Completed**
   - If the customer did not show: update the status to **No-show**
3. Go to **Reports** (`/reports`) to see the day's revenue and completion rate

---

## Workflow 6: Add a new staff member and assign them to services

1. Go to **Staff → New Staff** (`/staff/new`)
2. Enter the staff member's Full Name and Email (required)
3. Set their working hours
4. In the **Workspaces** sidebar, check the workspaces where they work
5. In the **Services** sidebar, check the services they provide
6. Set the Status to **Active**
7. Click **Create Staff**
8. Verify: go to a service and confirm the new staff member appears in the staff assignment list

---

## Workflow 7: Create a service for a specific workspace only

1. Go to **Services → New Service** (`/services/new`)
2. Fill in the service name, duration, and price
3. In the **Workspaces** section, check only the workspace(s) where this service is available
4. In **Staff Assignment**, check the staff who provide this service
5. Click **Create Service**
6. Verify: the service should appear only when customers book through the associated workspace's booking page

---

## Workflow 8: Create separate booking pages for different locations

1. Create separate **Workspaces** for each location (if not already done)
2. Go to **Booking Pages → New Booking Page** (`/booking-pages/new`)
3. Set the **Type** to "business" or "service" as appropriate
4. Set a unique **Slug** per location (e.g., "downtown", "east-branch")
5. Configure the page for that location
6. Publish each page
7. Share the respective links with customers for each location

---

## Workflow 9: Handle a service with custom intake questions

1. Go to **Services** → edit (or create) the service
2. In the **Custom Questions** section, click **Add Field**
3. Enter the question label (e.g., "What is your main concern?")
4. Select the type: Short text, Long text, Dropdown, Checkbox, Email, or Phone
5. Toggle **Required** if the customer must answer
6. Save the service
7. When customers book this service, Step 5 of the booking wizard will include your custom question

---

## Workflow 10: Review and improve booking conversion

Use the Reports page to identify issues:

1. Go to **Reports** (`/reports`), set range to Last 30 days
2. Check **Cancellation Rate**: if above 20%, consider adjusting your cancellation policy
3. Check **No-show Rate**: if high, consider contacting customers before their appointments (automatic reminders are not available yet)
4. Check **Service Performance**: identify your most and least popular services
5. Check **Top Customers**: identify VIP customers and consider tagging them in the Customers section
6. Check **Staff Workload**: if one staff member is heavily overloaded, consider adding availability
