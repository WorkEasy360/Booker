// Online backup of the SQLite database, verified and described in a manifest.
// Usage (from server/):  npm run db:backup -- [--db ./data/workeasy360.db] [--out ./backups]
// Safe while the server is running. Only reads the source database.
import 'dotenv/config';
import path from 'path';
import { backupDatabase } from '../src/db/ops';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const source = path.resolve(arg('db') ?? process.env.DB_PATH ?? './data/workeasy360.db');
  const outDir = path.resolve(arg('out') ?? './backups');
  const result = await backupDatabase(source, outDir);
  console.log(`Backup written: ${result.file} (${(result.bytes / 1024).toFixed(1)} KiB)`);
  console.log(`Manifest:       ${result.manifest}`);
  console.log(`SHA-256:        ${result.sha256}`);
  console.log(`Integrity:      ${result.summary.integrity}; foreign key problems: ${result.summary.foreignKeyProblems}`);
  console.log(`Migrations:     ${result.summary.migrations.join(', ') || 'none recorded'}`);
  console.log('Rows:           ' + Object.entries(result.summary.tables).map(([t, c]) => `${t}=${c}`).join(', '));
}

main().catch(e => { console.error(`Backup failed: ${(e as Error).message}`); process.exit(1); });
