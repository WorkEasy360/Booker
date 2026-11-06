// Live end-to-end check against a real server process on an isolated, throwaway database.
// Run from the server directory: npm run test:e2e
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// Hold a power request for the run: idle standby freezes the server under test (see scripts/keep-awake.cjs).
const keepAwake = createRequire(import.meta.url)('./keep-awake.cjs').startKeepAwake();

const RUN = Date.now().toString(36);
// As many migrations as the code defines (read from the source, so a new migration needs no edit here).
const MIGRATION_COUNT = (fs.readFileSync(new URL('../src/db/migrations.ts', import.meta.url), 'utf8').match(/^\s+id: '\d{3}_\w+',$/gm) ?? []).length;
const PORT = 3077;

// A local SMTP server catches the account emails (sign-up confirmation, password reset); nothing leaves the machine.
const { SMTPServer } = createRequire(import.meta.url)('smtp-server');
const mail = [];
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'], logger: false,
  onData(stream, session, cb) { let raw = ''; stream.on('data', c => (raw += c)); stream.on('end', () => { mail.push({ to: session.envelope.rcptTo.map(r => r.address), raw }); cb(); }); },
});
await new Promise(r => smtp.listen(0, '127.0.0.1', r));
const SMTP_PORT = smtp.server.address().port;
/** The token from the newest email to `to` with a link to `linkPath` (waits for the background send). */
async function emailedToken(to, linkPath) {
  const unfold = raw => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
  for (let i = 0; i < 100; i++) {
    const m = [...mail].reverse().find(x => x.to.includes(to) && unfold(x.raw).includes(`${linkPath}#token=`));
    if (m) return new RegExp(`${linkPath}#token=([A-Za-z0-9_-]+)`).exec(unfold(m.raw))[1];
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}
// Throw-away database in the OS temp folder: outside the synced project, where sync clients lock new files.
const DB_DIR = path.join(os.tmpdir(), `we360-e2e-${RUN}`);
const DB = path.join(DB_DIR, `e2e-${RUN}.db`);
const BASE = `http://localhost:${PORT}/api`;
const APP_ORIGIN = 'http://localhost:5173';
const env = {
  ...process.env,
  DB_PATH: DB,
  PORT: String(PORT),
  NODE_ENV: 'development',
  JWT_SECRET: randomBytes(48).toString('hex'), // throwaway, per run
  JWT_EXPIRES_IN: '1h',
  CORS_ORIGIN: APP_ORIGIN,
  // Email only to the local SMTP server above; never to anyone.
  EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false',
  EMAIL_FROM: 'WorkeasyBooking <bookings@example.test>', PUBLIC_APP_URL: 'http://localhost:5173',
  SMTP_USER: '', SMTP_PASS: '', // values from server/.env must never reach a test server
  RATE_LIMITS: 'on',
};

const results = [];
/** Keeps session cookies, CSRF/manage tokens and passwords out of printed failure details. */
function redact(text) {
  return String(text)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]')
    .replace(/\bv1\.[\w-]+\.[0-9a-z]+\.[\w-]{20,}/g, '[redacted-manage-token]')
    .replace(/((?:we360_session|we360_device)=)[^;\s"]+/g, '$1[redacted]')
    .replace(/("(?:token|csrfToken|manageToken|password|confirmPassword|currentPassword|newPassword)"\s*:\s*)"[^"]*"/g, '$1"[redacted]"');
}
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail: redact(detail) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? `  -> ${redact(detail)}` : ''}`);
}

let server;
async function start() {
  // One plain Node process (no tsx CLI wrapper), so stopping it really releases the database file.
  // stdout is not needed; stderr is read below, so no pipe is ever left unread.
  server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', d => { const s = String(d); if (/error/i.test(s) && !/\[ERROR\]/.test(s)) process.stderr.write('[server] ' + s); });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}
async function stop() {
  if (!server) return;
  const exited = new Promise(r => server.once('exit', r));
  server.kill();
  await exited;
  server = undefined;
}

// Behaves like the browser app: session cookie plus the CSRF token from sign-in / /auth/me on every change.
let cookie = '';
let csrf = '';
async function api(method, p, body, { auth = true, raw = false, cookieOverride, headers: extra = {}, noCsrf = false } = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const c = cookieOverride ?? (auth ? cookie : '');
  if (c) headers.Cookie = c;
  if (c && method !== 'GET' && csrf && !noCsrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (p.startsWith('/auth/') && json.data?.csrfToken) csrf = json.data.csrfToken;
  return raw ? { res, json } : { status: res.status, data: json.data, error: json.error, code: json.code, json, headers: res.headers };
}

function day(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; }
const ALL_DAY = Object.fromEntries(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]));

const owner = { email: `e2e-owner-${RUN}@example.com`, password: 'E2ePass123' };
const ids = {};
let sessionBeforeRestart = '';

try {
  await start();

  // 1. Sign up (confirm the emailed link, then sign in), cookie flags, session survives a "refresh"
  {
    const signup = await api('POST', '/auth/signup', { name: 'E2E Owner', email: owner.email, company: `E2E Org ${RUN}`, password: owner.password, confirmPassword: owner.password }, { auth: false, raw: true });
    check('signup answers 202 with the generic message and signs nobody in', signup.res.status === 202 && /next steps/.test(signup.json.data?.message ?? '') && !signup.res.headers.get('set-cookie'), JSON.stringify(signup.json));
    const verifyToken = await emailedToken(owner.email, '/verify-email');
    check('the confirmation email reaches the mailbox with a /verify-email#token= link', !!verifyToken);
    const before = await api('POST', '/auth/login', owner, { auth: false });
    check('an unconfirmed sign-up cannot sign in', before.status === 401);
    const verified = await api('POST', '/auth/verify-email', { token: verifyToken }, { auth: false, raw: true });
    check('confirming the link creates the account, without signing in', verified.res.status === 201 && !verified.res.headers.get('set-cookie'));
    const { res, json } = await api('POST', '/auth/login', owner, { auth: false, raw: true });
    const setCookie = res.headers.get('set-cookie') ?? '';
    cookie = setCookie.split(';')[0];
    check('sign-in after confirming returns 200', res.status === 200, JSON.stringify(json));
    check('session token is not in the response body', json.data && json.data.token === undefined && typeof json.data.csrfToken === 'string');
    check('session cookie is HttpOnly', /httponly/i.test(setCookie), setCookie);
    check('session cookie is SameSite=Lax', /samesite=lax/i.test(setCookie), setCookie);
    const me = await api('GET', '/auth/me');
    check('GET /auth/me with cookie (page refresh)', me.status === 200 && me.data.email === owner.email && me.data.role === 'admin');
    check('helmet security headers present', !!res.headers.get('x-content-type-options'));
  }

  // 2. Service + staff (relationship sync) + customer
  {
    const svc = await api('POST', '/services', { name: 'E2E Consult', category: 'consultation', duration: 60, price: 80 });
    ids.service = svc.data?.id;
    const staff = await api('POST', '/staff', { name: 'E2E Staff', email: owner.email, serviceIds: [ids.service], workingHours: ALL_DAY });
    ids.staff = staff.data?.id;
    const svcAfter = await api('GET', `/services/${ids.service}`);
    check('staff→service assignment visible on service', svcAfter.data?.staffIds?.includes(ids.staff));
    const helper = await api('POST', '/staff', { name: 'E2E Helper', email: `e2e-helper-${RUN}@example.com` });
    const invite = await api('POST', `/staff/${helper.data?.id}/invitations`, { role: 'staff' });
    check('staff invitation is sent through the same mail server as the account emails', invite.status === 201 && invite.data?.email?.status === 'sent', JSON.stringify(invite.json));
    check('the invitation email still links to /accept-invite#token=', !!(await emailedToken(`e2e-helper-${RUN}@example.com`, '/accept-invite')));
    const edited = await api('PUT', `/services/${ids.service}`, { name: 'E2E Consult (edited)', price: 90 });
    check('service edit persists', edited.data?.name === 'E2E Consult (edited)' && edited.data?.price === 90);

    const cust = await api('POST', '/customers', { name: `E2E Customer ${RUN}`, email: `e2e-cust-${RUN}@example.com`, phone: '+91 98765 40100' });
    ids.customer = cust.data?.id;
    const list = await api('GET', '/customers');
    check('customer appears in customer list', list.data?.some(c => c.id === ids.customer));
    const detail = await api('GET', `/customers/${ids.customer}`);
    check('customer detail loads', detail.status === 200 && detail.data?.email === `e2e-cust-${RUN}@example.com`);
  }

  // 3. Appointment visible in list, calendar data, customer history, reports
  const D = day(3);
  {
    const appt = await api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff, customerId: ids.customer, date: D, startTime: '10:00' });
    ids.appt = appt.data?.id; ids.ref = appt.data?.bookingRef;
    check('admin creates appointment', appt.status === 201, appt.error);
    const list = await api('GET', '/appointments');
    const row = list.data?.find(a => a.id === ids.appt);
    check('appointment in list with joined names', row?.customerName?.startsWith('E2E Customer') && row?.serviceName === 'E2E Consult (edited)' && row?.staffName === 'E2E Staff');
    const hist = await api('GET', `/appointments?customerId=${ids.customer}`);
    check('appointment in customer history', hist.data?.some(a => a.id === ids.appt));
    const byStaff = await api('GET', `/appointments?staffId=${ids.staff}`);
    check('appointment in staff/MySpace view (staff email = owner email)', byStaff.data?.some(a => a.id === ids.appt));
    const conflict = await api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff, customerId: ids.customer, date: D, startTime: '10:30' });
    check('overlapping admin booking rejected 409', conflict.status === 409);
    const badStatus = await api('PUT', `/appointments/${ids.appt}`, { status: 'no-show' });
    check('legacy status spelling rejected with readable detail', badStatus.status === 400 && Array.isArray(badStatus.json.details));
  }

  // 4. Edit, reschedule, cancel; verify everywhere
  {
    const notes = await api('PUT', `/appointments/${ids.appt}`, { internalNotes: 'E2E note' });
    check('edit internal notes', notes.data?.internalNotes === 'E2E note');
    const resch = await api('PUT', `/appointments/${ids.appt}`, { date: day(4), startTime: '11:00' });
    check('admin reschedule recomputes end time', resch.data?.date === day(4) && resch.data?.endTime === '12:00');
    const cancel = await api('PUT', `/appointments/${ids.appt}`, { status: 'cancelled' });
    check('cancel appointment', cancel.data?.status === 'cancelled');
    const hist = await api('GET', `/appointments?customerId=${ids.customer}`);
    check('customer history shows cancelled state', hist.data?.find(a => a.id === ids.appt)?.status === 'cancelled');
    const rebook = await api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff, customerId: ids.customer, date: day(4), startTime: '11:00' });
    check('cancelled slot can be rebooked', rebook.status === 201, rebook.error);
    ids.appt2 = rebook.data?.id;
    const summary = await api('GET', '/reports/summary?range=30d');
    check('reports summary reachable', summary.status === 200 && typeof summary.data?.totalAppointments === 'number');
  }

  // 5. Resource and workspace CRUD
  {
    const res = await api('POST', '/resources', { name: 'E2E Table', type: 'table', capacity: 4 });
    ids.resource = res.data?.id;
    check('create table resource', res.status === 201 && res.data?.type === 'table');
    const upd = await api('PUT', `/resources/${ids.resource}`, { capacity: 6 });
    check('edit resource', upd.data?.capacity === 6);
    const del = await api('DELETE', `/resources/${ids.resource}`);
    const gone = await api('GET', `/resources/${ids.resource}`);
    check('delete resource', del.status === 200 && gone.status === 404);

    const ws = await api('POST', '/workspaces', { name: 'E2E Room', serviceIds: [ids.service], staffIds: [ids.staff] });
    ids.ws = ws.data?.id;
    const wsUpd = await api('PUT', `/workspaces/${ids.ws}`, { name: 'E2E Room 2' });
    check('workspace edit keeps relationships', wsUpd.data?.name === 'E2E Room 2' && wsUpd.data?.serviceIds?.includes(ids.service));
    const wsDel = await api('DELETE', `/workspaces/${ids.ws}`);
    check('delete workspace', wsDel.status === 200);
  }

  // 6. Booking page publish → public page → public booking → admin view; conflict; verified self-service
  {
    const slug = `e2e-${RUN}`;
    const PD = day(5);
    const before = await api('GET', `/public/availability?date=${PD}&serviceId=${ids.service}&staffId=${ids.staff}`, undefined, { auth: false });
    check('unpublished service is not publicly bookable', before.status === 404);
    const page = await api('POST', '/booking-pages', { title: 'E2E Page', slug, serviceIds: [ids.service], isPublished: true, formFields: [{ id: 'q1', label: 'Reason', type: 'text', required: false }], theme: { primaryColor: '#3B82F6' } });
    ids.page = page.data?.id;
    check('create published booking page with form fields + theme', page.status === 201 && page.data?.formFields?.length === 1 && page.data?.theme?.primaryColor === '#3B82F6', page.error);
    const reserved = await api('POST', '/booking-pages', { title: 'x', slug: 'lookup' });
    check('reserved slug rejected', reserved.status === 409);
    const pub = await api('GET', `/public/pages/${slug}`, undefined, { auth: false });
    check('public page lists its service', pub.status === 200 && pub.data?.services?.[0]?.id === ids.service);
    const staffPub = await api('GET', `/public/services/${ids.service}/staff`, undefined, { auth: false });
    check('public staff list for service', staffPub.data?.some(s => s.id === ids.staff));
    const avail = await api('GET', `/public/availability?date=${PD}&serviceId=${ids.service}&staffId=${ids.staff}`, undefined, { auth: false });
    check('public availability returns slots', avail.data?.some(s => s.start === '14:00' && s.available));
    const patEmail = `pat-${RUN}@example.com`;
    const book = await api('POST', '/public/book', { pageSlug: slug, serviceId: ids.service, staffId: ids.staff, date: PD, startTime: '14:00', notes: 'Private note from Pat', customer: { name: 'Public Pat', email: patEmail, phone: '+91 98765 40101' } }, { auth: false });
    ids.publicRef = book.data?.bookingRef;
    check('public booking succeeds', book.status === 201, book.error);
    const admin = await api('GET', `/appointments?q=${ids.publicRef}`);
    check('public booking appears in admin list', admin.data?.length === 1 && admin.data[0].customerName === 'Public Pat');
    const dup = await api('POST', '/public/book', { pageSlug: slug, serviceId: ids.service, staffId: ids.staff, date: PD, startTime: '14:30', customer: { name: 'Late Lee', email: `lee-${RUN}@example.com`, phone: '+91 98765 40102' } }, { auth: false });
    check('conflicting public booking rejected 409', dup.status === 409);

    const byRef = await api('GET', `/public/appointments/${ids.publicRef}`, undefined, { auth: false });
    check('booking reference alone reveals nothing', byRef.status === 404 && byRef.data === undefined && !JSON.stringify(byRef.json).includes('Pat'));
    const refCancel = await api('POST', `/public/appointments/${ids.publicRef}/cancel`, {}, { auth: false });
    check('booking reference alone cannot cancel', refCancel.status === 404);
    const wrong = await api('POST', '/public/appointments/lookup', { ref: ids.publicRef, email: `someone-else-${RUN}@example.com` }, { auth: false });
    check('lookup with the wrong email is refused without detail', wrong.status === 404 && wrong.data === undefined);
    const found = await api('POST', '/public/appointments/lookup', { ref: ids.publicRef.toLowerCase(), email: patEmail.toUpperCase() }, { auth: false });
    const body = JSON.stringify(found.json);
    check('lookup with reference + email returns a manage token', found.status === 200 && typeof found.data?.token === 'string' && found.data?.appointment?.bookingRef === ids.publicRef, found.error);
    check('verified view has no name, phone, notes or full email', !body.includes('Public Pat') && !body.includes('+91 98765 40101') && !body.includes('Private note') && !body.includes(patEmail) && found.data?.appointment?.maskedEmail === `p•••@example.com`);
    const token = found.data?.token;
    const noToken = await api('POST', '/public/appointments/manage/reschedule', { date: PD, startTime: '14:30' }, { auth: false });
    check('reschedule without a token → 401', noToken.status === 401);
    const forged = await api('POST', '/public/appointments/manage/cancel', {}, { auth: false, headers: { 'X-Booking-Token': `${token.slice(0, -4)}AAAA` } });
    check('tampered token → 401', forged.status === 401);
    const pr = await api('POST', '/public/appointments/manage/reschedule', { date: PD, startTime: '14:30' }, { auth: false, headers: { 'X-Booking-Token': token } });
    check('verified reschedule into overlap with own slot', pr.status === 200, pr.error);
    const pc = await api('POST', '/public/appointments/manage/cancel', {}, { auth: false, headers: { 'X-Booking-Token': token } });
    check('verified cancel', pc.status === 200, pc.error);

    // Guessing is throttled: repeated failed lookups for one reference are refused for a while.
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await api('POST', '/public/appointments/lookup', { ref: 'WE-GUESS000', email: `guess${i}@example.com` }, { auth: false })).status);
    }
    const limited = await api('POST', '/public/appointments/lookup', { ref: 'WE-GUESS000', email: 'guess9@example.com' }, { auth: false });
    check('repeated failed lookups are rate limited (429 + Retry-After)', statuses.slice(0, 5).every(s => s === 404) && statuses[5] === 429 && limited.status === 429 && Number(limited.headers.get('retry-after')) > 0, statuses.join(','));

    const unpub = await api('PUT', `/booking-pages/${ids.page}`, { isPublished: false });
    const gone = await api('GET', `/public/pages/${slug}`, undefined, { auth: false });
    check('unpublished page is not public', unpub.status === 200 && gone.status === 404);
  }

  // 7. Auth failures, CSRF and cross-site requests
  {
    const noCookie = await api('GET', '/appointments', undefined, { auth: false });
    check('no session → 401', noCookie.status === 401);
    const bad = await api('GET', '/appointments', undefined, { cookieOverride: 'we360_session=forged.token.value' });
    check('forged/expired session → 401', bad.status === 401 && !/stack|at /i.test(bad.error ?? ''));
    const err = await api('GET', '/appointments/does-not-exist');
    check('404 has no internals', err.status === 404 && err.error === 'Appointment not found');
    const noCsrf = await api('POST', '/customers', { name: 'No Token', email: `nocsrf-${RUN}@example.com` }, { noCsrf: true });
    check('cookie-authenticated change without CSRF token → 403', noCsrf.status === 403 && noCsrf.code === 'CSRF_FAILED');
    const crossSite = await api('POST', '/customers', { name: 'Cross Site', email: `xsite-${RUN}@example.com` }, { headers: { Origin: 'https://evil.example' } });
    check('change sent from another website → 403', crossSite.status === 403 && crossSite.code === 'ORIGIN_NOT_ALLOWED');
    const sameSite = await api('POST', '/customers', { name: 'Same Site', email: `samesite-${RUN}@example.com` }, { headers: { Origin: APP_ORIGIN } });
    check('change sent from the app origin with CSRF token succeeds', sameSite.status === 201, sameSite.error);
    const badJson = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    check('malformed JSON → 400, not 500', badJson.status === 400);
    sessionBeforeRestart = cookie;
  }

  // 8. Restart: data and sessions survive; logout ends the session for good
  await stop();
  await start();
  {
    const still = await api('GET', '/auth/me', undefined, { cookieOverride: sessionBeforeRestart });
    check('existing session still valid after restart', still.status === 200);
    const { res } = await api('POST', '/auth/login', owner, { auth: false, raw: true });
    cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    check('fresh login after restart', res.status === 200);
    const appt = await api('GET', `/appointments/${ids.appt2}`);
    check('appointment persisted across restart', appt.status === 200 && appt.data?.date === day(4));
    const cancelled = await api('GET', `/appointments/${ids.appt}`);
    check('cancelled state persisted', cancelled.data?.status === 'cancelled' && cancelled.data?.internalNotes === 'E2E note');
    const pubAppt = await api('GET', `/appointments?q=${ids.publicRef}`);
    check('public booking persisted with reschedule + cancel', pubAppt.data?.[0]?.startTime === '14:30' && pubAppt.data?.[0]?.status === 'cancelled');
    const page = await api('GET', `/booking-pages/${ids.page}`);
    check('booking page form fields persisted', page.data?.formFields?.[0]?.label === 'Reason');
    const loggedOutCookie = cookie;
    const logout = await api('POST', '/auth/logout', {});
    check('logout succeeds', logout.status === 200);
    const replay = await api('GET', '/auth/me', undefined, { cookieOverride: loggedOutCookie });
    check('a copied cookie stops working after logout', replay.status === 401);
  }

  // 8b. Password reset by email over HTTP: same answer for unknown addresses, link works once, sessions end
  {
    const signedIn = await api('POST', '/auth/login', owner, { auth: false, raw: true });
    const oldCookie = (signedIn.res.headers.get('set-cookie') ?? '').split(';')[0];
    const known = await api('POST', '/auth/password/forgot', { email: owner.email }, { auth: false });
    const unknown = await api('POST', '/auth/password/forgot', { email: `nobody-${RUN}@example.com` }, { auth: false });
    check('reset requests answer the same for a registered and an unknown address', known.status === 202 && unknown.status === 202 && JSON.stringify(known.json) === JSON.stringify(unknown.json));
    const resetToken = await emailedToken(owner.email, '/reset-password');
    check('the reset email reaches the mailbox with a /reset-password#token= link', !!resetToken);
    check('no email is sent for the unknown address', !mail.some(m => m.to.includes(`nobody-${RUN}@example.com`)));
    const newPassword = 'E2eReset456';
    const done = await api('POST', '/auth/password/reset', { token: resetToken, password: newPassword, confirmPassword: newPassword }, { auth: false });
    check('the reset link changes the password', done.status === 200);
    const reused = await api('POST', '/auth/password/reset', { token: resetToken, password: 'E2eAgain789', confirmPassword: 'E2eAgain789' }, { auth: false });
    check('the reset link works only once', reused.status === 410 && reused.code === 'RESET_USED');
    check('the session from before the reset has ended', (await api('GET', '/auth/me', undefined, { cookieOverride: oldCookie })).status === 401);
    check('the old password no longer signs in', (await api('POST', '/auth/login', owner, { auth: false })).status === 401);
    owner.password = newPassword;
    check('the new password signs in', (await api('POST', '/auth/login', owner, { auth: false })).status === 200);
    await new Promise(r => setTimeout(r, 300));
    check('a password-changed notice is emailed', mail.some(m => m.to.includes(owner.email) && /password was changed/.test(m.raw)));
  }

  // 9. Database tools (npm scripts) on this run's throwaway database, while its server keeps running.
  //    Everything is written to a temporary folder; the development database is never named.
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `we360-dbtools-${RUN}-`));
    const live = path.resolve(DB);
    // One command string (quoted here) rather than an argument list with shell: true, which Node deprecates (DEP0190).
    const npm = (...args) => spawnSync(['npm', 'run', ...args].map(a => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' '),
      { encoding: 'utf8', shell: true, env: { ...process.env, DB_PATH: live } });
    const status = npm('db:status', '--', '--db', live);
    check(`db:status reports all ${MIGRATION_COUNT} migrations applied on the live database`, MIGRATION_COUNT >= 10 && status.status === 0 && (status.stdout.match(/ applied 20/g) ?? []).length === MIGRATION_COUNT && /Integrity:\s+ok/.test(status.stdout), status.stdout + status.stderr);
    const backup = npm('db:backup', '--', '--db', live, '--out', path.join(tmp, 'backups'));
    const backupFile = (backup.stdout.match(/Backup written: (.+\.db) \(/) ?? [])[1];
    const manifest = backupFile && fs.existsSync(`${backupFile}.json`) ? JSON.parse(fs.readFileSync(`${backupFile}.json`, 'utf8')) : null;
    check('db:backup takes a verified online backup with a manifest while the server runs', backup.status === 0 && !!backupFile && manifest?.summary?.integrity === 'ok' && manifest.summary.tables.appointments > 0, backup.stdout + backup.stderr);
    const target = path.join(tmp, 'restored.db');
    const restore = npm('db:restore', '--', '--from', backupFile ?? 'missing', '--to', target);
    check('db:restore restores into a separate database and verifies counts, migrations and triggers', restore.status === 0 && /match the backup/.test(restore.stdout) && fs.existsSync(target), restore.stdout + restore.stderr);
    const again = npm('db:restore', '--', '--from', backupFile ?? 'missing', '--to', target);
    check('db:restore refuses to overwrite an existing database', again.status !== 0 && /already exists/.test(again.stderr + again.stdout));
    const forced = npm('db:restore', '--', '--from', backupFile ?? 'missing', '--to', target, '--force');
    const aside = (forced.stdout.match(/moved aside to: (.+)/) ?? [])[1]?.trim();
    check('db:restore --force moves the existing database aside instead of deleting it', forced.status === 0 && !!aside && fs.existsSync(aside), forced.stdout + forced.stderr);
    const restoredStatus = npm('db:status', '--', '--db', target);
    const appliedIds = out => (out.match(/^\s+(\d{3}_\w+)\s+applied 20/gm) ?? []).map(l => l.trim().split(/\s+/)[0]);
    check('the restored database reports the same migrations', restoredStatus.status === 0 && appliedIds(restoredStatus.stdout).length === MIGRATION_COUNT && appliedIds(restoredStatus.stdout).join() === appliedIds(status.stdout).join(), restoredStatus.stdout + restoredStatus.stderr);
    // Evidence for the run log: tool output holds paths, row counts and migration ids only.
    for (const [label, r] of [['db:status (live)', status], ['db:backup', backup], ['db:restore', restore], ['db:restore --force', forced], ['db:status (restored)', restoredStatus]]) {
      const lines = r.stdout.split(/\r?\n/).filter(l => l && !l.startsWith('>'));
      console.log(`  --- ${label}\n${lines.map(l => `    ${l}`).join('\n')}`);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
} catch (e) {
  check('e2e run completed without crashing', false, String(e?.stack ?? e));
} finally {
  await stop();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  // Remove the throw-away database; a file still held briefly by the OS is retried, and a leftover is reported.
  try {
    fs.rmSync(DB_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (e) {
    console.log(`[cleanup] could not remove the throw-away database folder ${DB_DIR}: ${e.code ?? e.message}`);
  }
  try { keepAwake?.kill(); } catch { /* already gone */ }
  await new Promise(r => smtp.close(r));
  process.exit(failed.length ? 1 : 0);
}
