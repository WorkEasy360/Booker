/**
 * AI Operator — Tool Registry.
 * Each tool declares its schema, permissions, and whether it requires confirmation.
 * Read-only tools execute immediately.
 * Write tools create a pending proposal for the user to confirm.
 */

import db from '../db/init';
import { nanoid } from 'nanoid';
import type { AuthPayload } from '../types';
import { todayInTimezone, getOrgTimezone, freeTimesByStaff } from './availability';
import { staffSlotProblem } from './bookability';
import { addMinutesToTime } from './zoned-time';
import { sendAppointmentEmail } from './email/notify';
import { appointmentState, recordCreated } from './appointment-history';
import { chooseResources, holdResources } from './resources';
import { CUSTOMER_BOOKING_COUNT } from './customer-bookings';
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

// ─── Tool definitions (passed to Claude as tool schemas) ──────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: 'navigate_to_page',
    description: 'Navigate the user to a specific page in the WorkEasy360 dashboard. Use for read-only navigation — this does NOT create or change any data.',
    input_schema: {
      type: 'object' as const,
      required: ['page'],
      properties: {
        page: {
          type: 'string',
          enum: [
            'dashboard', 'appointments', 'appointments/new', 'calendar',
            'customers', 'customers/new', 'services', 'services/new',
            'staff', 'staff/new', 'workspaces', 'resources',
            'booking-pages', 'reports', 'settings', 'my-space',
          ],
          description: 'The page to navigate to',
        },
        reason: { type: 'string', description: 'Brief reason for navigating here' },
      },
    },
  },
  {
    name: 'search_records',
    description: 'Search for customers, services, or staff by name or keyword. Returns matching records from the database.',
    input_schema: {
      type: 'object' as const,
      required: ['recordType', 'query'],
      properties: {
        recordType: {
          type: 'string',
          enum: ['customers', 'services', 'staff', 'appointments'],
        },
        query: { type: 'string', description: 'Search keyword or name to look for' },
      },
    },
  },
  {
    name: 'get_availability',
    description: 'Check available appointment slots for a service on a given date. Returns time slots.',
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
    name: 'get_dashboard_summary',
    description: 'Get a summary of key business metrics: appointment counts, revenue, top services.',
    input_schema: {
      type: 'object' as const,
      properties: {
        range: {
          type: 'string',
          enum: ['7d', '30d', '3m', '1y'],
          description: 'Time range for the summary (default 30d)',
        },
      },
    },
  },
  {
    name: 'propose_create_service',
    description: 'Prepare a proposal to create a new service. The user must confirm before the service is actually created.',
    input_schema: {
      type: 'object' as const,
      required: ['name', 'duration', 'price'],
      properties: {
        name: { type: 'string', description: 'Service name' },
        duration: { type: 'number', description: 'Duration in minutes (e.g. 30, 60, 90)' },
        price: { type: 'number', description: 'Price (numeric, e.g. 500)' },
        category: {
          type: 'string',
          enum: ['consultation', 'class', 'workshop', 'session', 'tour', 'rental', 'other'],
        },
        description: { type: 'string' },
        location: { type: 'string' },
      },
    },
  },
  {
    name: 'propose_create_appointment',
    description: 'Prepare a proposal to create a new appointment. The user must confirm before it is saved. Checks for conflicts first.',
    input_schema: {
      type: 'object' as const,
      required: ['serviceId', 'staffId', 'customerId', 'date', 'startTime'],
      properties: {
        serviceId: { type: 'string' },
        staffId: { type: 'string' },
        customerId: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        startTime: { type: 'string', description: 'HH:MM (24-hour)' },
        notes: { type: 'string' },
      },
    },
  },
  {
    name: 'propose_create_customer',
    description: 'Prepare a proposal to create a new customer. The user must confirm before the customer is saved.',
    input_schema: {
      type: 'object' as const,
      required: ['name', 'email'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        notes: { type: 'string' },
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
      case 'get_dashboard_summary':
        return executeDashboardSummary(input, user);
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
  return {
    type: 'result',
    content: { navigated: true, page },
    navigate: `/${page}`,
  };
}

function executeSearch(input: Record<string, unknown>, user: AuthPayload): ToolResult {
  const recordType = input.recordType as string;
  const query = ((input.query as string) ?? '').toLowerCase().trim();

  let results: unknown[] = [];

  if (recordType === 'customers') {
    results = (db.prepare(`
      SELECT id, name, email, phone, ${CUSTOMER_BOOKING_COUNT} as totalBookings
      FROM customers WHERE organization_id = ?
        AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?)
      ORDER BY name LIMIT 10
    `).all(user.orgId, `%${query}%`, `%${query}%`, `%${query}%`) as unknown[]);
  } else if (recordType === 'services') {
    results = (db.prepare(`
      SELECT id, name, duration, price, currency, category, is_active as isActive
      FROM services WHERE organization_id = ? AND LOWER(name) LIKE ?
      ORDER BY name LIMIT 10
    `).all(user.orgId, `%${query}%`) as unknown[]);
  } else if (recordType === 'staff') {
    results = (db.prepare(`
      SELECT id, name, email, role, title, is_active as isActive
      FROM staff WHERE organization_id = ?
        AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)
      ORDER BY name LIMIT 10
    `).all(user.orgId, `%${query}%`, `%${query}%`) as unknown[]);
  } else if (recordType === 'appointments') {
    results = (db.prepare(`
      SELECT a.id, a.booking_ref as bookingRef, a.date, a.start_time as startTime,
             a.end_time as endTime, a.status,
             s.name as serviceName, st.name as staffName, c.name as customerName
      FROM appointments a
      JOIN services s ON a.service_id = s.id
      JOIN staff st ON a.staff_id = st.id
      JOIN customers c ON a.customer_id = c.id
      WHERE a.organization_id = ?
        AND (LOWER(c.name) LIKE ? OR LOWER(s.name) LIKE ? OR a.booking_ref LIKE ?)
      ORDER BY a.date DESC, a.start_time DESC LIMIT 10
    `).all(user.orgId, `%${query}%`, `%${query}%`, `%${query}%`) as unknown[]);
  }

  return {
    type: 'result',
    content: {
      recordType,
      query,
      count: results.length,
      results,
    },
  };
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

  // Get service details
  const service = db.prepare('SELECT id, name, duration FROM services WHERE id = ? AND organization_id = ?')
    .get(serviceId, user.orgId) as { id: string; name: string; duration: number } | undefined;

  if (!service) {
    return { type: 'result', content: { error: 'Service not found', serviceId } };
  }

  if (!assignedActiveStaff(user.orgId, serviceId, staffId)) {
    return { type: 'result', content: { error: 'No active staff found for this service', serviceId } };
  }

  // The same rules as the New Appointment form: hours, business hours, breaks, time off, closures, buffers.
  const slotsPerStaff = freeTimesByStaff(user.orgId, serviceId, date, staffId)
    .map(s => ({ staffId: s.staffId, staffName: s.staffName, slots: s.times }));

  return {
    type: 'result',
    content: {
      date,
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

function executeDashboardSummary(input: Record<string, unknown>, user: AuthPayload): ToolResult {
  const range = (input.range as string) ?? '30d';
  const days = range === '7d' ? 7 : range === '3m' ? 90 : range === '1y' ? 365 : 30;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status != 'cancelled' THEN price ELSE 0 END) as revenue,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM appointments WHERE organization_id = ? AND date >= ?
  `).get(user.orgId, since) as { total: number; revenue: number; cancelled: number; completed: number };

  const upcoming = (db.prepare(`
    SELECT COUNT(*) as c FROM appointments
    WHERE organization_id = ? AND date >= ? AND status NOT IN ('cancelled', 'completed')
  `).get(user.orgId, new Date().toISOString().slice(0, 10)) as { c: number }).c;

  const customerCount = (db.prepare('SELECT COUNT(*) as c FROM customers WHERE organization_id = ?')
    .get(user.orgId) as { c: number }).c;

  return {
    type: 'result',
    content: {
      range, period: `${days} days`, since,
      totalAppointments: totals.total,
      revenue: totals.revenue ?? 0,
      completed: totals.completed,
      cancelled: totals.cancelled,
      upcomingAppointments: upcoming,
      totalCustomers: customerCount,
    },
  };
}

function executePropose(
  toolName: string,
  input: Record<string, unknown>,
  user: AuthPayload,
  conversationId: string,
): ToolResult {
  let displayData: Record<string, unknown> = {};

  if (toolName === 'propose_create_service') {
    displayData = {
      type: 'Create Service',
      fields: [
        { label: 'Name', value: input.name },
        { label: 'Duration', value: `${input.duration} minutes` },
        { label: 'Price', value: input.price },
        { label: 'Category', value: input.category ?? 'consultation' },
        { label: 'Description', value: input.description ?? '—' },
        { label: 'Location', value: input.location ?? '—' },
      ],
    };
  } else if (toolName === 'propose_create_appointment') {
    // Fetch names for display
    const service = db.prepare('SELECT name, duration FROM services WHERE id = ? AND organization_id = ?')
      .get(input.serviceId, user.orgId) as { name: string; duration: number } | undefined;
    const staff = db.prepare('SELECT name FROM staff WHERE id = ? AND organization_id = ?')
      .get(input.staffId, user.orgId) as { name: string } | undefined;
    const customer = db.prepare('SELECT name FROM customers WHERE id = ? AND organization_id = ?')
      .get(input.customerId, user.orgId) as { name: string } | undefined;

    if (!service) return { type: 'error', content: 'Service not found' };
    if (!staff) return { type: 'error', content: 'Staff member not found' };
    if (!customer) return { type: 'error', content: 'Customer not found' };

    // Validate date is not past (the business's date)
    if ((input.date as string) < todayInTimezone(getOrgTimezone(user.orgId))) {
      return { type: 'error', content: 'Cannot create appointments in the past.' };
    }

    // The same rules as public and dashboard booking: grid, buffers, hours, breaks, time off, closures, conflicts.
    const problem = staffSlotProblem({
      orgId: user.orgId, staffId: input.staffId as string, serviceId: input.serviceId as string,
      date: input.date as string, startTime: input.startTime as string, requireActiveService: true,
    });
    if (problem) return { type: 'error', content: problem.error };
    const endTime = addMinutesToTime(input.startTime as string, service.duration);

    displayData = {
      type: 'Create Appointment',
      fields: [
        { label: 'Service', value: service.name },
        { label: 'Staff', value: staff.name },
        { label: 'Customer', value: customer.name },
        { label: 'Date', value: input.date },
        { label: 'Time', value: `${input.startTime} – ${endTime}` },
        { label: 'Notes', value: input.notes ?? '—' },
      ],
    };
    // Store computed endTime
    input = { ...input, endTime };

  } else if (toolName === 'propose_create_customer') {
    displayData = {
      type: 'Create Customer',
      fields: [
        { label: 'Name', value: input.name },
        { label: 'Email', value: input.email },
        { label: 'Phone', value: input.phone ?? '—' },
        { label: 'Notes', value: input.notes ?? '—' },
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

function executeCreateService(input: Record<string, unknown>, user: AuthPayload) {
  const id = `svc-${nanoid(10)}`;
  db.prepare(`
    INSERT INTO services (id, organization_id, name, description, category, duration, price, currency, location, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT currency FROM organizations WHERE id = ?), ?, 1)
  `).run(
    id, user.orgId,
    input.name, input.description ?? '', input.category ?? 'consultation',
    Number(input.duration), Number(input.price),
    user.orgId,
    input.location ?? '',
  );
  return { id, name: input.name, type: 'service' };
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

  const { price: servicePrice, currency: serviceCurrency } = db.prepare('SELECT price, currency FROM services WHERE id = ?')
    .get(input.serviceId) as { price: number; currency: string };

  const id = `appt-${nanoid(10)}`;
  const bookingRef = `WE-${nanoid(8).toUpperCase()}`;

  // Checked again under the write lock, so the check and the insert are atomic (as for dashboard bookings).
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
         status, date, start_time, end_time, duration, timezone, price, currency, notes, resource_ids)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, '[]')
    `).run(
      id, bookingRef, user.orgId,
      input.serviceId, input.staffId, input.customerId,
      input.date, input.startTime, endTime, service.duration,
      getOrgTimezone(user.orgId), servicePrice, serviceCurrency,
      input.notes ?? '',
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
  // Check for duplicate email
  const existing = db.prepare('SELECT id FROM customers WHERE organization_id = ? AND LOWER(email) = LOWER(?)')
    .get(user.orgId, input.email);
  if (existing) throw new Error(`A customer with email ${input.email} already exists.`);

  const id = `cust-${nanoid(10)}`;
  db.prepare(`
    INSERT INTO customers (id, organization_id, name, email, phone, notes, tags)
    VALUES (?, ?, ?, ?, ?, ?, '[]')
  `).run(id, user.orgId, input.name, input.email, input.phone ?? null, input.notes ?? '');

  return { id, name: input.name, email: input.email, type: 'customer' };
}
