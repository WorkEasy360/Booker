// Smoke test of the compiled server (dist/) in production mode, on throw-away databases.
// Run from server/ after `npm run build`:  npm run test:smoke
// 1. Production refuses to start with an unsafe configuration, naming the setting but never its value.
// 2. Without email it starts, warns, and refuses sign-up clearly instead of pretending to send.
// 3. Production refuses SMTP without credentials.
// 4. With email (to a local SMTP server; nothing leaves the machine) the server signs in and sends over required
//    STARTTLS, a sign-up is confirmed from the emailed https link, and signing in issues hardened cookies. The local
//    server uses the test-only certificate in src/tests/fixtures/smtp-tls, which only the spawned server trusts
//    (NODE_EXTRA_CA_CERTS), so certificate verification stays on.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// As many migrations as the code defines (read from the source, so a new migration needs no edit here).
const MIGRATION_COUNT = (fs.readFileSync(new URL('../src/db/migrations.ts', import.meta.url), 'utf8').match(/^\s+id: '\d{3}_\w+',$/gm) ?? []).length;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`);
}

if (!fs.existsSync('dist/index.js')) { console.error('dist/index.js not found: run `npm run build` first'); process.exit(2); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we360-smoke-'));
const SECRET = randomBytes(48).toString('hex');
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}

const TLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'tests', 'fixtures', 'smtp-tls');
const SMTP_USER = 'smoke-smtp-user';
const SMTP_PASS = randomBytes(18).toString('hex');
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');
const mail = [];
const signIns = [];
const smtp = new SMTPServer({
  key: fs.readFileSync(path.join(TLS_DIR, 'localhost-key.pem')), cert: fs.readFileSync(path.join(TLS_DIR, 'localhost-cert.pem')),
  logger: false, authOptional: false,
  onAuth(auth, session, cb) {
    signIns.push({ secure: !!session.secure, ok: auth.username === SMTP_USER && auth.password === SMTP_PASS });
    if (signIns.at(-1).ok) cb(null, { user: auth.username }); else cb(new Error('Authentication failed'));
  },
  onData(stream, session, cb) { let raw = ''; stream.on('data', c => (raw += c)); stream.on('end', () => { mail.push({ to: session.envelope.rcptTo.map(r => r.address), raw, secure: !!session.secure }); cb(); }); },
});
smtp.on('error', () => undefined); // clients that end a session abruptly; not part of the checks
await new Promise(r => smtp.listen(0, '127.0.0.1', r));

const base = {
  NODE_ENV: 'production', JWT_SECRET: SECRET, JWT_EXPIRES_IN: '1h',
  CORS_ORIGIN: 'https://app.example.test', PUBLIC_APP_URL: 'https://book.example.test', TRUST_PROXY: '1',
  EMAIL_TRANSPORT: 'disabled', SMTP_USER: '', SMTP_PASS: '', RATE_LIMITS: 'on',
};
const withEmail = {
  ...base, EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.server.address().port), SMTP_SECURE: 'false',
  SMTP_USER, SMTP_PASS, EMAIL_FROM: 'WorkeasyBooking <bookings@example.test>',
  NODE_EXTRA_CA_CERTS: path.join(TLS_DIR, 'localhost-cert.pem'),
};

function run(env, port, db) {
  const child = spawn(process.execPath, ['dist/index.js'], { env: { ...process.env, ...env, PORT: String(port), DB_PATH: path.join(TMP, db) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', d => out.push(String(d)));
  child.stderr.on('data', d => out.push(String(d)));
  return { child, out, exited: new Promise(r => child.once('exit', code => r(code))) };
}
async function waitHealthy(port) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}
const post = (port, route, body, origin = 'https://app.example.test') => fetch(`http://127.0.0.1:${port}/api${route}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
});
const owner = { name: 'Smoke Owner', email: 'smoke@example.test', company: 'Smoke Co', password: 'SmokePass123', confirmPassword: 'SmokePass123' };

