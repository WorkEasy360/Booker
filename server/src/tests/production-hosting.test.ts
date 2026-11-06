// Production hosting: the database and uploads can only be where the operator explicitly put them (never a default,
// never inside the application, which a redeploy replaces), the server refuses to start otherwise without creating
// any file, and the built web app can be served by the API process on the same origin (WEB_DIST_DIR).
// Every server process here starts in its own temporary folder, so even a broken guard could only create files there.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { APP_DIR, databasePath, uploadDirectory } from '../db/location';
import { mountWebApp } from '../web-app';

jest.setTimeout(120_000);

const SERVER_DIR = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we360-hosting-'));
const prod = (env: Record<string, string>) => ({ NODE_ENV: 'production', ...env }) as NodeJS.ProcessEnv;

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('where production keeps its data', () => {
  it('the application folder is the project root, holding server/ and the web app', () => {
    expect(APP_DIR).toBe(path.resolve(SERVER_DIR, '..'));
    expect(fs.existsSync(path.join(APP_DIR, 'server', 'src', 'db', 'location.ts'))).toBe(true);
    expect(fs.existsSync(path.join(APP_DIR, 'index.html'))).toBe(true);
  });

  it('production refuses a missing, relative or in-application DB_PATH; outside production the default stays', () => {
    expect(() => databasePath(prod({}), TMP)).toThrow(/DB_PATH is not set/);
    expect(() => databasePath(prod({ DB_PATH: '  ' }), TMP)).toThrow(/DB_PATH is not set/);
    expect(() => databasePath(prod({ DB_PATH: './data/workeasy360.db' }), TMP)).toThrow(/absolute path/);
    expect(() => databasePath(prod({ DB_PATH: 'data/workeasy360.db' }), TMP)).toThrow(/absolute path/);
    // The development database's own location (computed only, never opened) is refused, and so is anything else inside.
    expect(() => databasePath(prod({ DB_PATH: path.join(APP_DIR, 'server', 'data', 'workeasy360.db') }), TMP)).toThrow(/inside the application folder/);
    expect(() => databasePath(prod({ DB_PATH: path.join(APP_DIR, 'server', 'dist', 'x.db') }), TMP)).toThrow(/inside the application folder/);
    // Beside server/ but still inside the application (in the image: /app/data), so lost on the next deploy.
    expect(() => databasePath(prod({ DB_PATH: path.join(APP_DIR, 'data', 'workeasy360.db') }), TMP)).toThrow(/inside the application folder/);
    // A sibling folder whose name merely starts with the application's name is outside it.
    expect(databasePath(prod({ DB_PATH: `${APP_DIR}-data${path.sep}workeasy360.db` }), TMP)).toBe(path.resolve(`${APP_DIR}-data${path.sep}workeasy360.db`));
    expect(databasePath(prod({ DB_PATH: '/data/workeasy360.db' }), TMP)).toBe(path.resolve('/data/workeasy360.db'));
    expect(databasePath(prod({ DB_PATH: path.join(TMP, 'client.db') }), TMP)).toBe(path.join(TMP, 'client.db'));
    // Development and tests: unchanged behaviour.
    expect(databasePath({ NODE_ENV: 'development' } as NodeJS.ProcessEnv, TMP)).toBe(path.join(TMP, 'data', 'workeasy360.db'));
    expect(databasePath({ NODE_ENV: 'test', DB_PATH: 'x/y.db' } as NodeJS.ProcessEnv, TMP)).toBe(path.join(TMP, 'x', 'y.db'));
  });

  it('uploads follow the database, with the same production rules for UPLOAD_DIR', () => {
    expect(uploadDirectory(prod({ DB_PATH: path.join(TMP, 'client.db') }), TMP)).toBe(path.join(TMP, 'uploads'));
    expect(uploadDirectory(prod({ DB_PATH: path.join(TMP, 'client.db'), UPLOAD_DIR: path.join(TMP, 'media') }), TMP)).toBe(path.join(TMP, 'media'));
    expect(() => uploadDirectory(prod({ DB_PATH: path.join(TMP, 'client.db'), UPLOAD_DIR: 'uploads' }), TMP)).toThrow(/absolute path/);
    expect(() => uploadDirectory(prod({ DB_PATH: path.join(TMP, 'client.db'), UPLOAD_DIR: path.join(APP_DIR, 'uploads') }), TMP)).toThrow(/inside the application folder/);
    expect(() => uploadDirectory(prod({ DB_PATH: path.join(TMP, 'client.db'), UPLOAD_DIR: path.join(APP_DIR, 'server', 'data', 'uploads') }), TMP)).toThrow(/inside the application folder/);
    expect(() => uploadDirectory(prod({}), TMP)).toThrow(/DB_PATH is not set/);
    expect(uploadDirectory({ NODE_ENV: 'development', UPLOAD_DIR: 'up' } as NodeJS.ProcessEnv, TMP)).toBe(path.join(TMP, 'up'));
  });
});

// ── A real server process in production mode, started in a temporary folder ──────────────────────────────────────
const TSX_LOADER = pathToFileURL(path.join(SERVER_DIR, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const ENTRY = path.join(SERVER_DIR, 'src', 'index.ts');
const productionEnv = (extra: Record<string, string>) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env, NODE_ENV: 'production', DOTENV_CONFIG_PATH: path.join(TMP, 'no-such.env'),
    JWT_SECRET: 'f3a9c1e7b2d84a6f0c5e9b1d7a3f8c2e6b0d4a9f1c7e3b5d8a2f6c0e4b9d1a7f', CORS_ORIGIN: 'https://book.client.example',
    PUBLIC_APP_URL: 'https://book.client.example', TRUST_PROXY: '1', EMAIL_TRANSPORT: 'disabled', NOTIFICATIONS_PROVIDER_MODE: 'mock', ...extra,
  };
  for (const k of ['DB_PATH', 'UPLOAD_DIR', 'WEB_DIST_DIR']) if (!(k in extra)) delete env[k];
  return env;
};
function run(cwd: string, env: NodeJS.ProcessEnv, untilMs = 60_000) {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, ENTRY], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const exited = new Promise<number | null>(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(null); }, untilMs);
    child.on('exit', code => { clearTimeout(timer); resolve(code); });
  });
  return { child, exited, output: () => out };
}
const freePort = () => new Promise<number>(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });

