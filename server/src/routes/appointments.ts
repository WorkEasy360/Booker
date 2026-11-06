import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { can } from '../auth/permissions';
import { missingIds } from '../services/relations';
import { RULES, consume, sendRateLimited } from '../middleware/rate-limit';
import { getAvailableSlots, todayInTimezone, getOrgTimezone } from '../services/availability';
import { staffSlotProblem, type SlotProblem } from '../services/bookability';
import { toMinutes } from '../services/schedule';
import { DateString, TimeString } from '../validation';
import { sendAppointmentEmail, listDeliveries } from '../services/email/notify';
import { APPOINTMENT_STATUSES, INITIAL_STATUSES, statusChangeProblem, type StatusProblem } from '../services/appointment-status';
import { appointmentState, listHistory, recordChanges, recordCreated, recordDeleted, type HistoryActor } from '../services/appointment-history';
import { chooseResources, heldResources, holdResources, releaseResources } from '../services/resources';

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('appointments:read', 'appointments:read_own');
const canWrite = requirePermission('appointments:write');

/**
 * Which appointments the user may see: all of the organization's, or only those assigned to their own staff record.
 * A staff account without a linked staff record sees none.
 */
function visibleStaffId(req: AuthRequest): { all: true } | { all: false; staffId: string | null } {
  return can(req.user!.role, 'appointments:read') ? { all: true } : { all: false, staffId: req.user!.staffId ?? null };
}

/** Changes made from the dashboard are recorded against the signed-in user. */
function dashboardActor(req: AuthRequest): HistoryActor {
  return { type: 'user', userId: req.user!.sub, source: 'dashboard' };
}

function orgToday(orgId: string): string {
  return todayInTimezone(getOrgTimezone(orgId));
}

type OrgTable = 'services' | 'staff' | 'customers' | 'workspaces' | 'appointments';

