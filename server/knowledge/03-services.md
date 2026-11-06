# Services — Complete Guide

## What are services?

Services are the bookable offerings your business provides to customers — for example, "30-minute Consultation", "60-minute Massage", "Yoga Class", "Hair Cut". Each service has a name, duration, price, category, and can be assigned to specific staff and workspaces.

## Viewing services

Go to **Services** (`/services`) to see all services listed in alphabetical order. The list shows each service's name, category, duration, price, and active/inactive status.

## Creating a new service

1. Go to **Services** → **New Service** (`/services/new`) or click **+ New Service**.
2. Fill in the form:

### Basic Information
- **Service Name** (required) — the name customers will see (e.g., "30-min Consultation")
- **Description** (optional) — detailed description shown to customers
- **Category** (required) — one of: Consultation, Treatment, Class, Meeting, Other
- **Location** (optional) — where the service takes place (e.g., "In-person", "Video Call", "Room A")

### Duration & Pricing
- **Duration** — slider from 15 to 480 minutes, in 15-minute increments (default: 60 min)
- **Price** — price per session, minimum 0 (free services allowed), entered in dollars/cents
- **Currency** — USD, EUR, GBP, or CAD

### Service Color
- Choose from 6 preset colors for visual identification in the calendar

### Staff Assignment
- Check which staff members can provide this service
- Only assigned staff will appear when booking this service

### Scheduling Rules
- **Buffer Before** — gap before the appointment (None, 5 min, 10 min, 15 min, 30 min)
- **Buffer After** — gap after the appointment (same options)
- **Minimum Notice** — how far in advance customers must book (No minimum, 1h, 2h, 4h, 8h, 12h, 24h, 48h)
- **Advance Booking Window** — how many days ahead customers can book (7, 14, 30, 60, 90, 180 days)

### Cancellation Policy
- Free text field for the cancellation and refund policy for this service

### Custom Questions
- Add custom intake questions that customers must answer when booking
- Question types: Short text, Long text, Dropdown, Checkbox, Email, Phone
- Questions can be set as required or optional

3. Click **Create Service**.

### Service validation errors
- "Service name is required" — the name field is empty
- "Enter a valid price" — price is not a valid non-negative number

## Editing a service

1. Go to **Services** (`/services`).
2. Click on the service to view its detail page, then click **Edit**, OR go directly to `/services/:id/edit`.
3. Modify any fields.
4. Click **Save Changes**.

## Disabling/deactivating a service

A service can be set to inactive to hide it from booking pages without deleting it:
1. Edit the service.
2. Toggle the **Active** status to inactive.
3. Save.

Inactive services do not appear in public booking pages or in the staff assignment dropdown when creating appointments.

## Deleting a service

1. Open the service detail page.
2. Click **Delete**.
3. Confirm deletion.

Note: Deleting a service does not delete existing appointments that used it.

## Service categories

| Category | When to use |
|---|---|
| Consultation | Advisory sessions, assessments, consultations |
| Treatment | Therapy, medical or wellness procedures |
| Class | Group sessions, workshops, training |
| Meeting | Business meetings, catch-ups |
| Other | Any service that doesn't fit above categories |

## Service API endpoints

| Action | Method | URL |
|---|---|---|
| List services | GET | /api/services |
| Get one service | GET | /api/services/:id |
| Create service | POST | /api/services |
| Update service | PUT | /api/services/:id |
| Delete service | DELETE | /api/services/:id |

All endpoints require authentication.

## Service fields reference

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| name | text | Yes | — | Service display name |
| description | text | No | — | Customer-visible description |
| category | select | Yes | consultation | See categories above |
| duration | number (minutes) | Yes | 60 | 15–480 minutes |
| price | number | Yes | 0 | Non-negative; 0 = free |
| currency | select | No | USD | USD, EUR, GBP, CAD |
| location | text | No | — | "In-person", "Video Call", etc. |
| isActive | boolean | No | true | Inactive = hidden from booking |
| bufferBefore | number (minutes) | No | 0 | Time blocked before appointment |
| bufferAfter | number (minutes) | No | 0 | Time blocked after appointment |
| minNotice | number (hours) | No | 0 | Minimum advance booking time |
| maxAdvance | number (days) | No | 30 | Maximum advance booking window |
| staffIds | array | No | [] | Assigned staff member IDs |
| workspaceIds | array | No | [] | Assigned workspace IDs |
| resourceIds | array | No | [] | Assigned resource IDs |
| customFields | array | No | [] | Custom intake questions |
| cancellationPolicy | text | No | — | Service-specific policy |

## Custom fields / intake questions

Add custom questions to collect information from customers at booking time:

1. In the service form, scroll to **Custom Questions**.
2. Click **Add Field**.
3. Enter:
   - **Question Label** — the question text (e.g., "What is your main concern?")
   - **Field Type** — Short text / Long text / Dropdown / Checkbox / Email / Phone
   - **Required** — whether the customer must answer before booking
4. Click **Add** to save the field.

These questions appear on the booking wizard at Step 5 (Your Information).

## Associating services with workspaces

In the service form, the **Workspaces** section shows checkboxes for each workspace. Checking a workspace means this service is available at that location. If no workspace is checked, the service is available in all workspaces.

## Troubleshooting services

**Service not showing in booking page** — Check that the service is marked as Active, and that the booking page has this service included in its service list.

**Staff not available for a service** — The staff member must be assigned to the service in the Staff Assignment section of the service form.

**Customers can't find a time slot** — Check the minimum notice and advance booking window settings. Also check that the staff member has working hours set that include that time.
