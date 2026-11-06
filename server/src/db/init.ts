import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { runMigrations, MIGRATION_IDS } from './migrations';
import { createSchema } from './schema';
import { databasePath } from './location';

// In production this refuses a missing, relative or in-application DB_PATH before anything is opened (location.ts).
const resolved = databasePath();

// Ensure data directory exists
fs.mkdirSync(path.dirname(resolved), { recursive: true });

const db = new Database(resolved);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────

createSchema(db);
const migrationReport = runMigrations(db);
// Every start says where the schema stands; anything skipped is a warning that names the records to fix.
if (process.env.NODE_ENV !== 'test') {
  const done = migrationReport.alreadyApplied.length + migrationReport.applied.length;
  console.log(`[migrations] ${done}/${MIGRATION_IDS.length} applied`
    + (migrationReport.applied.length ? `; applied now: ${migrationReport.applied.join(', ')}` : '')
    + (migrationReport.skipped.length ? `; skipped: ${migrationReport.skipped.map(s => s.id).join(', ')}` : ''));
}
for (const s of migrationReport.skipped) console.warn(`[migrations] SKIPPED ${s.id}: ${s.reason}`);

export { migrationReport };
export default db;
