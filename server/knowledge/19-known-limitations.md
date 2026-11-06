# Known Limitations and Partial Features

This document accurately describes what WorkEasy360 currently supports and what is not yet implemented.

## Fully implemented features (server-backed, verified)

- Authentication: login, signup with email confirmation, password change, password reset by email
- Organization settings: business profile, working hours, booking rules, cancellation policy, language and region preferences (except language which is browser-only)
- Workspaces: full CRUD with real API
- Resources: full CRUD with real API
- Reports: full API with mock fallback (summary, by-service, by-staff, top customers)
- All appointment CRUD operations with server-side validation
- Public booking API (slot availability, booking creation, cancellation)
- Staff CRUD API
- Services CRUD API
- Customers CRUD API
- Booking pages CRUD API

## Features that use mock/simulated data (not live API in current frontend code)

The following frontend pages use in-memory mock repositories. Data may not persist across browser refreshes and does not sync with the server:

- **New Appointment page** (`/appointments/new`) — uses mock service/staff data and simulated appointment creation
- **Service Form** (`/services/new`, `/services/:id/edit`) — uses mock service/staff data
- **Staff Form** (`/staff/new`, `/staff/:id/edit`) — uses mock staff/service/workspace data
- **Customer Form** (`/customers/new`) — uses simulated customer creation with 500ms delay
- **Public Booking Wizard** (`/book/:slug`) — uses mock repositories for all steps
- **Booking Page Editor** (`/booking-pages/new`, `/booking-pages/:id`) — uses mock booking page data
- **My Space** (`/my-space`) — uses mock appointment data

The backend API endpoints for all these resources exist and are functional; the frontend pages just haven't been wired up to them yet in all cases.

## Stubs and planned-but-not-yet-implemented features

| Feature | Location | Status |
|---|---|---|
| Two-factor authentication | Settings → Security | Toggle exists; shows "not yet available" |
| Active session management | Settings → Security | Placeholder text shown |
| Role permission customization | Settings → Roles | Read-only display matrix; save shows info message |
| Report CSV/PDF export | Reports page | Button shows info message about needing an export integration |
| Google Calendar integration | Booking Confirmation | Button shows toast; not yet functional |
| Apple Calendar integration | Booking Confirmation | Button shows toast; not yet functional |
| Outlook integration | Booking Confirmation | Button shows toast; not yet functional |
| Language preference persistence | Settings → Language | Language is stored in browser only, not saved to server |
| Logo upload | Settings → Branding, Booking Page Editor | UI exists; no backend upload implemented |
| Notification templates | Notifications page | Page exists; full template configuration in development |
| User management (add users) | Settings | Not accessible from the current dashboard |

## Frontend / backend type mismatches (known inconsistencies)

- **Staff roles**: Frontend shows Owner/Admin/Staff/Viewer. Backend accepts admin/manager/staff. "Owner" maps to admin; "Viewer" maps to staff.
- **Service categories**: consultation, class, workshop, session, tour, rental, other.
- **Appointment status**: scheduled, confirmed, completed, cancelled, no_show.

## AI assistant requirements

The assistant answers questions about WorkeasyBooking only, from this knowledge base and your own business's records. It can look up customers, services, staff and appointments, check free times, summarise your figures, open pages, and prepare a new service, customer or appointment that you must confirm before anything is saved. It cannot edit or delete records, send messages, take payments or change settings, and it declines questions that are not about WorkeasyBooking. When the server operator has connected a language model, it can hold a normal conversation; otherwise it answers from the knowledge base and its built-in questions only.

## Data persistence

All data is stored in a SQLite database file. This database persists across server restarts. The AI knowledge base is seeded on startup if not already present.

## Booking reference format

All booking references follow the format: WE-XXXXXXXX (8 uppercase alphanumeric characters). Example: WE-8328PTT8.

## Known QA data

- Appointment WE-8328PTT8 for customer "QA Customer" is test data and should not be deleted unless explicitly authorized.
