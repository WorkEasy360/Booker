import { Router } from 'express';
import { z } from 'zod';
import { phoneField } from '../lib/phone';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { CUSTOMER_COLUMNS } from '../services/customer-bookings';

// V4 customers: a name and at least one contact method (phone or email; the other is optional). No tags, VIP levels,
// company fields, addresses or separate customer notes. A missing email is stored as '' and reported as null.

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('customers:read');
const canWrite = requirePermission('customers:write');

/** '' or absent → undefined; otherwise a valid, lower-case address. */
const EmailField = z.preprocess(
  v => (v === null || (typeof v === 'string' && v.trim() === '') ? '' : v),
  z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid email address').max(254)]),
);

const CustomerFields = {
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer')
    .refine(s => s.trim().length > 0, 'Name cannot be all whitespace')
    .refine(s => !/[<>]/.test(s), 'Name must not contain HTML characters')
    .transform(s => s.trim()),
  email: EmailField.optional(),
  phone: z.preprocess(v => (v === null ? '' : v), phoneField()).optional(),
};
// Older clients may still send these; they are accepted and ignored.
const Ignored = { timezone: z.unknown().optional(), notes: z.unknown().optional(), tags: z.unknown().optional() };

const CONTACT_REQUIRED = 'Enter a phone number or an email address';
const CreateSchema = z.object({
  ...CustomerFields, ...Ignored,
  /** The owner saw the phone-number match and still wants a separate customer (for example a shared family phone). */
  confirmNew: z.boolean().optional(),
})
  .refine(d => !!d.email || !!d.phone, { message: CONTACT_REQUIRED, path: ['phone'] });
const UpdateSchema = z.object({ ...CustomerFields, ...Ignored }).partial();

function rowToCustomer(row: Record<string, unknown>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    email: (row.email as string) || null,
    phone: row.phone ?? null,
    // Counted from the appointments (services/customer-bookings.ts), not the stored counter.
    totalBookings: row.booking_count ?? 0,
    lastBookingDate: row.last_booking ?? null,
    createdAt: row.created_at,
  };
}

const escapeLike = (q: string) => `%${q.replace(/[\\%_]/g, m => '\\' + m)}%`;

/**
 * Existing customers with this email or phone. One match is a duplicate the owner should open instead of creating
 * another record; an email matching one customer and a phone matching another is a conflict the owner resolves.
 */
function contactMatches(orgId: string, email: string | undefined, phone: string | undefined, exceptId?: string) {
  const byEmail = email
    ? db.prepare("SELECT id, name FROM customers WHERE organization_id = ? AND email = ? AND email <> '' AND id != ?").get(orgId, email, exceptId ?? '') as { id: string; name: string } | undefined
    : undefined;
  const byPhone = phone
    ? db.prepare('SELECT id, name FROM customers WHERE organization_id = ? AND phone = ? AND id != ? ORDER BY created_at LIMIT 2').all(orgId, phone, exceptId ?? '') as Array<{ id: string; name: string }>
    : [];
  return { byEmail, byPhone };
}

type MatchProblem = { status: 409; body: { error: string; code: 'CUSTOMER_EXISTS' | 'CUSTOMER_MATCH_CONFLICT'; customerId?: string; customerIds?: string[] } };