function belongsToOrg(table: OrgTable, id: string, orgId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND organization_id = ?`).get(id, orgId);
}

/** Returns an error message if any referenced record is missing or belongs to another organization. */
function invalidReference(orgId: string, refs: { staffId?: string; customerId?: string; workspaceId?: string | null; resourceIds?: string[] }): string | null {
  if (refs.staffId !== undefined && !belongsToOrg('staff', refs.staffId, orgId)) return 'Staff member not found';
  if (refs.customerId !== undefined && !belongsToOrg('customers', refs.customerId, orgId)) return 'Customer not found';
  if (refs.workspaceId && !belongsToOrg('workspaces', refs.workspaceId, orgId)) return 'Workspace not found';
  if (refs.resourceIds?.length && missingIds('resources', refs.resourceIds, orgId).length) return 'Resource not found';
  return null;
}

// Statuses that do not occupy the staff member's time (the same set the availability service and the overlap
// triggers use).
const INACTIVE_STATUSES = ['cancelled', 'no_show'];

const isSlotProblem = (r: Record<string, unknown> | SlotProblem): r is SlotProblem =>
  typeof (r as SlotProblem).error === 'string' && typeof (r as SlotProblem).status === 'number' && !('id' in r);

const AppointmentSchema = z.object({
  workspaceId: z.string().max(64).optional(),
  serviceId: z.string().min(1).max(64),
  staffId: z.string().min(1).max(64),
  customerId: z.string().min(1).max(64),
  resourceIds: z.array(z.string().max(64)).max(50).optional(),
  status: z.enum(APPOINTMENT_STATUSES).default('scheduled'),
  date: DateString,
  startTime: TimeString,
  // Accepted for backwards compatibility but ignored: appointments always use the business time zone.
  timezone: z.string().optional(),
  notes: z.string().max(2000).optional(),
  internalNotes: z.string().max(5000).optional(),
  customerAnswers: z.array(z.unknown()).max(50).optional(),
});

function rowToAppointment(row: Record<string, unknown>) {
  return {
    id: row.id,
    bookingRef: row.booking_ref,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id ?? null,
    serviceId: row.service_id,
    staffId: row.staff_id,
    customerId: row.customer_id,
    resourceIds: JSON.parse(row.resource_ids as string ?? '[]'),
    status: row.status,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    duration: row.duration,
    timezone: row.timezone,
    price: row.price,
    currency: row.currency,
    location: row.location ?? '',
    notes: row.notes ?? '',
    internalNotes: row.internal_notes ?? '',
    customerAnswers: JSON.parse(row.customer_answers as string ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAppointmentWithNames(row: Record<string, unknown>) {
  return {
    ...rowToAppointment(row),
    customerName: (row.customer_name as string) ?? '',
    customerEmail: (row.customer_email as string) ?? '',
    serviceName: (row.service_name as string) ?? '',
    serviceColor: (row.service_color as string) ?? '#00BF62',
    staffName: (row.staff_name as string) ?? '',
    staffColor: (row.staff_color as string) ?? '#94A3B8',
  };
}

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

function generateRef(): string {
  return 'WE-' + nanoid(8).toUpperCase();
}

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const { date, staffId, status, customerId, q } = req.query as Record<string, string | undefined>;
    const scope = visibleStaffId(req);
    if (!scope.all && !scope.staffId) { res.json({ data: [] }); return; }
    let sql = `
      SELECT a.*,
        c.name  AS customer_name,  c.email AS customer_email,
        s.name  AS service_name,   s.color AS service_color,
        st.name AS staff_name,     st.color AS staff_color
      FROM appointments a
      LEFT JOIN customers c  ON a.customer_id = c.id
      LEFT JOIN services  s  ON a.service_id  = s.id
      LEFT JOIN staff     st ON a.staff_id    = st.id
      WHERE a.organization_id = ?`;
    const params: unknown[] = [req.user!.orgId];

    if (!scope.all) { sql += ' AND a.staff_id = ?';    params.push(scope.staffId); }
    if (date)       { sql += ' AND a.date = ?';        params.push(date); }
    if (staffId)    { sql += ' AND a.staff_id = ?';    params.push(staffId); }
    if (status)     { sql += ' AND a.status = ?';      params.push(status); }
    if (customerId) { sql += ' AND a.customer_id = ?'; params.push(customerId); }
    if (q?.trim()) {
      const like = `%${q.trim().replace(/[\\%_]/g, m => '\\' + m)}%`;
      sql += " AND (c.name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR a.booking_ref LIKE ? ESCAPE '\\')";
      params.push(like, like, like);
    }

    sql += ' ORDER BY a.date DESC, a.start_time ASC';
    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    res.json({ data: rows.map(rowToAppointmentWithNames) });
  } catch (err) { next(err); }
});

router.get('/availability', canWrite, (req: AuthRequest, res, next) => {
  try {
    const { date, serviceId, staffId, excludeAppointmentId } = req.query as Record<string, string | undefined>;
    if (!date || !serviceId || !staffId) {
      res.status(400).json({ error: 'date, serviceId, and staffId are required' });
      return;
    }
    // Another organization's staff schedule must not be readable through this endpoint.
    if (!belongsToOrg('staff', staffId, req.user!.orgId)) { res.status(404).json({ error: 'Staff member not found' }); return; }
    // When rescheduling, the appointment being moved does not block its own times.
    if (excludeAppointmentId !== undefined && !belongsToOrg('appointments', excludeAppointmentId, req.user!.orgId)) {
      res.status(404).json({ error: 'Appointment not found' });
      return;
    }

    const svc = db
      .prepare('SELECT duration, buffer_before, buffer_after FROM services WHERE id = ? AND organization_id = ?')
      .get(serviceId, req.user!.orgId) as
      | { duration: number; buffer_before: number; buffer_after: number }
      | undefined;

    if (!svc) { res.status(404).json({ error: 'Service not found' }); return; }

    const slots = getAvailableSlots({
      date, serviceId, staffId,
      duration: svc.duration,
      bufferBefore: svc.buffer_before,
      bufferAfter: svc.buffer_after,
      skipMinNotice: true, // admin staff can book same-day; min notice is for public booking only
      excludeAppointmentId,
    });

    res.json({ data: slots });
  } catch (err) { next(err); }
});

router.get('/:id', canRead, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare(
        `SELECT a.*,
          c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
          s.name AS service_name, s.color AS service_color,
          st.name AS staff_name, st.color AS staff_color, st.title AS staff_title
         FROM appointments a
         LEFT JOIN customers c  ON a.customer_id = c.id
         LEFT JOIN services  s  ON a.service_id  = s.id
         LEFT JOIN staff     st ON a.staff_id    = st.id
         WHERE a.id = ? AND a.organization_id = ?`
      )
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    const scope = visibleStaffId(req);
    if (!row || (!scope.all && row.staff_id !== scope.staffId)) { res.status(404).json({ error: 'Appointment not found' }); return; }
    res.json({ data: {
      ...rowToAppointmentWithNames(row),
      serviceColor: (row.service_color as string) ?? '#00BF62',
      staffTitle: (row.staff_title as string) ?? '',
      customerPhone: (row.customer_phone as string) ?? '',
    }});
  } catch (err) { next(err); }
});

router.post('/', canWrite, async (req: AuthRequest, res, next) => {
  if (req.body && typeof req.body === 'object' && 'status' in req.body
    && !(INITIAL_STATUSES as unknown[]).includes((req.body as { status?: unknown }).status)) {
    res.status(400).json({ error: 'A new appointment can only be scheduled or confirmed.', code: 'INVALID_STATUS_CHANGE' });
    return;
  }
  try {
    const data = AppointmentSchema.parse(req.body);

    if (data.date < orgToday(req.user!.orgId)) {
      res.status(400).json({ error: 'Cannot create appointments in the past.' });
      return;
    }

    const refError = invalidReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }

    const svc = db
      .prepare('SELECT duration, price, currency, location FROM services WHERE id = ? AND organization_id = ?')
      .get(data.serviceId, req.user!.orgId) as
      | { duration: number; price: number; currency: string; location: string }
      | undefined;
    if (!svc) { res.status(400).json({ error: 'Service not found' }); return; }

    const endTime = addMinutes(data.startTime, svc.duration);
    // The rules public booking uses: grid, buffers, hours, breaks, time off, closures, conflicts (services/bookability.ts).
    const slotCheck = { orgId: req.user!.orgId, staffId: data.staffId, serviceId: data.serviceId, date: data.date, startTime: data.startTime, requireActiveService: true };
    const early = staffSlotProblem(slotCheck);
    if (early) { res.status(early.status).json({ error: early.error }); return; }
    const bookingRef = generateRef();
    const id = `appt-${nanoid(8)}`;
    const orgId = req.user!.orgId;

    const createAppointment = db.transaction((): Record<string, unknown> | SlotProblem => {
      // Checked again under the write lock, so a booking made meanwhile is seen.
      const problem = staffSlotProblem(slotCheck);
      if (problem) return problem;
      // Staff may name the resources; otherwise one free resource of the service's pool, if it needs one.
      const resources = chooseResources({
        orgId, serviceId: data.serviceId, date: data.date, startTime: data.startTime, endTime,
        workspaceId: data.workspaceId ?? null, explicit: data.resourceIds,
      });
      if ('error' in resources) return resources;
      db.prepare(
        `INSERT INTO appointments
          (id, booking_ref, organization_id, workspace_id, service_id, staff_id, customer_id,
           resource_ids, status, date, start_time, end_time, duration, timezone, price, currency,
           location, notes, internal_notes, customer_answers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, bookingRef, orgId,
        data.workspaceId ?? null, data.serviceId, data.staffId, data.customerId,
        '[]', data.status,
        data.date, data.startTime, endTime, svc.duration,
        getOrgTimezone(orgId),
        svc.price, svc.currency, svc.location,
        data.notes ?? '', data.internalNotes ?? '',
        JSON.stringify(data.customerAnswers ?? [])
      );
      db.prepare(
        `UPDATE customers SET total_bookings = total_bookings + 1, last_booking_date = ? WHERE id = ? AND organization_id = ?`
      ).run(data.date, data.customerId, orgId);
      holdResources(id, orgId, resources.ids);
      recordCreated(appointmentState(id)!, dashboardActor(req));
      return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id) as Record<string, unknown>;
    });

    // IMMEDIATE takes the write lock before the conflict check, so concurrent writers cannot interleave.
    const row = createAppointment.immediate();
    if (isSlotProblem(row)) { res.status(row.status).json({ error: row.error }); return; }
    const email = await sendAppointmentEmail('confirmation', row.id as string);
    res.status(201).json({ data: { ...rowToAppointment(row), email } });
  } catch (err) { next(err); }
});

