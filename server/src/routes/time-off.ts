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

router.get('/breaks', requirePermission('appointments:write', 'staff:manage'), (req: AuthRequest, res, next) => {
  try {
    const { staffId } = req.query as Record<string, string | undefined>;
    const rows = db.prepare(
      `SELECT b.*, s.name AS staff_name FROM schedule_breaks b LEFT JOIN staff s ON s.id = b.staff_id AND s.organization_id = b.organization_id
       WHERE b.organization_id = ? ${staffId ? 'AND (b.staff_id = ? OR b.staff_id IS NULL)' : ''} ORDER BY b.weekday, b.start_time`
    ).all(...(staffId ? [req.user!.orgId, staffId] : [req.user!.orgId])) as BreakRow[];
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

// ─── Time off and closures ──────────────────────────────────────────────────

// Who books appointments needs to see why a time is unavailable.
router.get('/', requirePermission('appointments:write', 'staff:manage'), (req: AuthRequest, res, next) => {
  try {
    const { staffId, from, to } = req.query as Record<string, string | undefined>;
    if ((from && !isRealDate(from)) || (to && !isRealDate(to))) { res.status(400).json({ error: 'from and to must be real dates (YYYY-MM-DD)' }); return; }
    const where = ['t.organization_id = ?'];
    const vals: unknown[] = [req.user!.orgId];
    if (staffId) { where.push('(t.staff_id = ? OR t.staff_id IS NULL)'); vals.push(staffId); }
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
