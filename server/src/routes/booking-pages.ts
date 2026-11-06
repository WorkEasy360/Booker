import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('catalog:read');
const canWrite = requirePermission('booking_pages:write');

const BookingPageSchema = z.object({
  workspaceId: z.string().optional(),
  serviceId: z.string().optional(),
  staffId: z.string().optional(),
  type: z.enum(['business', 'service', 'staff']).default('business'),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  isPublished: z.boolean().default(false),
  // Rendered on the public booking page, so colours and fonts are restricted to safe values.
  theme: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    fontFamily: z.enum(['Inter', 'Roboto', 'Open Sans', 'Lato']).optional(),
    buttonText: z.string().max(40).optional(),
    headerText: z.string().max(120).optional(),
    footerText: z.string().max(300).optional(),
    showLogo: z.boolean().optional(),
    showStaffPhoto: z.boolean().optional(),
    layout: z.enum(['classic', 'modern', 'minimal']).optional(),
  }).strict().optional(),
  formFields: z.array(z.object({
    id: z.string().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    type: z.enum(['text', 'textarea', 'select', 'checkbox', 'phone', 'email']),
    required: z.boolean(),
  })).max(30).optional(),
  serviceIds: z.array(z.string().max(64)).max(200).optional(),
});

// Public pages are resolved by slug alone, so a slug must be unique across all organizations.
// 'lookup' is used by the public booking-reference lookup route (/book/lookup/manage).
const RESERVED_SLUGS = new Set(['lookup']);

function slugTaken(slug: string, exceptId?: string): boolean {
  if (RESERVED_SLUGS.has(slug)) return true;
  return !!db.prepare('SELECT 1 FROM booking_pages WHERE slug = ? AND id != ?').get(slug, exceptId ?? '');
}

function foreignReference(orgId: string, data: { serviceIds?: string[]; serviceId?: string; staffId?: string; workspaceId?: string }): string | null {
  const ids = [...(data.serviceIds ?? []), ...(data.serviceId ? [data.serviceId] : [])];
  for (const id of ids) {
    if (!db.prepare('SELECT 1 FROM services WHERE id = ? AND organization_id = ?').get(id, orgId)) return `Service ${id} not found`;
  }
  if (data.staffId && !db.prepare('SELECT 1 FROM staff WHERE id = ? AND organization_id = ?').get(data.staffId, orgId)) return 'Staff member not found';
  if (data.workspaceId && !db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND organization_id = ?').get(data.workspaceId, orgId)) return 'Workspace not found';
  return null;
}

function rowToPage(row: Record<string, unknown>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id ?? null,
    serviceId: row.service_id ?? null,
    staffId: row.staff_id ?? null,
    type: row.type,
    title: row.title,
    description: row.description ?? '',
    slug: row.slug,
    isPublished: Boolean(row.is_published),
    theme: JSON.parse(row.theme as string ?? '{}'),
    formFields: JSON.parse(row.form_fields as string ?? '[]'),
    serviceIds: JSON.parse(row.service_ids as string ?? '[]'),
    createdAt: row.created_at,
  };
}

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const rows = db
      .prepare('SELECT * FROM booking_pages WHERE organization_id = ? ORDER BY title')
      .all(req.user!.orgId) as Record<string, unknown>[];
    res.json({ data: rows.map(rowToPage) });
  } catch (err) { next(err); }
});

router.get('/:id', canRead, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM booking_pages WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Booking page not found' }); return; }
    res.json({ data: rowToPage(row) });
  } catch (err) { next(err); }
});

router.post('/', canWrite, (req: AuthRequest, res, next) => {
  try {
    const data = BookingPageSchema.parse(req.body);
    if (slugTaken(data.slug)) { res.status(409).json({ error: 'A booking page with that slug already exists' }); return; }
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const id = `bp-${nanoid(8)}`;
    db.prepare(
      `INSERT INTO booking_pages (id, organization_id, workspace_id, service_id, staff_id,
        type, title, description, slug, is_published, theme, form_fields, service_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.user!.orgId,
      data.workspaceId ?? null, data.serviceId ?? null, data.staffId ?? null,
      data.type, data.title, data.description ?? '', data.slug,
      data.isPublished ? 1 : 0,
      JSON.stringify(data.theme ?? {}), JSON.stringify(data.formFields ?? []),
      JSON.stringify(data.serviceIds ?? [])
    );
    const row = db.prepare('SELECT * FROM booking_pages WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ data: rowToPage(row) });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'A booking page with that slug already exists' });
      return;
    }
    next(err);
  }
});

router.put('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id FROM booking_pages WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId);
    if (!existing) { res.status(404).json({ error: 'Booking page not found' }); return; }

    const data = BookingPageSchema.partial().parse(req.body);
    if (data.slug !== undefined && slugTaken(data.slug, req.params.id)) {
      res.status(409).json({ error: 'A booking page with that slug already exists' });
      return;
    }
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (data.title !== undefined) { sets.push('title = ?'); vals.push(data.title); }
    if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description); }
    if (data.slug !== undefined) { sets.push('slug = ?'); vals.push(data.slug); }
    if (data.isPublished !== undefined) { sets.push('is_published = ?'); vals.push(data.isPublished ? 1 : 0); }
    if (data.type !== undefined) { sets.push('type = ?'); vals.push(data.type); }
    if (data.theme !== undefined) { sets.push('theme = ?'); vals.push(JSON.stringify(data.theme)); }
    if (data.formFields !== undefined) { sets.push('form_fields = ?'); vals.push(JSON.stringify(data.formFields)); }
    if (data.serviceIds !== undefined) { sets.push('service_ids = ?'); vals.push(JSON.stringify(data.serviceIds)); }
    if (data.workspaceId !== undefined) { sets.push('workspace_id = ?'); vals.push(data.workspaceId); }
    if (data.staffId !== undefined) { sets.push('staff_id = ?'); vals.push(data.staffId); }
    if (data.serviceId !== undefined) { sets.push('service_id = ?'); vals.push(data.serviceId); }

    if (sets.length) {
      db.prepare(`UPDATE booking_pages SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
    }

    const row = db.prepare('SELECT * FROM booking_pages WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ data: rowToPage(row) });
  } catch (err) { next(err); }
});

// Toggle publish
router.post('/:id/publish', canWrite, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT id, is_published FROM booking_pages WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as { id: string; is_published: number } | undefined;
    if (!row) { res.status(404).json({ error: 'Booking page not found' }); return; }

    const newState = row.is_published ? 0 : 1;
    db.prepare('UPDATE booking_pages SET is_published = ? WHERE id = ?').run(newState, req.params.id);
    res.json({ data: { isPublished: Boolean(newState) } });
  } catch (err) { next(err); }
});

router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const result = db
      .prepare('DELETE FROM booking_pages WHERE id = ? AND organization_id = ?')
      .run(req.params.id, req.user!.orgId);
    if (result.changes === 0) { res.status(404).json({ error: 'Booking page not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

export default router;
