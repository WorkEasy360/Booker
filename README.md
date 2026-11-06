# WorkeasyBooking

**A WorkEasy360 Product.** Smart appointment scheduling for businesses, built with React 18, TypeScript, Vite and
Tailwind CSS, with a Node/Express API in `server/`. Branding rules and files: [docs/BRANDING.md](docs/BRANDING.md).

---

## Quick Start (Local)

```bash
# Install dependencies (web app and API)
npm install
npm install --prefix server

# Configure the API: copy server/.env.example to server/.env and set JWT_SECRET
# Start the API (port 3001) and the web app (port 5173) together
npm run dev:all
```

Opens at **http://localhost:5173**. Vite forwards `/api` to the API.

Signing up and resetting a password send email, so they need email set up even locally. Start a local test inbox
(`npm run mail:catcher` in `server/`, or Mailpit), point the API at it, and open the emails at http://localhost:8025.
The exact commands, including a way that changes no file, are in "Local email testing" in
[docs/EMAIL.md](docs/EMAIL.md). Without email, sign-up and "Forgot password?" answer "Email is not set up on this
server"; existing accounts sign in as usual.

The data lives in the SQLite file `server/data/workeasy360.db` (set with `DB_PATH`). The API applies database
migrations when it starts.

---

## Production

The web app (`npm run build` → `dist/`) and the API (`server/`, `npm run build` → `server/dist/`) are deployed
together behind one https origin. Hosting the web app alone does not work. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

| Topic | Document |
|---|---|
| Deployment, environment variables, proxy, persistence, scheduled jobs | [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) |
| Security model and production checklist | [docs/SECURITY.md](docs/SECURITY.md) |
| Booking and account emails, SMTP and DNS | [docs/EMAIL.md](docs/EMAIL.md) |
| Backup, restore, migrations, test-data cleanup | [docs/DATABASE_OPERATIONS.md](docs/DATABASE_OPERATIONS.md) |
| Working hours, breaks, time off, closures, time zones | [docs/SCHEDULING.md](docs/SCHEDULING.md) |
| Integrations, payments, reminders: what is and is not built | [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Staging verification, step by step | [docs/STAGING.md](docs/STAGING.md) |

---

## What works

| Feature | Status |
|---|---|
| Sign-up with email confirmation, sign-in, password reset by email, server-side sessions, roles (admin, manager, staff), staff invitations | ✅ (sign-up and password reset need SMTP) |
| Separate data per business | ✅ |
| Services, staff, customers, workspaces, resources | ✅ |
| Appointments and calendar, with conflict checks | ✅ |
| Public booking pages, self-service reschedule and cancel | ✅ |
| Business and staff working hours; breaks, time off and closures (API only, no screens yet) | ✅ |
| Business time zones (changing one keeps every appointment at the same moment) | ✅ |
| Booking emails over SMTP (confirmation, reschedule, cancellation), with retries | ✅ when SMTP is configured |
| Reports | ✅ |
| In-app assistant (local knowledge search, no external AI service) | ✅ |
| Backup, restore and migration tooling | ✅ |

## Not built yet

- Integrations (Google Calendar, Outlook, Zoom, Google Meet, Mailchimp, Twilio SMS, Stripe, PayPal, Zapier,
  webhooks). The Integrations page marks each as "Not available yet".
- Online payments. Customers pay the business directly.
- Appointment reminders, SMS and WhatsApp messages, staff alerts, editable email templates.
- "Add to calendar" buttons, report export.
- Recurring and group bookings.

Details and what each would need: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

---

## Tests

```bash
npm run test:unit            # web app unit tests
npx tsc --noEmit             # web app type check
npm run lint                 # ESLint (TypeScript, React Hooks); must report no problems
npm run test:browser         # builds, then drives the app in headless Chrome (desktop and phone)
cd server
npm test                     # API test suites (Jest) on throw-away databases
npm run test:e2e             # API end to end on a throw-away database
npm run test:email           # every email flow through a local test inbox (nothing leaves the machine)
npm run build && npm run test:smoke   # compiled API in production mode
```

No test touches `server/data/workeasy360.db` or sends real email.

---

## Tech Stack

- **React 18** + **TypeScript**
- **Vite** (build tool)
- **Tailwind CSS** (custom design system)
- **React Router v7** (SPA routing)
- **react-big-calendar** (calendar views)
- **Recharts** (analytics charts)
- **Lucide React** (icons)
- **react-hook-form** (form handling)
- **date-fns** (date utilities)
- **Node.js / Express**, **SQLite** (better-sqlite3), **Jest** (API)

## Brand Colors

| Token | Hex |
|---|---|
| Primary Green | `#00BF62` |
| Dark Green | `#008F49` |
| Dark Navy | `#13222E` |
| Accent Yellow | `#FFC940` |
