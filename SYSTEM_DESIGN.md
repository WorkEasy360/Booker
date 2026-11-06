# WorkEasy360 — System Design

## 1. Product Scope & User Roles

WorkEasy360 is a multi-workspace appointment scheduling and business management platform. It allows organizations to manage services, staff, customers, and bookings through an admin dashboard, while exposing a public-facing booking flow for customers.

### Internal User Roles (Admin App)

| Role    | Description                                                                                    |
|---------|-----------------------------------------------------------------------------------------------|
| Owner   | Full access to all features including billing, organization settings, and user management      |
| Admin   | Full access to operational features; cannot modify billing or delete the organization          |
| Staff   | Access to own schedule, appointments, and customer notes; limited to "My Space" and calendar   |
| Viewer  | Read-only access to appointments and reports; cannot create or modify records                  |

### External Role

| Role     | Description                                                                              |
|----------|------------------------------------------------------------------------------------------|
| Customer | Accesses the public `/book` flow to discover services, pick a time slot, and self-book   |

---

## 2. Application Boundaries

The application consists of two distinct halves that share the same codebase but are served through separate layouts and URL namespaces.

### Admin Application (`/`)
- Wrapped by `MainLayout` — includes sidebar navigation, header, and toast context
- Requires authentication (future: JWT-protected)
- Manages all back-office operations: staff, services, workspaces, appointments, reports

### Public Booking Flow (`/book`)
- Wrapped by `PublicLayout` — minimal branding, no sidebar
- Fully anonymous — no login required
- Customers discover business/staff pages, pick a service, choose a time slot, and confirm

---

## 3. Route Map

### Admin Routes

| Path                        | Component                    | Description                                         |
|-----------------------------|------------------------------|-----------------------------------------------------|
| `/`                         | Redirect → `/dashboard`      | Root redirect                                       |
| `/dashboard`                | `DashboardPage`              | KPI stats, upcoming appointments, charts            |
| `/my-space`                 | `MySpacePage`                | Staff's personal schedule and today view            |
| `/appointments`             | `AppointmentsPage`           | Full appointment list with filters and search       |
| `/appointments/new`         | `NewAppointmentPage`         | Create a new appointment with staff/service picker  |
| `/appointments/:id`         | `AppointmentDetailPage`      | View/edit a single appointment, status controls     |
| `/calendar`                 | `CalendarPage`               | React Big Calendar month/week/day/agenda views      |
| `/workspaces`               | `WorkspacesPage`             | List of all workspace locations                     |
| `/workspaces/new`           | `WorkspaceFormPage`          | Create a new workspace                              |
| `/workspaces/:id`           | `WorkspaceDetailPage`        | Workspace overview: staff, services, hours          |
| `/workspaces/:id/edit`      | `WorkspaceFormPage`          | Edit workspace details                              |
| `/services`                 | `ServicesPage`               | Service catalog with category filters               |
| `/services/new`             | `ServiceFormPage`            | Create a new service with custom fields             |
| `/services/:id`             | `ServiceDetailPage`          | Service detail: staff, bookings, performance        |
| `/services/:id/edit`        | `ServiceFormPage`            | Edit service                                        |
| `/staff`                    | `StaffPage`                  | Staff roster with role and availability indicators  |
| `/staff/new`                | `StaffFormPage`              | Invite or create a staff member                     |
| `/staff/:id`                | `StaffProfilePage`           | Staff profile: calendar, services, performance      |
| `/staff/:id/edit`           | `StaffFormPage`              | Edit staff details and working hours                |
| `/resources`                | `ResourcesPage`              | Rooms, equipment, vehicles — resource catalog       |
| `/resources/new`            | `ResourceFormPage`           | Create a new resource                               |
| `/resources/:id`            | `ResourceDetailPage`         | Resource detail: schedule and linked services       |
| `/customers`                | `CustomersPage`              | Customer directory with search, tags, history       |
| `/customers/new`            | `CustomerFormPage`           | Add a new customer manually                         |
| `/customers/:id`            | `CustomerDetailPage`         | Customer profile: appointment history, notes        |
| `/booking-pages`            | `BookingPagesPage`           | List of published booking page links                |
| `/booking-pages/new`        | `BookingPageEditor`          | Create and configure a booking page                 |
| `/booking-pages/:id`        | `BookingPageEditor`          | Edit an existing booking page                       |
| `/notifications`            | `NotificationsPage`          | Email/SMS templates by trigger type                 |
| `/integrations`             | `IntegrationsPage`           | Connect calendar, video, payment, and CRM tools     |
| `/reports`                  | `ReportsPage`                | Analytics: revenue, bookings, staff performance     |
| `/settings`                 | `SettingsPage`               | Organization, branding, billing, team settings      |
| `/settings/:tab`            | `SettingsPage`               | Deep-linked settings tab                            |

