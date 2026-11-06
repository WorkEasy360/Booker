// Non-destructive checks of a deployed WorkeasyBooking site (staging), from outside, the way a browser sees it:
// HTTPS and redirect, health, security headers, single-page routing, JSON errors, cross-site request refusal, CORS,
// and (optionally) the session cookie flags through one sign-in that is signed out again. Creates no records.
//
//   cd server
//   node scripts/staging-check.mjs --url https://staging.example.com
//
// For the session-cookie checks, first set STAGING_EMAIL and STAGING_PASSWORD from a hidden prompt (step 6 of
// docs/STAGING.md shows how in bash and Windows PowerShell), then run the same command. The password is read from the
// environment only, never from the command line, and is never printed.
// --origin <origin> sets the Origin header the checks send (default: the site's own origin).
// --allow-http skips the HTTPS-only checks (for a local trial; never for the real staging check).
// --http-port <n> is the plain-http port for the redirect check (default 80; for a local trial).
import net from 'node:net';
import tls from 'node:tls';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const flag = name => args.includes(name);
const site = opt('--url');
if (!site) { console.error('Usage: node scripts/staging-check.mjs --url https://staging.example.com [--origin <origin>] [--allow-http] [--http-port <n>]'); process.exit(2); }
const base = new URL(site);
const origin = opt('--origin') ?? base.origin;
const allowHttp = flag('--allow-http');
const httpPort = opt('--http-port') ?? '';
/** HSTS must last at least 180 days (helmet's default); a year is better. Returns the first header's max-age. */
const MIN_HSTS_SECONDS = 180 * 24 * 60 * 60;
const hstsMaxAge = value => Number((/max-age=(\d+)/i.exec(value ?? '') ?? [])[1] ?? -1);
const at = path => new URL(path, base).toString();

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`); };
const info = (name, detail) => console.log(`INFO  ${name}: ${detail}`);
const get = (path, init = {}) => fetch(at(path), { redirect: 'manual', ...init });

try {
  // 1. HTTPS
  if (allowHttp) info('HTTPS', 'skipped (--allow-http)');
  else {
    check('the site is served over https', base.protocol === 'https:', base.protocol);
    const plain = new URL(base); plain.protocol = 'http:'; plain.port = httpPort;
    try {
      const r = await fetch(plain, { redirect: 'manual' });
      const loc = r.headers.get('location') ?? '';
      check('http redirects to https', [301, 302, 307, 308].includes(r.status) && loc.startsWith('https://'), `${r.status} ${loc}`);
    } catch (e) { check('http redirects to https', false, `http not reachable (${e.cause?.code ?? e.message}); fine only if port 80 is closed on purpose`); }
    // The certificate, checked directly: trusted chain and host name (Node verifies both), TLS version, time left.
    try {
      const peer = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host: base.hostname, port: Number(base.port) || 443, servername: net.isIP(base.hostname) ? undefined : base.hostname }, () => {
          const cert = socket.getPeerCertificate();
          resolve({ protocol: socket.getProtocol(), validTo: cert?.valid_to });
          socket.end();
        });
        socket.setTimeout(10_000, () => socket.destroy(new Error('TLS handshake timed out')));
        socket.on('error', reject);
      });
      check('the TLS certificate is trusted and valid for this host name', true);
      check('TLS 1.2 or newer is negotiated', ['TLSv1.2', 'TLSv1.3'].includes(peer.protocol), peer.protocol);
      const daysLeft = Math.floor((Date.parse(peer.validTo) - Date.now()) / 86_400_000);
      check('the certificate stays valid for at least 14 more days', daysLeft >= 14, `${daysLeft} days left`);
      info('certificate valid until', `${peer.validTo} (${daysLeft} days)`);
    } catch (e) {
      check('the TLS certificate is trusted and valid for this host name', false, [e.code, e.message].filter(Boolean).join(': '));
    }
  }

  // 2. Health
  const health = await get('/api/health');
  const hBody = await health.json().catch(() => ({}));
  check('GET /api/health answers 200 {"status":"ok"}', health.status === 200 && hBody.status === 'ok', `${health.status} ${JSON.stringify(hBody)}`);
  check('the health answer exposes nothing else', Object.keys(hBody).sort().join() === 'status,ts', Object.keys(hBody).join());

  // 3. Security headers (API responses carry them from the server; the proxy should add HSTS to the pages)
  check('API sends X-Content-Type-Options: nosniff', health.headers.get('x-content-type-options') === 'nosniff');
  check('API does not advertise its framework (no X-Powered-By)', !health.headers.get('x-powered-by'));
  if (!allowHttp) {
    const sts = health.headers.get('strict-transport-security');
    check('API sends Strict-Transport-Security for at least 180 days', hstsMaxAge(sts) >= MIN_HSTS_SECONDS, sts ?? 'missing');
    if (sts?.includes(',')) info('API Strict-Transport-Security', 'sent more than once (the proxy and the API); browsers use the first. See the nginx note in DEPLOYMENT.md');
  }

  // 4. Single-page routing: deep links load the app, unknown API paths answer JSON 404
  const page = await get('/book/staging-check-unknown-page');
  const html = await page.text();
  check('a deep link (/book/…) returns the app page', page.status === 200 && /<div id="root">/.test(html), `${page.status}`);
  if (!allowHttp) {
    const sts = page.headers.get('strict-transport-security');
    check('the app page is sent with Strict-Transport-Security for at least 180 days', hstsMaxAge(sts) >= MIN_HSTS_SECONDS, sts ? sts : 'missing: add HSTS at the proxy');
    if (sts) info('app page Strict-Transport-Security', sts);
  }
  info('app page Cache-Control', page.headers.get('cache-control') ?? '(none; index.html should not be cached long-term)');
  const missing = await get('/api/staging-check-unknown');
  const mBody = await missing.json().catch(() => null);
  check('an unknown /api path answers 404 JSON', missing.status === 404 && mBody?.error === 'Not found', `${missing.status}`);

  // 5. Cross-site request protection and CORS
  const evil = 'https://attacker.example';
  const forged = await get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: evil }, body: '{}' });
  const fBody = await forged.json().catch(() => ({}));
  check('a state-changing request from another site is refused (403)', forged.status === 403 && fBody.code === 'ORIGIN_NOT_ALLOWED', `${forged.status} ${fBody.code ?? ''}`);
  const pre = await get('/api/auth/login', { method: 'OPTIONS', headers: { Origin: evil, 'Access-Control-Request-Method': 'POST' } });
  check('CORS does not allow another site', pre.headers.get('access-control-allow-origin') !== evil);
  const own = await get('/api/auth/login', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  check('CORS allows the app origin with credentials', own.headers.get('access-control-allow-origin') === origin && own.headers.get('access-control-allow-credentials') === 'true',
    `${own.headers.get('access-control-allow-origin')} / ${own.headers.get('access-control-allow-credentials')}`);
  const malformed = await get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{"broken' });
  const malformedText = await malformed.text();
  check('malformed input gets a 400 without internals', malformed.status === 400 && !/at\s+\w+\s+\(|node_modules|SQLITE|stack/i.test(malformedText), `${malformed.status} ${malformedText.slice(0, 120)}`);

  // 6. Session cookie (optional, needs a staging account)
  const email = process.env.STAGING_EMAIL, password = process.env.STAGING_PASSWORD;
  if (!email || !password) info('session cookie', 'skipped (set STAGING_EMAIL and STAGING_PASSWORD to check it with one sign-in)');
  else {
    const login = await get('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email, password }) });
    const lBody = await login.json().catch(() => ({}));
    check('signing in with the staging account works', login.status === 200 && !!lBody.data?.csrfToken, `${login.status} ${lBody.error ?? ''}`);
    const cookies = login.headers.getSetCookie?.() ?? [];
    const session = cookies.find(c => /^__Host-we360_session=/.test(c));
    check('session cookie is __Host- prefixed', !!session, cookies.map(c => c.split('=')[0]).join(', ') || 'no cookies');
    if (session) {
      check('session cookie is Secure, HttpOnly, SameSite=Lax, Path=/ and has no Domain',
        /;\s*Secure/i.test(session) && /;\s*HttpOnly/i.test(session) && /;\s*SameSite=Lax/i.test(session) && /;\s*Path=\//i.test(session) && !/;\s*Domain=/i.test(session),
        session.replace(/=[^;]+/, '=<value>'));
      const cookie = session.split(';')[0];
      const me = await get('/api/auth/me', { headers: { Cookie: cookie } });
      check('the session works for /api/auth/me', me.status === 200, String(me.status));
      const out = await get('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
      const after = await get('/api/auth/me', { headers: { Cookie: cookie } });
      check('signing out ends the session on the server', out.status === 200 && after.status === 401, `${out.status} then ${after.status}`);
    }
  }
} catch (e) {
  check('the site could be reached', false, e.cause?.code ?? e.message);
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} staging checks passed`);
// Let open connections close on their own; process.exit() here can crash Node on Windows.
process.exitCode = failed ? 1 : 0;
