// Production onboarding and operation: a client's business and first administrator are created by the operator
// (npm run org:create) with nothing else in them; with SIGNUP_MODE=closed nobody else can create a business from the
// web; production warns about a database path that would not survive a redeploy and about mock notifications; a stop
// signal lets requests finish and closes the database. Synthetic data in the per-file test database.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import app from '../index';
import db from '../db/init';
import { initSecurityConfig, readSecurityConfig } from '../config/security';
import { createShutdown } from '../shutdown';

jest.setTimeout(120_000);

const SERVER_DIR = path.join(__dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASSWORD = 'ClientStart2026';

function createOrganization(args: string[], password: string | undefined = PASSWORD) {
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_CONFIG_PATH: path.join(SERVER_DIR, 'no-such.env') };
  delete env.ORG_ADMIN_PASSWORD;
  if (password !== undefined) env.ORG_ADMIN_PASSWORD = password;
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/create-organization.ts', ...args], { cwd: SERVER_DIR, env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('npm run org:create: a client business with nothing in it but its administrator', () => {
  const email = `owner-${RUN}@client.example`;

  it('creates the business and its administrator, who can sign in to an empty business in its own time zone', async () => {
    const r = createOrganization(['--db', process.env.DB_PATH!, '--company', 'Client Clinic', '--name', 'Client Owner', '--email', email, '--country', 'India']);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/Created the business "Client Clinic" \(org-[\w-]+\)/);
    expect(r.out).not.toContain(PASSWORD); // the password is never printed
    const user = db.prepare('SELECT id, organization_id, role, password_hash FROM users WHERE email = ?').get(email) as { id: string; organization_id: string; role: string; password_hash: string };
    expect(user.role).toBe('admin');
    expect(user.password_hash).not.toContain(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, user.password_hash)).toBe(true);
    // Nothing but the business and its administrator: no demo data of any kind.
    for (const table of ['services', 'staff', 'customers', 'appointments', 'workspaces', 'resources', 'booking_pages']) {
      expect({ table, rows: db.prepare(`SELECT COUNT(*) FROM ${table} WHERE organization_id = ?`).pluck().get(user.organization_id) }).toEqual({ table, rows: 0 });
    }
    expect(db.prepare('SELECT COUNT(*) FROM users WHERE organization_id = ?').pluck().get(user.organization_id)).toBe(1);

    const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    const token = (login.headers['set-cookie'] as unknown as string[]).join(';').match(/=(eyJ[\w-]+\.[\w-]+\.[\w-]+)/)![1];
    const get = async (p: string) => (await request(app).get(`/api${p}`).set('Authorization', `Bearer ${token}`)).body.data;
    for (const p of ['/services', '/staff', '/customers', '/appointments', '/workspaces', '/booking-pages']) expect({ p, list: await get(p) }).toEqual({ p, list: [] });
    const settings = await get('/settings');
    expect([settings.name, settings.timezone, settings.currency]).toEqual(['Client Clinic', 'Asia/Kolkata', 'INR']);
  });

  it('refuses a second account with the same email, a weak password, and a missing --db; creates nothing then', async () => {
    const before = db.prepare('SELECT COUNT(*) FROM organizations').pluck().get();
    const dup = createOrganization(['--db', process.env.DB_PATH!, '--company', 'Again', '--name', 'Again', '--email', email]);
    expect([dup.status, /already exists/.test(dup.out)]).toEqual([1, true]);
    const weak = createOrganization(['--db', process.env.DB_PATH!, '--company', 'Weak', '--name', 'Weak', '--email', `weak-${RUN}@client.example`], 'short');
    expect([weak.status, /at least 8 characters/.test(weak.out)]).toEqual([1, true]);
    expect(weak.out).not.toContain('short');
    const noDb = createOrganization(['--company', 'No Db', '--name', 'No Db', '--email', `nodb-${RUN}@client.example`]);
    expect([noDb.status, /--db is required/.test(noDb.out)]).toEqual([1, true]);
    expect(db.prepare('SELECT COUNT(*) FROM organizations').pluck().get()).toBe(before);
  });
});

