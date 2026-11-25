/**
 * AI Operator — Tool Registry.
 * Each tool declares its schema, permissions, and whether it requires confirmation.
 * Read-only tools execute immediately.
 * Write tools create a pending proposal for the user to confirm.
 *
 * V4 product: four menus (Appointments with its calendar view, Availability, Customers, Settings) and My Account.
 * Services have a name and a duration only (no prices or categories); customers need a phone number or an email
 * address; appointment statuses are scheduled, completed, cancelled and no_show.
 */

import db from '../db/init';
import { nanoid } from 'nanoid';
import type { AuthPayload } from '../types';
import { todayInTimezone, getOrgTimezone, freeTimesByStaff } from './availability';
import { staffSlotProblem } from './bookability';
import { addMinutesToTime } from './zoned-time';
import { sendAppointmentEmail } from './email/notify';
import { appointmentLocation, syncDefaultBookingPage } from './default-booking-page';
import { appointmentState, recordCreated } from './appointment-history';
import { chooseResources, holdResources } from './resources';
import { syncServiceStaff } from './relations';
import { CUSTOMER_BOOKING_COUNT } from './customer-bookings';
import { DEFAULT_CURRENCY } from './business-locale';
import { normalizePhone } from '../lib/phone';
import { can, PROPOSAL_PERMISSIONS } from '../auth/permissions';

// ─── Proposal lifecycle ───────────────────────────────────────────────────────

const PROPOSAL_TTL_MINUTES = 10;

export interface ProposalRecord {
  id: string;
  conversationId: string;
  organizationId: string;
  userId: string;
  toolName: string;
  inputData: Record<string, unknown>;
  displayData: Record<string, unknown>;
  status: 'pending' | 'confirmed' | 'cancelled' | 'executed' | 'failed' | 'expired';
  result?: unknown;
  expiresAt: string;
  createdAt: string;
  executedAt?: string;
}

