// Local check of every account and booking email flow, through a real SMTP conversation with the local test inbox
// (scripts/mail-catcher.mjs). Nothing leaves the machine: the script starts its own inbox on free ports on 127.0.0.1,
// and the API (from source) on a free port with a throw-away database in the OS temp folder. Its email settings come
// from the process environment only, so server/.env and the development database are never used or changed.
//
//   cd server
//   npm run test:email
//
// Covers: sign-up confirmation, sign-in after confirming, forgot/reset password (all sessions end, link works once),
// the password-changed notice, replacement confirmation links, no account discovery, staff and manager resets,
// refused (550), temporarily refused (451) and unreachable mail servers. Never prints tokens or passwords.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'http://localhost:5173';
const RUN = Date.now().toString(36);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'we360-emailflows-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  -> ${detail}` : ''}`); };
const section = t => console.log(`\n## ${t}`);

async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

// ─── The local inbox ──────────────────────────────────────────────────────────
const inbox = async () => (await fetch(`${INBOX}/api/messages`)).json();
async function mailTo(addr, subjectPart, { after = 0, ms = 15000 } = {}) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = (await inbox()).find(x => x.to.includes(addr) && x.subject.includes(subjectPart) && Date.parse(x.receivedAt) >= after);
    if (m) return m;
    await sleep(150);
  }
  return null;
}
const linkIn = (m, p) => (m?.text.match(new RegExp(`(\\S+${p}#token=)([A-Za-z0-9_-]+)`)) ?? []);
const tokenIn = (m, p) => linkIn(m, p)[2] ?? null;