### Public Booking Routes

| Path                        | Component               | Description                                          |
|-----------------------------|-------------------------|------------------------------------------------------|
| `/book`                     | `BookingLanding`        | Landing page — search or browse businesses           |
| `/book/:slug`               | `BookingWizard`         | Step-by-step booking: service → staff → date → form  |
| `/book/:slug/confirmation`  | `BookingConfirmation`   | Booking confirmed: ref code, add-to-calendar links   |
| `/book/:slug/manage`        | `ManageBooking`         | Customer-initiated reschedule or cancellation        |

---

## 4. Component Architecture

### Layout Hierarchy

```
App
├── MainLayout (admin shell)
│   ├── Sidebar (navigation links, workspace switcher)
│   ├── Header (search, notifications, user menu)
│   └── <Outlet> (feature pages rendered here)
└── PublicLayout (booking shell)
    ├── PublicHeader (logo, back link)
    └── <Outlet> (booking wizard pages)
```

### Shared UI Components (`src/components/ui`)

All shared components live in `src/components/ui/index.ts` and are imported from `@/components/ui`. The library covers:

- **Layout**: `Card`, `CardHeader`, `Modal`, `Drawer`, `PageHeader`
- **Form**: `Button`, `Input`, `Textarea`, `Select`
- **Display**: `Badge`, `StatusBadge`, `Avatar`, `AvatarGroup`, `StatCard`
- **Data**: `Table`, `Pagination`, `Tabs`
- **Feedback**: `Spinner`, `EmptyState`, `useToast()`

### Feature Structure

Each feature under `src/features/<name>/` contains:
- `<Name>Page.tsx` — list/overview screen
- `<Name>FormPage.tsx` — create/edit form
- `<Name>DetailPage.tsx` — detail view
- Supporting sub-components (e.g., `AppointmentCard.tsx`, `StaffCalendar.tsx`)

---

## 5. Domain Entities & Relationships

### Entity Hierarchy

```
Organization
  └── Workspaces (1..n)
        ├── Services (n..n via serviceIds)
        │     ├── Staff (n..n via staffIds)
        │     ├── Resources (n..n via resourceIds)
        │     └── CustomFields (inline array)
        ├── Staff (n..n via staffIds)
        └── BookingPages (0..1 per workspace)

Staff ──────────── Appointments ──────── Customers
Service ──────────────┘         └──────────────────
Resource ─────────────┘
```

### Entities (from `src/types/index.ts`)

