import { Router } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { missingIds, syncResourceServices } from '../services/relations';

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('catalog:read');
const canWrite = requirePermission('resources:write');

/** Linked workspaces and services must belong to the same organization. */
function foreignReference(orgId: string, data: { workspaceIds?: string[]; serviceIds?: string[] }): string | null {
  if (data.workspaceIds?.length && missingIds('workspaces', data.workspaceIds, orgId).length) return 'One or more workspaces were not found';
  if (data.serviceIds?.length && missingIds('services', data.serviceIds, orgId).length) return 'One or more services were not found';
  return null;
}

const ResourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['room', 'equipment', 'vehicle', 'table', 'other']).default('room'),
  description: z.string().max(1000).optional(),
  capacity: z.number().int().positive().default(1),
  isActive: z.boolean().default(true),
  workspaceIds: z.array(z.string().max(64)).max(200).optional(),
  serviceIds: z.array(z.string().max(64)).max(500).optional(),
  availabilityRules: z.record(z.unknown()).optional(),
});

function rowToResource(row: Record<string, unknown>) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    type: row.type,
    description: row.description ?? '',
    capacity: row.capacity,
    isActive: Boolean(row.is_active),
    workspaceIds: JSON.parse(row.workspace_ids as string ?? '[]'),
    serviceIds: JSON.parse(row.service_ids as string ?? '[]'),
    availabilityRules: JSON.parse(row.availability_rules as string ?? '{}'),
    createdAt: row.created_at,
  };
}

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const rows = db
      .prepare('SELECT * FROM resources WHERE organization_id = ? ORDER BY name')
      .all(req.user!.orgId) as Record<string, unknown>[];
    res.json({ data: rows.map(rowToResource) });
  } catch (err) { next(err); }
});

router.get('/:id', canRead, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM resources WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Resource not found' }); return; }
    res.json({ data: rowToResource(row) });
  } catch (err) { next(err); }
});

router.post('/', canWrite, (req: AuthRequest, res, next) => {
  try {
    const data = ResourceSchema.parse(req.body);
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const id = `res-${nanoid(8)}`;
    db.transaction(() => {
    db.prepare(
      `INSERT INTO resources (id, organization_id, name, type, description, capacity,
        is_active, workspace_ids, service_ids, availability_rules)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.user!.orgId, data.name, data.type, data.description ?? '',
      data.capacity, data.isActive ? 1 : 0,
      JSON.stringify(data.workspaceIds ?? []), JSON.stringify(data.serviceIds ?? []),
      JSON.stringify(data.availabilityRules ?? {})
    );
    syncResourceServices(req.user!.orgId, id, data.serviceIds ?? []);
    })();
    const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ data: rowToResource(row) });
  } catch (err) { next(err); }
});

router.put('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id FROM resources WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId);
    if (!existing) { res.status(404).json({ error: 'Resource not found' }); return; }

    const data = ResourceSchema.partial().parse(req.body);
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name); }
    if (data.type !== undefined) { sets.push('type = ?'); vals.push(data.type); }
    if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description); }
    if (data.capacity !== undefined) { sets.push('capacity = ?'); vals.push(data.capacity); }
    if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0); }
    if (data.workspaceIds !== undefined) { sets.push('workspace_ids = ?'); vals.push(JSON.stringify(data.workspaceIds)); }
    if (data.serviceIds !== undefined) { sets.push('service_ids = ?'); vals.push(JSON.stringify(data.serviceIds)); }
    if (data.availabilityRules !== undefined) { sets.push('availability_rules = ?'); vals.push(JSON.stringify(data.availabilityRules)); }

    db.transaction(() => {
      if (sets.length) db.prepare(`UPDATE resources SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
      if (data.serviceIds !== undefined) syncResourceServices(req.user!.orgId, req.params.id, data.serviceIds);
    })();

    const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ data: rowToResource(row) });
  } catch (err) { next(err); }
});

router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    // Bookings that hold the resource keep it (a database reference): such a resource can be deactivated, not deleted.
    const result = db.transaction(() => {
      const r = db.prepare('DELETE FROM resources WHERE id = ? AND organization_id = ?').run(req.params.id, req.user!.orgId);
      if (r.changes > 0) syncResourceServices(req.user!.orgId, req.params.id, []);
      return r;
    })();
    if (result.changes === 0) { res.status(404).json({ error: 'Resource not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

export default router;