// ─── Its own local inbox (scripts/mail-catcher.mjs) on free ports ─────────────
const [SMTP_PORT, INBOX_PORT] = [await freePort(), await freePort()];
const INBOX = `http://127.0.0.1:${INBOX_PORT}`;
const catcher = spawn(process.execPath, ['scripts/mail-catcher.mjs', '--smtp', String(SMTP_PORT), '--http', String(INBOX_PORT)], { cwd: SERVER, stdio: ['ignore', 'pipe', 'pipe'] });
catcher.stdout.resume(); catcher.stderr.resume();
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${INBOX}/api/messages`)).ok) break; } catch { /* starting */ } await sleep(100); }

// ─── The API, from source, with process-only settings ─────────────────────────
const PORT = await freePort();
const env = {
  ...process.env,
  NODE_ENV: 'development', PORT: String(PORT), DB_PATH: path.join(TMP, 'flows.db'),
  JWT_SECRET: randomBytes(48).toString('hex'), JWT_EXPIRES_IN: '1h', CORS_ORIGIN: APP, PUBLIC_APP_URL: APP,
  EMAIL_TRANSPORT: 'smtp', EMAIL_FROM: 'WorkeasyBooking <bookings@example.test>',
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: 'false', SMTP_USER: '', SMTP_PASS: '',
  EMAIL_RETRY_DELAYS_MS: '1000,1000', EMAIL_WORKER_INTERVAL_MS: '500', // short retries so failure handling is visible
};
const api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
let apiLog = '';
api.stdout.on('data', d => { apiLog += d; }); api.stderr.on('data', d => { apiLog += d; });
/** Waits until the API log written since `from` matches `re` (or `ms` pass; the checks after it then report). */
async function waitForLog(from, re, ms) {
  for (const end = Date.now() + ms; Date.now() < end && !re.test(apiLog.slice(from));) await sleep(200);
}
for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; } catch { /* starting */ } await sleep(250); }

/** One browser: its own cookies and CSRF token. */
function browser() {
  const jar = new Map(); let csrf = null;
  async function call(method, route, body) {
    const headers = { 'Content-Type': 'application/json', Origin: APP };
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`http://127.0.0.1:${PORT}/api${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookies) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
    const json = await res.json().catch(() => ({}));
    if (json?.data?.csrfToken) csrf = json.data.csrfToken;
    return { status: res.status, json, data: json.data, code: json.code, setCookie: setCookies.length > 0 };
  }
  return { call, jar };
}
const anon = () => browser().call;
const GENERIC = 'We’ll send an email with the next steps if the address can be used for this request.';
const ALL_DAY = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]));
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const owner = { name: 'Flow Owner', email: `owner-${RUN}@example.test`, company: `Flow Co ${RUN}`, password: 'FlowPass123' };
let ownerBrowser;
try {
  check('the API started from source with email pointed at the local catcher', /Email transport: smtp/.test(apiLog), apiLog.slice(0, 300));

  section('1–3. Sign-up confirmation and sign-in');
  {
    const t0 = Date.now();
    const signup = await anon()('POST', '/auth/signup', { ...owner, confirmPassword: owner.password });
    check('1. sign-up answers 202 with the generic message and no session cookie', signup.status === 202 && signup.data?.message === GENERIC && !signup.setCookie);
    const mail = await mailTo(owner.email, 'Confirm your email', { after: t0 });
    const [, linkBase] = linkIn(mail, '/verify-email');
    check('1. the confirmation email reaches the local inbox', !!mail, 'no email');
    check('1. its link is PUBLIC_APP_URL/verify-email with the token after #', linkBase === `${APP}/verify-email#token=`, linkBase);
    const token = tokenIn(mail, '/verify-email');
    check('2. before confirming, the account cannot sign in', (await anon()('POST', '/auth/login', owner)).status === 401);
    const inspect = await anon()('POST', '/auth/verify-email/inspect', { token });
    check('2. the link is recognised (address and business shown to the link holder)', inspect.status === 200 && inspect.data?.email === owner.email && inspect.data?.businessName === owner.company);
    const verify = await anon()('POST', '/auth/verify-email', { token });
    check('2. confirming creates the account (201) and signs nobody in', verify.status === 201 && !verify.setCookie);
    const again = await anon()('POST', '/auth/verify-email', { token });
    check('2. the confirmation link works only once', again.status === 410 && again.code === 'VERIFY_USED');
    ownerBrowser = browser();
    const login = await ownerBrowser.call('POST', '/auth/login', owner);
    check('3. the confirmed account signs in normally', login.status === 200 && (await ownerBrowser.call('GET', '/auth/me')).data?.email === owner.email);
    check('3. the signing-up person is the business administrator', login.data?.user?.role === 'admin', login.data?.user?.role);
  }

  section('4–6. Forgot password, reset, sessions, notice');
  {
    const deviceB = browser();
    check('5. a second device is signed in before the reset', (await deviceB.call('POST', '/auth/login', owner)).status === 200);
    const t0 = Date.now();
    const forgot = await anon()('POST', '/auth/password/forgot', { email: owner.email });
    check('4. "Forgot password?" answers 202 with the generic message', forgot.status === 202 && forgot.data?.message === GENERIC);
    const mail = await mailTo(owner.email, 'Reset your', { after: t0 });
    check('4. the reset email reaches the local inbox', !!mail);
    check('4. its link is PUBLIC_APP_URL/reset-password with the token after #', linkIn(mail, '/reset-password')[1] === `${APP}/reset-password#token=`);
    const token = tokenIn(mail, '/reset-password');
    const weak = await anon()('POST', '/auth/password/reset', { token, password: 'short', confirmPassword: 'short' });
    check('5. the password policy applies to the new password', weak.status === 400);
    const newPassword = 'FlowReset456';
    const reset = await anon()('POST', '/auth/password/reset', { token, password: newPassword, confirmPassword: newPassword });
    check('5. a valid reset link changes the password (200), without signing in', reset.status === 200 && !reset.setCookie);
    check('5. the session on this device has ended', (await ownerBrowser.call('GET', '/auth/me')).status === 401);
    check('5. the session on the second device has ended', (await deviceB.call('GET', '/auth/me')).status === 401);
    check('5. the old password no longer signs in', (await anon()('POST', '/auth/login', owner)).status === 401);
    owner.password = newPassword;
    ownerBrowser = browser();
    check('5. the new password signs in', (await ownerBrowser.call('POST', '/auth/login', owner)).status === 200);
    const reuse = await anon()('POST', '/auth/password/reset', { token, password: 'FlowAgain789', confirmPassword: 'FlowAgain789' });
    check('5. the reset link works only once', reuse.status === 410 && reuse.code === 'RESET_USED');
    const notice = await mailTo(owner.email, 'password was changed', { after: t0 });
    check('6. the "password was changed" notice reaches the inbox, with no token in it', !!notice && !/#token=/.test(notice.text));
  }

  section('7. A replacement confirmation link replaces the earlier one');
  {
    const who = { name: 'Replace Person', email: `replace-${RUN}@example.test`, company: `Replace Co ${RUN}`, password: 'ReplacePass1' };
    const t0 = Date.now();
    await anon()('POST', '/auth/signup', { ...who, confirmPassword: who.password });
    const first = tokenIn(await mailTo(who.email, 'Confirm your email', { after: t0 }), '/verify-email');
    const t1 = Date.now();
    const resend = await anon()('POST', '/auth/verify-email/resend', { email: who.email });
    check('7. "Send a new link" answers 202 with the generic message', resend.status === 202 && resend.data?.message === GENERIC);
    const newMail = await mailTo(who.email, 'Your new link', { after: t1 });
    const second = tokenIn(newMail, '/verify-email');
    check('7. a new confirmation email arrives with a different link', !!second && second !== first);
    const old = await anon()('POST', '/auth/verify-email/inspect', { token: first });
    check('7. the earlier link is refused as replaced', old.status === 410 && old.code === 'VERIFY_REPLACED');
    check('7. the earlier link cannot confirm the account', (await anon()('POST', '/auth/verify-email', { token: first })).status === 410);
    check('7. the new link confirms the account', (await anon()('POST', '/auth/verify-email', { token: second })).status === 201);
    check('7. the account then signs in', (await anon()('POST', '/auth/login', who)).status === 200);
  }

  section('8. No account discovery');
  {
    const unknown = `nobody-${RUN}@example.test`;
    const t0 = Date.now();
    const known = await anon()('POST', '/auth/password/forgot', { email: owner.email });
    const unk = await anon()('POST', '/auth/password/forgot', { email: unknown });
    check('8. "Forgot password?" gives the same status and body for a registered and an unknown address', known.status === unk.status && JSON.stringify(known.json) === JSON.stringify(unk.json));
    const resendUnknown = await anon()('POST', '/auth/verify-email/resend', { email: unknown });
    check('8. "Send a new link" for an unknown address gives the same answer', resendUnknown.status === 202 && resendUnknown.data?.message === GENERIC);
    const dupe = await anon()('POST', '/auth/signup', { name: 'Someone Else', email: owner.email, company: 'Copycat Co', password: 'Different99', confirmPassword: 'Different99' });
    const fresh = await anon()('POST', '/auth/signup', { name: 'New Person', email: `fresh-${RUN}@example.test`, company: 'Fresh Co', password: 'FreshPass99', confirmPassword: 'FreshPass99' });
    check('8. signing up with a registered address answers exactly like a new address', dupe.status === fresh.status && JSON.stringify(dupe.json) === JSON.stringify(fresh.json) && !dupe.setCookie);
    const help = await mailTo(owner.email, 'Sign-in help', { after: t0 });
    check('8. only the mailbox owner learns the address is registered ("Sign-in help" email, no token)', !!help && !/#token=/.test(help.text));
    check('8. the registered account is unchanged (the sign-up password does not work, the real one does)',
      (await anon()('POST', '/auth/login', { email: owner.email, password: 'Different99' })).status === 401
      && (await anon()('POST', '/auth/login', owner)).status === 200);
    await sleep(800);
    check('8. nothing is emailed to the unknown address', !(await inbox()).some(m => m.to.includes(unknown)));
  }

  section('9. Staff and manager use the same reset flow');
  const service = (await ownerBrowser.call('POST', '/services', { name: 'Flow Consult', category: 'consultation', duration: 60, price: 50 })).data;
  for (const role of ['staff', 'manager']) {
    const person = { name: `Flow ${role}`, email: `${role}-${RUN}@example.test` };
    const staff = (await ownerBrowser.call('POST', '/staff', { ...person, serviceIds: [service.id], workingHours: ALL_DAY })).data;
    const t0 = Date.now();
    const invite = await ownerBrowser.call('POST', `/staff/${staff.id}/invitations`, { role });
    check(`9. the ${role} invitation is sent (201, delivery "sent")`, invite.status === 201 && invite.data?.email?.status === 'sent', JSON.stringify(invite.json).slice(0, 200));
    const inviteToken = tokenIn(await mailTo(person.email, 'invited you', { after: t0 }), '/accept-invite');
    const member = browser();
    const accepted = await member.call('POST', '/auth/invitations/accept', { token: inviteToken, password: 'MemberPass1', confirmPassword: 'MemberPass1' });
    check(`9. the ${role} accepts the invitation and has a ${role} sign-in`, accepted.status === 201 && accepted.data?.user?.role === role, JSON.stringify(accepted.json).slice(0, 200));
    const t1 = Date.now();
    await anon()('POST', '/auth/password/forgot', { email: person.email });
    const token = tokenIn(await mailTo(person.email, 'Reset your', { after: t1 }), '/reset-password');
    check(`9. the ${role} gets a reset email`, !!token);
    const reset = await anon()('POST', '/auth/password/reset', { token, password: 'MemberReset2', confirmPassword: 'MemberReset2' });
    check(`9. the ${role} resets the password; their open session ends`, reset.status === 200 && (await member.call('GET', '/auth/me')).status === 401);
    const login = await anon()('POST', '/auth/login', { email: person.email, password: 'MemberReset2' });
    check(`9. the ${role} signs in with the new password and keeps the ${role} role`, login.status === 200 && login.data?.user?.role === role);
    check(`9. the ${role} gets the "password was changed" notice`, !!(await mailTo(person.email, 'password was changed', { after: t1 })));
  }

  section('10. SMTP failures are handled safely');
  {
    // Account emails: the answer never depends on delivery, and the log records the failure (kind only).
    const logBefore = apiLog.length;
    const bounce = await anon()('POST', '/auth/signup', { name: 'Bounce Person', email: `bounce-${RUN}@example.test`, company: 'Bounce Co', password: 'BouncePass1', confirmPassword: 'BouncePass1' });
    const temp = await anon()('POST', '/auth/signup', { name: 'Temp Person', email: `tempfail-${RUN}@example.test`, company: 'Temp Co', password: 'TempPass12', confirmPassword: 'TempPass12' });
    check('10. sign-up answers the same generic 202 when the mail server refuses the address', bounce.status === 202 && temp.status === 202 && bounce.data?.message === GENERIC && temp.data?.message === GENERIC);
    // Retries come from the account-email queue (the worker runs every 0.5 s; 1 s between attempts).
    await waitForLog(logBefore, /account verify: FAILED via smtp after 3 attempt\(s\)/, 15_000);
    const log = apiLog.slice(logBefore);
    check('10. a permanent refusal (550) is logged as FAILED, not retried, not "sent"', /\[email\] account verify: FAILED via smtp after 1 attempt\(s\)/.test(log), log.slice(0, 400));
    check('10. a temporary refusal (451) is retried, then logged as FAILED', /account verify: attempt 1 failed via smtp, retrying/.test(log) && /account verify: FAILED via smtp after 3 attempt\(s\)/.test(log), log.slice(0, 600));
    check('10. no "sent" line for either refused email', (log.match(/account verify: sent via smtp/g) ?? []).length === 0);
    check('10. refused emails are not in the inbox', !(await inbox()).some(m => m.to.some(t => t.startsWith('bounce-') || t.startsWith('tempfail-'))));

    // Staff invitation: the administrator is told it was not delivered, and no usable invitation stays open.
    const bounceStaff = (await ownerBrowser.call('POST', '/staff', { name: 'Bounce Staff', email: `bounce-staff-${RUN}@example.test` })).data;
    const inv = await ownerBrowser.call('POST', `/staff/${bounceStaff.id}/invitations`, { role: 'staff' });
    check('10. an undeliverable invitation is reported as not delivered (502), not as sent', inv.status === 502 && inv.code === 'INVITE_NOT_DELIVERED' && inv.data?.email?.status !== 'sent', JSON.stringify(inv.json).slice(0, 200));
    const open = (await ownerBrowser.call('GET', `/staff/${bounceStaff.id}/invitations`)).data ?? [];
    check('10. the undelivered invitation is closed', open.length > 0 && open.every(i => i.status !== 'pending'), JSON.stringify(open).slice(0, 200));

    // Booking emails: the booking is kept; its email history shows the failure (permanent) or the retries (temporary).
    const staff = (await ownerBrowser.call('POST', '/staff', { name: 'Desk Staff', email: `desk-${RUN}@example.test`, serviceIds: [service.id], workingHours: ALL_DAY })).data;
    for (const [kind, local, slot] of [['permanent', 'bounce-cust', '10:00'], ['temporary', 'tempfail-cust', '12:00']]) {
      const cust = (await ownerBrowser.call('POST', '/customers', { name: `Cust ${kind}`, email: `${local}-${RUN}@example.test`, phone: '+91 98765 40100' })).data;
      const appt = await ownerBrowser.call('POST', '/appointments', { serviceId: service.id, staffId: staff.id, customerId: cust.id, date: day(3), startTime: slot });
      check(`10. a booking whose email is refused (${kind}) is still created`, appt.status === 201, JSON.stringify(appt.json).slice(0, 200));
      check(`10. the booking response reports the email as ${kind === 'permanent' ? '"failed"' : '"retrying"'}, not "sent"`, appt.data?.email?.status === (kind === 'permanent' ? 'failed' : 'retrying'), JSON.stringify(appt.data?.email));
      await sleep(kind === 'temporary' ? 4000 : 1000);
      const history = (await ownerBrowser.call('GET', `/appointments/${appt.data?.id}/emails`)).data ?? [];
      const statuses = history.map(h => h.status);
      check(`10. its email history shows the ${kind} failure and never "sent"`, statuses.length > 0 && statuses.includes('failed') && !statuses.includes('sent'), JSON.stringify(history).slice(0, 300));
      if (kind === 'temporary') check('10. the temporary failure was attempted more than once (retries)', history.filter(h => h.status === 'failed').length >= 2 || /attempt/i.test(JSON.stringify(history)), JSON.stringify(history).slice(0, 300));
    }
    const readable = (await ownerBrowser.call('GET', `/appointments`)).data ?? [];
    check('10. bookings are listed normally afterwards', readable.length >= 2);
  }

  section('Logs');
  {
    const tokens = (await inbox()).flatMap(m => [...m.text.matchAll(/#token=([A-Za-z0-9_-]+)/g)].map(x => x[1]));
    check(`the API log contains none of the ${tokens.length} emailed tokens`, tokens.length > 0 && tokens.every(t => !apiLog.includes(t)));
    check('the API log contains no passwords used in this check', !['FlowPass123', 'FlowReset456', 'MemberPass1', 'MemberReset2', 'ReplacePass1', 'Different99'].some(p => apiLog.includes(p)));
    check('the API log names no recipient address', !apiLog.includes(`-${RUN}@example.test`));
  }

  section('10. The mail server goes down');
  {
    catcher.kill();
    await new Promise(r => catcher.once('exit', r));
    const logBefore = apiLog.length;
    const down = await anon()('POST', '/auth/signup', { name: 'Down Person', email: `down-${RUN}@example.test`, company: 'Down Co', password: 'DownPass123', confirmPassword: 'DownPass123' });
    check('10. with the mail server unreachable, sign-up still answers the generic 202 (no claim of delivery)', down.status === 202 && down.data?.message === GENERIC);
    await waitForLog(logBefore, /account verify: FAILED via smtp after 3 attempt\(s\)/, 15_000);
    const log = apiLog.slice(logBefore);
    check('10. the connection failure is retried, then logged as FAILED, never "sent"', /account verify: attempt 1 failed via smtp, retrying/.test(log) && /account verify: FAILED via smtp after 3 attempt\(s\)/.test(log) && !/account verify: sent/.test(log), log.slice(0, 400));
    check('10. no account exists for that address', (await anon()('POST', '/auth/login', { email: `down-${RUN}@example.test`, password: 'DownPass123' })).status === 401);
  }
} catch (e) {
  check('flow check crashed', false, e.stack);
} finally {
  catcher.kill();
  api.kill();
  await new Promise(r => api.once('exit', r));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} email flow checks passed (throw-away database removed: ${!fs.existsSync(TMP)})`);
  process.exitCode = failed ? 1 : 0;
}