function matchProblem(orgId: string, email: string | undefined, phone: string | undefined, exceptId?: string, phoneConfirmed = false): MatchProblem | null {
  const { byEmail, byPhone: phoneMatches } = contactMatches(orgId, email, phone, exceptId);
  const byPhone = phoneConfirmed ? [] : phoneMatches;
  const phoneIds = byPhone.map(c => c.id);
  if (byEmail && phoneIds.some(id => id !== byEmail.id)) {
    return { status: 409, body: {
      error: 'The email address and phone number belong to different customers. Open the right customer, or correct the details.',
      code: 'CUSTOMER_MATCH_CONFLICT', customerIds: [byEmail.id, ...phoneIds.filter(id => id !== byEmail.id)],
    } };
  }
  if (byEmail) {
    return { status: 409, body: { error: `${byEmail.name} already has this email address.`, code: 'CUSTOMER_EXISTS', customerId: byEmail.id } };
  }
  if (byPhone.length > 1) {
    return { status: 409, body: { error: 'Several customers have this phone number. Choose the right one instead of adding another.', code: 'CUSTOMER_MATCH_CONFLICT', customerIds: phoneIds } };
  }
  if (byPhone.length === 1) {
    return { status: 409, body: { error: `${byPhone[0].name} already has this phone number.`, code: 'CUSTOMER_EXISTS', customerId: byPhone[0].id } };
  }
  return null;
}

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const q = (req.query.q as string | undefined)?.trim();
    const rows = q
      ? db.prepare(
          `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE organization_id = ?
             AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\'
                  OR replace(replace(replace(phone, ' ', ''), '-', ''), '+', '') LIKE ? ESCAPE '\\')
           ORDER BY name`
        ).all(req.user!.orgId, escapeLike(q), escapeLike(q), escapeLike(q), escapeLike(q.replace(/[\s\-+()]/g, ''))) as Record<string, unknown>[]
      : db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE organization_id = ? ORDER BY name`)
        .all(req.user!.orgId) as Record<string, unknown>[];
    res.json({ data: rows.map(rowToCustomer) });
  } catch (err) {
    next(err);
  }
});

// One definition of an active customer: a customer with at least one appointment that was not cancelled.
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
    const data = CreateSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const email = data.email || undefined;
    const phone = data.phone || undefined;
    const id = `cust-${nanoid(8)}`;
    // Checked and written together, so two requests cannot both add the same person.
    const outcome = db.transaction((): MatchProblem | null => {
      const problem = matchProblem(orgId, email, phone, undefined, data.confirmNew === true);
      if (problem) return problem;
      db.prepare(
        `INSERT INTO customers (id, organization_id, name, email, phone, notes, tags) VALUES (?, ?, ?, ?, ?, '', '[]')`
      ).run(id, orgId, data.name, email ?? '', phone ?? null);
      return null;
    }).immediate();
    if (outcome) { res.status(outcome.status).json(outcome.body); return; }
    const row = db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ?`).get(id) as Record<string, unknown>;
    res.status(201).json({ data: rowToCustomer(row) });
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'A customer with that email already exists', code: 'CUSTOMER_EXISTS' });
      return;
    }
    next(err);
  }
});

// Editing contact details changes only this customer record; appointments keep pointing at it.
router.put('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const orgId = req.user!.orgId;
    const existing = db.prepare('SELECT id, email, phone FROM customers WHERE id = ? AND organization_id = ?')
      .get(req.params.id, orgId) as { id: string; email: string; phone: string | null } | undefined;
    if (!existing) { res.status(404).json({ error: 'Customer not found' }); return; }

    const data = UpdateSchema.parse(req.body);
    const email = data.email !== undefined ? data.email : existing.email;
    const phone = data.phone !== undefined ? data.phone : (existing.phone ?? '');
    if (!email && !phone) { res.status(400).json({ error: CONTACT_REQUIRED }); return; }

    const outcome = db.transaction((): MatchProblem | null => {
      // A new email address must not belong to another customer. Phone numbers may be shared (a family phone).
      const problem = data.email !== undefined && email && email !== existing.email
        ? matchProblem(orgId, email, undefined, req.params.id)
        : null;
      if (problem) return problem;
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name); }
      if (data.email !== undefined) { sets.push('email = ?'); vals.push(email); }
      if (data.phone !== undefined) { sets.push('phone = ?'); vals.push(phone || null); }
      if (sets.length) db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
      return null;
    }).immediate();
    if (outcome) { res.status(outcome.status).json(outcome.body); return; }

    const row = db.prepare(`SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = ?`).get(req.params.id) as Record<string, unknown>;
    res.json({ data: rowToCustomer(row) });
  } catch (err) {
    if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'A customer with that email already exists', code: 'CUSTOMER_EXISTS' });
      return;
    }
    next(err);
  }
});

// Appointment history is preserved: a customer with appointments cannot be deleted.
router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const orgId = req.user!.orgId;
    if (db.prepare('SELECT 1 FROM appointments WHERE customer_id = ? AND organization_id = ? LIMIT 1').get(req.params.id, orgId)) {
      res.status(409).json({ error: 'This customer has appointments, so the record is kept with their history.', code: 'CUSTOMER_HAS_APPOINTMENTS' });
      return;
    }
    const result = db
      .prepare('DELETE FROM customers WHERE id = ? AND organization_id = ?')
      .run(req.params.id, orgId);
    if (result.changes === 0) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
