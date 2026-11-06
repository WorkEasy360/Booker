import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { missingIds, syncServiceStaff, syncServiceResources, syncServiceWorkspaces } from '../services/relations';
import { CurrencySchema } from '../currency';
import { DEFAULT_CURRENCY } from '../services/business-locale';

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('catalog:read');
const canWrite = requirePermission('services:write');

/** Linked workspaces and resources must belong to the same organization. */
function foreignReference(orgId: string, data: { workspaceIds?: string[]; resourceIds?: string[] }): string | null {
  if (data.workspaceIds?.length && missingIds('workspaces', data.workspaceIds, orgId).length) return 'One or more workspaces were not found';
  if (data.resourceIds?.length && missingIds('resources', data.resourceIds, orgId).length) return 'One or more resources were not found';
  return null;
}

const ServiceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000).optional(),
  category: z.enum(['consultation', 'class', 'workshop', 'session', 'tour', 'rental', 'other']),
  duration: z.number().int().positive().max(1440),
  price: z.number().min(0),
  currency: CurrencySchema.optional(),
  location: z.string().max(200).optional(),
  isActive: z.boolean().default(true),
  bufferBefore: z.number().int().min(0).default(0),
  bufferAfter: z.number().int().min(0).default(0),
  minNotice: z.number().int().min(0).default(0),
  maxAdvance: z.number().int().min(1).default(30),
  cancellationPolicy: z.string().max(2000).optional(),
  reschedulingPolicy: z.string().max(2000).optional(),
  color: z.string().max(32).optional(),
  workspaceIds: z.array(z.string().max(64)).max(500).optional(),
  staffIds: z.array(z.string().max(64)).max(500).optional(),
  resourceIds: z.array(z.string().max(64)).max(500).optional(),
  customFields: z.array(z.unknown()).max(50).optional(),
});

function rowToService(row: Record<string, unknown>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description ?? '',
    category: row.category,
    duration: row.duration,
    price: row.price,
    currency: row.currency,
    location: row.location ?? '',
    isActive: Boolean(row.is_active),
    bufferBefore: row.buffer_before,
    bufferAfter: row.buffer_after,
    minNotice: row.min_notice,
    maxAdvance: row.max_advance,
    cancellationPolicy: row.cancellation_policy ?? '',
    reschedulingPolicy: row.rescheduling_policy ?? '',
    color: row.color ?? '#00BF62',
    workspaceIds: JSON.parse(row.workspace_ids as string ?? '[]'),
    staffIds: JSON.parse(row.staff_ids as string ?? '[]'),
    resourceIds: JSON.parse(row.resource_ids as string ?? '[]'),
    customFields: JSON.parse(row.custom_fields as string ?? '[]'),
    createdAt: row.created_at,
  };
}

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const rows = db
      .prepare('SELECT * FROM services WHERE organization_id = ? ORDER BY name')
      .all(req.user!.orgId) as Record<string, unknown>[];
    res.json({ data: rows.map(rowToService) });
  } catch (err) { next(err); }
});

router.get('/:id', canRead, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM services WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Service not found' }); return; }
    res.json({ data: rowToService(row) });
  } catch (err) { next(err); }
});

router.post('/', canWrite, (req: AuthRequest, res, next) => {
  try {
    const data = ServiceSchema.parse(req.body);
    const orgId = req.user!.orgId;
    const refError = foreignReference(orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const unknown = missingIds('staff', data.staffIds ?? [], orgId);
    if (unknown.length) { res.status(400).json({ error: `Staff member not found: ${unknown.join(', ')}` }); return; }
    // New services use the business currency unless one is given explicitly.
    const currency = data.currency
      ?? (db.prepare('SELECT currency FROM organizations WHERE id = ?').get(orgId) as { currency: string | null } | undefined)?.currency
      ?? DEFAULT_CURRENCY;
    const id = `svc-${nanoid(8)}`;
    db.transaction(() => {
    db.prepare(
      `INSERT INTO services (id, organization_id, name, description, category, duration, price, currency,
        location, is_active, buffer_before, buffer_after, min_notice, max_advance,
        cancellation_policy, rescheduling_policy, color, workspace_ids, staff_ids, resource_ids, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.user!.orgId, data.name, data.description ?? '', data.category,
      data.duration, data.price, currency, data.location ?? '',
      data.isActive ? 1 : 0, data.bufferBefore, data.bufferAfter,
      data.minNotice, data.maxAdvance, data.cancellationPolicy ?? '',
      data.reschedulingPolicy ?? '', data.color ?? '#00BF62',
      JSON.stringify(data.workspaceIds ?? []), JSON.stringify(data.staffIds ?? []),
      JSON.stringify(data.resourceIds ?? []), JSON.stringify(data.customFields ?? [])
    );
    syncServiceStaff(orgId, id, data.staffIds ?? []);
    syncServiceResources(orgId, id, data.resourceIds ?? []);
    syncServiceWorkspaces(orgId, id, data.workspaceIds ?? []);
    })();
    const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ data: rowToService(row) });
  } catch (err) { next(err); }
});

router.put('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id FROM services WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId);
    if (!existing) { res.status(404).json({ error: 'Service not found' }); return; }

    const data = ServiceSchema.partial().parse(req.body);
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    if (data.staffIds) {
      const unknown = missingIds('staff', data.staffIds, req.user!.orgId);
      if (unknown.length) { res.status(400).json({ error: `Staff member not found: ${unknown.join(', ')}` }); return; }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];

    const map: Record<string, string> = {
      name: 'name', description: 'description', category: 'category',
      duration: 'duration', price: 'price', currency: 'currency', location: 'location',
      bufferBefore: 'buffer_before', bufferAfter: 'buffer_after',
      minNotice: 'min_notice', maxAdvance: 'max_advance',
      cancellationPolicy: 'cancellation_policy', reschedulingPolicy: 'rescheduling_policy',
      color: 'color',
    };

    for (const [key, col] of Object.entries(map)) {
      const v = (data as Record<string, unknown>)[key];
      if (v !== undefined) { sets.push(`${col} = ?`); vals.push(v); }
    }

    if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0); }
    if (data.workspaceIds !== undefined) { sets.push('workspace_ids = ?'); vals.push(JSON.stringify(data.workspaceIds)); }
    if (data.staffIds !== undefined) { sets.push('staff_ids = ?'); vals.push(JSON.stringify(data.staffIds)); }
    if (data.resourceIds !== undefined) { sets.push('resource_ids = ?'); vals.push(JSON.stringify(data.resourceIds)); }
    if (data.customFields !== undefined) { sets.push('custom_fields = ?'); vals.push(JSON.stringify(data.customFields)); }

    db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
      }
      if (data.staffIds !== undefined) syncServiceStaff(req.user!.orgId, req.params.id, data.staffIds);
      if (data.resourceIds !== undefined) syncServiceResources(req.user!.orgId, req.params.id, data.resourceIds);
      if (data.workspaceIds !== undefined) syncServiceWorkspaces(req.user!.orgId, req.params.id, data.workspaceIds);
    })();

    const row = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ data: rowToService(row) });
  } catch (err) { next(err); }
});

router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const result = db.transaction(() => {
      const r = db
        .prepare('DELETE FROM services WHERE id = ? AND organization_id = ?')
        .run(req.params.id, req.user!.orgId);
      if (r.changes > 0) { syncServiceStaff(req.user!.orgId, req.params.id, []); syncServiceResources(req.user!.orgId, req.params.id, []); syncServiceWorkspaces(req.user!.orgId, req.params.id, []); }
      return r;
    })();
    if (result.changes === 0) { res.status(404).json({ error: 'Service not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

export default router;
