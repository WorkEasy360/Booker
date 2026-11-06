import express, { type Express } from 'express';
import fs from 'fs';
import path from 'path';

// Serves the built web app (Vite's dist/) from the API process when WEB_DIST_DIR is set, so one process answers on one
// origin: a single Railway service, or any host without a separate web server. Unset (the default), nothing changes
// and a reverse proxy serves dist/ as in DEPLOYMENT.md. Mounted after every /api route, so /api paths never fall back to
// the app. The same security headers as the API apply (helmet, set earlier).
//  - /assets/*: file names carry a content hash, so they are cached for a year; a missing asset is a plain 404.
//  - other files (icons, manifest): revalidated on every use.
//  - any other GET for a page (for example /book/<page> or /settings/security): index.html, never cached, so a new
//    release is picked up at once.

export function mountWebApp(app: Express, dir: string | undefined): string | null {
  if (!dir?.trim()) return null;
  const root = path.resolve(dir.trim());
  const index = path.join(root, 'index.html');
  if (!fs.existsSync(index)) throw new Error('WEB_DIST_DIR has no index.html: build the web app (npm run build in the project root) or unset WEB_DIST_DIR');

  app.use('/assets', express.static(path.join(root, 'assets'), { index: false, immutable: true, maxAge: '365d' }));
  app.use('/assets', (_req, res) => { res.status(404).type('text/plain').send('Not found'); });
  app.use(express.static(root, { index: false, setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
  app.get(/^(?!\/api(\/|$)).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return root;
}
