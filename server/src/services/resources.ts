import db from '../db/init';
import { dayName, toMinutes } from './schedule';
import type { SlotProblem } from './bookability';

// Rooms, equipment and other resources. A service linked to resources (on either side: services.resource_ids or
// resources.service_ids) needs one free resource from that pool for each booking, which then holds it
// (appointment_resources, migration 013). A resource with capacity N can be held by N bookings whose times overlap.
// It is free only while active and within its own opening hours, if it has any. When a booking belongs to a
// workspace, only resources of that workspace (or of no particular workspace) are used. The database triggers apply
// the same capacity rule, so a write that slips past these checks is still refused.

interface ResourceRow { id: string; name: string; type: string; capacity: number; availability_rules: string; workspace_ids: string; service_ids: string; is_active: number }
export interface PoolResource { id: string; name: string; type: string; capacity: number; hours: Record<string, { enabled?: boolean; start?: string; end?: string }> }

const ACTIVE = "a.status NOT IN ('cancelled','no_show')";
const parse = <T>(json: string | null | undefined, fallback: T): T => { try { return JSON.parse(json ?? '') as T; } catch { return fallback; } };

/** Resources linked to the service, active or not (an empty list means the service needs none). */
function linkedResources(orgId: string, serviceId: string): ResourceRow[] {
  const svc = db.prepare('SELECT resource_ids FROM services WHERE id = ? AND organization_id = ?').get(serviceId, orgId) as { resource_ids: string } | undefined;
  if (!svc) return [];
  const listed = parse<string[]>(svc.resource_ids, []);
  const rows = db.prepare(
    'SELECT id, name, type, capacity, availability_rules, workspace_ids, service_ids, is_active FROM resources WHERE organization_id = ? ORDER BY name, id'
  ).all(orgId) as ResourceRow[];
  return rows.filter(r => listed.includes(r.id) || parse<string[]>(r.service_ids, []).includes(serviceId));
}

const toPool = (r: ResourceRow): PoolResource => ({ id: r.id, name: r.name, type: r.type, capacity: r.capacity, hours: parse(r.availability_rules, {}) });

/** The resources a booking of this service can use: linked, active, and in the booking's workspace if it has one. */
export function resourcePool(orgId: string, serviceId: string, workspaceId?: string | null): { needed: boolean; pool: PoolResource[]; noun: string } {
  const linked = linkedResources(orgId, serviceId);
  const noun = linked.length && linked.every(r => r.type === 'room') ? 'room' : 'room or resource';
  const pool = linked
    .filter(r => r.is_active)
    .filter(r => { const ws = parse<string[]>(r.workspace_ids, []); return !workspaceId || !ws.length || ws.includes(workspaceId); })
    .map(toPool);
  return { needed: linked.length > 0, pool, noun };
}

/** Within the resource's opening hours for that day (no hours set means always open). */
export function resourceOpen(r: PoolResource, date: string, start: string, end: string): boolean {
  if (!r.hours || !Object.keys(r.hours).length) return true;
  const day = r.hours[dayName(date)];
  if (!day) return true;
  if (!day.enabled) return false;
  return !!day.start && !!day.end && toMinutes(start) >= toMinutes(day.start) && toMinutes(end) <= toMinutes(day.end);
}

interface Use { resource_id: string; start_time: string; end_time: string }

/** Active bookings holding any of these resources on a date (the moved appointment itself excluded). */
function usesOn(resourceIds: string[], date: string, excludeAppointmentId?: string): Use[] {
  if (!resourceIds.length) return [];
  return db.prepare(
    `SELECT ar.resource_id, a.start_time, a.end_time FROM appointment_resources ar JOIN appointments a ON a.id = ar.appointment_id
     WHERE ar.resource_id IN (${resourceIds.map(() => '?').join(',')}) AND a.date = ? AND ${ACTIVE} AND a.id != ?`
  ).all(...resourceIds, date, excludeAppointmentId ?? '') as Use[];
}

const hasRoom = (r: PoolResource, uses: Use[], start: string, end: string) =>
  uses.filter(u => u.resource_id === r.id && u.start_time < end && u.end_time > start).length < r.capacity;

/**
 * For listing slots on one date: whether some resource of the pool is free for a time, or null when the service needs
 * no resource. Reads the day's bookings once.
 */
