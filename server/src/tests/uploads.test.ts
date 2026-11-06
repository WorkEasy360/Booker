// Logo and staff-photo uploads: the file type is read from the bytes (PNG, JPEG, WebP only; SVG, HTML and renamed
// files are refused), size and pixel limits, server-generated names, replace and remove, the public image response
// headers, and who may upload: administrators of the same business for staff photos, settings writers for the logo.
// Synthetic images and accounts; files go to the per-run temporary upload folder, which the tests empty afterwards.

import request from 'supertest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import bcrypt from 'bcryptjs';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { inspectImage, MAX_DIMENSION } from '../services/media/image-check';
import { LocalDiskStorage, mediaStorage, isStorageKey } from '../services/media/storage';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A real, minimal PNG of the given size (one colour). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x40)]);
  const raw = Buffer.concat(Array.from({ length: Math.min(height, 64) }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** JPEG header with a start-of-frame giving the size (enough for the type and size check). */
function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'), sof, Buffer.from([0xff, 0xd9])]);
}
/** WebP (lossless VP8L) header giving the size. */
function webp(width: number, height: number): Buffer {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const vp8l = Buffer.alloc(5); vp8l[0] = 0x2f; vp8l.writeUInt32LE(bits >>> 0, 1);
  const chunkHead = Buffer.concat([Buffer.from('VP8L'), Buffer.from([vp8l.length + 4, 0, 0, 0])]);
  const body = Buffer.concat([Buffer.from('WEBP'), chunkHead, vp8l, Buffer.alloc(8)]);
  const size = Buffer.alloc(4); size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF'), size, body]);
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

let owner: { h: Record<string, string>; orgId: string };
let other: { h: Record<string, string>; orgId: string };
let staffId = '';
let serviceId = '';
let slug = '';

async function business(label: string) {
  const s = await signUpAndSignIn(app, { name: `Up ${label}`, email: `up-${label}-${RUN}@example.com`, company: `Uploads ${label} ${RUN}`, password: 'StartPass123' });
  return { h: bearer(sessionToken(s)), orgId: s.body.data.user.organization_id as string };
}
async function userWithRole(orgId: string, role: string) {
  const email = `${role}-${nanoid(6)}-${RUN}@example.com`.toLowerCase();
  db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`user-${nanoid(8)}`, orgId, email, bcrypt.hashSync('TestPass123', 4), role, role);
  return bearer(sessionToken(await request(app).post('/api/auth/login').send({ email, password: 'TestPass123' })));
}
const putImage = (url: string, h: Record<string, string>, bytes: Buffer, type = 'image/png') =>
  request(app).put(url).set(h).set('Content-Type', type).send(bytes);

beforeAll(async () => {
  owner = await business('owner');
  other = await business('other');
  serviceId = (await request(app).post('/api/services').set(owner.h).send({ name: 'Photo Svc', category: 'consultation', duration: 30, price: 0, maxAdvance: 365 })).body.data.id;
  staffId = (await request(app).post('/api/staff').set(owner.h).send({ name: 'Photo Person', email: `photo-${RUN}@example.com`, serviceIds: [serviceId] })).body.data.id;
  slug = await publishBookingPage(app, owner.h, [serviceId], 'uploads');
});

// The shared teardown closes the database first, so the files are removed by folder: one per test business.
afterAll(() => {
  const root = path.join(path.dirname(process.env.DB_PATH!), 'uploads');
  for (const orgId of [owner?.orgId, other?.orgId]) if (orgId) fs.rmSync(path.join(root, orgId), { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(process.env.DB_PATH!), `keys-${RUN}`), { recursive: true, force: true });
});

describe('what counts as an image', () => {
  it('reads the type and size from the bytes', () => {
    expect(inspectImage(png(120, 40))).toEqual({ type: 'image/png', width: 120, height: 40 });
    expect(inspectImage(jpeg(640, 480))).toEqual({ type: 'image/jpeg', width: 640, height: 480 });
    expect(inspectImage(webp(300, 200))).toEqual({ type: 'image/webp', width: 300, height: 200 });
  });

  it('refuses SVG, HTML, empty, truncated, oversized and enormous images', () => {
    expect(inspectImage(SVG)).toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    expect(inspectImage(HTML)).toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    expect(inspectImage(Buffer.alloc(0))).toMatchObject({ code: 'EMPTY' });
    expect(inspectImage(png(10, 10).subarray(0, 12))).toMatchObject({ code: 'UNREADABLE' });
    expect(inspectImage(Buffer.concat([png(10, 10), Buffer.alloc(2 * 1024 * 1024)]))).toMatchObject({ code: 'TOO_LARGE' });
    expect(inspectImage(png(MAX_DIMENSION + 1, 10))).toMatchObject({ code: 'TOO_MANY_PIXELS' });
    expect(inspectImage(jpeg(20000, 20000))).toMatchObject({ code: 'TOO_MANY_PIXELS' });
  });

  it('storage keys cannot leave the upload folder', async () => {
    for (const bad of ['../x/abcdefgh.png', 'org/../../abcdefgh.png', 'org/abcdefgh.svg', 'org\\abcdefgh.png', '/etc/abcdefgh.png', 'org/short.png']) {
      expect([bad, isStorageKey(bad)]).toEqual([bad, false]);
    }
    const store = new LocalDiskStorage(path.join(path.dirname(process.env.DB_PATH!), `keys-${RUN}`));
    await expect(store.put('../escape/abcdefgh.png', Buffer.from('x'))).rejects.toThrow(/Invalid storage key/);
  });
});

describe('the business logo', () => {
  it('upload, show on the public page, replace and remove; the old file is deleted', async () => {
    const first = await putImage('/api/settings/logo', owner.h, png(200, 80));
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ url: `/api/public/media/${first.body.data.id}`, contentType: 'image/png', width: 200, height: 80 });
    const firstKey = (db.prepare('SELECT storage_key FROM media_files WHERE id = ?').get(first.body.data.id) as { storage_key: string }).storage_key;
    expect(firstKey).toMatch(new RegExp(`^${owner.orgId}/[A-Za-z0-9_-]{21}\\.png$`));
    expect(await mediaStorage().get(firstKey)).not.toBeNull();

    expect((await request(app).get('/api/settings').set(owner.h)).body.data.logoUpload).toMatchObject({ id: first.body.data.id });
    expect((await request(app).get(`/api/public/pages/${slug}`)).body.data.logoUrl).toBe(first.body.data.url);

    const second = await putImage('/api/settings/logo', owner.h, jpeg(64, 64), 'image/jpeg');
    expect(second.status).toBe(200);
    expect(await mediaStorage().get(firstKey)).toBeNull();
    expect((await request(app).get(first.body.data.url)).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) c FROM media_files WHERE organization_id = ? AND kind = 'logo'").get(owner.orgId)).toEqual({ c: 1 });

    expect((await request(app).delete('/api/settings/logo').set(owner.h)).status).toBe(200);
    expect((await request(app).get(second.body.data.url)).status).toBe(404);
    expect((await request(app).get(`/api/public/pages/${slug}`)).body.data.logoUrl ?? null).toBeNull();
    expect((await request(app).delete('/api/settings/logo').set(owner.h)).status).toBe(404);
  });

  it('refuses disguised and oversized files with a clear reason, whatever the content type says', async () => {
    const svg = await putImage('/api/settings/logo', owner.h, SVG, 'image/png');
    expect([svg.status, svg.body.code]).toEqual([415, 'UNSUPPORTED_TYPE']);
    const html = await putImage('/api/settings/logo', owner.h, HTML, 'image/jpeg');
    expect(html.status).toBe(415);
    const big = await putImage('/api/settings/logo', owner.h, Buffer.concat([png(10, 10), Buffer.alloc(2 * 1024 * 1024 + 10)]));
    expect(big.status).toBe(413);
    const huge = await putImage('/api/settings/logo', owner.h, png(5000, 10));
    expect([huge.status, huge.body.code]).toEqual([413, 'TOO_MANY_PIXELS']);
    expect(db.prepare("SELECT COUNT(*) c FROM media_files WHERE organization_id = ? AND kind = 'logo'").get(owner.orgId)).toEqual({ c: 0 });
  });

  it('only people who can change business settings can upload or remove it', async () => {
    const manager = await userWithRole(owner.orgId, 'manager');
    const staff = await userWithRole(owner.orgId, 'staff');
    for (const h of [manager, staff]) {
      expect((await putImage('/api/settings/logo', h, png(10, 10))).status).toBe(403);
      expect((await request(app).delete('/api/settings/logo').set(h)).status).toBe(403);
    }
    expect((await putImage('/api/settings/logo', {}, png(10, 10))).status).toBe(401);
  });

  it('is served with headers that stop it being run as a page', async () => {
    const up = await putImage('/api/settings/logo', owner.h, webp(32, 32), 'image/webp');
    const res = await request(app).get(up.body.data.url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['cache-control']).toMatch(/immutable/);
    expect(res.headers['content-disposition']).toMatch(/^inline; filename="logo\.webp"$/);
    expect((await request(app).get('/api/public/media/..%2F..%2Fetc%2Fpasswd')).status).toBe(404);
    expect((await request(app).get('/api/public/media/doesnotexist123')).status).toBe(404);
    await request(app).delete('/api/settings/logo').set(owner.h);
  });
});

