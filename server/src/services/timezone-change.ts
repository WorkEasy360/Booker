// Changing a business's time zone keeps every appointment at the same absolute instant.
// Appointments are stored as business-local date + times plus the zone they were recorded in. When the business moves
// to a new zone, each appointment recorded in another zone is re-expressed in the new one (10:00 in New York becomes
// 19:30 or 20:30 in Kolkata, depending on daylight saving); its instant, duration, staff and status do not change.
import type Database from 'better-sqlite3';
import { zonedToInstant, instantToZoned, addMinutesToTime } from './zoned-time';

interface Row { id: string; booking_ref: string; date: string; start_time: string; end_time: string; duration: number; timezone: string | null }
export interface ZoneChange { id: string; bookingRef: string; from: { date: string; startTime: string; timezone: string }; to: { date: string; startTime: string; endTime: string } }

/** What re-expressing the business's appointments in newZone would change (nothing is written). */
export function planZoneChange(db: Database.Database, orgId: string, oldZone: string, newZone: string): ZoneChange[] {
  const rows = db.prepare('SELECT id, booking_ref, date, start_time, end_time, duration, timezone FROM appointments WHERE organization_id = ?')
    .all(orgId) as Row[];
  const changes: ZoneChange[] = [];
  for (const r of rows) {
    const recorded = r.timezone || oldZone;
    if (recorded === newZone) continue;
    const local = instantToZoned(zonedToInstant(r.date, r.start_time, recorded), newZone);
    // The end keeps the duration on the clock face; past midnight it is written as 24:xx, as new bookings are.
    const length = r.duration || (Number(r.end_time.slice(0, 2)) * 60 + Number(r.end_time.slice(3, 5)) - Number(r.start_time.slice(0, 2)) * 60 - Number(r.start_time.slice(3, 5)));
    changes.push({ id: r.id, bookingRef: r.booking_ref, from: { date: r.date, startTime: r.start_time, timezone: recorded }, to: { date: local.date, startTime: local.time, endTime: addMinutesToTime(local.time, length) } });
  }
  return changes;
}

/**
 * Writes the plan inside the caller's transaction. Rows first move to a unique placeholder date, so the database's
 * overlap guard never compares a moved appointment with one that has not moved yet; then they take their new values.
 * A genuine overlap in absolute time (already a double booking) aborts the whole change.
 */
export function applyZoneChange(db: Database.Database, changes: ZoneChange[], newZone: string): void {
  const park = db.prepare("UPDATE appointments SET date = 'tz-move-' || id WHERE id = ?");
  const place = db.prepare("UPDATE appointments SET date = ?, start_time = ?, end_time = ?, timezone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?");
  for (const c of changes) park.run(c.id);
  for (const c of changes) place.run(c.to.date, c.to.startTime, c.to.endTime, newZone, c.id);
}