| Entity                | Key Fields                                                                                                       | Relationships                                          |
|-----------------------|------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------|
| `Organization`        | id, name, email, phone, timezone, currency, dateFormat, timeFormat, workingHours                                 | Root entity; owns everything                           |
| `WorkingHours`        | `{ [day]: DaySchedule }` with enabled, start, end, breaks                                                        | Embedded in Organization, Workspace, Staff, Resource   |
| `DaySchedule`         | enabled, start, end, breaks: TimeSlot[]                                                                          | Child of WorkingHours                                  |
| `TimeSlot`            | start, end                                                                                                       | Used in breaks and availability                        |
| `Workspace`           | id, name, description, color, timezone, address, isActive, serviceIds[], staffIds[], workingHours, bookingPageId | Belongs to Organization; references Services & Staff   |
| `Staff`               | id, name, email, role, title, bio, serviceIds[], workspaceIds[], workingHours, color, isActive                   | Belongs to Organization; linked to Services/Workspaces |
| `Service`             | id, name, category, duration, price, location, staffIds[], resourceIds[], bufferBefore, bufferAfter, customFields | Belongs to Organization; linked to Staff & Resources   |
| `Resource`            | id, name, type, description, capacity, isActive, serviceIds[], availabilityRules                                 | Belongs to Organization; linked to Services            |
| `Customer`            | id, name, email, phone, timezone, tags[], totalBookings, lastBookingDate                                         | Belongs to Organization; referenced by Appointments    |
| `Appointment`         | id, bookingRef, serviceId, staffId, customerId, resourceIds[], status, date, startTime, endTime, price            | Central transaction entity; references all above       |
| `CustomerAnswer`      | questionId, question, answer                                                                                     | Embedded in Appointment                                |
| `CustomField`         | id, label, type, required, options[], placeholder                                                                | Embedded in Service and BookingPage                    |
| `BookingPage`         | id, slug, type, title, theme, formFields[], serviceIds[], isPublished                                            | Belongs to Organization; links to Workspace/Staff/Svc  |
| `NotificationTemplate`| id, trigger, channel, name, subject, body, isEnabled, recipientType, timing                                      | Belongs to Organization                                |
| `Integration`         | id, provider, type, status, label, config                                                                        | Belongs to Organization                                |
| `AvailabilitySlot`    | time, available, staffId                                                                                         | Transient — returned by slot-generation logic          |
| `BookingWizardState`  | step, selectedService, selectedStaff, selectedDate, selectedSlot, customerInfo, answers, bookingRef               | UI-only state for the multi-step booking wizard        |
| `DashboardStats`      | todayAppointments, upcomingAppointments, totalBookings, cancelledToday, newCustomers, completionRate              | Aggregated read model for dashboard                    |

---

## 6. Mock Data Strategy

All data is defined in `src/mock/data.ts` as exported constants (`mockOrganization`, `mockWorkspaces`, `mockStaff`, etc.).

### Repository Pattern (`src/mock/repositories.ts`)

Each entity has a repository object that wraps an in-memory mutable array copied from the mock constants at module load time. All mutations (create, update, delete) modify the in-memory array only — data resets on page refresh.

```typescript
// Example pattern
let appointments = [...mockAppointments]; // mutable copy

export const appointmentRepo = {
  getAll: () => [...appointments],
  getById: (id) => appointments.find(a => a.id === id),
  create: (data) => { /* push to array */ },
  update: (id, data) => { /* splice array */ },
  cancel: (id) => appointmentRepo.update(id, { status: 'cancelled' }),
};
```

Repositories include: `appointmentRepo`, `customerRepo`, `staffRepo`, `serviceRepo`, `workspaceRepo`, `resourceRepo`, `bookingPageRepo`, `notificationRepo`, `integrationRepo`.

Helper functions: `getDashboardStats()` computes aggregated KPIs; `getMockAvailableSlots()` returns time slots for a given date/staff combination.

Chart data: `mockBookingTrend`, `mockStatusBreakdown`, `mockServicePerformance` are static arrays used by Recharts components.

---

## 7. REST API Boundaries (Future Backend)

All endpoints are under `/api/v1/`. Every authenticated request carries `Authorization: Bearer <jwt>` and `X-Organization-Id: <orgId>` headers.

### Appointments
| Method | Path                          | Description                     |
|--------|-------------------------------|---------------------------------|
| GET    | `/appointments`               | List with filters (date, status, staff, customer) |
| POST   | `/appointments`               | Create new appointment          |
| GET    | `/appointments/:id`           | Get single appointment          |
| PATCH  | `/appointments/:id`           | Update status/notes/details     |
| DELETE | `/appointments/:id`           | Hard delete (owner only)        |
| GET    | `/appointments/availability`  | Get available time slots        |

