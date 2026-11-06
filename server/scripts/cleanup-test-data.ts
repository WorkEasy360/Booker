// Removes confirmed, disposable test records listed in a plan file. Dry run unless --apply is given.
// Usage (from server/):
//   npx tsx scripts/cleanup-test-data.ts --plan ./data/test-data-cleanup-plan.json            (shows what would happen)
//   npx tsx scripts/cleanup-test-data.ts --plan ./data/test-data-cleanup-plan.json --apply    (backs up, then deletes)
// Options: --db <path> (default DB_PATH or ./data/workeasy360.db), --only <id,id,...> (a subset of the plan).
// Stop the API server before --apply. Never runs with NODE_ENV=production.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { backupDatabase } from '../src/db/ops';
import { applyCleanup, planCleanup, type CleanupRecord } from '../src/db/cleanup';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.NODE_ENV === 'production') throw new Error('Refusing to delete records with NODE_ENV=production.');
  const planFile = arg('plan');
  if (!planFile) throw new Error('--plan <file.json> is required');
  const source = path.resolve(arg('db') ?? process.env.DB_PATH ?? './data/workeasy360.db');
  let records = (JSON.parse(fs.readFileSync(planFile, 'utf8')) as { records: CleanupRecord[] }).records;
  const only = arg('only')?.split(',').map(s => s.trim()).filter(Boolean);
  if (only) records = records.filter(r => only.includes(r.id));
  if (!records.length) throw new Error('The plan selects no records.');

  const db = new Database(source, { readonly: !apply, fileMustExist: true });
  const plan = planCleanup(db, records);
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${source}`);
  for (const p of plan) {
    console.log(`${p.problems.length ? 'REFUSED' : 'delete '}  ${p.record.table} ${p.record.id} "${p.label ?? '?'}"${p.record.reason ? ` (${p.record.reason})` : ''}`);
    for (const e of p.effects) console.log(`           - ${e}`);
    for (const pr of p.problems) console.log(`           ! ${pr}`);
  }
  if (!apply) { console.log('\nNothing was changed. Re-run with --apply to delete the records above.'); db.close(); return; }
  if (plan.some(p => p.problems.length)) { db.close(); throw new Error('Some records are refused; nothing was deleted.'); }

  db.close();
  const backup = await backupDatabase(source, path.resolve(path.dirname(source), '..', 'backups'), `before-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  console.log(`Backup written first: ${backup.file}`);
  const rw = new Database(source, { fileMustExist: true });
  applyCleanup(rw, records);
  rw.close();
  console.log(`Deleted ${records.length} record(s).`);
}

main().catch(e => { console.error((e as Error).message); process.exit(1); });