router.put('/:id', canWrite, async (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id, status, service_id, staff_id, customer_id, workspace_id, date, start_time, end_time, timezone FROM appointments WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as
      | { id: string; status: string; service_id: string; staff_id: string; customer_id: string; workspace_id: string | null; date: string; start_time: string; end_time: string; timezone: string }
      | undefined;
    if (!existing) { res.status(404).json({ error: 'Appointment not found' }); return; }

    const data = AppointmentSchema.partial().parse(req.body);

    // Reject reschedule to a past date
    if (data.date !== undefined && data.date < orgToday(req.user!.orgId)) {
      res.status(400).json({ error: 'Cannot reschedule to a date in the past.' });
      return;
    }

    const refError = invalidReference(req.user!.orgId, { staffId: data.staffId, workspaceId: data.workspaceId });
    if (refError) { res.status(400).json({ error: refError }); return; }
    if (data.serviceId !== undefined && data.serviceId !== existing.service_id) {
      res.status(400).json({ error: 'Changing the service of an existing appointment is not supported. Cancel and create a new one.' });
      return;
    }
    if (data.customerId !== undefined && data.customerId !== existing.customer_id) {
      res.status(400).json({ error: 'Changing the customer of an existing appointment is not supported.' });
      return;
    }

    const newDate     = data.date     ?? existing.date;
    const newStaffId  = data.staffId  ?? existing.staff_id;
    const newStartTime = data.startTime ?? existing.start_time;

    // Recompute end_time when startTime changes
    let newEndTime = existing.end_time;
    if (data.startTime !== undefined) {
      const svc = db.prepare('SELECT duration FROM services WHERE id = ?').get(existing.service_id) as { duration: number } | undefined;
      if (svc) newEndTime = addMinutes(newStartTime, svc.duration);
    }

    // A move (date, time or staff) or bringing back a cancelled / no-show appointment is a booking: the same rules as
    // public booking apply. Edits that keep an active appointment where it is (status, notes) are not re-checked, so
    // appointments made before these rules stay editable.
    const timeOrStaffChanged = data.date !== undefined || data.startTime !== undefined || data.staffId !== undefined;
    const reactivated = INACTIVE_STATUSES.includes(existing.status) && data.status !== undefined && !INACTIVE_STATUSES.includes(data.status);
    const mustCheck = timeOrStaffChanged || reactivated;
    const slotCheck = {
      orgId: req.user!.orgId, staffId: newStaffId, serviceId: existing.service_id, date: newDate, startTime: newStartTime,
      durationMinutes: toMinutes(newEndTime) - toMinutes(newStartTime), excludeAppointmentId: req.params.id, requireActiveService: false,
    };
    const statusProblem = (from: string) => data.status === undefined ? null
      : statusChangeProblem(from, data.status, { date: newDate, startTime: newStartTime, timezone: existing.timezone });
    const earlyStatus = statusProblem(existing.status);
    if (earlyStatus) { res.status(earlyStatus.status).json({ error: earlyStatus.error, code: earlyStatus.code }); return; }
    if (mustCheck) {
      const early = staffSlotProblem(slotCheck);
      if (early) { res.status(early.status).json({ error: early.error }); return; }
    }

    const doUpdate = db.transaction((): Record<string, unknown> | SlotProblem | StatusProblem => {
      // Checked again under the write lock: another request may have changed the status since it was read.
      const now = appointmentState(req.params.id);
      if (!now) return { status: 409, code: 'INVALID_STATUS_CHANGE', error: 'The appointment no longer exists.' } as StatusProblem;
      const problem = statusProblem(now.status);
      if (problem) return problem;
      if (mustCheck) {
        const slot = staffSlotProblem(slotCheck);
        if (slot) return slot;
      }
      // A booking that stays or becomes active at a new time (or comes back) needs its resources free again: the same
      // ones if possible, otherwise another of the service's pool. They are released first and held again after the
      // move, so the database check sees the new time.
      const finalStatus = data.status ?? now.status;
      let resourcePlan: string[] | null = null;
      if ((mustCheck || data.resourceIds !== undefined || data.workspaceId !== undefined) && !INACTIVE_STATUSES.includes(finalStatus)) {
        const chosen = chooseResources({
          orgId: req.user!.orgId, serviceId: existing.service_id, date: newDate, startTime: newStartTime, endTime: newEndTime,
          excludeAppointmentId: req.params.id, workspaceId: data.workspaceId !== undefined ? data.workspaceId : existing.workspace_id,
          explicit: data.resourceIds, keep: heldResources(req.params.id),
        });
        if ('error' in chosen) return chosen;
        resourcePlan = chosen.ids;
        releaseResources(req.params.id);
      }

      const sets: string[] = ['updated_at = (strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\'))'];
      const vals: unknown[] = [];

      if (data.status !== undefined)        { sets.push('status = ?');         vals.push(data.status); }
      if (data.date !== undefined)          { sets.push('date = ?');           vals.push(data.date); }
      if (data.startTime !== undefined)     { sets.push('start_time = ?');     vals.push(data.startTime); }
      if (data.startTime !== undefined)     { sets.push('end_time = ?');       vals.push(newEndTime); }
      if (data.notes !== undefined)         { sets.push('notes = ?');          vals.push(data.notes); }
      if (data.internalNotes !== undefined) { sets.push('internal_notes = ?'); vals.push(data.internalNotes); }
      if (data.staffId !== undefined)       { sets.push('staff_id = ?');       vals.push(data.staffId); }
      if (data.workspaceId !== undefined)   { sets.push('workspace_id = ?');   vals.push(data.workspaceId); }

      db.prepare(`UPDATE appointments SET ${sets.join(', ')} WHERE id = ? AND status = ?`).run(...vals, req.params.id, now.status);
      if (resourcePlan) holdResources(req.params.id, req.user!.orgId, resourcePlan);
      recordChanges(now, appointmentState(req.params.id)!, dashboardActor(req));
      return db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    });

    const row = doUpdate.immediate();
    if ('code' in row && (row.code === 'INVALID_STATUS_CHANGE' || row.code === 'APPOINTMENT_NOT_STARTED')) {
      res.status(409).json({ error: row.error, code: row.code });
      return;
    }
    if (isSlotProblem(row)) { res.status(row.status).json({ error: row.error }); return; }
    // Notify the customer only about changes they care about; status-only edits like "completed" send nothing.
    let email: Awaited<ReturnType<typeof sendAppointmentEmail>> | undefined;
    if (data.status === 'cancelled' && existing.status !== 'cancelled') {
      email = await sendAppointmentEmail('cancellation', existing.id);
    } else if ((row.date !== existing.date || row.start_time !== existing.start_time) && row.status !== 'cancelled') {
      email = await sendAppointmentEmail('reschedule', existing.id, { date: existing.date, startTime: existing.start_time, endTime: existing.end_time });
    }
    res.json({ data: { ...rowToAppointment(row), ...(email ? { email } : {}) } });
  } catch (err) { next(err); }
});

