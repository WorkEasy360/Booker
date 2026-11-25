// Staff time off (leave, part-day absences), business closures (holidays) and weekly breaks, which block new bookings.
// Existing appointments are never changed: creating a period that overlaps them returns those appointments as
// conflicts, so the business can contact the customers.
import { Router, type Response } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { can } from '../auth/permissions';
import { DateString, TimeString, isRealDate } from '../validation';
import { businessHours, dayName, scheduleProblem } from '../services/schedule';
import { getOrgTimezone, todayInTimezone } from '../services/availability';

const router = Router();
router.use(requireAuth);

const TimeOffSchema = z.object({
  /** Omit (or null) for a closure of the whole business. */
  staffId: z.string().min(1).max(64).nullable().optional(),
  startDate: DateString,
  endDate: DateString,
  /** Both or neither: without times the whole of each day is blocked. */
  startTime: TimeString.optional(),
  endTime: TimeString.optional(),
  reason: z.string().trim().max(200).optional(),
}).strict()
  .refine(d => isRealDate(d.startDate) && isRealDate(d.endDate), { message: 'Dates must be real calendar dates (YYYY-MM-DD)' })
  .refine(d => d.endDate >= d.startDate, { message: 'The end date must be on or after the start date', path: ['endDate'] })
  .refine(d => (Date.parse(`${d.endDate}T00:00:00Z`) - Date.parse(`${d.startDate}T00:00:00Z`)) / 86_400_000 <= 366, { message: 'A period can be at most a year long', path: ['endDate'] })
  .refine(d => (d.startTime === undefined) === (d.endTime === undefined), { message: 'Give both a start and an end time, or neither for whole days', path: ['endTime'] })
  .refine(d => !d.startTime || !d.endTime || d.endTime > d.startTime, { message: 'The end time must be after the start time', path: ['endTime'] });

interface Row {
  id: string; staff_id: string | null; start_date: string; end_date: string; start_time: string | null; end_time: string | null;
  reason: string; created_at: string; staff_name?: string | null;
}
const toApi = (r: Row) => ({
  id: r.id, staffId: r.staff_id, staffName: r.staff_name ?? null, startDate: r.start_date, endDate: r.end_date,
  startTime: r.start_time, endTime: r.end_time, reason: r.reason, wholeDay: !r.start_time, createdAt: r.created_at,
});

/** Staff time off needs staff management; a closure of the whole business needs the business settings permission. */
function mayChange(req: AuthRequest, staffId: string | null, res: Response): boolean {
  const ok = staffId ? can(req.user?.role, 'staff:manage') : can(req.user?.role, 'settings:write');
  if (!ok) res.status(403).json({ error: 'You do not have permission to do this', code: 'FORBIDDEN' });
  return ok;
}

/**
 * Reading availability: owners and people who book see everything; staff who only see their own appointments see
 * their own rows and the business's (closures, business hours), never another provider's.
 */
const canReadAvailability = requirePermission('appointments:write', 'staff:manage', 'appointments:read_own');
type ReadScope = { all: true } | { all: false; staffId: string | null };
function readScope(req: AuthRequest): ReadScope {
  const role = req.user?.role;
  return can(role, 'appointments:write') || can(role, 'staff:manage') ? { all: true } : { all: false, staffId: req.user?.staffId ?? null };
}
/** SQL condition and values limiting rows (of the given alias) to the scope and an optional staffId filter. */
function scopeCondition(scope: ReadScope, staffId: string | undefined, alias: string): { sql: string; vals: unknown[] } {
  if (scope.all) return staffId ? { sql: `(${alias}.staff_id = ? OR ${alias}.staff_id IS NULL)`, vals: [staffId] } : { sql: '1 = 1', vals: [] };
  if (!scope.staffId || (staffId && staffId !== scope.staffId)) return { sql: `${alias}.staff_id IS NULL`, vals: [] };
  return { sql: `(${alias}.staff_id = ? OR ${alias}.staff_id IS NULL)`, vals: [scope.staffId] };
}

// ─── Weekly breaks ───────────────────────────────────────────────────────────

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
const BreakSchema = z.object({
  /** Omit (or null) for a break of the whole business. */
  staffId: z.string().min(1).max(64).nullable().optional(),
  weekday: z.enum(WEEKDAYS),
  startTime: TimeString,
  endTime: TimeString,
  label: z.string().trim().max(100).optional(),
}).strict().refine(d => d.endTime > d.startTime, { message: 'The end time must be after the start time', path: ['endTime'] });

interface BreakRow { id: string; staff_id: string | null; weekday: string; start_time: string; end_time: string; label: string; staff_name?: string | null }
const breakToApi = (b: BreakRow) => ({ id: b.id, staffId: b.staff_id, staffName: b.staff_name ?? null, weekday: b.weekday, startTime: b.start_time, endTime: b.end_time, label: b.label });

