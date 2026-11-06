import { Router } from 'express';
import { z } from 'zod';
import { phoneField } from '../lib/phone';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { missingIds, syncWorkspaceServices, syncWorkspaceStaff, workspaceLinks } from '../services/relations';
import { TimeZoneString } from '../validation';
import { getOrgTimezone } from '../services/availability';
import { DEFAULT_TIMEZONE } from '../services/business-locale';

const router = Router();
router.use(requireAuth);
const canRead = requirePermission('catalog:read');
const canWrite = requirePermission('workspaces:write');

/** Linked services and staff must belong to the same organization. */
function foreignReference(orgId: string, data: { serviceIds?: string[]; staffIds?: string[] }): string | null {
  if (data.serviceIds?.length && missingIds('services', data.serviceIds, orgId).length) return 'One or more services were not found';
  if (data.staffIds?.length && missingIds('staff', data.staffIds, orgId).length) return 'One or more staff members were not found';
  return null;
}

const WorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  color: z.string().max(32).optional(),
  timezone: TimeZoneString.optional(),
  address: z.string().max(200).optional(),
  phone: phoneField().optional(),
  email: z.string().email().max(254).optional(),
  isActive: z.boolean().default(true),
  serviceIds: z.array(z.string().max(64)).max(500).optional(),
  staffIds: z.array(z.string().max(64)).max(500).optional(),
  workingHours: z.record(z.unknown()).optional(),
});

function rowToWorkspace(row: Record<string, unknown>, links: { serviceIds: string[]; staffIds: string[] }) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description ?? '',
    color: row.color ?? '#00BF62',
    timezone: row.timezone ?? DEFAULT_TIMEZONE,
    address: row.address ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    isActive: Boolean(row.is_active),
    // From either side of the link, existing records only (see services/relations.ts).
    serviceIds: links.serviceIds,
    staffIds: links.staffIds,
    workingHours: JSON.parse(row.working_hours as string ?? '{}'),
    createdAt: row.created_at,
  };
}

const withLinks = (orgId: string, row: Record<string, unknown>) =>
  rowToWorkspace(row, workspaceLinks(orgId)(row as { id: string; service_ids: string; staff_ids: string }));

router.get('/', canRead, (req: AuthRequest, res, next) => {
  try {
    const rows = db
      .prepare('SELECT * FROM workspaces WHERE organization_id = ? ORDER BY name')
      .all(req.user!.orgId) as Record<string, unknown>[];
    const linksOf = workspaceLinks(req.user!.orgId);
    res.json({ data: rows.map(r => rowToWorkspace(r, linksOf(r as { id: string; service_ids: string; staff_ids: string }))) });
  } catch (err) { next(err); }
});

router.get('/:id', canRead, (req: AuthRequest, res, next) => {
  try {
    const row = db
      .prepare('SELECT * FROM workspaces WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId) as Record<string, unknown> | undefined;
    if (!row) { res.status(404).json({ error: 'Workspace not found' }); return; }
    res.json({ data: withLinks(req.user!.orgId, row) });
  } catch (err) { next(err); }
});

router.post('/', canWrite, (req: AuthRequest, res, next) => {
  try {
    const data = WorkspaceSchema.parse(req.body);
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const id = `ws-${nanoid(8)}`;
    const orgId = req.user!.orgId;
    db.transaction(() => {
    db.prepare(
      `INSERT INTO workspaces (id, organization_id, name, description, color, timezone,
        address, phone, email, is_active, service_ids, staff_ids, working_hours)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, req.user!.orgId, data.name, data.description ?? '',
      // Without an explicit zone a workspace follows its business, not a fixed default.
      data.color ?? '#00BF62', data.timezone ?? getOrgTimezone(req.user!.orgId),
      data.address ?? null, data.phone || null, data.email ?? null,
      data.isActive ? 1 : 0,
      JSON.stringify(data.serviceIds ?? []), JSON.stringify(data.staffIds ?? []),
      JSON.stringify(data.workingHours ?? {})
    );
    syncWorkspaceServices(orgId, id, data.serviceIds ?? []);
    syncWorkspaceStaff(orgId, id, data.staffIds ?? []);
    })();
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Record<string, unknown>;
    res.status(201).json({ data: withLinks(orgId, row) });
  } catch (err) { next(err); }
});

router.put('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const existing = db
      .prepare('SELECT id FROM workspaces WHERE id = ? AND organization_id = ?')
      .get(req.params.id, req.user!.orgId);
    if (!existing) { res.status(404).json({ error: 'Workspace not found' }); return; }

    const data = WorkspaceSchema.partial().parse(req.body);
    const refError = foreignReference(req.user!.orgId, data);
    if (refError) { res.status(400).json({ error: refError }); return; }
    const sets: string[] = [];
    const vals: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); vals.push(data.name); }
    if (data.description !== undefined) { sets.push('description = ?'); vals.push(data.description); }
    if (data.color !== undefined) { sets.push('color = ?'); vals.push(data.color); }
    if (data.timezone !== undefined) { sets.push('timezone = ?'); vals.push(data.timezone); }
    if (data.address !== undefined) { sets.push('address = ?'); vals.push(data.address); }
    if (data.phone !== undefined) { sets.push('phone = ?'); vals.push(data.phone || null); }
    if (data.email !== undefined) { sets.push('email = ?'); vals.push(data.email); }
    if (data.isActive !== undefined) { sets.push('is_active = ?'); vals.push(data.isActive ? 1 : 0); }
    if (data.serviceIds !== undefined) { sets.push('service_ids = ?'); vals.push(JSON.stringify(data.serviceIds)); }
    if (data.staffIds !== undefined) { sets.push('staff_ids = ?'); vals.push(JSON.stringify(data.staffIds)); }
    if (data.workingHours !== undefined) { sets.push('working_hours = ?'); vals.push(JSON.stringify(data.workingHours)); }

    db.transaction(() => {
      if (sets.length) {
        db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...vals, req.params.id);
      }
      if (data.serviceIds !== undefined) syncWorkspaceServices(req.user!.orgId, req.params.id, data.serviceIds);
      if (data.staffIds !== undefined) syncWorkspaceStaff(req.user!.orgId, req.params.id, data.staffIds);
    })();

    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as Record<string, unknown>;
    res.json({ data: withLinks(req.user!.orgId, row) });
  } catch (err) { next(err); }
});

router.delete('/:id', canWrite, (req: AuthRequest, res, next) => {
  try {
    const result = db.transaction(() => {
      const r = db.prepare('DELETE FROM workspaces WHERE id = ? AND organization_id = ?').run(req.params.id, req.user!.orgId);
      // Services and staff no longer list a workspace that is gone.
      if (r.changes > 0) { syncWorkspaceServices(req.user!.orgId, req.params.id, []); syncWorkspaceStaff(req.user!.orgId, req.params.id, []); }
      return r;
    })();
    if (result.changes === 0) { res.status(404).json({ error: 'Workspace not found' }); return; }
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

export default router;
