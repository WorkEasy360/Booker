# Staff — Complete Guide

## What is a staff member in WorkEasy360?

A staff member is a team member who provides services and appears as a bookable provider. Each staff member has a name, email, role, working hours, and can be assigned to specific workspaces and services.

## Viewing staff

Go to **Staff** (`/staff`) to see all team members listed alphabetically. Each entry shows the staff member's avatar, name, title/role, and active/inactive status.

## Adding a new staff member

1. Go to **Staff** → **New Staff** (`/staff/new`) or click **+ New Staff**.
2. Fill in the form:

### Basic Information
- **Full Name** (required) — the staff member's display name
- **Email Address** (required, must be valid email format)
- **Phone Number** (optional)
- **Job Title** (optional) — e.g., "Senior Therapist", "Front Desk"
- **Role** (required) — Admin, Manager, or Staff
- **Bio** (optional) — description shown to customers on booking pages

### Avatar Color
- Choose from 6 preset colors — used for visual identification in the calendar

### Working Hours
- Set the days and times the staff member is available for appointments
- Toggle each day on/off, then set start and end times
- Default: Monday–Friday, 09:00–17:00

### Status (sidebar)
- **Active** — appears in booking pages and can receive appointments
- **Inactive** — hidden from customers, no new bookings accepted

### Workspaces (sidebar)
- Check which workspaces this staff member works at

### Services (sidebar)
- Check which services this staff member can provide

3. Click **Create Staff**.

### Staff creation validation errors
- "Name is required" — name field is empty
- "Email is required" — email field is empty
- "Enter a valid email address" — email is not a valid format

## Editing a staff member

1. Go to **Staff** (`/staff`).
2. Click on the staff member to open their profile.
3. Click **Edit Profile** or go to `/staff/:id/edit`.
4. Change any fields.
5. Click **Save Changes**.

## Staff roles

| Role | Description |
|---|---|
| Admin | Full access to all dashboard features |
| Manager | Manage appointments, staff, services; cannot change org settings |
| Staff | View own appointments and schedule only |

Note: The system has three backend roles (admin, manager, staff). "Owner" and "Viewer" shown in some UI screens are frontend-only display names and map to admin and staff respectively on the backend.

## Staff working hours

Each staff member has their own working hours, set in the staff form. The staff member's hours determine when customers and staff can book them. Only administrators can change them.

To change a staff member's working hours:
1. Go to **Staff** (`/staff`) and open the staff member.
2. Click **Edit Profile**.
3. In the staff form, scroll to **Working Hours**.
4. Toggle on each day the staff member works.
5. Set their start and end time for each active day.
6. Click **Save Changes**.

A day without hours is a day off for that staff member. If the business has saved its own hours (Settings → Working Hours), bookings must also fit inside those, and a day the business is closed is closed for everyone.

## Inviting a staff member to sign in

Adding a staff member does not give them a sign-in. To invite them (administrators only):
1. Go to **Staff** (`/staff`) and open the staff member's profile.
2. In the **Sign-in access** card, choose the **Sign-in role**: Staff (sees their own appointments) or Manager.
3. Click **Send invitation**.

The invitation is emailed to the staff member's address, and they choose their own password from the email. It works once and expires after 72 hours; **Send a new invitation** replaces it and **Cancel invitation** withdraws it. The staff member must be active, and invitations can only be delivered when email sending is configured. **Turn off sign-in** removes access again.

## Time off, breaks and closures

Staff time off, weekly breaks and whole-business closures are enforced when booking: those times are not offered to customers or staff. There is no screen to manage them yet (the staff profile still says time-off tracking is not implemented); an administrator can add and remove them through the server API (`/api/time-off`). Adding time off never moves or cancels existing appointments.

## Assigning staff to services

Staff must be assigned to a service to be bookable for that service:
- **Option A:** In the staff form, check the services under **Services** in the sidebar.
- **Option B:** In the service form, check the staff member under **Staff Assignment**.

Both methods achieve the same result.

## Staff profile page

Click on any staff member to see their profile at `/staff/:id`, which shows:
- Profile information (name, email, phone, title, bio)
- Assigned workspaces and services
- Working hours
- Recent appointment history

## Deactivating a staff member

1. Edit the staff member.
2. Toggle the status to **Inactive**.
3. Save.

Inactive staff are hidden from booking pages. Existing appointments are not cancelled.

## Deleting a staff member

1. Open the staff profile.
2. Click **Delete**.
3. Confirm.

Warning: Deleting a staff member will affect their existing appointments. Consider deactivating instead.

## Staff booking page URL

Each staff member can have a personal booking page URL. This can be set in the **Booking Page URL** field when editing the staff member. Leave empty if the staff member doesn't have their own booking page.

## Staff API endpoints

| Action | Method | URL |
|---|---|---|
| List staff | GET | /api/staff |
| Get one | GET | /api/staff/:id |
| Create | POST | /api/staff |
| Update | PUT | /api/staff/:id |
| Delete | DELETE | /api/staff/:id |

## Troubleshooting staff issues

**Staff not showing in booking** — Check that the staff member is Active and is assigned to the service being booked.

**No available time slots for a staff member** — Check their working hours (a day without hours is a day off) and the business hours in Settings → Working Hours, which also limit them once saved. Also check for time off, breaks, business closures and existing appointments.

**Staff member can't log in** — Staff log in using the main login page (`/login`) with their email and password. If they forgot their password, they use **Forgot password?** on that page. If they don't have a sign-in yet, an administrator sends them an invitation from their staff page (signing up at `/signup` would create a separate business).
