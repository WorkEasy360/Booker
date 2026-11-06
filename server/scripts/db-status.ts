// Read-only migration report for a database: which migrations are applied, pending, or blocked by existing data.
// Usage (from server/):  npm run db:status -- [--db ./data/workeasy360.db]
import 'dotenv/config';
import path from 'path';
import Database from 'better-sqlite3';
import { migrationStatus } from '../src/db/migrations';
import { summarize } from '../src/db/ops';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const file = path.resolve(arg('db') ?? process.env.DB_PATH ?? './data/workeasy360.db');
const summary = summarize(file);
const db = new Database(file, { readonly: true, fileMustExist: true });
try {
  console.log(`Database:   ${file}`);
  console.log(`Integrity:  ${summary.integrity}; foreign key problems: ${summary.foreignKeyProblems}`);
  console.log('Migrations:');
  for (const m of migrationStatus(db)) {
    const detail = m.state === 'applied' ? `applied ${m.appliedAt}` : m.state === 'blocked' ? `BLOCKED: ${m.reason}` : 'pending (applies at next server start)';
    console.log(`  ${m.id.padEnd(34)} ${detail}`);
  }
} finally {
  db.close();
}