### Customers
| Method | Path               | Description                     |
|--------|--------------------|---------------------------------|
| GET    | `/customers`       | List with search and tag filter |
| POST   | `/customers`       | Create customer                 |
| GET    | `/customers/:id`   | Customer profile + history      |
| PATCH  | `/customers/:id`   | Update customer details         |
| DELETE | `/customers/:id`   | Delete (owner/admin only)       |

### Staff
| Method | Path                     | Description                  |
|--------|--------------------------|------------------------------|
| GET    | `/staff`                 | List staff members           |
| POST   | `/staff`                 | Invite new staff member      |
| GET    | `/staff/:id`             | Staff profile                |
| PATCH  | `/staff/:id`             | Update profile/hours         |
| DELETE | `/staff/:id`             | Remove staff member          |
| GET    | `/staff/:id/schedule`    | Get staff weekly schedule    |

### Services
| Method | Path              | Description               |
|--------|-------------------|---------------------------|
| GET    | `/services`       | List services             |
| POST   | `/services`       | Create service            |
| GET    | `/services/:id`   | Service detail            |
| PATCH  | `/services/:id`   | Update service            |
| DELETE | `/services/:id`   | Archive service           |

### Workspaces, Resources, Booking Pages, Notifications, Integrations
Same CRUD pattern: `GET /resources`, `POST /resources`, `GET /resources/:id`, `PATCH /resources/:id`, `DELETE /resources/:id`.

### Public Booking (no auth)
| Method | Path                                  | Description                          |
|--------|---------------------------------------|--------------------------------------|
| GET    | `/public/booking/:slug`               | Resolve slug to booking page config  |
| GET    | `/public/booking/:slug/slots`         | Available slots for date/staff combo |
| POST   | `/public/booking/:slug/book`          | Create appointment anonymously       |
| GET    | `/public/booking/manage/:ref`         | Look up booking by ref               |
| PATCH  | `/public/booking/manage/:ref`         | Reschedule booking                   |
| DELETE | `/public/booking/manage/:ref`         | Cancel booking                       |

---

## 8. Database Design Proposal (Future)

Target: PostgreSQL 15+. All tables have `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` and `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`.

