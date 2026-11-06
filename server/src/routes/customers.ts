import { Router } from 'express';
import { z } from 'zod';
import { phoneField } from '../lib/phone';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { CUSTOMER_COLUMNS } from '../services/customer-bookings';

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('customers:read');
const canWrite = requirePermission('customers:write');

const CustomerSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer')
    .refine(s => s.trim().length > 0, 'Name cannot be all whitespace')
    .refine(s => !/[<>]/.test(s), 'Name must not contain HTML characters'),
  email: z.string().email().max(254),
  phone: phoneField().optional(),
  timezone: z.string().optional(),
  notes: z.string().max(2000).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
});

function rowToCustomer(row: Record<string, unknown>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    timezone: row.timezone ?? null,
    notes: row.notes ?? '',
    tags: JSON.parse(row.tags as string ?? '[]'),
    // Counted from the appointments (services/customer-bookings.ts), not the stored counter.
    totalBookings: row.booking_count ?? 0,
    lastBookingDate: row.last_booking ?? null,
    createdAt: row.created_at,
  };
}

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const q = req.query.q as string | undefined;
    let rows: Record<string, unknown>[];
    if (q) {
      rows = db
        .prepare(
          `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE organization_id = ? AND (name LIKE ? OR email LIKE ?) ORDER BY name`
        )
        .all(req.user!.orgId, `%${q}%`, `%${q}%`) as Record<string, unknown>[];
    } else {
      rows = db
        .prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE organization_id = ? ORDER BY name`)
        .all(req.user!.orgId) as Record<string, unknown>[];
    }
    res.json({ data: rows.map(rowToCustomer) });
  } catch (err) {
    next(err);
  }
});

// One definition of an active customer, used by both the Customers page and the Dashboard: a customer with at least one
// appointment that was not cancelled (past or upcoming, any outcome).
router.get('/summary', canRead, (req: AuthRequest, res, next) => {
  try {
    const orgId = req.user!.orgId;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM customers WHERE organization_id = ?').get(orgId) as { n: number }).n;
    const active = (db.prepare(
      `SELECT COUNT(DISTINCT a.customer_id) AS n FROM appointments a JOIN customers c ON c.id = a.customer_id
       WHERE a.organization_id = ? AND c.organization_id = ? AND a.status != 'cancelled'`
    ).get(orgId, orgId) as { n: number }).n;
    res.json({ data: { total, active } });
  } catch (err) { next(err); }
});

router.get('/:id', canRead, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ? AND organization_id = ?`)
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.json({ data: rowToCustomer(row) });
  } catch (err) {
    next(err);
  }
});

router.post('/', canWrite, (req: AuthRequest, res, next) => {
  try {
    const data = CustomerSchema.parse(req.body);
    const id = `cust-${nanoid(8)}`;
    db.prepare(
      `INSERT INTO customers (id, organization_id, name, email, phone, timezone, notes, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.user!.orgId, data.name, data.email.toLowerCase(),
      data.phone || null, data.timezone ?? null, data.notes ?? '',
      JSON.stringify(data.tags ?? [])
    );
    const row = db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ?`).get(id) as Record<string, unknown>;
    res.status(201).json({ data: rowToCustomer(row) });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'A customer with that email already exists' });
      return;
    }
    next(err);
  }
});

router.put('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id FROM customers WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId);
    if (!existing) { res.status(404).json({ error: 'Customer not found' }); return; }

    const data = CustomerSchema.partial().parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name); }
    if (data.email !== undefined) { sets.push('email = ?'); vals.push(data.email.toLowerCase()); }
    if (data.phone !== undefined) { sets.push('phone = ?'); vals.push(data.phone || null); }
    if (data.timezone !== undefined) { sets.push('timezone = ?'); vals.push(data.timezone); }
    if (data.notes !== undefined) { sets.push('notes = ?'); vals.push(data.notes); }
    if (data.tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(data.tags)); }

    if (sets.length) {
      db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    }

    const row = db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ?`).get(req.params.id) as Record<string, unknown>;
    res.json({ data: rowToCustomer(row) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const result = db
      .prepare('DELETE FROM customers WHERE id = ? AND organization_id = ?')
      .run(req.params.id, req.user!.orgId);
    if (result.changes === 0) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