try {
  // 1. Unsafe production configuration: missing PUBLIC_APP_URL and a placeholder secret.
  {
    const placeholder = 'replace_with_a_long_random_secret_at_least_64_chars';
    const p = run({ ...base, PUBLIC_APP_URL: '', JWT_SECRET: placeholder }, await freePort(), 'unsafe.db');
    const code = await Promise.race([p.exited, new Promise(r => setTimeout(() => r('still running'), 20_000))]);
    if (code === 'still running') p.child.kill();
    const text = p.out.join('');
    check('production refuses to start with an unsafe configuration', code !== 0 && code !== 'still running', `exit=${code}`);
    check('the refusal names the problems', /PUBLIC_APP_URL is required in production/.test(text) && /placeholder/.test(text), text.slice(0, 300));
    check('the refusal never prints the secret value', !text.includes(placeholder));
  }

  // 2. Production configuration without email.
  {
    const port = await freePort();
    const p = run(base, port, 'no-email.db');
    check('compiled server starts in production mode', await waitHealthy(port), p.out.join('').slice(0, 300));
    const startup = p.out.join('');
    check('startup reports the migrations on the new database', MIGRATION_COUNT >= 10 && startup.includes(`[migrations] ${MIGRATION_COUNT}/${MIGRATION_COUNT} applied`), startup.slice(0, 300));
    check('startup warns that email is disabled, and that sign-up and password reset need it', /EMAIL_TRANSPORT is disabled/.test(startup) && /sign-ups and password reset/.test(startup));
    const signup = await post(port, '/auth/signup', owner);
    const body = await signup.json().catch(() => ({}));
    check('sign-up says email is not set up instead of pretending to send', signup.status === 503 && body.code === 'EMAIL_NOT_CONFIGURED' && !signup.headers.get('set-cookie'), String(signup.status));
    check('a non-https or foreign origin is refused', (await post(port, '/auth/signup', {}, 'http://app.example.test')).status === 403);
    p.child.kill();
    await p.exited;
  }

  // 3. Production SMTP without credentials (so without authenticated TLS) is refused at startup.
  {
    const p = run({ ...withEmail, SMTP_USER: '', SMTP_PASS: '' }, await freePort(), 'no-smtp-auth.db');
    const code = await Promise.race([p.exited, new Promise(r => setTimeout(() => r('still running'), 20_000))]);
    if (code === 'still running') p.child.kill();
    const text = p.out.join('');
    check('production refuses SMTP without SMTP_USER and SMTP_PASS', code !== 0 && code !== 'still running' && /SMTP_USER and SMTP_PASS are required in production/.test(text), `exit=${code} ${text.slice(0, 200)}`);
  }

  // 4. Production configuration with email: confirm the sign-up from the emailed link, then sign in.
  {
    const port = await freePort();
    const p = run(withEmail, port, 'email.db');
    check('compiled server starts in production mode with SMTP email', await waitHealthy(port), p.out.join('').slice(0, 300));
    check('startup reports that STARTTLS is required', /Email transport: smtp \(STARTTLS required\)/.test(p.out.join('')));
    const signup = await post(port, '/auth/signup', owner);
    check('sign-up answers 202 and signs nobody in', signup.status === 202 && !signup.headers.get('set-cookie'), String(signup.status));
    let link = null;
    for (let i = 0; i < 100 && !link; i++) {
      const m = mail.find(x => x.to.includes(owner.email));
      if (m) link = /https:\/\/book\.example\.test\/verify-email#token=([A-Za-z0-9_-]+)/.exec(m.raw.replace(/=\r?\n/g, '').replace(/=3D/g, '='));
      if (!link) await new Promise(r => setTimeout(r, 100));
    }
    check('the confirmation email links to PUBLIC_APP_URL over https with the token after #', !!link);
    check('the server signed in and sent only over TLS (STARTTLS, certificate verified)', signIns.length > 0 && signIns.every(s => s.secure && s.ok) && mail.length > 0 && mail.every(m => m.secure), JSON.stringify({ signIns, sent: mail.map(m => m.secure) }));
    const token = link?.[1] ?? '';
    const verified = await post(port, '/auth/verify-email', { token });
    check('the emailed link confirms the account without signing in', verified.status === 201 && !verified.headers.get('set-cookie'), String(verified.status));
    const login = await post(port, '/auth/login', { email: owner.email, password: owner.password });
    const cookies = login.headers.getSetCookie?.() ?? [login.headers.get('set-cookie') ?? ''];
    const session = cookies.find(c => c.startsWith('__Host-we360_session=')) ?? '';
    check('sign-in succeeds from the configured app origin', login.status === 200, String(login.status));
    check('session cookie is __Host- prefixed, Secure, HttpOnly, SameSite=Lax, Path=/', /;\s*Secure/i.test(session) && /HttpOnly/i.test(session) && /SameSite=Lax/i.test(session) && /Path=\//.test(session), cookies.map(c => c.split('=')[0]).join(', '));
    check('device cookie is __Host- prefixed and Secure', cookies.some(c => c.startsWith('__Host-we360_device=') && /;\s*Secure/i.test(c)));
    const output = p.out.join('');
    check('the server output never contains the signing secret, the SMTP password, the emailed token, or the password', !output.includes(SECRET) && !output.includes(SMTP_PASS) && !!token && !output.includes(token) && !output.includes(owner.password));
    p.child.kill();
    await p.exited;
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  await new Promise(r => smtp.close(r));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} production smoke checks passed`);
  process.exit(failed ? 1 : 0);
}