```sql
-- Organizations (root multi-tenant boundary)
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'UTC',
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  working_hours JSONB NOT NULL,
  ...
);

-- Workspaces (locations / branches)
CREATE TABLE workspaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  color           CHAR(7),
  timezone        TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  working_hours   JSONB NOT NULL,
  INDEX: (organization_id)
);

-- Staff (users within an org)
CREATE TABLE staff (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('owner','admin','staff','viewer')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  working_hours   JSONB NOT NULL,
  UNIQUE: (organization_id, email),
  INDEX: (organization_id)
);

-- Staff ↔ Workspace many-to-many
CREATE TABLE staff_workspaces (
  staff_id     UUID REFERENCES staff(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, workspace_id)
);

-- Services
CREATE TABLE services (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  duration        INT NOT NULL,  -- minutes
  price           NUMERIC(10,2) NOT NULL DEFAULT 0,
  buffer_before   INT NOT NULL DEFAULT 0,
  buffer_after    INT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  custom_fields   JSONB NOT NULL DEFAULT '[]',
  INDEX: (organization_id)
);

-- Staff ↔ Service many-to-many
CREATE TABLE staff_services (
  staff_id   UUID REFERENCES staff(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

-- Resources
CREATE TABLE resources (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL,
  capacity           INT NOT NULL DEFAULT 1,
  is_active          BOOLEAN NOT NULL DEFAULT true,
  availability_rules JSONB NOT NULL,
  INDEX: (organization_id)
);

-- Customers
CREATE TABLE customers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  timezone        TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}',
  total_bookings  INT NOT NULL DEFAULT 0,
  INDEX: (organization_id),
  INDEX: (organization_id, email)
);

-- Appointments (central transaction table)
CREATE TABLE appointments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_ref      TEXT UNIQUE NOT NULL,
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  workspace_id     UUID REFERENCES workspaces(id),
  service_id       UUID NOT NULL REFERENCES services(id),
  staff_id         UUID NOT NULL REFERENCES staff(id),
  customer_id      UUID NOT NULL REFERENCES customers(id),
  status           TEXT NOT NULL CHECK (status IN ('pending','scheduled','completed','cancelled','no-show')),
  date             DATE NOT NULL,
  start_time       TIME NOT NULL,
  end_time         TIME NOT NULL,
  timezone         TEXT NOT NULL,
  price            NUMERIC(10,2) NOT NULL DEFAULT 0,
  notes            TEXT,
  internal_notes   TEXT,
  customer_answers JSONB NOT NULL DEFAULT '[]',
  INDEX: (organization_id, date),
  INDEX: (staff_id, date),
  INDEX: (customer_id),
  INDEX: (status)
);

-- Appointment ↔ Resource many-to-many
CREATE TABLE appointment_resources (
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  resource_id    UUID REFERENCES resources(id),
  PRIMARY KEY (appointment_id, resource_id)
);

-- Booking Pages
CREATE TABLE booking_pages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  workspace_id    UUID REFERENCES workspaces(id),
  service_id      UUID REFERENCES services(id),
  staff_id        UUID REFERENCES staff(id),
  type            TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  is_published    BOOLEAN NOT NULL DEFAULT false,
  theme           JSONB NOT NULL,
  form_fields     JSONB NOT NULL DEFAULT '[]',
  service_ids     UUID[] NOT NULL DEFAULT '{}',
  INDEX: (slug)
);

-- Notification Templates
CREATE TABLE notification_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id),
  trigger          TEXT NOT NULL,
  channel          TEXT NOT NULL,
  name             TEXT NOT NULL,
  subject          TEXT,
  body             TEXT NOT NULL,
  is_enabled       BOOLEAN NOT NULL DEFAULT true,
  recipient_type   TEXT NOT NULL,
  timing           INT,
  INDEX: (organization_id, trigger)
);

-- Integrations
CREATE TABLE integrations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  provider        TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'disconnected',
  config          JSONB,
  connected_at    TIMESTAMPTZ,
  connected_by    UUID REFERENCES staff(id),
  UNIQUE: (organization_id, provider)
);
```

---

## 9. Booking Lifecycle & State Transitions

### Appointment Status FSM

```
                    ┌─────────────────────────────────────┐
                    │                                     │
         [self-book or admin creates]                     │
                    │                                     │
                    ▼                                     │
              ┌──────────┐                                │
              │  PENDING  │  (awaiting confirmation)      │
              └────┬─────┘                                │
                   │ [confirm / auto-confirm]              │
                   ▼                                      │
            ┌───────────┐     [no-show recorded]          │
            │ SCHEDULED │ ──────────────────────► NO-SHOW │
            └─────┬─────┘                                 │
                  │                   ┌──────────┐        │
                  ├──────────────────►│CANCELLED │◄───────┘
                  │  [cancel by any]  └──────────┘
                  │
                  │ [appointment time passes, mark done]
                  ▼
            ┌───────────┐
            │ COMPLETED │
            └───────────┘
```

Terminal states: `completed`, `cancelled`, `no-show` — no further transitions allowed.

### Business Rules
- A `pending` appointment holds the time slot but allows overbooking with a warning.
- `scheduled` locks the slot — conflict validation fires before confirming.
- Cancellations within the service's `cancellationPolicy` window may trigger a fee.
- Status changes fire the corresponding `NotificationTemplate` trigger automatically.

---

## 10. Scheduling, Timezone & Conflict Validation

### Conflict Detection Algorithm
Before confirming an appointment at `[date, start, end]` for `staffId`:
1. Fetch all `scheduled` or `pending` appointments for `staffId` on `date`.
2. For each existing appointment with `[s, e]`: check if `(start < e) AND (end > s)`. If true, conflict exists.
3. Also check buffer times: effective occupied range is `[s - bufferBefore, e + bufferAfter]`.
4. Check resource conflicts for each `resourceId` the same way.

