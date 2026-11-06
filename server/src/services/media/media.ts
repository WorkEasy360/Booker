import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import db from '../../db/init';
import { inspectImage, EXTENSIONS, type ImageProblem } from './image-check';
import { mediaStorage } from './storage';

// Uploaded images: one business logo per organization and one photo per staff member (table media_files, migration
// 012_media_files). The bytes go to the storage adapter under a server-generated key; the database records what the
// file is. Replacing an image removes the old file once the new one is saved. Images are served publicly by their
// random id (they appear on public booking pages), never by name or path.

export type MediaKind = 'logo' | 'staff_photo';

export interface MediaRow {
  id: string; organization_id: string; kind: MediaKind; owner_id: string; storage: string; storage_key: string;
  content_type: string; byte_size: number; width: number; height: number; sha256: string; created_at: string;
}

export const mediaUrl = (id: string) => `/api/public/media/${id}`;

export function publicMedia(row: Pick<MediaRow, 'id' | 'content_type' | 'width' | 'height' | 'byte_size'>) {
  return { id: row.id, url: mediaUrl(row.id), contentType: row.content_type, width: row.width, height: row.height, byteSize: row.byte_size };
}

export function currentMedia(orgId: string, kind: MediaKind, ownerId: string): MediaRow | undefined {
  return db.prepare('SELECT * FROM media_files WHERE organization_id = ? AND kind = ? AND owner_id = ?').get(orgId, kind, ownerId) as MediaRow | undefined;
}

/** Staff photo URLs of one organization, by staff id. */
export function staffPhotoUrls(orgId: string): Map<string, string> {
  const rows = db.prepare("SELECT id, owner_id FROM media_files WHERE organization_id = ? AND kind = 'staff_photo'").all(orgId) as Array<{ id: string; owner_id: string }>;
  return new Map(rows.map(r => [r.owner_id, mediaUrl(r.id)]));
}

export type SaveResult = { ok: true; media: ReturnType<typeof publicMedia> } | { ok: false; status: number; error: string; code: string };

const STATUS_FOR: Record<ImageProblem['code'], number> = { EMPTY: 400, TOO_LARGE: 413, UNSUPPORTED_TYPE: 415, UNREADABLE: 400, TOO_MANY_PIXELS: 413 };

/** Checks and stores an uploaded image, replacing the previous one for the same owner. */
export async function saveImage(orgId: string, kind: MediaKind, ownerId: string, bytes: Buffer, uploadedBy: string): Promise<SaveResult> {
  const info = inspectImage(bytes);
  if ('error' in info) return { ok: false, status: STATUS_FOR[info.code], error: info.error, code: info.code };
  const storage = mediaStorage();
  const id = nanoid(21);
  const key = `${orgId}/${id}.${EXTENSIONS[info.type]}`;
  await storage.put(key, bytes);
  let previous: MediaRow | undefined;
  try {
    previous = db.transaction(() => {
      const old = currentMedia(orgId, kind, ownerId);
      if (old) db.prepare('DELETE FROM media_files WHERE id = ?').run(old.id);
      db.prepare(
        `INSERT INTO media_files (id, organization_id, kind, owner_id, storage, storage_key, content_type, byte_size, width, height, sha256, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, orgId, kind, ownerId, storage.name, key, info.type, bytes.length, info.width, info.height,
        createHash('sha256').update(bytes).digest('hex'), uploadedBy);
      return old;
    }).immediate();
  } catch (e) {
    await storage.remove(key).catch(() => undefined); // nothing refers to it
    throw e;
  }
  if (previous) await storage.remove(previous.storage_key).catch(() => undefined);
  return { ok: true, media: publicMedia({ id, content_type: info.type, width: info.width, height: info.height, byte_size: bytes.length }) };
}

/** Removes an owner's image (row first, then the file). False when there was none. */
export async function removeImage(orgId: string, kind: MediaKind, ownerId: string): Promise<boolean> {
  const row = currentMedia(orgId, kind, ownerId);
  if (!row) return false;
  db.prepare('DELETE FROM media_files WHERE id = ?').run(row.id);
  await mediaStorage().remove(row.storage_key).catch(() => undefined);
  return true;
}

/** The bytes and type of a stored image by id, or null. */
export async function readImage(id: string): Promise<{ row: MediaRow; bytes: Buffer } | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const row = db.prepare('SELECT * FROM media_files WHERE id = ?').get(id) as MediaRow | undefined;
  if (!row) return null;
  const bytes = await mediaStorage().get(row.storage_key);
  return bytes ? { row, bytes } : null;
}
