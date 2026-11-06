// Removal of confirmed, disposable test records. Every record is named in a plan together with the name (or slug or
// email) it must still have, so a reused or mistyped id can never delete something else. Anything that carries real
// activity (appointments, customers) is refused instead of deleted.
import type Database from 'better-sqlite3';

export type CleanupTable = 'booking_pages' | 'services' | 'workspaces' | 'resources' | 'customers' | 'users' | 'organizations';
export interface CleanupRecord { table: CleanupTable; id: string; expect: string; reason?: string }
export interface PlannedDeletion { record: CleanupRecord; label: string | null; problems: string[]; effects: string[] }

const LABEL: Record<CleanupTable, string> = {
  booking_pages: 'slug', services: 'name', workspaces: 'name', resources: 'name', customers: 'email', users: 'email', organizations: 'name',
};

/** JSON list columns that can hold an id of the table being cleaned. */
const LIST_REFERENCES: Partial<Record<CleanupTable, Array<[table: string, column: string]>>> = {
  services: [['workspaces', 'service_ids'], ['staff', 'service_ids'], ['resources', 'service_ids'], ['booking_pages', 'service_ids']],
  workspaces: [['services', 'workspace_ids'], ['staff', 'workspace_ids'], ['resources', 'workspace_ids']],
  resources: [['services', 'resource_ids']],
};

type Db = Database.Database;
const count = (db: Db, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { c: number }).c;
const listing = (db: Db, table: string, column: string, id: string) =>
  count(db, `SELECT COUNT(*) c FROM ${table} WHERE EXISTS (SELECT 1 FROM json_each(${table}.${column}) WHERE value = ?)`, id);

/** What each deletion would do, and why it is refused (problems). Reads only. */
export function planCleanup(db: Db, records: CleanupRecord[]): PlannedDeletion[] {
  const orgsGoing = new Set(records.filter(r => r.table === 'organizations').map(r => r.id));
  return records.map(record => {
    const problems: string[] = [];
    const effects: string[] = [];
    if (!(record.table in LABEL)) return { record, label: null, problems: [`table "${record.table}" is not supported`], effects };
    const row = db.prepare(`SELECT * FROM ${record.table} WHERE id = ?`).get(record.id) as Record<string, unknown> | undefined;
    if (!row) return { record, label: null, problems: ['not found'], effects };
    const label = String(row[LABEL[record.table]] ?? '');
    if (label !== record.expect) problems.push(`its ${LABEL[record.table]} is "${label}", not "${record.expect}" as planned`);
    const id = record.id;

    switch (record.table) {
      case 'services':
        if (count(db, 'SELECT COUNT(*) c FROM appointments WHERE service_id = ?', id)) problems.push('it has appointments');
        break;
      case 'workspaces':
        if (count(db, 'SELECT COUNT(*) c FROM appointments WHERE workspace_id = ?', id)) problems.push('it has appointments');
        break;
      case 'resources':
        if (listing(db, 'appointments', 'resource_ids', id)) problems.push('appointments use it');
        break;
      case 'customers':
        if (count(db, 'SELECT COUNT(*) c FROM appointments WHERE customer_id = ?', id)) problems.push('the customer has appointments');
        break;
      case 'users': {
        const orgId = row.organization_id as string;
        const otherAdmins = count(db, "SELECT COUNT(*) c FROM users WHERE organization_id = ? AND role = 'admin' AND is_active = 1 AND id != ?", orgId, id);
        if (row.role === 'admin' && !otherAdmins && !orgsGoing.has(orgId)) problems.push('it is the business\'s last active administrator');
        effects.push('its sign-in stops working and its sessions end');
        break;
      }
      case 'organizations': {
        const activity = count(db, 'SELECT COUNT(*) c FROM appointments WHERE organization_id = ?', id)
          + count(db, 'SELECT COUNT(*) c FROM customers WHERE organization_id = ?', id);
        if (activity) problems.push('it has customers or appointments, so it is not test-only');
        effects.push(`removes its ${count(db, 'SELECT COUNT(*) c FROM users WHERE organization_id = ?', id)} sign-in(s) and all of its settings`);
        break;
      }
      case 'booking_pages':
        if (row.is_published) effects.push(`the public link /book/${row.slug} stops working`);
        break;
    }
    for (const [table, column] of LIST_REFERENCES[record.table] ?? []) {
      const n = listing(db, table, column, id);
      if (n) effects.push(`removed from ${n} ${table.replace('_', ' ')} list(s)`);
    }
    return { record, label, problems, effects };
  });
}

/** Deletes the planned records in one transaction, or nothing at all if any record is refused. */
export function applyCleanup(db: Db, records: CleanupRecord[]): PlannedDeletion[] {
  const plan = planCleanup(db, records);
  const refused = plan.filter(p => p.problems.length);
  if (refused.length) {
    throw new Error(`Nothing was deleted. Refused: ${refused.map(p => `${p.record.table} ${p.record.id} (${p.problems.join('; ')})`).join(', ')}`);
  }
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    for (const { record } of plan) {
      for (const [table, column] of LIST_REFERENCES[record.table] ?? []) {
        db.prepare(
          `UPDATE ${table} SET ${column} = (SELECT json_group_array(value) FROM json_each(${table}.${column}) WHERE value != ?)
           WHERE EXISTS (SELECT 1 FROM json_each(${table}.${column}) WHERE value = ?)`
        ).run(record.id, record.id);
      }
      if (record.table === 'services') db.prepare('UPDATE booking_pages SET service_id = NULL WHERE service_id = ?').run(record.id);
      if (record.table === 'organizations') {
        // Rows that name the organization without a cascading foreign key go first.
        for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'organizations'").all() as Array<{ name: string }>) {
          const hasOrgColumn = (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>).some(c => c.name === 'organization_id');
          const cascades = (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as Array<{ table: string; on_delete: string }>)
            .some(f => f.table === 'organizations' && f.on_delete === 'CASCADE');
          if (hasOrgColumn && !cascades) db.prepare(`DELETE FROM ${name} WHERE organization_id = ?`).run(record.id);
        }
      }
      db.prepare(`DELETE FROM ${record.table} WHERE id = ?`).run(record.id);
    }
  })();
  return plan;
}