function createProposal(
  conversationId: string,
  user: AuthPayload,
  toolName: string,
  inputData: Record<string, unknown>,
  displayData: Record<string, unknown>,
): ProposalRecord {
  const id = `prop-${nanoid(12)}`;
  const expiresAt = new Date(Date.now() + PROPOSAL_TTL_MINUTES * 60_000).toISOString();
  db.prepare(`
    INSERT INTO ai_proposals (id, conversation_id, organization_id, user_id, tool_name, input_data, display_data, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, conversationId, user.orgId, user.sub, toolName, JSON.stringify(inputData), JSON.stringify(displayData), expiresAt);

  return getProposal(id)!;
}

export function getProposal(id: string): ProposalRecord | null {
  const row = db.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    organizationId: row.organization_id as string,
    userId: row.user_id as string,
    toolName: row.tool_name as string,
    inputData: JSON.parse(row.input_data as string),
    displayData: JSON.parse(row.display_data as string),
    status: row.status as ProposalRecord['status'],
    result: row.result ? JSON.parse(row.result as string) : undefined,
    expiresAt: row.expires_at as string,
    createdAt: row.created_at as string,
    executedAt: row.executed_at as string | undefined,
  };
}

export function cancelProposal(id: string, user: AuthPayload): { ok: boolean; error?: string } {
  const prop = getProposal(id);
  if (!prop) return { ok: false, error: 'Proposal not found' };
  if (prop.userId !== user.sub || prop.organizationId !== user.orgId)
    return { ok: false, error: 'Not authorized' };
  if (prop.status !== 'pending') return { ok: false, error: `Proposal is already ${prop.status}` };
  db.prepare("UPDATE ai_proposals SET status = 'cancelled' WHERE id = ?").run(id);
  return { ok: true };
}

function auditLog(
  user: AuthPayload,
  action: string,
  opts: { conversationId?: string; proposalId?: string; resourceType?: string; resourceId?: string; details?: unknown }
): void {
  db.prepare(`
    INSERT INTO ai_audit_log (id, organization_id, user_id, conversation_id, proposal_id, action, resource_type, resource_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `audit-${nanoid(10)}`,
    user.orgId, user.sub,
    opts.conversationId ?? null, opts.proposalId ?? null,
    action,
    opts.resourceType ?? null, opts.resourceId ?? null,
    opts.details ? JSON.stringify(opts.details) : null,
  );
}

// ─── Pages the assistant can open ─────────────────────────────────────────────

/** Every screen of the V4 app, by the name the model uses. Earlier screens (dashboard, reports, workspaces…) are gone. */
export const PAGE_ROUTES = {
  'appointments': '/appointments',
  'calendar': '/appointments?view=calendar',
  'new-appointment': '/appointments/new',
  'availability': '/availability',
  'customers': '/customers',
  'new-customer': '/customers/new',
  'settings': '/settings',
  'business-details': '/settings/business',
  'services': '/settings/services',
  'notifications': '/settings/notifications',
  'public-booking': '/settings/public-booking',
  'team': '/settings/team',
  'automation': '/settings/automation',
  'integrations': '/settings/integrations',
  'my-account': '/account',
} as const;

export type PageName = keyof typeof PAGE_ROUTES;
export const PAGE_NAMES = Object.keys(PAGE_ROUTES) as [PageName, ...PageName[]];

// ─── Appointment counts ───────────────────────────────────────────────────────

export const SUMMARY_PERIODS = ['today', 'tomorrow', 'this_week', 'this_month', 'last_7_days', 'last_30_days'] as const;
export type SummaryPeriod = typeof SUMMARY_PERIODS[number];

/** YYYY-MM-DD plus whole days (calendar arithmetic, no time zone involved). */
export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First and last date of a period counted from the business's today. Weeks run Monday to Sunday. */
export function periodRange(period: SummaryPeriod, today: string): { from: string; to: string; label: string } {
  switch (period) {
    case 'today': return { from: today, to: today, label: 'today' };
    case 'tomorrow': { const t = shiftDate(today, 1); return { from: t, to: t, label: 'tomorrow' }; }
    case 'this_week': {
      const monday = shiftDate(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
      return { from: monday, to: shiftDate(monday, 6), label: 'this week' };
    }
    case 'this_month': {
      const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
      return { from: `${today.slice(0, 7)}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), label: 'this month' };
    }
    case 'last_7_days': return { from: shiftDate(today, -6), to: today, label: 'in the last 7 days' };
    case 'last_30_days': return { from: shiftDate(today, -29), to: today, label: 'in the last 30 days' };
  }
}

export interface AppointmentCounts { total: number; scheduled: number; completed: number; cancelled: number; noShow: number }

/** Appointments of the business between two dates (inclusive), by status. */
export function appointmentCounts(orgId: string, from: string, to: string): AppointmentCounts {
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status IN ('scheduled', 'confirmed') THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'no_show' THEN 1 ELSE 0 END) AS noShow
    FROM appointments WHERE organization_id = ? AND date >= ? AND date <= ?
  `).get(orgId, from, to) as Partial<AppointmentCounts>;
  return {
    total: row.total ?? 0, scheduled: row.scheduled ?? 0, completed: row.completed ?? 0,
    cancelled: row.cancelled ?? 0, noShow: row.noShow ?? 0,
  };
}

// ─── Tool definitions (passed to the model as tool schemas) ───────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'navigate_to_page',
    description: 'Open a screen of WorkEasy360 Booking for the user. Read-only: it does not create or change any data. '
      + 'Pages: appointments (list, today\'s figures, booking link), calendar (calendar view of appointments), new-appointment, '
      + 'availability (business and staff working hours, breaks, holidays and time off), customers, new-customer, settings, '
      + 'business-details (name, contact details, timezone, location), services, notifications (email, WhatsApp, SMS, reminder), '
      + 'public-booking (accept online bookings, booking link, change cutoff), team (staff members and their sign-in), '
      + 'automation, integrations (webhooks), my-account (password, two-factor sign-in, language, plan and wallets).',
    input_schema: {
      type: 'object' as const,
      required: ['page'],
      properties: {
        page: {
          type: 'string',
          enum: [...PAGE_NAMES],
          description: 'The page to open',
        },
        reason: { type: 'string', description: 'Brief reason for opening it' },
      },
    },
  },
  {
    name: 'search_records',
    description: 'Search this business\'s customers (by name, phone or email), services, staff members or appointments (by customer name, service or booking reference). Returns matching records.',
    input_schema: {
      type: 'object' as const,
      required: ['recordType', 'query'],
      properties: {
        recordType: {
          type: 'string',
          enum: ['customers', 'services', 'staff', 'appointments'],
        },
        query: { type: 'string', description: 'Name, phone number, email, service or booking reference to look for (empty lists the first records)' },
      },
    },
  },
  {
    name: 'get_availability',
    description: 'Free appointment times for a service on a date, per staff member, with the same rules as the New Appointment form (working hours, breaks, date exceptions, other appointments).',
    input_schema: {
      type: 'object' as const,
      required: ['date', 'serviceId'],
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        serviceId: { type: 'string', description: 'Service ID' },
        staffId: { type: 'string', description: 'Optional staff ID to filter by' },
      },
    },
  },
  {
    name: 'get_appointment_summary',
    description: 'Count this business\'s appointments for a period (in the business timezone) by status: scheduled, completed, cancelled and no-show, plus upcoming appointments and total customers. There are no prices or revenue.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          enum: [...SUMMARY_PERIODS],
          description: 'Period to count (default this_week)',
        },
      },
    },
  },
  {
    name: 'propose_create_service',
    description: 'Prepare a new service (a name and a duration in minutes; services have no price). Every active staff member will offer it. The user must confirm before it is created.',
    input_schema: {
      type: 'object' as const,
      required: ['name', 'duration'],
      properties: {
        name: { type: 'string', description: 'Service name' },
        duration: { type: 'number', description: 'Duration in whole minutes, 5 to 1440 (e.g. 30, 45, 60)' },
      },
    },
  },
  {
    name: 'propose_create_appointment',
    description: 'Prepare a new appointment. The time must be free for the staff member (check get_availability first). The user must confirm before it is saved; the customer then gets the booking confirmation.',
    input_schema: {
      type: 'object' as const,
      required: ['serviceId', 'staffId', 'customerId', 'date', 'startTime'],
      properties: {
        serviceId: { type: 'string' },
        staffId: { type: 'string' },
        customerId: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        startTime: { type: 'string', description: 'HH:MM (24-hour)' },
        internalNote: { type: 'string', description: 'Optional private note for the team, never shown to the customer' },
      },
    },
  },
  {
    name: 'propose_create_customer',
    description: 'Prepare a new customer: a name plus a phone number or an email address (at least one). The user must confirm before the customer is saved.',
    input_schema: {
      type: 'object' as const,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
    },
  },
];