describe('staff photos', () => {
  it('an administrator uploads and removes a photo; it appears on staff records and the public staff list', async () => {
    const up = await putImage(`/api/staff/${staffId}/photo`, owner.h, png(256, 256));
    expect(up.status).toBe(200);
    expect((await request(app).get(`/api/staff/${staffId}`).set(owner.h)).body.data.photoUrl).toBe(up.body.data.url);
    expect((await request(app).get('/api/staff').set(owner.h)).body.data.find((s: { id: string }) => s.id === staffId).photoUrl).toBe(up.body.data.url);
    const publicStaff = (await request(app).get(`/api/public/services/${serviceId}/staff`)).body.data;
    expect(publicStaff.find((s: { id: string }) => s.id === staffId).photoUrl).toBe(up.body.data.url);
    expect((await request(app).delete(`/api/staff/${staffId}/photo`).set(owner.h)).status).toBe(200);
    expect((await request(app).get(`/api/staff/${staffId}`).set(owner.h)).body.data.photoUrl).toBeNull();
  });

  it('another business, managers and staff cannot change it; unknown staff is 404', async () => {
    const manager = await userWithRole(owner.orgId, 'manager');
    expect((await putImage(`/api/staff/${staffId}/photo`, other.h, png(10, 10))).status).toBe(404);
    expect((await request(app).delete(`/api/staff/${staffId}/photo`).set(other.h)).status).toBe(404);
    expect((await putImage(`/api/staff/${staffId}/photo`, manager, png(10, 10))).status).toBe(403);
    expect((await putImage('/api/staff/staff-nope/photo', owner.h, png(10, 10))).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) c FROM media_files WHERE kind = 'staff_photo' AND owner_id = ?").get(staffId)).toEqual({ c: 0 });
  });

  it('deleting the staff member removes the photo and its file', async () => {
    const tempStaff = (await request(app).post('/api/staff').set(owner.h).send({ name: 'Short Stay', email: `short-${RUN}@example.com` })).body.data.id;
    const up = await putImage(`/api/staff/${tempStaff}/photo`, owner.h, png(40, 40));
    const key = (db.prepare('SELECT storage_key FROM media_files WHERE id = ?').get(up.body.data.id) as { storage_key: string }).storage_key;
    expect((await request(app).delete(`/api/staff/${tempStaff}`).set(owner.h)).status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) c FROM media_files WHERE id = ?').get(up.body.data.id)).toEqual({ c: 0 });
    expect(await mediaStorage().get(key)).toBeNull();
    expect(fs.existsSync(path.join(path.dirname(process.env.DB_PATH!), 'uploads', key))).toBe(false);
  });
});