// Who created, moved, reassigned, cancelled or completed the appointment, and when. Read-only: there is no route that
// changes or removes an entry, and the database refuses to. Staff accounts see the history of their own appointments.
router.get('/:id/history', canRead, (req: AuthRequest, res, next) => {
  try {
    const appt = db.prepare('SELECT staff_id FROM appointments WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as { staff_id: string } | undefined;
    const scope = visibleStaffId(req);
    if (!appt || (!scope.all && appt.staff_id !== scope.staffId)) { res.status(404).json({ error: 'Appointment not found' }); return; }
    res.json({ data: listHistory(req.user!.orgId, req.params.id) });
  } catch (err) { next(err); }
});

router.get('/:id/emails', requirePermission('appointments:read'), (req: AuthRequest, res, next) => {
  try {
    const exists = db.prepare('SELECT 1 FROM appointments WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId);
    if (!exists) { res.status(404).json({ error: 'Appointment not found' }); return; }
    res.json({ data: listDeliveries(req.user!.orgId, req.params.id) });
  } catch (err) { next(err); }
});

const ResendSchema = z.object({ kind: z.enum(['confirmation', 'reschedule', 'cancellation']) });

router.post('/:id/emails', requirePermission('emails:send'), async (req: AuthRequest, res, next) => {
  try {
    const { kind } = ResendSchema.parse(req.body);
    const appt = db.prepare('SELECT status FROM appointments WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as { status: string } | undefined;
    if (!appt) { res.status(404).json({ error: 'Appointment not found' }); return; }
    // Resends go to a real inbox: a few per booking, and a ceiling per business.
    const limit = consume([
      { rule: RULES.resendAppointment, key: req.params.id },
      { rule: RULES.resendOrg, key: req.user!.orgId },
    ]);
    if (!limit.allowed) { sendRateLimited(res, limit.retryAfterMs); return; }
    if ((kind === 'cancellation') !== (appt.status === 'cancelled')) {
      res.status(400).json({ error: kind === 'cancellation' ? 'Only cancelled appointments can get a cancellation email' : 'This appointment is cancelled' });
      return;
    }
    // An explicit resend is a new email (it is not de-duplicated against earlier ones).
    res.json({ data: await sendAppointmentEmail(kind, req.params.id, undefined, { manual: true }) });
  } catch (err) { next(err); }
});

router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    // The deletion is recorded with the appointment's last state; the history entry stays after the appointment is gone.
    const deleted = db.transaction((): boolean => {
      const before = appointmentState(req.params.id, req.user!.orgId);
      if (!before) return false;
      recordDeleted(before, dashboardActor(req));
      return db.prepare('DELETE FROM appointments WHERE id = ? AND organization_id = ?').run(req.params.id, req.user!.orgId).changes > 0;
    }).immediate();
    if (!deleted) { res.status(404).json({ error: 'Appointment not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

export default router;