// ─── Tool execution (read-only tools run immediately) ─────────────────────────

export interface ToolResult {
  type: 'result' | 'proposal' | 'error';
  content: unknown;
  proposal?: ProposalRecord;
  navigate?: string;
}

export function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  user: AuthPayload,
  conversationId: string,
): ToolResult {
  try {
    switch (toolName) {
      case 'navigate_to_page':
        return executeNavigate(input);
      case 'search_records':
        return executeSearch(input, user);
      case 'get_availability':
        return executeAvailability(input, user);
      case 'get_appointment_summary':
        return executeAppointmentSummary(input, user);
      case 'propose_create_service':
        return executePropose('propose_create_service', input, user, conversationId);
      case 'propose_create_appointment':
        return executePropose('propose_create_appointment', input, user, conversationId);
      case 'propose_create_customer':
        return executePropose('propose_create_customer', input, user, conversationId);
      default:
        return { type: 'error', content: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { type: 'error', content: err instanceof Error ? err.message : 'Tool execution failed' };
  }
}

function executeNavigate(input: Record<string, unknown>): ToolResult {
  const page = input.page as string;
  const route = Object.prototype.hasOwnProperty.call(PAGE_ROUTES, page) ? PAGE_ROUTES[page as PageName] : undefined;
  if (!route) return { type: 'error', content: `Unknown page: ${page}` };
  return { type: 'result', content: { navigated: true, page }, navigate: route };
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled', confirmed: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

const like = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;
const digitsOf = (q: string) => q.replace(/[\s\-+().]/g, '');

/** Customers matching a name, email or phone (spaces, dashes and the + of a number are ignored). */
export function findCustomers(orgId: string, query: string, limit = 10): Array<Record<string, unknown>> {
  const q = query.toLowerCase().trim();
  const digits = digitsOf(q);
  const phoneMatch = /^\d{3,}$/.test(digits)
    ? ` OR replace(replace(replace(replace(replace(COALESCE(phone, ''), ' ', ''), '-', ''), '+', ''), '(', ''), ')', '') LIKE ? ESCAPE '\\'`
    : '';
  const params: unknown[] = [orgId, like(q), like(q)];
  if (phoneMatch) params.push(like(digits));
  return db.prepare(`
    SELECT id, name, NULLIF(email, '') AS email, phone, ${CUSTOMER_BOOKING_COUNT} AS totalBookings
    FROM customers WHERE organization_id = ?
      AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\'${phoneMatch})
    ORDER BY name LIMIT ${limit}
  `).all(...params) as Array<Record<string, unknown>>;
}

export function findServices(orgId: string, query: string, limit = 10): Array<Record<string, unknown>> {
  return (db.prepare(`
    SELECT id, name, duration, is_active AS isActive FROM services
    WHERE organization_id = ? AND LOWER(name) LIKE ? ESCAPE '\\' ORDER BY is_active DESC, name LIMIT ${limit}
  `).all(orgId, like(query.toLowerCase().trim())) as Array<Record<string, unknown>>)
    .map(s => ({ ...s, isActive: !!s.isActive }));
}

export function findStaff(orgId: string, query: string, limit = 10): Array<Record<string, unknown>> {
  const q = like(query.toLowerCase().trim());
  return (db.prepare(`
    SELECT id, name, email, phone, is_active AS isActive FROM staff
    WHERE organization_id = ? AND (LOWER(name) LIKE ? ESCAPE '\\' OR LOWER(email) LIKE ? ESCAPE '\\')
    ORDER BY is_active DESC, name LIMIT ${limit}
  `).all(orgId, q, q) as Array<Record<string, unknown>>).map(s => ({ ...s, isActive: !!s.isActive }));
}

export function findAppointments(orgId: string, query: string, limit = 10): Array<Record<string, unknown>> {
  const q = like(query.toLowerCase().trim());
  return (db.prepare(`
    SELECT a.id, a.booking_ref AS bookingRef, a.date, a.start_time AS startTime, a.end_time AS endTime, a.status,
           s.name AS serviceName, st.name AS staffName, c.name AS customerName
    FROM appointments a
    JOIN services s ON a.service_id = s.id
    JOIN staff st ON a.staff_id = st.id
    JOIN customers c ON a.customer_id = c.id
    WHERE a.organization_id = ?
      AND (LOWER(c.name) LIKE ? ESCAPE '\\' OR LOWER(s.name) LIKE ? ESCAPE '\\' OR LOWER(a.booking_ref) LIKE ? ESCAPE '\\'
           OR COALESCE(c.phone, '') LIKE ? ESCAPE '\\')
    ORDER BY a.date DESC, a.start_time DESC LIMIT ${limit}
  `).all(orgId, q, q, q, q) as Array<Record<string, unknown>>)
    .map(a => ({ ...a, status: statusLabel(a.status as string) }));
}

/** The permission a record search needs (the same as the page that lists those records). */
function canSearch(user: AuthPayload, recordType: string): boolean {
  if (recordType === 'customers') return can(user.role, 'customers:read');
  if (recordType === 'appointments') return can(user.role, 'appointments:read');
  return can(user.role, 'catalog:read');
}

function executeSearch(input: Record<string, unknown>, user: AuthPayload): ToolResult {
  const recordType = input.recordType as string;
  const query = ((input.query as string) ?? '').trim();
  if (!canSearch(user, recordType)) return { type: 'error', content: `This account cannot see ${recordType}.` };

  const results = recordType === 'customers' ? findCustomers(user.orgId, query)
    : recordType === 'services' ? findServices(user.orgId, query)
    : recordType === 'staff' ? findStaff(user.orgId, query)
    : recordType === 'appointments' ? findAppointments(user.orgId, query)
    : [];

  return { type: 'result', content: { recordType, query, count: results.length, results } };
}

function executeAvailability(input: Record<string, unknown>, user: AuthPayload): ToolResult {
  const date = input.date as string;
  const serviceId = input.serviceId as string;
  const staffId = input.staffId as string | undefined;

  // "Today" is the business's date, not the server's.
  const today = todayInTimezone(getOrgTimezone(user.orgId));
  if (date < today) {
    return { type: 'result', content: { error: 'Cannot check availability for past dates', date } };
  }

  const service = db.prepare('SELECT id, name, duration, is_active FROM services WHERE id = ? AND organization_id = ?')
    .get(serviceId, user.orgId) as { id: string; name: string; duration: number; is_active: number } | undefined;

  if (!service) {
    return { type: 'result', content: { error: 'Service not found', serviceId } };
  }
  if (!service.is_active) {
    return { type: 'result', content: { error: 'This service is inactive and cannot be booked. It can be activated in Settings → Services.', serviceId } };
  }

  if (!assignedActiveStaff(user.orgId, serviceId, staffId)) {
    return { type: 'result', content: { error: 'No active staff member offers this service. Assign it in Settings → Team.', serviceId } };
  }

  // The same rules as the New Appointment form: hours, business hours, breaks, time off, closures, buffers.
  const slotsPerStaff = freeTimesByStaff(user.orgId, serviceId, date, staffId)
    .map(s => ({ staffId: s.staffId, staffName: s.staffName, slots: s.times }));

  return {
    type: 'result',
    content: {
      date,
      timezone: getOrgTimezone(user.orgId),
      serviceName: service.name,
      duration: service.duration,
      slotsPerStaff,
      totalSlots: slotsPerStaff.reduce((s, x) => s + x.slots.length, 0),
    },
  };
}

/** Whether an active staff member is assigned to the service (tells "nobody can do it" from "fully booked"). */
function assignedActiveStaff(orgId: string, serviceId: string, staffId?: string): boolean {
  const svc = db.prepare('SELECT staff_ids FROM services WHERE id = ? AND organization_id = ?')
    .get(serviceId, orgId) as { staff_ids: string | null } | undefined;
  const ids = (JSON.parse(svc?.staff_ids ?? '[]') as string[]).filter(id => !staffId || id === staffId);
  if (!ids.length) return false;
  const placeholders = ids.map(() => '?').join(',');
  return !!db.prepare('SELECT 1 FROM staff WHERE id IN (' + placeholders + ') AND is_active = 1 AND organization_id = ? LIMIT 1')
    .get(...ids, orgId);
}

function executeAppointmentSummary(input: Record<string, unknown>, user: AuthPayload): ToolResult {
  if (!can(user.role, 'appointments:read')) return { type: 'error', content: 'This account cannot see all appointments.' };
  const period = (SUMMARY_PERIODS as readonly string[]).includes(input.period as string) ? input.period as SummaryPeriod : 'this_week';
  const timezone = getOrgTimezone(user.orgId);
  const today = todayInTimezone(timezone);
  const { from, to } = periodRange(period, today);
  const counts = appointmentCounts(user.orgId, from, to);

  const upcoming = (db.prepare(`
    SELECT COUNT(*) AS c FROM appointments WHERE organization_id = ? AND date >= ? AND status IN ('scheduled', 'confirmed')
  `).get(user.orgId, today) as { c: number }).c;
  const totalCustomers = (db.prepare('SELECT COUNT(*) AS c FROM customers WHERE organization_id = ?').get(user.orgId) as { c: number }).c;

  return {
    type: 'result',
    content: {
      period, from, to, timezone,
      totalAppointments: counts.total,
      scheduled: counts.scheduled, completed: counts.completed, cancelled: counts.cancelled, noShow: counts.noShow,
      upcomingAppointments: upcoming,
      totalCustomers,
    },
  };
}

// ─── Proposals ────────────────────────────────────────────────────────────────

/** A customer's contact details checked as the Customers screen checks them; an error message when they are refused. */
function customerContact(orgId: string, input: Record<string, unknown>): { email: string; phone: string | null } | { error: string } {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const rawPhone = typeof input.phone === 'string' ? input.phone.trim() : '';
  if (!email && !rawPhone) return { error: 'A customer needs a phone number or an email address.' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
  let phone: string | null = null;
  if (rawPhone) {
    const checked = normalizePhone(rawPhone);
    if (!checked.ok) return { error: checked.error };
    phone = checked.phone;
  }
  // Never a second record for the same person: the user opens the existing customer instead.
  const byEmail = email
    ? db.prepare("SELECT name FROM customers WHERE organization_id = ? AND email <> '' AND LOWER(email) = ?").get(orgId, email) as { name: string } | undefined
    : undefined;
  if (byEmail) return { error: `${byEmail.name} already has this email address. Use that customer instead.` };
  const byPhone = phone
    ? db.prepare('SELECT name FROM customers WHERE organization_id = ? AND phone = ? LIMIT 1').get(orgId, phone) as { name: string } | undefined
    : undefined;
  if (byPhone) return { error: `${byPhone.name} already has this phone number. Use that customer instead.` };
  return { email, phone };
}

function executePropose(
  toolName: string,
  input: Record<string, unknown>,
  user: AuthPayload,
  conversationId: string,
): ToolResult {
  const needed = PROPOSAL_PERMISSIONS[toolName];
  if (!needed || !can(user.role, needed)) return { type: 'error', content: 'This account does not have permission to do this.' };

  let displayData: Record<string, unknown> = {};

  if (toolName === 'propose_create_service') {
    const name = String(input.name ?? '').trim();
    const duration = Number(input.duration);
    if (!name) return { type: 'error', content: 'A service needs a name.' };
    if (!Number.isInteger(duration) || duration < 5 || duration > 1440) return { type: 'error', content: 'The duration must be whole minutes between 5 and 1440.' };
    if (db.prepare('SELECT 1 FROM services WHERE organization_id = ? AND LOWER(name) = LOWER(?)').get(user.orgId, name)) {
      return { type: 'error', content: `A service called ${name} already exists. It can be edited in Settings → Services.` };
    }
    input = { name, duration };
    displayData = {
      type: 'Create Service',
      fields: [
        { label: 'Name', value: name },
        { label: 'Duration', value: `${duration} minutes` },
        { label: 'Offered by', value: 'Every active team member' },
      ],
    };
  } else if (toolName === 'propose_create_appointment') {
    const service = db.prepare('SELECT name, duration, location FROM services WHERE id = ? AND organization_id = ?')
      .get(input.serviceId, user.orgId) as { name: string; duration: number; location: string | null } | undefined;
    const staff = db.prepare('SELECT name FROM staff WHERE id = ? AND organization_id = ?')
      .get(input.staffId, user.orgId) as { name: string } | undefined;
    const customer = db.prepare('SELECT name, email, phone FROM customers WHERE id = ? AND organization_id = ?')
      .get(input.customerId, user.orgId) as { name: string; email: string | null; phone: string | null } | undefined;

    if (!service) return { type: 'error', content: 'Service not found' };
    if (!staff) return { type: 'error', content: 'Staff member not found' };
    if (!customer) return { type: 'error', content: 'Customer not found' };

    // Validate date is not past (the business's date)
    const timezone = getOrgTimezone(user.orgId);
    if ((input.date as string) < todayInTimezone(timezone)) {
      return { type: 'error', content: 'Cannot create appointments in the past.' };
    }

    // The same rules as public and in-app booking: grid, buffers, hours, breaks, time off, closures, conflicts.
    const problem = staffSlotProblem({
      orgId: user.orgId, staffId: input.staffId as string, serviceId: input.serviceId as string,
      date: input.date as string, startTime: input.startTime as string, requireActiveService: true,
    });
    if (problem) return { type: 'error', content: problem.error };
    const endTime = addMinutesToTime(input.startTime as string, service.duration);
    const note = typeof input.internalNote === 'string' ? input.internalNote.trim() : '';
    const location = appointmentLocation(user.orgId, service.location);

    displayData = {
      type: 'Create Appointment',
      fields: [
        { label: 'Customer', value: customer.name },
        { label: 'Service', value: service.name },
        { label: 'Staff', value: staff.name },
        { label: 'Date', value: input.date },
        { label: 'Time', value: `${input.startTime} – ${endTime}` },
        { label: 'Timezone', value: timezone },
        ...(location ? [{ label: 'Location', value: location }] : []),
        ...(note ? [{ label: 'Internal note', value: note }] : []),
        ...(!customer.email ? [{ label: 'Note', value: 'No email address: the confirmation cannot be emailed to this customer.' }] : []),
      ],
    };
    input = {
      serviceId: input.serviceId, staffId: input.staffId, customerId: input.customerId,
      date: input.date, startTime: input.startTime, internalNote: note,
    };
  } else if (toolName === 'propose_create_customer') {
    const name = String(input.name ?? '').trim();
    if (!name) return { type: 'error', content: 'A customer needs a name.' };
    const contact = customerContact(user.orgId, input);
    if ('error' in contact) return { type: 'error', content: contact.error };
    input = { name, email: contact.email, phone: contact.phone };
    displayData = {
      type: 'Create Customer',
      fields: [
        { label: 'Name', value: name },
        { label: 'Phone', value: contact.phone || '—' },
        { label: 'Email', value: contact.email || '—' },
      ],
    };
  }

  const proposal = createProposal(conversationId, user, toolName, input, displayData);
  auditLog(user, 'proposal_created', {
    conversationId,
    proposalId: proposal.id,
    resourceType: toolName,
    details: input,
  });

  return { type: 'proposal', content: displayData, proposal };
}

// ─── Proposal execution (called after user confirms) ─────────────────────────

export function executeConfirmedProposal(
  proposalId: string,
  user: AuthPayload,
): { ok: boolean; result?: unknown; error?: string } {
  const prop = getProposal(proposalId);
  if (!prop) return { ok: false, error: 'Proposal not found' };
  if (prop.userId !== user.sub || prop.organizationId !== user.orgId)
    return { ok: false, error: 'Not authorized to execute this proposal' };
  // Checked again at execution time: the user's role may have changed since the proposal was made.
  const needed = PROPOSAL_PERMISSIONS[prop.toolName];
  if (!needed || !can(user.role, needed)) return { ok: false, error: 'You do not have permission to do this' };
  if (prop.status !== 'pending') return { ok: false, error: `Proposal is ${prop.status} and cannot be executed` };
  if (new Date(prop.expiresAt) < new Date()) {
    db.prepare("UPDATE ai_proposals SET status = 'expired' WHERE id = ?").run(proposalId);
    return { ok: false, error: 'Proposal has expired. Please create a new one.' };
  }

  // Mark as confirmed atomically to prevent double execution
  const changed = db.prepare("UPDATE ai_proposals SET status = 'confirmed' WHERE id = ? AND status = 'pending'")
    .run(proposalId).changes;
  if (!changed) return { ok: false, error: 'Proposal already executed or cancelled' };

  let result: unknown;
  let executionError: string | undefined;

  try {
    switch (prop.toolName) {
      case 'propose_create_service':
        result = executeCreateService(prop.inputData, user);
        break;
      case 'propose_create_appointment':
        result = executeCreateAppointment(prop.inputData, user);
        break;
      case 'propose_create_customer':
        result = executeCreateCustomer(prop.inputData, user);
        break;
      default:
        throw new Error(`No executor for tool: ${prop.toolName}`);
    }

    db.prepare("UPDATE ai_proposals SET status = 'executed', result = ?, executed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(JSON.stringify(result), proposalId);

    auditLog(user, 'proposal_executed', {
      proposalId,
      resourceType: prop.toolName,
      details: result,
    });

  } catch (err) {
    executionError = err instanceof Error ? err.message : 'Execution failed';
    db.prepare("UPDATE ai_proposals SET status = 'failed', result = ? WHERE id = ?")
      .run(JSON.stringify({ error: executionError }), proposalId);
    return { ok: false, error: executionError };
  }

  return { ok: true, result };
}

/** Saved the way Settings → Services saves a new service: name and duration, offered by every active team member. */
function executeCreateService(input: Record<string, unknown>, user: AuthPayload) {
  const name = String(input.name ?? '').trim();
  const duration = Number(input.duration);
  if (!name) throw new Error('A service needs a name.');
  if (!Number.isInteger(duration) || duration < 5 || duration > 1440) throw new Error('The duration must be whole minutes between 5 and 1440.');
  const id = `svc-${nanoid(10)}`;
  db.transaction(() => {
    const staffIds = (db.prepare('SELECT id FROM staff WHERE organization_id = ? AND is_active = 1').all(user.orgId) as Array<{ id: string }>).map(s => s.id);
    const currency = (db.prepare('SELECT currency FROM organizations WHERE id = ?').get(user.orgId) as { currency: string | null } | undefined)?.currency
      ?? DEFAULT_CURRENCY;
    db.prepare(`
      INSERT INTO services (id, organization_id, name, description, category, duration, price, currency, location, is_active, staff_ids)
      VALUES (?, ?, ?, '', 'consultation', ?, 0, ?, '', 1, ?)
    `).run(id, user.orgId, name, duration, currency, JSON.stringify(staffIds));
    syncServiceStaff(user.orgId, id, staffIds);
    syncDefaultBookingPage(user.orgId);
  })();
  return { id, name, duration, type: 'service' };
}

function executeCreateAppointment(input: Record<string, unknown>, user: AuthPayload) {
  // Re-validate conflict before final execution
  const service = db.prepare('SELECT duration FROM services WHERE id = ? AND organization_id = ?')
    .get(input.serviceId, user.orgId) as { duration: number };
  if (!service) throw new Error('Service not found');
  if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(input.staffId, user.orgId)) {
    throw new Error('Staff member not found');
  }
  if (!db.prepare('SELECT 1 FROM customers WHERE id = ? AND organization_id = ?').get(input.customerId, user.orgId)) {
    throw new Error('Customer not found');
  }

  // The end always follows the service duration; a proposal cannot carry its own end time.
  const endTime = addMinutesToTime(input.startTime as string, service.duration);

  const today = todayInTimezone(getOrgTimezone(user.orgId));
  if ((input.date as string) < today) throw new Error('Cannot create appointments in the past.');

  const slotCheck = {
    orgId: user.orgId, staffId: input.staffId as string, serviceId: input.serviceId as string,
    date: input.date as string, startTime: input.startTime as string, requireActiveService: true,
  };
  const early = staffSlotProblem(slotCheck);
  if (early) throw new Error(early.error);

  const { price: servicePrice, currency: serviceCurrency, location: serviceLocation } = db.prepare('SELECT price, currency, location FROM services WHERE id = ?')
    .get(input.serviceId) as { price: number; currency: string; location: string | null };

  const id = `appt-${nanoid(10)}`;
  const bookingRef = `WE-${nanoid(8).toUpperCase()}`;
  // Proposals made before internal notes existed carried "notes"; either way it is a private note for the team.
  const internalNote = String(input.internalNote ?? input.notes ?? '').trim();

  // Checked again under the write lock, so the check and the insert are atomic (as for in-app bookings).
  db.transaction(() => {
    const problem = staffSlotProblem(slotCheck);
    if (problem) throw new Error(problem.error);
    const resources = chooseResources({
      orgId: user.orgId, serviceId: input.serviceId as string, date: input.date as string, startTime: input.startTime as string, endTime,
    });
    if ('error' in resources) throw new Error(resources.error);
    db.prepare(`
      INSERT INTO appointments
        (id, booking_ref, organization_id, service_id, staff_id, customer_id,
         status, date, start_time, end_time, duration, timezone, price, currency, notes, internal_notes, resource_ids, location)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, '', ?, '[]', ?)
    `).run(
      id, bookingRef, user.orgId,
      input.serviceId, input.staffId, input.customerId,
      input.date, input.startTime, endTime, service.duration,
      getOrgTimezone(user.orgId), servicePrice, serviceCurrency,
      internalNote, appointmentLocation(user.orgId, serviceLocation),
    );

    // Update customer stats
    db.prepare(`UPDATE customers SET total_bookings = total_bookings + 1, last_booking_date = ? WHERE id = ? AND organization_id = ?`)
      .run(input.date, input.customerId, user.orgId);
    holdResources(id, user.orgId, resources.ids);
    recordCreated(appointmentState(id)!, { type: 'user', userId: user.sub, source: 'assistant' });
  }).immediate();

  // Proposal execution is synchronous; the outcome is recorded in email_deliveries and shown on the appointment.
  void sendAppointmentEmail('confirmation', id);

  return { id, bookingRef, type: 'appointment', date: input.date, startTime: input.startTime };
}

function executeCreateCustomer(input: Record<string, unknown>, user: AuthPayload) {
  // V4: a name plus a phone number or an email address, never a duplicate of an existing customer.
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('A customer needs a name.');
  const contact = customerContact(user.orgId, input);
  if ('error' in contact) throw new Error(contact.error);

  const id = `cust-${nanoid(10)}`;
  db.prepare(`
    INSERT INTO customers (id, organization_id, name, email, phone, notes, tags)
    VALUES (?, ?, ?, ?, ?, '', '[]')
  `).run(id, user.orgId, name, contact.email, contact.phone);

  return { id, name, email: contact.email || null, phone: contact.phone, type: 'customer' };
}
