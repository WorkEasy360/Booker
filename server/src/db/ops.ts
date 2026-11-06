import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

// SQLite backup, verification and restore. Used by scripts/db-backup.ts and scripts/db-restore.ts and by the tests.
// Nothing here deletes data: a restore moves the database it replaces aside instead of overwriting it.

export interface DbSummary {
  integrity: string;
  foreignKeyProblems: number;
  tables: Record<string, number>;
  migrations: string[];
  triggers: string[];
}

/** Integrity check, row counts per table, applied migrations and triggers. Opens the file read-only. */
export function summarize(file: string): DbSummary {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) ?? 'unknown';
    const foreignKeyProblems = (db.pragma('foreign_key_check') as unknown[]).length;
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
      .map(r => r.name);
    const tables: Record<string, number> = {};
    for (const name of names) tables[name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as { c: number }).c;
    const migrations = names.includes('schema_migrations')
      ? (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: string }>).map(r => r.id)
      : [];
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>).map(r => r.name);
    return { integrity, foreignKeyProblems, tables, migrations, triggers };
  } finally {
    db.close();
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export interface BackupResult { file: string; manifest: string; bytes: number; sha256: string; summary: DbSummary }

/**
 * Consistent online backup using SQLite's backup API: safe while the server is running and writing (WAL included),
 * unlike copying the .db file. The copy is verified and described in a manifest next to it.
 */
export async function backupDatabase(source: string, outDir: string, label = new Date().toISOString().replace(/[:.]/g, '-')): Promise<BackupResult> {
  if (!fs.existsSync(source)) throw new Error(`Database not found: ${source}`);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${path.basename(source, path.extname(source))}-${label}.db`);
  if (fs.existsSync(file)) throw new Error(`Backup already exists: ${file}`);

  let src: Database.Database;
  try {
    src = new Database(source, { readonly: true, fileMustExist: true });
  } catch {
    // A WAL database that no process has open may need its shared-memory file created; this does not change data.
    src = new Database(source, { fileMustExist: true });
  }
  try {
    await src.backup(file);
  } finally {
    src.close();
  }

  const summary = summarize(file);
  if (summary.integrity !== 'ok') throw new Error(`Backup failed its integrity check: ${summary.integrity}`);
  const result = { file, bytes: fs.statSync(file).size, sha256: sha256(file), summary };
  const manifest = `${file}.json`;
  fs.writeFileSync(manifest, JSON.stringify({ source: path.resolve(source), createdAt: new Date().toISOString(), ...result }, null, 2));
  return { ...result, manifest };
}

export interface RestoreResult { target: string; movedAside: string | null; summary: DbSummary }

/**
 * Restores a backup to `target`. The backup is verified first. An existing target is never overwritten unless
 * `force` is set, and even then it is moved aside (with its -wal/-shm files) rather than deleted.
 * The server must be stopped while restoring its live database.
 */
export async function restoreDatabase(backup: string, target: string, opts: { force?: boolean } = {}): Promise<RestoreResult> {
  if (!fs.existsSync(backup)) throw new Error(`Backup not found: ${backup}`);
  let before: DbSummary;
  try {
    before = summarize(backup);
  } catch (e) {
    throw new Error(`Backup is not a readable SQLite database: ${(e as Error).message}`);
  }
  if (before.integrity !== 'ok') throw new Error(`Backup failed its integrity check: ${before.integrity}`);
  if (path.resolve(backup) === path.resolve(target)) throw new Error('Backup and target are the same file');

  let movedAside: string | null = null;
  if (fs.existsSync(target)) {
    if (!opts.force) throw new Error(`Target already exists: ${target}. Use --force to move it aside and restore.`);
    movedAside = `${target}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(target, movedAside);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(target + suffix)) fs.renameSync(target + suffix, movedAside + suffix);
    }
  }

  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  const src = new Database(backup, { readonly: true, fileMustExist: true });
  try {
    await src.backup(target);
  } finally {
    src.close();
  }

  const after = summarize(target);
  const problems: string[] = [];
  if (after.integrity !== 'ok') problems.push(`integrity: ${after.integrity}`);
  for (const [table, count] of Object.entries(before.tables)) {
    if (after.tables[table] !== count) problems.push(`${table}: ${after.tables[table]} rows, expected ${count}`);
  }
  if (after.migrations.join() !== before.migrations.join()) problems.push('migration history differs');
  if (after.triggers.join() !== before.triggers.join()) problems.push('triggers differ');
  if (problems.length) throw new Error(`Restored database does not match the backup: ${problems.join('; ')}`);
  return { target, movedAside, summary: after };
}
