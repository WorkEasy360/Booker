/**
 * 44-question regression suite for the Knowledge Search chat agent.
 * Covers: how-to, navigation, live-data, record-search, actions, typos,
 * one-word queries, Hinglish, off-topic, wrong-topic regressions, and
 * the 15 standard Phase-8 queries.
 *
 * Uses isolated test database. No external API calls.
 * Target: 90 %+ pass rate.
 */

import { describe, it, expect, beforeAll } from '@jest/globals';

process.env.DB_PATH = './data/test-chat-agent.db';

import db from '../db/init';
import { indexDocument } from '../services/rag';
import { localAnswer } from '../services/local-answer';
import { routeIntent } from '../services/intent-router';
import type { AuthPayload } from '../types';

const MOCK_USER: AuthPayload = {
  sub: 'user-ca-001',
  email: 'ca@workeasy360.com',
  orgId: 'org-ca',
  role: 'admin',
};

// ── Seed ──────────────────────────────────────────────────────────────────────

beforeAll(() => {
  db.prepare(`INSERT OR IGNORE INTO organizations (id, name, email) VALUES ('org-ca','CA Test Org','ca@workeasy360.com')`).run();
  db.prepare(`INSERT OR IGNORE INTO users (id, organization_id, email, password_hash, name, role)
    VALUES ('user-ca-001','org-ca','ca@workeasy360.com','$2b$10$placeholder','CA User','admin')`).run();

  // Delete ALL knowledge to prevent stale real-docs from contaminating the isolated test DB
  db.prepare("DELETE FROM ai_knowledge_chunks").run();
  db.prepare("DELETE FROM ai_knowledge_docs").run();

  const docs = [
    {
      id: 'ca-appt',
      title: 'Appointments Guide',
      category: 'appointments',
      content: `# Appointments Guide
Creating a new appointment:
1. Go to Appointments at /appointments/new
2. Select a Service from the dropdown
3. Select a Staff Member
4. Pick a date (cannot be in the past)
5. Select a time slot
6. Select or add a Customer
7. Click Create Appointment

Rescheduling: open the appointment and click Edit. Change the date or time. Save.
Cancelling: open the appointment and click Cancel. Confirm the cancellation.
Business rules: cannot create appointments in the past.`,
    },
    {
      id: 'ca-staff',
      title: 'Staff Guide',
      category: 'staff',
      content: `# Staff Guide

## Adding a new staff member
1. Go to Staff at /staff/new
2. Enter their Full Name (required)
3. Enter their Email (required)
4. Assign to workspaces and services
5. Click Create Staff

## Staff working hours
To set working hours for a staff member:
1. In the staff form, scroll to Working Hours
2. Toggle on each day the staff member works
3. Set start and end time for each active day

Staff roles: Admin, Manager, Staff.`,
    },
    {
      id: 'ca-services',
      title: 'Services Guide',
      category: 'services',
      content: `# Services Guide
Creating a new service:
1. Go to Services at /services/new
2. Enter the service name (required)
3. Set the duration (15–480 minutes)
4. Set the price (0 or more)
5. Choose a category: Consultation, Treatment, Class, Meeting, Other
6. Assign staff members
7. Click Create Service

Service categories: consultation, treatment, class, meeting, other.`,
    },
    {
      id: 'ca-customers',
      title: 'Customers Guide',
      category: 'customers',
      content: `# Customers Guide
Adding a customer:
1. Go to Customers at /customers/new
2. Enter the Full Name (required)
3. Enter the Email (required)
4. Optionally add Phone, Timezone, Tags, Notes
5. Click Create Customer

Searching customers: go to /customers and use the search bar to filter by name or email.`,
    },
    {
      id: 'ca-settings',
      title: 'Settings Guide',
      category: 'settings',
      content: `# Settings Guide
Settings are at /settings. Tabs: Business Profile, Security, Working Hours, Notifications.

## Account management
To delete or deactivate your account:
1. Contact WorkEasy360 support to request account deletion
2. Deactivate staff: go to Staff, edit the member, set status to Inactive
3. Stop accepting bookings: unpublish your Booking Page

## Security and password
Change password at /settings/security.
1. Enter your current password
2. Enter a new password (min 8 chars, one uppercase, one number)
3. Confirm the new password
4. Click Update Password
Two-factor authentication is not yet available.`,
    },
    {
      id: 'ca-reports',
      title: 'Reports Guide',
      category: 'reports',
      content: `# Reports Guide
Reports are available at /reports.

Available report types:
- Total Appointments: count of all appointments in the selected period
- Total Revenue: sum of prices from confirmed and completed appointments
- Cancellation Rate: percentage of appointments cancelled
- No-show Rate: percentage marked no-show
- Booking Volume Chart: appointments over time
- Status Breakdown: pie chart by status
- Service Performance: most popular services
- Staff Workload: appointments per staff member
- Top Customers: top customers by booking count

Select a date range: Last 7 days, Last 30 days, Last 3 months, Last year.`,
    },
    {
      id: 'ca-notifications',
      title: 'Notifications Guide',
      category: 'notifications',
      content: `# Notifications Guide
Notifications are at /notifications.

## Email reminders and notification types
Supported notification types:
- Booking Confirmation: sent to customers/clients when appointment is created
- Appointment Reminder: email reminder sent before appointment (e.g., 24 hours before)
- Cancellation Confirmation: sent when appointment is cancelled
- Staff Notification: sent to staff when they have a new appointment

## Configuring email reminders for clients
To send email reminders to clients:
1. Go to Notifications at /notifications
2. Find Appointment Reminder and open it
3. Set the timing (e.g., 24 hours before appointment)
4. Enable the notification
Note: notification template configuration is in development.`,
    },
    {
      id: 'ca-integrations',
      title: 'Integrations Guide',
      category: 'integrations',
      content: `# Integrations Guide
Integrations are at /integrations.

Available integrations:
- Google Calendar: sync appointments to Google Calendar (in development)
- Apple Calendar: add appointments to Apple Calendar via .ics
- Outlook: add to Microsoft Outlook
- Report export: download reports as CSV/PDF (planned)

To connect Google Calendar:
1. Go to Integrations at /integrations
2. Select Google Calendar
3. Follow the setup steps
Note: Calendar integrations are currently in development and show a toast notification.`,
    },
    {
      id: 'ca-workspaces',
      title: 'Workspaces Guide',
      category: 'workspaces',
      content: `# Workspaces Guide
Workspaces represent locations or branches of your business.

## Creating a workspace
1. Go to Workspaces at /workspaces/new
2. Enter the name (required)
3. Add address, phone, timezone
4. Click Create

## Inviting and assigning team members to a workspace
To invite or assign staff to a workspace:
1. Go to Staff at /staff
2. Open the staff member's profile
3. Under Workspaces in the sidebar, check the target workspace
4. Save the staff member

Each staff member can be assigned to multiple workspaces.`,
    },
  ];

  for (const doc of docs) indexDocument(doc);
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase-8 standard queries (Q1–Q15)
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase-8 standard queries', () => {

  it('Q1  "hi" → greeting', () => {
    const r = routeIntent('hi');
    expect(r.intent).toBe('greeting');
  });

  it('Q2  "how to add new member" → platform_how_to, staff', () => {
    const r = routeIntent('how to add new member');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('staff');
  });

  it('Q3  "How do I add a new staff member?" → platform_how_to, staff', () => {
    const r = routeIntent('How do I add a new staff member?');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('staff');
  });

  it('Q4  "How can I invite someone to my team?" → not out_of_scope, staff categories', () => {
    const r = routeIntent('How can I invite someone to my team?');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.featureCategories).toContain('staff');
  });

  it('Q5  "What\'s my appointment count this month?" → live_data_query', () => {
    const r = routeIntent("What's my appointment count this month?");
    expect(r.intent).toBe('live_data_query');
  });

  it('Q6  "Show me available slots for tomorrow" → availability_query (or workflow_blocker without services)', async () => {
    const r = routeIntent('Show me available slots for tomorrow');
    expect(r.intent).toBe('availability_query');
    const result = await localAnswer('Show me available slots for tomorrow', 5, MOCK_USER);
    expect(['availability', 'workflow_blocker', 'clarification']).toContain(result.type);
  });

  it('Q7  "Create a 30-minute consultation service for ₹500" → action_request or action_proposal', async () => {
    const r = routeIntent('Create a 30-minute consultation service for ₹500');
    expect(r.intent).toBe('action_request');
    const result = await localAnswer('Create a 30-minute consultation service for ₹500', 5, MOCK_USER);
    expect(['action_proposal', 'clarification']).toContain(result.type);
    expect(result.answer.trim()).not.toBe('');
  });

  it('Q8  "Find customer Alice Johnson" → record_search, customers', () => {
    const r = routeIntent('Find customer Alice Johnson');
    expect(r.intent).toBe('record_search');
    expect(r.entities.recordType).toBe('customers');
  });

  it('Q9  "Take me to the reports page" → navigation, /reports', () => {
    const r = routeIntent('Take me to the reports page');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/reports');
  });

  it('Q10 "What is the capital of France?" → out_of_scope', () => {
    const r = routeIntent('What is the capital of France?');
    expect(r.intent).toBe('out_of_scope');
  });

  it('Q11 "How do I change my password?" → platform_how_to, settings', () => {
    const r = routeIntent('How do I change my password?');
    expect(r.intent).toBe('platform_how_to');
    expect(r.featureCategories).toContain('settings');
  });

  it('Q12 undocumented feature → not out_of_scope, no fabrication', async () => {
    const result = await localAnswer('How do I bulk import customers from a spreadsheet?');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.trim().length).toBeGreaterThan(5);
    expect(result.answer.toLowerCase()).not.toMatch(/step 1.*import.*spreadsheet/i);
  });

  it('Q13 "Create a service" (bare) → clarification_needed', () => {
    const r = routeIntent('Create a service');
    expect(r.intent).toBe('clarification_needed');
  });

  it('Q14 live-data without user → BM25 fallback, never live_data', async () => {
    const result = await localAnswer("What's my appointment count this month?");
    expect(result.type).not.toBe('live_data');
    expect(result.liveData).toBeUndefined();
    expect(result.answer.trim().length).toBeGreaterThan(5);
  });

  it('Q15 "open the second one" → non-blank, no crash', async () => {
    const result = await localAnswer('open the second one');
    expect(result.answer.trim().length).toBeGreaterThan(5);
    expect(result.type).not.toBe('error');
    expect(result.type).not.toBe('live_data');
    expect(result.type).not.toBe('action_proposal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wrong-topic regression (Q16–Q22)
// ─────────────────────────────────────────────────────────────────────────────

describe('Wrong-topic regression', () => {

  it('Q16 "create appointment and assign to staff" → featureCategories includes appointments', () => {
    const r = routeIntent('create appointment and assign to staff');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.featureCategories).toContain('appointments');
  });

  it('Q17 "set staff working hours" → featureCategories includes staff', () => {
    const r = routeIntent('set staff working hours');
    expect(r.featureCategories).toContain('staff');
  });

  it('Q18 "connect Google Calendar" → featureCategories includes integrations, not calendar alone', () => {
    const r = routeIntent('connect Google Calendar');
    expect(r.featureCategories).toContain('integrations');
  });

  it('Q19 "email reminders" → featureCategories includes notifications', () => {
    const r = routeIntent('email reminders');
    expect(r.featureCategories).toContain('notifications');
  });

  it('Q20 "what reports are available" → NOT availability_query', () => {
    const r = routeIntent('what reports are available');
    expect(r.intent).not.toBe('availability_query');
    expect(r.featureCategories).toContain('reports');
  });

  it('Q21 "show my bookings tomorrow" → live_data_query', () => {
    const r = routeIntent('show my bookings tomorrow');
    expect(r.intent).toBe('live_data_query');
    expect(r.entities.date).toBeDefined();
  });

  it('Q22 "invite team members to a workspace" → featureCategories includes workspaces', () => {
    const r = routeIntent('invite team members to a workspace');
    expect(r.featureCategories).toContain('workspaces');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Typos and fuzzy matching (Q23–Q26)
// ─────────────────────────────────────────────────────────────────────────────

describe('Typos and fuzzy matching', () => {

  it('Q23 "apointment" (1 char off) → NOT out_of_scope', () => {
    const r = routeIntent('apointment');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('Q24 "custommer" (extra char) → NOT out_of_scope', () => {
    const r = routeIntent('custommer');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('Q25 "servis" (2 char off) → NOT out_of_scope', () => {
    const r = routeIntent('servis');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('Q26 "stafff" (extra char) → NOT out_of_scope', () => {
    const r = routeIntent('stafff');
    expect(r.intent).not.toBe('out_of_scope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One-word queries (Q27–Q29)
// ─────────────────────────────────────────────────────────────────────────────

describe('One-word queries', () => {

  it('Q27 "member" → NOT out_of_scope, non-empty answer', async () => {
    const r = routeIntent('member');
    expect(r.intent).not.toBe('out_of_scope');
    const result = await localAnswer('member');
    expect(result.answer.trim().length).toBeGreaterThan(5);
    expect(result.type).not.toBe('error');
  });

  it('Q28 "staff" → NOT out_of_scope', () => {
    const r = routeIntent('staff');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('Q29 "appointment" → NOT out_of_scope', () => {
    const r = routeIntent('appointment');
    expect(r.intent).not.toBe('out_of_scope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Hinglish queries (Q30–Q32)
// ─────────────────────────────────────────────────────────────────────────────

describe('Hinglish queries', () => {

  it('Q30 "appointment kaise banate hain" → NOT out_of_scope', () => {
    const r = routeIntent('appointment kaise banate hain');
    expect(r.intent).not.toBe('out_of_scope');
  });

  it('Q31 "customer kaise add karte hain" → NOT out_of_scope', async () => {
    const r = routeIntent('customer kaise add karte hain');
    expect(r.intent).not.toBe('out_of_scope');
    const result = await localAnswer('customer kaise add karte hain');
    expect(result.answer.trim().length).toBeGreaterThan(5);
  });

  it('Q32 "staff member kaise add karein" → NOT out_of_scope, staff categories', () => {
    const r = routeIntent('staff member kaise add karein');
    expect(r.intent).not.toBe('out_of_scope');
    expect(r.featureCategories).toContain('staff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Account management (Q33)
// ─────────────────────────────────────────────────────────────────────────────

describe('Account management', () => {

  it('Q33 "How do I delete my account?" → NOT out_of_scope, settings-related answer', async () => {
    const r = routeIntent('How do I delete my account?');
    expect(r.intent).not.toBe('out_of_scope');
    const result = await localAnswer('How do I delete my account?');
    expect(result.type).not.toBe('out_of_scope');
    expect(result.answer.trim().length).toBeGreaterThan(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Navigation (Q34–Q36)
// ─────────────────────────────────────────────────────────────────────────────

describe('Navigation queries', () => {

  it('Q34 "go to calendar" → navigation, /calendar', () => {
    const r = routeIntent('go to calendar');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/calendar');
  });

  it('Q35 "open settings" → navigation, /settings', () => {
    const r = routeIntent('open settings');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/settings');
  });

  it('Q36 "take me to staff" → navigation, /staff', () => {
    const r = routeIntent('take me to staff');
    expect(r.intent).toBe('navigation');
    expect(r.entities.routePath).toBe('/staff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// List / search queries (Q37–Q38)
// ─────────────────────────────────────────────────────────────────────────────

describe('List and search queries', () => {

  it('Q37 "list customers" → record_search, customers', () => {
    const r = routeIntent('list customers');
    expect(r.intent).toBe('record_search');
    expect(r.entities.recordType).toBe('customers');
    expect(r.entities.listMode).toBe(true);
  });

  it('Q38 "show all staff" → record_search, staff', () => {
    const r = routeIntent('show all staff');
    expect(r.intent).toBe('record_search');
    expect(r.entities.recordType).toBe('staff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Off-topic (Q39–Q40)
// ─────────────────────────────────────────────────────────────────────────────

describe('Off-topic queries', () => {

  it('Q39 "who won the world cup" → out_of_scope', () => {
    const r = routeIntent('who won the world cup');
    expect(r.intent).toBe('out_of_scope');
  });

  it('Q40 "tell me a joke" → out_of_scope', () => {
    const r = routeIntent('tell me a joke');
    expect(r.intent).toBe('out_of_scope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notification / integration feature matching (Q41–Q44)
// ─────────────────────────────────────────────────────────────────────────────

describe('Notification and integration feature matching', () => {

  it('Q41 "how to set up notifications" → featureCategories includes notifications', () => {
    const r = routeIntent('how to set up notifications');
    expect(r.featureCategories).toContain('notifications');
  });

  it('Q42 "how to configure email reminders" → featureCategories includes notifications', () => {
    const r = routeIntent('how to configure email reminders');
    expect(r.featureCategories).toContain('notifications');
  });

  it('Q43 "what integrations are available" → featureCategories includes integrations, not availability_query', () => {
    const r = routeIntent('what integrations are available');
    expect(r.intent).not.toBe('availability_query');
    expect(r.featureCategories).toContain('integrations');
  });

  it('Q44 "schedule an appointment" → NOT out_of_scope', () => {
    const r = routeIntent('schedule an appointment');
    expect(r.intent).not.toBe('out_of_scope');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New follow-up cases (Q45–Q51)
// ─────────────────────────────────────────────────────────────────────────────

describe('Follow-up: fuzzy, heading rank, Hinglish, account deletion', () => {

  it('Q45 "apointment" → appointment suggestions, not BM25 doc dump', async () => {
    const result = await localAnswer('apointment', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/appointment|booking|schedule/);
  });

  it('Q46 "member" (single word) → feature suggestions, not raw doc fragment', async () => {
    const result = await localAnswer('member', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/staff|add.*staff|working hours/i);
  });

  it('Q47 "set staff working hours" → working hours steps returned', async () => {
    const result = await localAnswer('set staff working hours', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/working hours|toggle|hours/i);
    expect((result.steps ?? []).length).toBeGreaterThan(0);
  });

  it('Q48 "appointment kaise banate hain" → appointment creation steps', async () => {
    const result = await localAnswer('appointment kaise banate hain', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/appointment|booking|create|service/i);
  });

  it('Q49 "send email reminders" → notifications content, not unrelated topic', async () => {
    const result = await localAnswer('send email reminders', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/notification|reminder|email/i);
  });

  it('Q50 "invite team members" → staff/team info', async () => {
    const result = await localAnswer('invite team members', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/staff|member|team/i);
  });

  it('Q51 "delete my account" → support/deactivate info first, not Two-Factor Auth', async () => {
    const result = await localAnswer('delete my account', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/support|deactivate|contact/i);
    // Early content must not lead with TFA
    const early = result.answer + ' ' + (result.steps ?? []).slice(0, 3).join(' ');
    expect(early.toLowerCase()).not.toMatch(/two.factor|2fa/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Heading-rank, email reminders, workspace invite (Q52–Q54)
// ─────────────────────────────────────────────────────────────────────────────

describe('Heading rank, email reminders, workspace invite', () => {

  it('Q52 "How do I set staff working hours" → working hours steps, not add-staff steps', async () => {
    const result = await localAnswer('How do I set staff working hours', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/working hours/i);
    expect((result.steps ?? []).length).toBeGreaterThan(0);
    // Must not return the add-staff steps as the primary answer
    const stepText = (result.steps ?? []).join(' ').toLowerCase();
    expect(stepText).not.toMatch(/^go to staff.*\/staff\/new/);
  });

  it('Q53 "How do I send email reminders to clients" → notification/reminder content, not unrelated', async () => {
    const result = await localAnswer('How do I send email reminders to clients', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/notification|reminder|email/i);
    // Must not return FAQ, business-hours, or working-hours chunk
    expect(fullText.toLowerCase()).not.toMatch(/business hours|what is faq|frequently asked/i);
  });

  it('Q54 "How do I invite team members to a workspace" → workspace invite/assign steps', async () => {
    const result = await localAnswer('How do I invite team members to a workspace', 5, MOCK_USER);
    expect(result.type).not.toBe('out_of_scope');
    const fullText = result.answer + ' ' + (result.steps ?? []).join(' ');
    expect(fullText.toLowerCase()).toMatch(/workspace|staff|invite|assign/i);
    // Should surface invite/assign info, not just workspace creation steps
    const stepsText = (result.steps ?? []).join(' ').toLowerCase();
    expect(stepsText).toMatch(/staff|assign|workspace|profile/i);
  });
});
