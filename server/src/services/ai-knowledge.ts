/**
 * Seed the knowledge base with WorkEasy360 product documentation.
 * Called once at startup; documents are idempotent (re-indexed by stable ID).
 */

import { indexDocument, CHUNKING_VERSION } from './rag';
import db from '../db/init';

const KNOWLEDGE_DOCS = [
  {
    id: 'kdoc-appointments',
    title: 'Managing Appointments',
    category: 'appointments',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Managing Appointments in WorkEasy360

## Creating a New Appointment
Navigate to Appointments > New Appointment (or click "New Appointment" in the sidebar).
Required fields: Service, Staff member, Customer, Date, and Start time.
The system automatically calculates the end time based on service duration.
Past dates are rejected — appointments must be scheduled for today or a future date.
The system checks for staff conflicts before saving.

## Viewing Appointments
Go to the Appointments page to see a list of all appointments.
Use the Calendar page for a visual day/week/month view.
Filter by date, staff member, status, or customer.

## Rescheduling an Appointment
Open the appointment detail page, then click Reschedule.
Pick a new date and time; the system checks for conflicts automatically.
Past dates cannot be selected.

## Appointment Statuses
- Scheduled: Confirmed and upcoming
- Completed: Service was delivered
- Cancelled: Appointment was cancelled
- No-show: Customer did not attend

## Double-booking Prevention
The system uses half-open interval conflict detection.
Two appointments with the same staff member cannot overlap in time.
A 409 Conflict response is returned if a time slot is already taken.
Different staff members can have appointments at the same time.

## Cancelling an Appointment
Open the appointment detail page and click the Cancel button.
Cancelling frees the time slot for other bookings.
A cancelled appointment can be rebooked at the same time.`,
  },

  {
    id: 'kdoc-services',
    title: 'Managing Services',
    category: 'services',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Managing Services in WorkEasy360

## Creating a Service
Go to Services in the sidebar, then click "New Service".
Required fields: Name, Duration (in minutes), Price, and Category.
Optional: Description, Location, Buffer time before/after, Minimum notice, Maximum advance booking.

## Service Categories
Available categories: consultation, class, workshop, session, tour, rental, other.

## Service Duration and Pricing
Duration is set in minutes (e.g. 30, 60, 90, 120).
Price is a decimal number (e.g. 500.00 for ₹500 or $500).
Currency is set at the organisation level in Settings.

## Editing a Service
Open the service detail page, click Edit.
Changes to duration automatically affect new appointment end times.
Existing appointments are not retroactively changed.

## Activating and Deactivating Services
Toggle the Active status on the service detail page.
Inactive services do not appear in public booking pages.

## Assigning Staff to a Service
On the service form, select which staff members can perform this service.
Only assigned staff will appear when booking this service.`,
  },

  {
    id: 'kdoc-staff',
    title: 'Managing Staff Members',
    category: 'staff',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Managing Staff in WorkEasy360

## Adding a Staff Member
Go to Staff in the sidebar, then click the add button.
Required fields: Full name, Email, Role.
Optional: Phone number, Title, Bio, Colour coding.

## Staff Roles
- Admin: Full access to all settings and data, including staff and their working hours
- Manager: Can manage appointments, customers, services, resources and booking pages
- Staff: Can view their own appointments

## Staff Working Hours
Open the staff member, click Edit Profile, and set their hours per day in the Working Hours section of the staff form.
Only times within a staff member's working hours can be booked. A day without hours is a day off.
If the business has saved its own hours in Settings, bookings must also fit inside those.

## Staff and Service Assignment
Assign staff to specific services they can perform.
A staff member not assigned to a service will not appear for that service's booking.

## Deactivating Staff
Inactive staff do not appear in booking forms.
Their past appointments remain visible in the system.`,
  },

  {
    id: 'kdoc-customers',
    title: 'Managing Customers',
    category: 'customers',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Managing Customers in WorkEasy360

## Adding a Customer
Go to Customers in the sidebar, then click New Customer.
Required fields: Full name, Email address.
Optional: Phone number, Timezone, Tags, Notes.

## Customer Tags
Tags help categorise customers: regular, vip, corporate, sports, referral, new.

## Searching Customers
Use the search bar on the Customers page to find by name, email, or phone.

## Customer History
The customer detail page shows all past and upcoming appointments.
Total bookings count is updated automatically when appointments are created or cancelled.

## Customer Profiles
Each customer belongs to your organisation and is not shared with other businesses on the platform.`,
  },

  {
    id: 'kdoc-calendar',
    title: 'Using the Calendar',
    category: 'calendar',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Using the Calendar in WorkEasy360

## Calendar Views
Switch between Day, Week, and Month views using the toolbar.
Navigate using the previous/next arrow buttons or the date picker.

## Viewing Appointments
Each appointment block shows the customer name, service, and time.
Click an appointment to open the detail drawer.

## Creating Appointments from Calendar
Click on an empty time slot to begin creating a new appointment for that time.

## Filtering by Staff
Use the staff filter to show appointments for a specific staff member only.`,
  },

  {
    id: 'kdoc-dashboard',
    title: 'Understanding the Dashboard',
    category: 'dashboard',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Dashboard Overview — WorkEasy360

## Key Metrics
The dashboard shows: today's appointments count, total active customers, monthly revenue, and upcoming appointments.

## Charts
Revenue over time and appointments by service are shown as interactive charts.
Use the date range filter to change the period (7 days, 30 days, 3 months, 1 year).

## Quick Actions
Use the "New Appointment" button in the sidebar to quickly create an appointment.

## Recent Appointments
The dashboard shows the most recent appointments with their status.`,
  },

  {
    id: 'kdoc-settings',
    title: 'Business Settings',
    category: 'settings',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Business Settings in WorkEasy360

## Organisation Profile
Go to Settings to edit your business name, email, phone, website, address, and logo.

## Time Zone and Currency
Set the business time zone and the currency for pricing in Settings → Language & Region.
The business time zone applies to all bookings. Changing it keeps every existing appointment at the same moment.

## Business Working Hours
Go to Settings → Working Hours (/settings/hours), switch on the days the business is open, set the opening and
closing times, and click Save Changes.
Saved business hours limit every staff member: a time can be booked only when it is inside both the staff member's
hours and the business hours, and a day switched off here is closed for everyone. Until business hours are saved,
staff hours alone decide.

## Booking Rules: Minimum Notice and Advance Booking
Set global rules: minimum advance notice (hours), maximum advance booking (days), buffer times.

## Cancellation Policy
Enter your cancellation policy text. This appears on public booking pages.`,
  },

  {
    id: 'kdoc-booking-pages',
    title: 'Public Booking Pages',
    category: 'booking-pages',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Public Booking Pages in WorkEasy360

## What Is a Booking Page?
A booking page is a public URL where customers can book appointments without logging in.
Types: Business (all services), Service (specific service), Staff (specific staff member's availability).

## Creating a Booking Page
Go to Booking Pages in the sidebar, then create a new page.
Set a unique URL slug, title, and description.
Select which services are available on that page.

## Publishing a Booking Page
A booking page must be published to be accessible to customers.
Use the publish toggle to make it live or take it offline.

## Booking Wizard
Customers see a step-by-step wizard: select service → pick date → choose time slot → enter details → confirm.
The system checks real-time availability before confirming.

## Managing Bookings from Public Pages
Public bookings appear in the Appointments list alongside admin-created appointments.
Customers receive a booking reference code (format: WE-XXXXXXXX) to manage their booking.`,
  },

  {
    id: 'kdoc-workspaces',
    title: 'Workspaces and Locations',
    category: 'workspaces',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Workspaces in WorkEasy360

## What Is a Workspace?
A workspace represents a physical location or operational unit within your business.
For example: "Main Branch", "Online Sessions", "Studio 2".

## Creating a Workspace
Go to Workspaces in the sidebar, then click New Workspace.
Required: Name, optional: address, phone, colour, timezone, working hours.
A workspace's time zone and working hours are saved for reference; bookable times come from staff and business hours.

## Assigning Services and Staff
Assign services and staff members to a workspace.
Appointments are linked to a workspace when booked through that workspace's booking page.`,
  },

  {
    id: 'kdoc-resources',
    title: 'Resources and Equipment',
    category: 'resources',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Resources in WorkEasy360

## What Is a Resource?
Resources are bookable assets: rooms, equipment, vehicles, tables, or other physical items.
Resources can be required for a service to prevent double-booking of physical equipment.

## Creating a Resource
Go to Resources in the sidebar, then create a new resource.
Set the type (room, equipment, vehicle, table, other), capacity, and which services require it.

## Resource Availability
Availability rules can be saved with a resource, but they are not checked when booking yet, and a resource is not
yet protected from being booked twice at the same time.`,
  },

  {
    id: 'kdoc-reports',
    title: 'Reports and Analytics',
    category: 'reports',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# Reports in WorkEasy360

## Summary Report
Shows total appointments, revenue, new customers, and cancellation rate for a selected period.
Available ranges: last 7 days, 30 days, 3 months, 1 year.

## By Service Report
Shows which services generate the most bookings and revenue.

## By Staff Report
Shows appointment counts per staff member for performance tracking.

## Top Customers Report
Shows the top 10 customers by total bookings.

## Accessing Reports
Go to Reports in the sidebar. Reports are real-time from the database.`,
  },

  {
    id: 'kdoc-ai-operator',
    title: 'AI Operator — How to Use',
    category: 'ai',
    source: 'WorkEasy360 Help',
    accessScope: 'authenticated' as const,
    content: `# WorkEasy360 AI Operator

## What Can the AI Do?
The AI assistant (AI Operator) can:
- Answer questions about how to use WorkEasy360
- Navigate you to the right page
- Help you find customers, services, staff, and appointments
- Prepare new records (services, customers, appointments) for your review
- Execute actions after your explicit confirmation

## What the AI Cannot Do
- Execute actions without your confirmation for any write operation
- Access another organisation's data
- Bypass business rules (e.g. double-booking prevention, past-date restrictions)
- Perform bulk deletions or irreversible changes

## How Confirmation Works
For any write action (creating or updating records), the AI prepares a proposal.
You see a clear summary of what will happen, with Confirm and Cancel buttons.
The action only executes after you click Confirm.
Proposals expire after 10 minutes if not confirmed.

## Examples of Things You Can Ask
- "How do I add a new staff member?"
- "Show me available slots for tomorrow for a 60-minute consultation"
- "Create a service called Initial Consultation, 30 minutes, ₹500"
- "Find customer John Doe's recent appointments"
- "Go to the calendar"
- "What's my appointment count for this month?"
- "Mujhe naya service banana hai — Initial Consultation 30 min ₹500"

## Tips
- Be specific about names, prices, and dates
- If the AI asks a clarifying question, answer concisely
- You can always Cancel a proposed action
- You can ignore the AI panel and work in the main app at the same time`,
  },
];

/**
 * Adds the built-in articles and re-indexes any whose text or chunking has changed since, so corrections reach
 * existing databases.
 */
export function seedKnowledge(): void {
  const current = db.prepare('SELECT content, version FROM ai_knowledge_docs WHERE id = ?');
  const setVersion = db.prepare('UPDATE ai_knowledge_docs SET version = ? WHERE id = ?');
  const version = `builtin-c${CHUNKING_VERSION}`;
  let written = 0;
  for (const doc of KNOWLEDGE_DOCS) {
    const row = current.get(doc.id) as { content: string; version: string | null } | undefined;
    if (row?.content === doc.content && row.version === version) continue;
    indexDocument(doc);
    setVersion.run(version, doc.id);
    written++;
  }
  if (written) console.log(`[AI] Indexed ${written} built-in knowledge document(s).`);
}