export function resourceChecker(orgId: string, serviceId: string, date: string, excludeAppointmentId?: string, workspaceId?: string | null):
  ((start: string, end: string) => boolean) | null {
  const { needed, pool } = resourcePool(orgId, serviceId, workspaceId);
  if (!needed) return null;
  const uses = usesOn(pool.map(r => r.id), date, excludeAppointmentId);
  return (start, end) => pool.some(r => resourceOpen(r, date, start, end) && hasRoom(r, uses, start, end));
}

/**
 * The resources a booking will hold, or why it cannot be booked. Call inside the write transaction.
 * `explicit`: resources chosen by staff (each must be free). Otherwise the ones in `keep` (what a moved booking holds)
 * if they are all still free, else the first free resource of the service's pool.
 */
export function chooseResources(input: {
  orgId: string; serviceId: string; date: string; startTime: string; endTime: string;
  excludeAppointmentId?: string; workspaceId?: string | null; explicit?: string[]; keep?: string[];
}): { ids: string[] } | SlotProblem {
  const { orgId, serviceId, date, startTime, endTime } = input;
  if (input.explicit?.length) {
    const rows = db.prepare(
      `SELECT id, name, type, capacity, availability_rules, workspace_ids, service_ids, is_active FROM resources
       WHERE organization_id = ? AND id IN (${input.explicit.map(() => '?').join(',')})`
    ).all(orgId, ...input.explicit) as ResourceRow[];
    if (rows.length !== new Set(input.explicit).size) return { status: 400, error: 'Resource not found' };
    const uses = usesOn(rows.map(r => r.id), date, input.excludeAppointmentId);
    for (const r of rows) {
      if (!r.is_active) return { status: 400, error: `${r.name} is inactive and cannot be booked` };
      const res = toPool(r);
      if (!resourceOpen(res, date, startTime, endTime)) return { status: 400, error: `${r.name} is not open at that time` };
      if (!hasRoom(res, uses, startTime, endTime)) return { status: 409, error: `${r.name} is already in use at that time. Choose another time.` };
    }
    return { ids: rows.map(r => r.id) };
  }
  const { needed, pool, noun } = resourcePool(orgId, serviceId, input.workspaceId);
  const keep = input.keep ?? [];
  const uses = usesOn([...new Set([...pool.map(r => r.id), ...keep])], date, input.excludeAppointmentId);
  if (keep.length) {
    const kept = db.prepare(
      `SELECT id, name, type, capacity, availability_rules, workspace_ids, service_ids, is_active FROM resources
       WHERE organization_id = ? AND id IN (${keep.map(() => '?').join(',')})`
    ).all(orgId, ...keep) as ResourceRow[];
    if (kept.length === keep.length && kept.every(r => r.is_active && resourceOpen(toPool(r), date, startTime, endTime) && hasRoom(toPool(r), uses, startTime, endTime))) {
      return { ids: keep };
    }
  }
  if (!needed) return { ids: [] };
  if (!pool.length) return { status: 409, error: `This service needs a ${noun}, and none is available. Ask the business to check its resources.` };
  const free = pool.find(r => resourceOpen(r, date, startTime, endTime) && hasRoom(r, uses, startTime, endTime));
  if (!free) return { status: 409, error: `No ${noun} is free at that time. Please choose another time.` };
  return { ids: [free.id] };
}

/** Records what a booking holds (table and the appointment's resource list). Call after the appointment row is final. */
export function holdResources(appointmentId: string, orgId: string, resourceIds: string[]): void {
  db.prepare('DELETE FROM appointment_resources WHERE appointment_id = ?').run(appointmentId);
  const insert = db.prepare('INSERT INTO appointment_resources (appointment_id, resource_id, organization_id) VALUES (?, ?, ?)');
  for (const id of resourceIds) insert.run(appointmentId, id, orgId);
  db.prepare('UPDATE appointments SET resource_ids = ? WHERE id = ?').run(JSON.stringify(resourceIds), appointmentId);
}

/** Releases what a booking holds, before it is moved (the new holding is recorded after the move). */
export function releaseResources(appointmentId: string): void {
  db.prepare('DELETE FROM appointment_resources WHERE appointment_id = ?').run(appointmentId);
}

export function heldResources(appointmentId: string): string[] {
  return (db.prepare('SELECT resource_id FROM appointment_resources WHERE appointment_id = ? ORDER BY resource_id').all(appointmentId) as Array<{ resource_id: string }>)
    .map(r => r.resource_id);
}