### Timezone Handling
- All appointment datetimes are stored in UTC (`TIMESTAMPTZ` in DB).
- Each appointment carries a `timezone` field representing the customer's timezone at booking time.
- Display conversion: `date-fns-tz` or `Intl.DateTimeFormat` used to format in org timezone.
- The calendar view renders appointments in the organization's timezone.
- Public booking wizard asks for the customer's timezone and shows slots converted accordingly.

### Availability Slot Generation
1. Start from staff's `workingHours` for the requested day.
2. Remove slots blocked by existing appointments (+ buffers).
3. Remove slots that violate `service.minNotice` (too soon) or `service.maxAdvance` (too far out).
4. Return remaining slots in the staff/org timezone, converted to the customer's timezone for display.

---

## 11. Authentication & RBAC Plan

### Authentication Flow (Phase 2)
- **Registration**: organization owner creates account → receives email verification link.
- **Login**: POST `/auth/login` with email + password → returns `{ accessToken, refreshToken }`.
- **Token type**: JWT (HS256 for dev, RS256 for prod), 15-minute access tokens, 7-day refresh tokens.
- **Refresh**: POST `/auth/refresh` with valid `refreshToken` → new access token.
- **Logout**: POST `/auth/logout` → invalidates refresh token (server-side blocklist).

### JWT Payload
```json
{
  "sub": "staff-uuid",
  "orgId": "org-uuid",
  "role": "admin",
  "workspaceIds": ["ws-1", "ws-2"],
  "iat": 1720000000,
  "exp": 1720000900
}
```

### Permission Matrix

| Feature               | Owner | Admin | Staff | Viewer |
|-----------------------|-------|-------|-------|--------|
| View dashboard        | ✓     | ✓     | ✓     | ✓      |
| View all appointments | ✓     | ✓     | Own   | ✓      |
| Create appointments   | ✓     | ✓     | ✓     | ✗      |
| Cancel appointments   | ✓     | ✓     | Own   | ✗      |
| Manage staff          | ✓     | ✓     | ✗     | ✗      |
| Manage services       | ✓     | ✓     | ✗     | ✗      |
| Manage workspaces     | ✓     | ✓     | ✗     | ✗      |
| Manage customers      | ✓     | ✓     | ✓     | ✗      |
| View reports          | ✓     | ✓     | Own   | ✓      |
| Manage integrations   | ✓     | ✓     | ✗     | ✗      |
| Manage billing        | ✓     | ✗     | ✗     | ✗      |
| Organization settings | ✓     | ✓     | ✗     | ✗      |

---

## 12. Integration Architecture

### Email: SendGrid / Mailgun
- Triggered by notification template engine on appointment lifecycle events.
- Templates rendered server-side using Handlebars or Liquid syntax.
- Dynamic variables: `{{customer_name}}`, `{{service_name}}`, `{{date}}`, `{{time}}`, `{{booking_ref}}`, `{{cancel_link}}`.
- Webhooks from provider update delivery status in a `notification_logs` table.

### SMS: Twilio
- Same trigger events as email; channel determined by `NotificationTemplate.channel`.
- Character limits enforced; long messages split into segments.
- Phone number validation before sending.

### Calendar: Google Calendar & Microsoft Outlook
- OAuth 2.0 flow: staff grants access; tokens stored encrypted in `integrations.config`.
- On appointment create/update/cancel: push event to staff's connected calendar via API.
- Bi-directional sync: Outlook/Google events block availability in WorkEasy360 (Phase 3).

### Payment: Stripe
- Service price collected at booking via Stripe Checkout or Payment Intents.
- `Appointment.price` set at booking time; refunds handled via Stripe API on cancellation.
- Webhooks (`payment_intent.succeeded`, `charge.refunded`) update appointment payment status.

### Video: Zoom / Google Meet
- On appointment confirm: auto-create meeting via Zoom API or Google Meet API.
- Meeting link stored in `appointment.location`; included in confirmation notifications.
- Requires organization to have connected the integration with valid OAuth tokens.

