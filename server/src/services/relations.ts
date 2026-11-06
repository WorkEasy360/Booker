import db from '../db/init';

// Staff↔service assignment is stored on both sides (staff.service_ids and services.staff_ids), and so are
// resource↔service (resources.service_ids and services.resource_ids) and the services and staff of a workspace
// (workspaces.service_ids / services.workspace_ids, workspaces.staff_ids / staff.workspace_ids). Every write keeps both
// sides in sync.

type Table = 'services' | 'staff' | 'resources' | 'workspaces';

/** Ids that do not exist in the organization (unknown ids and other organizations' ids alike). */
export function missingIds(table: Table, ids: string[], orgId: string): string[] {
  const stmt = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND organization_id = ?`);
  return ids.filter(id => !stmt.get(id, orgId));
}

function syncOtherSide(
  otherTable: Table,
  otherColumn: 'staff_ids' | 'service_ids' | 'resource_ids' | 'workspace_ids',
  orgId: string,
  ownId: string,
  wantedIds: string[],
): void {
  const rows = db
    .prepare(`SELECT id, ${otherColumn} AS ids FROM ${otherTable} WHERE organization_id = ?`)
    .all(orgId) as Array<{ id: string; ids: string }>;
  const update = db.prepare(`UPDATE ${otherTable} SET ${otherColumn} = ? WHERE id = ?`);
  for (const row of rows) {
    const current = JSON.parse(row.ids ?? '[]') as string[];
    const has = current.includes(ownId);
    const want = wantedIds.includes(row.id);
    if (has === want) continue;
    const next = want ? [...current, ownId] : current.filter(x => x !== ownId);
    update.run(JSON.stringify(next), row.id);
  }
}

export function syncStaffServices(orgId: string, staffId: string, serviceIds: string[]): void {
  syncOtherSide('services', 'staff_ids', orgId, staffId, serviceIds);
}

export function syncServiceStaff(orgId: string, serviceId: string, staffIds: string[]): void {
  syncOtherSide('staff', 'service_ids', orgId, serviceId, staffIds);
}

/** After a resource's services change: the services' resource lists follow. */
export function syncResourceServices(orgId: string, resourceId: string, serviceIds: string[]): void {
  syncOtherSide('services', 'resource_ids', orgId, resourceId, serviceIds);
}

/** After a service's resources change: the resources' service lists follow. */
export function syncServiceResources(orgId: string, serviceId: string, resourceIds: string[]): void {
  syncOtherSide('resources', 'service_ids', orgId, serviceId, resourceIds);
}

/** After a service's workspaces change: the workspaces' service lists follow. */
export function syncServiceWorkspaces(orgId: string, serviceId: string, workspaceIds: string[]): void {
  syncOtherSide('workspaces', 'service_ids', orgId, serviceId, workspaceIds);
}

/** After a staff member's workspaces change: the workspaces' staff lists follow. */
export function syncStaffWorkspaces(orgId: string, staffId: string, workspaceIds: string[]): void {
  syncOtherSide('workspaces', 'staff_ids', orgId, staffId, workspaceIds);
}

/** After a workspace's services change: the services' workspace lists follow. */
export function syncWorkspaceServices(orgId: string, workspaceId: string, serviceIds: string[]): void {
  syncOtherSide('services', 'workspace_ids', orgId, workspaceId, serviceIds);
}

/** After a workspace's staff change: the staff members' workspace lists follow. */
export function syncWorkspaceStaff(orgId: string, workspaceId: string, staffIds: string[]): void {
  syncOtherSide('staff', 'workspace_ids', orgId, workspaceId, staffIds);
}

/**
 * The services and staff of each workspace, linked from either side (a link made on only one side, as older data may
 * have, still counts) and only records that still exist in the organization.
 */
export function workspaceLinks(orgId: string): (workspace: { id: string; service_ids: string; staff_ids: string }) => { serviceIds: string[]; staffIds: string[] } {
  const services = db.prepare('SELECT id, workspace_ids FROM services WHERE organization_id = ? ORDER BY rowid').all(orgId) as Array<{ id: string; workspace_ids: string }>;
  const staff = db.prepare('SELECT id, workspace_ids FROM staff WHERE organization_id = ? ORDER BY rowid').all(orgId) as Array<{ id: string; workspace_ids: string }>;
  const parse = (v: string | null) => { try { return JSON.parse(v ?? '[]') as string[]; } catch { return []; } };
  const linked = (rows: Array<{ id: string; workspace_ids: string }>, wsId: string, listed: string[]) =>
    rows.filter(r => listed.includes(r.id) || parse(r.workspace_ids).includes(wsId)).map(r => r.id);
  return ws => ({ serviceIds: linked(services, ws.id, parse(ws.service_ids)), staffIds: linked(staff, ws.id, parse(ws.staff_ids)) });
}