describe('production startup', () => {
  it.each([
    ['DB_PATH missing', {}, /DB_PATH is not set/],
    ['DB_PATH relative', { DB_PATH: './data/workeasy360.db' }, /DB_PATH must be an absolute path/],
  ])('refuses to start with %s, and creates no database file', async (_name, extra, message) => {
    const cwd = fs.mkdtempSync(path.join(TMP, 'start-'));
    const r = run(cwd, productionEnv(extra as Record<string, string>));
    const code = await r.exited;
    expect(code).not.toBe(0);
    expect(code).not.toBeNull(); // it stopped by itself, it did not keep running
    expect(r.output()).toMatch(message);
    expect(fs.readdirSync(cwd)).toEqual([]); // no ./data folder, no database
  });

  it('with an explicit database outside the application, it starts, answers health and serves the web app on the same origin', async () => {
    const cwd = fs.mkdtempSync(path.join(TMP, 'start-'));
    const dist = path.join(TMP, 'web-dist');
    fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>WorkEasy360 test app</title><div id="root"></div>');
    fs.writeFileSync(path.join(dist, 'assets', 'app-3f9a.js'), 'console.log(1)');
    const port = await freePort();
    const db = path.join(TMP, 'volume', 'workeasy360.db');
    const r = run(cwd, productionEnv({ DB_PATH: db, WEB_DIST_DIR: dist, PORT: String(port) }));
    try {
      let health = 0;
      for (let i = 0; i < 100 && health !== 200; i++) {
        await new Promise(res => setTimeout(res, 300));
        health = await fetch(`http://127.0.0.1:${port}/api/health`).then(x => x.status, () => 0);
      }
      expect(health).toBe(200);
      expect(fs.existsSync(db)).toBe(true);
      expect(fs.readdirSync(cwd)).toEqual([]);
      expect(r.output()).toMatch(/Web app: served from/);
      const page = await fetch(`http://127.0.0.1:${port}/book/client-clinic`);
      expect([page.status, await page.text()]).toEqual([200, expect.stringContaining('WorkEasy360 test app')]);
      expect(page.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
      expect(page.headers.get('strict-transport-security')).toMatch(/max-age=\d{7,}/);
      const api404 = await fetch(`http://127.0.0.1:${port}/api/no-such-route`);
      expect([api404.status, ((await api404.json()) as { error?: string }).error]).toEqual([404, 'Not found']);
    } finally {
      r.child.kill();
      await r.exited;
    }
  });
});

describe('serving the web app (WEB_DIST_DIR)', () => {
  const dist = path.join(TMP, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'brand'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app shell</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(dist, 'brand', 'icon-192.png'), 'png');
  fs.writeFileSync(path.join(dist, '.env'), 'SECRET_IN_DIST=1');
  fs.writeFileSync(path.join(TMP, 'outside-secret.txt'), 'SECRET_OUTSIDE=1');

  const app = express();
  app.use(helmet());
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });
  const mounted = mountWebApp(app, dist);

  it('is off unless WEB_DIST_DIR is set, and refuses a folder without index.html', () => {
    expect(mounted).toBe(path.resolve(dist));
    expect(mountWebApp(express(), undefined)).toBeNull();
    expect(mountWebApp(express(), '  ')).toBeNull();
    expect(() => mountWebApp(express(), path.join(TMP, 'empty-dir'))).toThrow(/no index.html/);
  });

  it('pages get index.html, never cached; hashed assets are cached for a year; other files revalidate', async () => {
    for (const p of ['/', '/login', '/book/client-clinic', '/settings/security']) {
      const r = await request(app).get(p);
      expect({ p, status: r.status, body: r.text, cache: r.headers['cache-control'] }).toEqual({ p, status: 200, body: '<!doctype html><title>app shell</title>', cache: 'no-cache' });
    }
    const asset = await request(app).get('/assets/index-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const icon = await request(app).get('/brand/icon-192.png');
    expect([icon.status, icon.headers['cache-control']]).toEqual([200, 'no-cache']);
  });

  it('a missing asset is a 404, not the app; /api paths are never the app; only GET and HEAD fall back', async () => {
    const missing = await request(app).get('/assets/index-gone.js');
    expect([missing.status, missing.text]).toEqual([404, 'Not found']);
    const api = await request(app).get('/api/anything');
    expect([api.status, api.body]).toEqual([404, { error: 'Not found' }]);
    expect((await request(app).post('/book/client-clinic').send({})).status).toBe(404);
    expect((await request(app).head('/book/client-clinic')).status).toBe(200);
  });

  it('never serves dotfiles or files outside the folder', async () => {
    for (const p of ['/.env', '/assets/../.env', '/..%2foutside-secret.txt', '/%2e%2e/outside-secret.txt', '/assets/..%2f..%2foutside-secret.txt']) {
      const r = await request(app).get(p);
      expect({ p, leaked: /SECRET_/.test(r.text) }).toEqual({ p, leaked: false });
    }
  });

  it('pages carry the same security headers as the API', async () => {
    const r = await request(app).get('/book/client-clinic');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'self'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