router.get('/breaks', canReadAvailability, (req: AuthRequest, res, next) => {
  try {
    const { staffId } = req.query as Record<string, string | undefined>;
    const scope = scopeCondition(readScope(req), staffId, 'b');
    const rows = db.prepare(
      `SELECT b.*, s.name AS staff_name FROM schedule_breaks b LEFT JOIN staff s ON s.id = b.staff_id AND s.organization_id = b.organization_id
       WHERE b.organization_id = ? AND ${scope.sql} ORDER BY b.weekday, b.start_time`
    ).all(req.user!.orgId, ...scope.vals) as BreakRow[];
    res.json({ data: rows.map(breakToApi) });
  } catch (err) { next(err); }
});

router.post('/breaks', requirePermission('staff:manage', 'settings:write'), (req: AuthRequest, res, next) => {
  try {
    const parsed = BreakSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
    const d = parsed.data;
    const staffId = d.staffId ?? null;
    if (!mayChange(req, staffId, res)) return;
    if (staffId && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(staffId, req.user!.orgId)) {
      res.status(404).json({ error: 'Staff member not found' }); return;
    }
    const id = `brk-${nanoid(10)}`;
    db.prepare('INSERT INTO schedule_breaks (id, organization_id, staff_id, weekday, start_time, end_time, label) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, req.user!.orgId, staffId, d.weekday, d.startTime, d.endTime, d.label ?? '');
    const row = db.prepare('SELECT b.*, s.name AS staff_name FROM schedule_breaks b LEFT JOIN staff s ON s.id = b.staff_id WHERE b.id = ?').get(id) as BreakRow;
    res.status(201).json({ data: breakToApi(row) });
  } catch (err) { next(err); }
});

router.delete('/breaks/:id', requirePermission('staff:manage', 'settings:write'), (req: AuthRequest, res, next) => {
  try {
    const row = db.prepare('SELECT staff_id FROM schedule_breaks WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId) as { staff_id: string | null } | undefined;
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    if (!mayChange(req, row.staff_id, res)) return;
    db.prepare('DELETE FROM schedule_breaks WHERE id = ? AND organization_id = ?').run(req.params.id, req.user!.orgId);
    res.json({ data: { id: req.params.id } });
  } catch (err) { next(err); }
});

// ─── Different hours on a specific date ─────────────────────────────────────
// A provider's row replaces their weekly hours on that date; a business row (staffId null) replaces the business's.
// Existing appointments are never changed: GET /affected lists the ones that no longer fit.

const DateHoursSchema = z.object({
  staffId: z.string().min(1).max(64).nullable().optional(),
  date: DateString,
  startTime: TimeString,
  endTime: TimeString,
  reason: z.string().trim().max(200).optional(),
}).strict()
  .refine(d => isRealDate(d.date), { message: 'The date must be a real calendar date (YYYY-MM-DD)', path: ['date'] })
  .refine(d => d.endTime > d.startTime, { message: 'The end time must be after the start time', path: ['endTime'] });

interface DateHoursRow { id: string; staff_id: string | null; date: string; start_time: string; end_time: string; reason: string; created_at: string; staff_name?: string | null }
const dateHoursToApi = (r: DateHoursRow) => ({
  id: r.id, staffId: r.staff_id, staffName: r.staff_name ?? null, date: r.date, startTime: r.start_time, endTime: r.end_time,
  reason: r.reason, createdAt: r.created_at,
});

/** The business's hours on a date (its date row, else its weekly hours); null when none are set; 'closed' when closed. */
function businessHoursOn(orgId: string, date: string): { start: string; end: string } | 'closed' | null {
  const special = db.prepare('SELECT start_time, end_time FROM date_hours WHERE organization_id = ? AND date = ? AND staff_id IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(orgId, date) as { start_time: string; end_time: string } | undefined;
  if (special) return { start: special.start_time, end: special.end_time };
  const weekly = businessHours(orgId);
  if (!weekly) return null;
  const day = weekly[dayName(date)];
  return day?.enabled && day.start && day.end ? { start: day.start, end: day.end } : 'closed';
}

router.get('/date-hours', canReadAvailability, (req: AuthRequest, res, next) => {
  try {
    const { staffId, from, to } = req.query as Record<string, string | undefined>;
    if ((from && !isRealDate(from)) || (to && !isRealDate(to))) { res.status(400).json({ error: 'from and to must be real dates (YYYY-MM-DD)' }); return; }
    const scope = scopeCondition(readScope(req), staffId, 'h');
    const where = ['h.organization_id = ?', scope.sql];
    const vals: unknown[] = [req.user!.orgId, ...scope.vals];
    if (from) { where.push('h.date >= ?'); vals.push(from); }
    if (to) { where.push('h.date <= ?'); vals.push(to); }
    const rows = db.prepare(
      `SELECT h.*, s.name AS staff_name FROM date_hours h LEFT JOIN staff s ON s.id = h.staff_id AND s.organization_id = h.organization_id
       WHERE ${where.join(' AND ')} ORDER BY h.date, h.staff_id IS NOT NULL, h.start_time`
    ).all(...vals) as DateHoursRow[];
    res.json({ data: rows.map(dateHoursToApi) });
  } catch (err) { next(err); }
});

router.post('/date-hours', requirePermission('staff:manage', 'settings:write'), (req: AuthRequest, res, next) => {
  try {
    const parsed = DateHoursSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
    const d = parsed.data;
    const orgId = req.user!.orgId;
    const staffId = d.staffId ?? null;
    if (!mayChange(req, staffId, res)) return;
    if (staffId) {
      if (!db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(staffId, orgId)) { res.status(404).json({ error: 'Staff member not found' }); return; }
      // A provider's hours must fall within the business's opening hours that day.
      const biz = businessHoursOn(orgId, d.date);
      if (biz === 'closed') { res.status(400).json({ error: 'The business is closed on that date. Set the business hours for the date first.', code: 'OUTSIDE_BUSINESS_HOURS' }); return; }
      if (biz && (d.startTime < biz.start || d.endTime > biz.end)) {
        res.status(400).json({ error: `Staff hours must be within business hours on that date (${biz.start}–${biz.end}).`, code: 'OUTSIDE_BUSINESS_HOURS' });
        return;
      }
    }
    const id = `dh-${nanoid(10)}`;
    db.transaction(() => {
      // One set of hours per date and person: a new one replaces the earlier.
      db.prepare('DELETE FROM date_hours WHERE organization_id = ? AND date = ? AND staff_id IS ?').run(orgId, d.date, staffId);
      db.prepare(
        'INSERT INTO date_hours (id, organization_id, staff_id, date, start_time, end_time, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, orgId, staffId, d.date, d.startTime, d.endTime, d.reason ?? '', req.user!.sub);
    }).immediate();
    const row = db.prepare('SELECT h.*, s.name AS staff_name FROM date_hours h LEFT JOIN staff s ON s.id = h.staff_id WHERE h.id = ?').get(id) as DateHoursRow;
    res.status(201).json({ data: dateHoursToApi(row), affected: affectedAppointments(orgId, staffId ?? undefined, d.date, d.date) });
  } catch (err) { next(err); }
});

router.delete('/date-hours/:id', requirePermission('staff:manage', 'settings:write'), (req: AuthRequest, res, next) => {
  try {
    const row = db.prepare('SELECT staff_id FROM date_hours WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId) as { staff_id: string | null } | undefined;
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    if (!mayChange(req, row.staff_id, res)) return;
    db.prepare('DELETE FROM date_hours WHERE id = ? AND organization_id = ?').run(req.params.id, req.user!.orgId);
    res.json({ data: { id: req.params.id } });
  } catch (err) { next(err); }
});

// ─── Appointments affected by availability changes ──────────────────────────

/**
 * Future Scheduled appointments (from today in the business time zone) whose time no longer fits the provider's
 * availability: working hours, business hours, breaks, time off, closures or date hours. They are only reported;
 * nothing is moved or cancelled automatically.
 */
function affectedAppointments(orgId: string, staffId?: string, from?: string, to?: string) {
  const today = todayInTimezone(getOrgTimezone(orgId));
  const rows = db.prepare(
    `SELECT a.id, a.booking_ref, a.date, a.start_time, a.end_time, a.staff_id, st.name AS staff_name,
            c.name AS customer_name, s.name AS service_name
     FROM appointments a
     JOIN staff st ON st.id = a.staff_id
     LEFT JOIN customers c ON c.id = a.customer_id
     LEFT JOIN services s ON s.id = a.service_id
     WHERE a.organization_id = ? AND a.status IN ('scheduled', 'confirmed') AND a.date >= ?
       AND (? IS NULL OR a.date <= ?) AND (? IS NULL OR a.staff_id = ?)
     ORDER BY a.date, a.start_time LIMIT 2000`
  ).all(orgId, from && from > today ? from : today, to ?? null, to ?? null, staffId ?? null, staffId ?? null) as Array<Record<string, string>>;
  const out = [];
  for (const r of rows) {
    const problem = scheduleProblem(r.staff_id, r.staff_name, r.date, r.start_time, r.end_time);
    if (problem) {
      out.push({
        id: r.id, bookingRef: r.booking_ref, date: r.date, startTime: r.start_time, endTime: r.end_time,
        staffId: r.staff_id, staffName: r.staff_name, customerName: r.customer_name ?? '', serviceName: r.service_name ?? '', problem,
      });
    }
  }
  return out;
}

router.get('/affected', canReadAvailability, (req: AuthRequest, res, next) => {
  try {
    const scope = readScope(req);
    let staffId = (req.query.staffId as string | undefined) || undefined;
    if (!scope.all) {
      if (!scope.staffId || (staffId && staffId !== scope.staffId)) { res.json({ data: [] }); return; }
      staffId = scope.staffId;
    }
    res.json({ data: affectedAppointments(req.user!.orgId, staffId) });
  } catch (err) { next(err); }
});

// ─── Time off and closures ──────────────────────────────────────────────────

// Who books appointments needs to see why a time is unavailable.
router.get('/', canReadAvailability, (req: AuthRequest, res, next) => {
  try {
    const { staffId, from, to } = req.query as Record<string, string | undefined>;
    if ((from && !isRealDate(from)) || (to && !isRealDate(to))) { res.status(400).json({ error: 'from and to must be real dates (YYYY-MM-DD)' }); return; }
    const scope = scopeCondition(readScope(req), staffId, 't');
    const where = ['t.organization_id = ?', scope.sql];
    const vals: unknown[] = [req.user!.orgId, ...scope.vals];
    if (from) { where.push('t.end_date >= ?'); vals.push(from); }
    if (to) { where.push('t.start_date <= ?'); vals.push(to); }
    const rows = db.prepare(
      `SELECT t.*, s.name AS staff_name FROM time_off t LEFT JOIN staff s ON s.id = t.staff_id AND s.organization_id = t.organization_id
       WHERE ${where.join(' AND ')} ORDER BY t.start_date, t.start_time`
    ).all(...vals) as Row[];
    res.json({ data: rows.map(toApi) });
  } catch (err) { next(err); }
});

router.post('/', requirePermission('staff:manage', 'settings:write'), (req: AuthRequest, res, next) => {
  try {
    const parsed = TimeOffSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' }); return; }
    const d = parsed.data;
    const orgId = req.user!.orgId;
    const staffId = d.staffId ?? null;
    if (!mayChange(req, staffId, res)) return;
    if (staffId && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(staffId, orgId)) {
      res.status(404).json({ error: 'Staff member not found' }); return;
    }
    const id = `off-${nanoid(10)}`;
    db.prepare(
      `INSERT INTO time_off (id, organization_id, staff_id, start_date, end_date, start_time, end_time, reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, staffId, d.startDate, d.endDate, d.startTime ?? null, d.endTime ?? null, d.reason ?? '', req.user!.sub);

    // Active appointments inside the new period: reported, never moved or cancelled.
    const conflicts = db.prepare(
      `SELECT a.id, a.booking_ref, a.date, a.start_time, a.end_time, s.name AS staff_name FROM appointments a JOIN staff s ON s.id = a.staff_id
       WHERE a.organization_id = ? AND a.status IN ('scheduled', 'confirmed') AND a.date BETWEEN ? AND ?
         AND (? IS NULL OR a.staff_id = ?)
         AND (? IS NULL OR (a.start_time < ? AND a.end_time > ?))
       ORDER BY a.date, a.start_time`
    ).all(orgId, d.startDate, d.endDate, staffId, staffId, d.startTime ?? null, d.endTime ?? null, d.startTime ?? null) as Array<Record<string, string>>;
    const row = db.prepare('SELECT t.*, s.name AS staff_name FROM time_off t LEFT JOIN staff s ON s.id = t.staff_id WHERE t.id = ?').get(id) as Row;
    res.status(201).json({
      data: toApi(row),
      conflicts: conflicts.map(c => ({ id: c.id, bookingRef: c.booking_ref, date: c.date, startTime: c.start_time, endTime: c.end_time, staffName: c.staff_name })),
    });
  } catch (err) { next(err); }
});

router.delete('/:id', requirePermission('staff:manage', 'settings:write'), (req: AuthRequest, res, next) => {
  try {
    const row = db.prepare('SELECT staff_id FROM time_off WHERE id = ? AND organization_id = ?').get(req.params.id, req.user!.orgId) as { staff_id: string | null } | undefined;
    if (!row) { res.status(404).json({ error: 'Not found' }); return; }
    if (!mayChange(req, row.staff_id, res)) return;
    db.prepare('DELETE FROM time_off WHERE id = ? AND organization_id = ?').run(req.params.id, req.user!.orgId);
    res.json({ data: { id: req.params.id } });
  } catch (err) { next(err); }
});

export default router;
