// Restores a verified backup. Stop the server first when restoring its live database.
// Usage (from server/):  npm run db:restore -- --from ./backups/workeasy360-<time>.db --to ./data/restored.db [--force]
// Without --force an existing target is never touched; with --force it is moved aside (renamed), never deleted.
import path from 'path';
import { restoreDatabase } from '../src/db/ops';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const from = arg('from');
  const to = arg('to');
  if (!from || !to) {
    console.error('Usage: npm run db:restore -- --from <backup.db> --to <target.db> [--force]');
    process.exit(2);
  }
  const result = await restoreDatabase(path.resolve(from), path.resolve(to), { force: process.argv.includes('--force') });
  if (result.movedAside) console.log(`Previous database moved aside to: ${result.movedAside}`);
  console.log(`Restored to:  ${result.target}`);
  console.log(`Integrity:    ${result.summary.integrity}; foreign key problems: ${result.summary.foreignKeyProblems}`);
  console.log(`Migrations:   ${result.summary.migrations.join(', ') || 'none recorded'}`);
  console.log('Rows:         ' + Object.entries(result.summary.tables).map(([t, c]) => `${t}=${c}`).join(', '));
  console.log('Row counts, migrations and triggers match the backup.');
}

main().catch(e => { console.error(`Restore failed: ${(e as Error).message}`); process.exit(1); });