### Automation: Zapier / Make
- REST webhooks sent on key events (appointment created, completed, cancelled).
- Inbound webhooks allow external triggers to create appointments.

---

## 13. Error Handling, Validation & Accessibility

### Client-Side Validation
- Forms use `react-hook-form` with `register`, `handleSubmit`, and `formState.errors`.
- Per-field error messages displayed via `Input`/`Select` component's `error` prop.
- Required fields marked with asterisk and `aria-required="true"`.

### API Error Codes (Future)
| Code | Meaning                                 |
|------|-----------------------------------------|
| 400  | Validation error — body includes field errors |
| 401  | Not authenticated                       |
| 403  | Insufficient permissions                |
| 404  | Resource not found                      |
| 409  | Conflict — e.g., double booking         |
| 422  | Business rule violation                 |
| 429  | Rate limit exceeded                     |
| 500  | Internal server error                   |

### Accessibility
- All form inputs have associated `<label>` elements.
- `Modal` and `Drawer` trap focus and restore on close.
- `EmptyState` and `Spinner` include descriptive `aria-label` attributes.
- Color is never the sole means of communicating status — `StatusBadge` uses both color and text.
- Keyboard navigation: modals closeable with `Escape`, dropdowns navigable with arrow keys.
- `Button` components include `aria-disabled` when in loading state.
- WCAG 2.1 AA target: minimum 4.5:1 contrast ratio for all text.

---

## 14. Responsive Strategy

### Breakpoints (Tailwind defaults)
| Name | Width  | Behavior                                      |
|------|--------|-----------------------------------------------|
| sm   | 640px  | Single-column stack; hidden secondary columns |
| md   | 768px  | Two-column layouts introduced                 |
| lg   | 1024px | Sidebar visible; full table columns           |
| xl   | 1280px | Full dashboard grid                           |

### Mobile Patterns
- **Sidebar**: collapses to a hamburger-triggered `Drawer` on screens below `lg`.
- **Tables**: collapse to card-based stacked rows on mobile using responsive utilities.
- **Calendar**: defaults to Agenda view on mobile (`react-big-calendar` view switching based on window width).
- **Modals**: full-screen on mobile (`size='lg'` → `inset-0` positioning).
- **Page containers**: `page-container` class applies `px-4 md:px-6 lg:px-8` for consistent gutters.
- **Charts**: Recharts components use `<ResponsiveContainer width="100%">` for fluid resizing.

---

## 15. UI Phase Limitations & Future Phases

### Phase 1 — UI Prototype (Current)
What is **simulated** (no real backend):
- All data is in-memory mock data; resets on page refresh.
- Create/edit/delete operations update in-memory arrays only.
- No real email or SMS notifications are sent.
- No real payment processing; prices are display-only.
- No calendar sync with Google/Outlook.
- No real video meeting links generated.
- No authentication; all roles are assumed to be "owner".
- No real-time updates or websockets.

What **actually works** in Phase 1:
- Full navigation and routing.
- All forms with client-side validation.
- Mock CRUD that persists within a session.
- Filters, search, sorting on list views.
- React Big Calendar with mock appointments rendered.
- Recharts dashboards with mock chart data.
- Booking wizard multi-step flow with mock slot generation.
- Responsive layout including mobile drawer sidebar.
- Toast notifications for all user actions.

### Phase 2 — Production Backend
- Node.js (NestJS) or Python (FastAPI) REST API.
- PostgreSQL database with the schema described in Section 8.
- JWT authentication with role-based middleware.
- SendGrid for email, Twilio for SMS.
- Stripe payment integration.
- Google & Outlook calendar OAuth.
- Redis for session caching and rate limiting.

### Phase 3 — Mobile & Scale
- React Native mobile app sharing the same API.
- Real-time appointment updates via WebSockets or Server-Sent Events.
- Zoom / Google Meet auto-generation on confirm.
- Multi-language (i18n) support.
- Subdomain-based multi-tenant routing (e.g., `apexwellness.workeasy360.com`).