describe('SIGNUP_MODE', () => {
  const production = { NODE_ENV: 'production', JWT_SECRET: 'f3a9c1e7b2d84a6f0c5e9b1d7a3f8c2e6b0d4a9f1c7e3b5d8a2f6c0e4b9d1a7f', CORS_ORIGIN: 'https://book.client.example', PUBLIC_APP_URL: 'https://book.client.example', TRUST_PROXY: '1', EMAIL_TRANSPORT: 'smtp' };

  it('is open unless set to closed; anything else stops the server from starting', () => {
    expect(readSecurityConfig({ ...production, DB_PATH: '/var/lib/workeasy360/workeasy360.db' }).signupOpen).toBe(true);
    expect(readSecurityConfig({ ...production, DB_PATH: '/var/lib/workeasy360/workeasy360.db', SIGNUP_MODE: 'closed' }).signupOpen).toBe(false);
    expect(() => readSecurityConfig({ ...production, SIGNUP_MODE: 'invite-only' })).toThrow(/SIGNUP_MODE must be open or closed/);
  });

  it('closed: sign-up, email confirmation and resend are refused; signing in still works', async () => {
    initSecurityConfig({ ...process.env, SIGNUP_MODE: 'closed' });
    try {
      const signup = await request(app).post('/api/auth/signup').send({ name: 'X', email: `x-${RUN}@example.com`, company: 'X', password: 'StartPass123', confirmPassword: 'StartPass123' });
      expect([signup.status, signup.body.code]).toEqual([403, 'SIGNUP_CLOSED']);
      expect((await request(app).post('/api/auth/verify-email').send({ token: 'a'.repeat(43) })).status).toBe(403);
      expect((await request(app).post('/api/auth/verify-email/resend').send({ email: `x-${RUN}@example.com` })).status).toBe(403);
      expect((await request(app).post('/api/auth/login').send({ email: `owner-${RUN}@client.example`, password: PASSWORD })).status).toBe(200);
    } finally {
      initSecurityConfig(process.env);
    }
  });
});

describe('production warnings', () => {
  const production = { NODE_ENV: 'production', JWT_SECRET: 'f3a9c1e7b2d84a6f0c5e9b1d7a3f8c2e6b0d4a9f1c7e3b5d8a2f6c0e4b9d1a7f', CORS_ORIGIN: 'https://book.client.example', PUBLIC_APP_URL: 'https://book.client.example', TRUST_PROXY: '1', EMAIL_TRANSPORT: 'smtp' };
  const warns = (env: Record<string, string>) => readSecurityConfig({ ...production, ...env }).warnings.join('\n');

  it('a missing or relative DB_PATH is flagged; an absolute one (Linux or Windows) is not', () => {
    expect(warns({})).toMatch(/DB_PATH is not an absolute path/);
    expect(warns({ DB_PATH: './data/workeasy360.db' })).toMatch(/DB_PATH is not an absolute path/);
    expect(warns({ DB_PATH: '/var/lib/workeasy360/workeasy360.db' })).not.toMatch(/DB_PATH/);
    expect(warns({ DB_PATH: 'D:\\workeasy360\\workeasy360.db' })).not.toMatch(/DB_PATH/);
  });

  it('mock notifications in production are flagged', () => {
    expect(warns({ DB_PATH: '/var/lib/w.db', NOTIFICATIONS_PROVIDER_MODE: 'mock' })).toMatch(/NOTIFICATIONS_PROVIDER_MODE=mock/);
    expect(warns({ DB_PATH: '/var/lib/w.db' })).not.toMatch(/NOTIFICATIONS_PROVIDER_MODE/);
  });
});

describe('graceful shutdown', () => {
  const fakes = () => {
    const calls: string[] = [];
    let closeCallback: (() => void) | null = null;
    return {
      calls,
      finishRequests: () => closeCallback?.(),
      deps: {
        server: { close: (cb: () => void) => { calls.push('stop accepting'); closeCallback = cb; }, closeIdleConnections: () => calls.push('close idle connections') },
        stopWorkers: () => calls.push('stop workers'),
        closeDatabase: () => calls.push('close database'),
        exit: (code: number) => calls.push(`exit ${code}`),
        log: () => undefined,
      },
    };
  };

  it('stops the workers and new connections, waits for requests in progress, then closes the database and exits once', () => {
    const f = fakes();
    const shutdown = createShutdown({ ...f.deps, graceMs: 60_000 });
    shutdown('SIGTERM');
    shutdown('SIGINT'); // a second signal while stopping changes nothing
    expect(f.calls).toEqual(['stop workers', 'stop accepting', 'close idle connections']);
    f.finishRequests();
    expect(f.calls).toEqual(['stop workers', 'stop accepting', 'close idle connections', 'close database', 'exit 0']);
  });

  it('does not wait forever for a request that never ends', async () => {
    const f = fakes();
    createShutdown({ ...f.deps, graceMs: 50 })('SIGTERM');
    await new Promise(r => setTimeout(r, 150));
    expect(f.calls.slice(-2)).toEqual(['close database', 'exit 0']);
    f.finishRequests(); // finishing late does not close or exit twice
    expect(f.calls.filter(c => c === 'exit 0')).toHaveLength(1);
  });
});
