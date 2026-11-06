import path from 'path';

// Where the database and uploaded files live. The database is opened (and migrated) as soon as src/db/init.ts is
// imported, before any other startup check runs, so the production rules are applied here:
//  - DB_PATH must be set and absolute. Without it the old default, ./data/workeasy360.db relative to the start
//    directory, would be used: started in server/ on a development machine that is the development database.
//  - DB_PATH and UPLOAD_DIR must be outside the application folder: inside it they would be lost on the next
//    redeploy (a container image or a replaced release folder), and a development database there is never meant for
//    production.
// Outside production the defaults stay as they were.

/**
 * The application folder: the project root that holds server/ and the web app (/app in the Docker image, the release
 * folder on a server), whether running from server/src (tsx) or server/dist.
 */
export const APP_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DB_PATH = './data/workeasy360.db';

const isAbsolutePath = (p: string) => /^([a-zA-Z]:[\\/]|\/)/.test(p);
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export class StorageLocationError extends Error {}

/** The database file to open; throws in production when DB_PATH is missing, relative or inside the application. */
export function databasePath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), appDir = APP_DIR): string {
  const configured = env.DB_PATH?.trim();
  if (env.NODE_ENV !== 'production') return path.resolve(cwd, configured || DEFAULT_DB_PATH);
  if (!configured) {
    throw new StorageLocationError('DB_PATH is not set. In production it must be the absolute path of the database file on the persistent disk or volume (for example /data/workeasy360.db); the server will not fall back to a default database');
  }
  if (!isAbsolutePath(configured)) {
    throw new StorageLocationError('DB_PATH must be an absolute path in production (for example /data/workeasy360.db)');
  }
  const resolved = path.resolve(configured);
  if (inside(resolved, appDir)) {
    throw new StorageLocationError('DB_PATH points inside the application folder; in production the database must be on the persistent disk or volume, outside the application');
  }
  return resolved;
}

/** The folder for uploaded logos and photos: UPLOAD_DIR, or "uploads" beside the database. Same rules in production. */
export function uploadDirectory(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd(), appDir = APP_DIR): string {
  const configured = env.UPLOAD_DIR?.trim();
  if (!configured) return path.join(path.dirname(databasePath(env, cwd, appDir)), 'uploads');
  if (env.NODE_ENV !== 'production') return path.resolve(cwd, configured);
  if (!isAbsolutePath(configured)) throw new StorageLocationError('UPLOAD_DIR must be an absolute path in production');
  const resolved = path.resolve(configured);
  if (inside(resolved, appDir)) {
    throw new StorageLocationError('UPLOAD_DIR points inside the application folder; in production uploads must be on the persistent disk or volume');
  }
  return resolved;
}
