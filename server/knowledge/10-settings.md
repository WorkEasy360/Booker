# Settings — Complete Guide

## Accessing settings

Go to **Settings** (`/settings`) from the left sidebar. Settings are organized into 9 tabs accessible via the left panel of the settings page.

---

## Tab 1: Business Profile (`/settings/business`)

Configure your organization's contact information and basic details.

### Fields
- **Organization Name** (required) — your business name; validation: "Organization name is required."
- **Email** (required, valid email format) — validation: "Enter a valid email address."
- **Phone** — optional phone number
- **Website** — optional URL (e.g., "https://example.com")
- **Address** — street address
- **City** — city
- **Country** — country

### How to save
Click **Save Changes**. Success message: "Business profile saved".

---

## Tab 2: Branding (`/settings/branding`)

Customize the visual appearance of your booking pages.

### Options
- **Logo** — upload PNG or JPG up to 2 MB (note: logo upload storage is a stub in the current version)
- **Primary Color** — choose from 6 preset colors that apply to buttons and accents
  - Options: #00BF62 (Emerald), #3B82F6 (Blue), #8B5CF6 (Purple), #EF4444 (Red), #F59E0B (Amber), #EC4899 (Pink)
- **Business Display Name** — synced with your organization name from the Business Profile tab

A preview shows how the selected color and name will appear on your booking page.

---

## Tab 3: Working Hours (`/settings/hours`)

Set your business's opening hours. Once saved, they limit every staff member: a time can be booked only when it is inside both the staff member's own working hours and the business hours, and a day switched off here is closed for everyone. This applies to the public booking pages and to appointments created by staff.

### How to configure
1. Toggle on each day your business is open.
2. Set the opening time (e.g., 09:00) and closing time (e.g., 17:00) for each active day.
3. Time options are available in 30-minute increments from 00:00 to 23:30.
4. Use **Apply to all active days** to copy one day's hours to all enabled days.
5. Click **Save Changes**.

Until business hours are saved, staff working hours alone decide when staff can be booked. The tab shows Monday through Friday, 09:00–17:00 as a starting point, and those hours apply only after you click **Save Changes**.

Staff members' own hours are set in the staff form (Staff → the staff member → Edit Profile → Working Hours).

---

## Tab 4: Booking Rules (`/settings/booking`)

Control how and when customers can book appointments.

### Settings
- **Default Duration** — the default appointment duration: 15, 30, 45, 60, 90, or 120 minutes
- **Buffer Time** — gap between consecutive appointments: 0, 5, 10, or 15 minutes
- **Minimum Booking Notice** — how far ahead customers must book: No minimum, 1, 2, 4, 8, 12, 24, or 48 hours
- **Maximum Advance Booking** — how far ahead customers can book: 7, 14, 30, 60, or 90 days
- **Allow same-day booking** — toggle: "Customers can book appointments for the current day"
- **Require phone number** — toggle: "Make phone number a mandatory field at checkout"

---

## Tab 5: Cancellation Policy (`/settings/cancellation`)

Configure the rules for appointment cancellations and rescheduling.

### Settings
- **Allow cancellation** — toggle; if enabled: **Cancellation deadline** (1, 2, 4, 12, 24, or 48 hours before appointment)
- **Allow rescheduling** — toggle; if enabled: **Rescheduling deadline** (same options)
- **Cancellation fee** — toggle; if enabled: **Fee amount** (dollar amount, minimum 0)
- **Policy text** — free text shown to customers during booking; default: "Free cancellation up to 24 hours before the appointment. Cancellations within 24 hours may incur a fee."

---

## Tab 6: Notifications (`/settings/notifications`)

This tab redirects you to the dedicated Notifications page (`/notifications`). All notification template configuration is done there.

---

## Tab 7: Roles & Permissions (`/settings/roles`)

Shows a permission matrix for the four user roles (Owner, Admin, Staff, Viewer) across seven permission areas:

| Permission | Owner | Admin | Staff | Viewer |
|---|---|---|---|---|
| View appointments | ✓ | ✓ | ✓ | ✓ |
| Manage appointments | ✓ | ✓ | ✓ | — |
| Manage staff | ✓ | ✓ | — | — |
| Manage services | ✓ | ✓ | — | — |
| View reports | ✓ | ✓ | — | ✓ |
| Manage settings | ✓ | — | — | — |
| Manage billing | ✓ | — | — | — |

**Important:** This screen is currently read-only / display-only. The "Save Changes" button shows an informational message: "Role permissions are managed at the organization level — contact support to change them." Role permissions cannot be customized from the dashboard in the current version.

---

## Tab 8: Security (`/settings/security`)

### Change Password (fully implemented)
1. Enter your **Current password**
2. Enter a **New password** (at least 8 characters, one uppercase letter, one number)
3. Enter **Confirm new password** (must match)
4. Click **Update Password**

Validation errors:
- "Current password is required."
- "Must be at least 8 characters."
- "Must contain an uppercase letter."
- "Must contain a number."
- "Passwords do not match."

### Two-Factor Authentication (not yet available)
A toggle exists but clicking it shows: "Two-factor authentication is not yet available." This is a planned feature.

### Active Sessions (not yet available)
Shows placeholder text: "Session management is not yet available." This is a planned feature.

---

## Tab 9: Language & Region (`/settings/language`)

Configure display preferences for dates, times, and currency.

### Settings
- **Language** — English (US), English (UK), Spanish, French, German, Portuguese
  - Note: Language preference is stored locally in the browser only; it is not saved to the server in the current version.
- **Timezone** — full timezone list (e.g., "America/New_York", "Europe/London", "Asia/Kolkata")
- **Date Format** — MM/DD/YYYY, DD/MM/YYYY, or YYYY-MM-DD
- **Currency** — USD, EUR, GBP, INR, CAD, AUD
- **Time Format** — 12-hour or 24-hour

Timezone, date format, currency, and time format are saved to the server. Language is browser-only.

### Changing the business time zone
Choose the new zone under **Timezone** and click **Save Changes**. Every existing appointment keeps the same moment
in time and is shown in the new zone: 10:00 in New York becomes 20:30 in Kolkata in January. Working hours, breaks
and time off are local times, so they apply in the new zone. If two appointments of one staff member would end up at
the same moment, the change is refused and nothing is changed. Customers are not emailed, because their appointment
did not move.

---

## Settings API endpoint

| Action | Method | URL |
|---|---|---|
| Get settings | GET | /api/settings |
| Update settings | PUT | /api/settings |

Requires authentication. Only the authenticated user's organization settings are returned.

---

## Account management

### How to change your password
Go to **Settings** → **Security** (`/settings/security`) and use the Change Password form.

### How to reset a forgotten password
The Change Password form needs your current password. If you forgot it, reset it from the sign-in page instead:
1. On the sign-in page (`/login`), click **Forgot password?** below the password field.
2. Enter your email address and click **Send reset link**.
3. Open the reset link in the email. It works once and expires after 60 minutes.
4. Choose a new password and click **Save new password**.
5. You are signed out on every device. Sign in with the new password.

Owners, managers and staff all reset their password this way.

### How to delete or deactivate your account
WorkEasy360 does not have a self-service account deletion button in the current version. To deactivate or delete your organization account:
1. Contact WorkEasy360 support.
2. Individual staff members can be deactivated by an admin in **Staff** → edit staff → set status to **Inactive**.
3. To stop accepting new bookings, unpublish your Booking Page in **Booking Pages** → toggle to unpublished.

### How to log out
Click your user avatar in the top-right corner and select **Log out**, or navigate to `/logout`.
