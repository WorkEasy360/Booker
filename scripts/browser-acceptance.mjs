// Real-browser acceptance run: headless Chrome driven over the DevTools protocol.
// Serves the production build (dist/) with an /api proxy to a test backend on an isolated, throwaway DB.
// Usage: npm run test:browser (builds dist/ first). Needs Google Chrome; override with CHROME_PATH.
// Screenshots and report.json are written to .acceptance/.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = `${ROOT}/server`;
const DIST = path.resolve(`${ROOT}/dist`);
const OUT = path.join(ROOT, '.acceptance');
const SHOTS = path.join(OUT, 'shots');
// Test-data id used in names, emails and slugs. Set ACCEPTANCE_DATA_ID to reuse the same data in two runs, so their
// screenshots can be compared pixel for pixel. Files of each run always get their own id.
const RUN = process.env.ACCEPTANCE_DATA_ID || Date.now().toString(36);
const INSTANCE = Date.now().toString(36);
const API_PORT = 3078, WEB_PORT = 5199, CDP_PORT = 9333;
// WE360_SAME_ORIGIN=1: the API itself serves dist/ (WEB_DIST_DIR) with its real security headers, as in a single-service
// deployment (Dockerfile, Railway); the harness's own static server is not started.
const SAME_ORIGIN = process.env.WE360_SAME_ORIGIN === '1';
const ORIGIN = SAME_ORIGIN ? `http://localhost:${API_PORT}` : `http://localhost:${WEB_PORT}`;
// Throw-away database in the OS temp folder (outside the synced project).
const DB_FILE = path.join(os.tmpdir(), `we360-e2e-browser-${INSTANCE}.db`);
const JWT_SECRET = randomBytes(48).toString('hex'); // one per run so restarts keep sessions valid
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Chrome's throwaway profile lives in the OS temp folder: inside a synced folder (OneDrive) its constant small writes
// get scanned and locked, which can stall the browser.
const PROFILE = path.join(os.tmpdir(), `we360-acceptance-profile-${INSTANCE}`);
// Screenshots describe this run only: earlier runs' files (named after their own data) would otherwise pile up.
fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ── Result tracking ──────────────────────────────────────────────────────────
const RUN_STARTED = new Date();
const results = [];
const consoleIssues = [];
let current = 'setup';
// Isolated audit mode: Chrome may reach only this machine; page requests to any other host are recorded here.
const ISOLATED = process.env.WE360_ISOLATED_BROWSER === '1';
const ISOLATION_ARGS = ['--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE localhost , EXCLUDE 127.0.0.1', '--proxy-server=http://127.0.0.1:9',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-domain-reliability', '--no-pings', '--disable-client-side-phishing-detection'];
const externalRequests = new Map(); // url -> { step, answered }
const isLocalUrl = u => { try { const h = new URL(u).hostname; return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'; } catch { return true; } };

/** Removes credentials from text that ends up in the console or report.json (session, CSRF, manage and invite tokens, passwords). */
export function redactSecrets(text) {
  return String(text)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted-jwt]')
    .replace(/\bv1\.[\w-]+\.[0-9a-z]+\.[\w-]{20,}/g, '[redacted-manage-token]')
    .replace(/((?:we360_session|we360_device|__Host-we360_session|__Host-we360_device)=)[^;\s"]+/g, '$1[redacted]')
    .replace(/(token=)[\w%.-]{16,}/gi, '$1[redacted]')
    .replace(/("(?:token|csrfToken|manageToken|password|confirmPassword|currentPassword|newPassword)"\s*:\s*)"[^"]*"/g, '$1"[redacted]"');
}

function record(name, ok, detail = '') {
  const safe = redactSecrets(detail);
  results.push({ name, ok: !!ok, detail: safe });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && safe ? `  -> ${safe}` : ''}`);
}

// ── Keep the machine awake while the suite runs ──────────────────────────────
// Diagnosis (2026-10-22): runs failed when Windows entered Modern Standby on its 5-minute idle timeout; resuming reset
// every TCP connection, including the harness's DevTools socket (close code 1006 at the exact second Windows logged the
// power transition). The suite now holds a power request for its duration, like `caffeinate` on macOS.
// Shared helper (server/scripts/keep-awake.cjs): it also exits by itself if this process dies.
let keepAwake = null;
function startKeepAwake() {
  keepAwake = createRequire(path.join(SERVER_DIR, 'package.json'))('./scripts/keep-awake.cjs').startKeepAwake();
  if (keepAwake) console.log('[diagnostics] keeping the machine awake for the duration of the run');
}

/** Windows power transitions during the run: the evidence when the DevTools connection drops. */
function powerEventsDuringRun() {
  if (process.platform !== 'win32') return [];
  const since = RUN_STARTED.toISOString();
  const ps = `Get-WinEvent -FilterHashtable @{ LogName='System'; ProviderName='Microsoft-Windows-Kernel-Power'; StartTime=[datetime]'${since}' } -ErrorAction SilentlyContinue | Where-Object { $_.Id -in 506,507,566 } | Sort-Object TimeCreated | ForEach-Object { $_.TimeCreated.ToString('HH:mm:ss') + ' ' + (($_.Message -replace '\\s+',' ').Substring(0, [Math]::Min(90, ($_.Message -replace '\\s+',' ').Length))) }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 20_000 });
  return (r.stdout || '').split(/\r?\n/).filter(Boolean);
}

// ── Processes ────────────────────────────────────────────────────────────────
let api, web, chrome;
async function waitHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + url);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const API_LOG = path.join(os.tmpdir(), `we360-api-${INSTANCE}.log`);
async function startApi() {
  // One plain Node process (no tsx CLI wrapper), so stopping it cannot leave an orphan server behind.
  // Its output goes to a log file: an unread pipe would eventually block the server's writes.
  const out = fs.openSync(API_LOG, 'a');
  api = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, DB_PATH: DB_FILE, PORT: String(API_PORT), NODE_ENV: 'development',
      JWT_SECRET, JWT_EXPIRES_IN: '1h', CORS_ORIGIN: ORIGIN,
      EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2526', SMTP_SECURE: 'false',
      // Set explicitly so values from server/.env can never reach the test server.
      SMTP_USER: '', SMTP_PASS: '',
      EMAIL_FROM: 'WorkEasy360 QA <qa@example.com>', PUBLIC_APP_URL: ORIGIN,
      // The webhook step delivers to a receiver on 127.0.0.1 (refused by the server outside development).
      WEBHOOKS_ALLOW_PRIVATE_NETWORK: '1',
      // SMS, WhatsApp and calendar calls go to the in-process stand-in, whatever server/.env says.
      NOTIFICATIONS_PROVIDER_MODE: 'mock', PUBLIC_API_URL: '', WEB_DIST_DIR: SAME_ORIGIN ? DIST : '' },
    stdio: ['ignore', out, out],
  });
  await waitHttp(`http://localhost:${API_PORT}/api/health`);
}
async function stopApi() {
  if (!api) return;
  const done = new Promise(r => api.once('exit', r));
  api.kill(); await done; api = undefined;
}

function startWeb() {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  web = http.createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      const p = http.request({ host: 'localhost', port: API_PORT, path: req.url, method: req.method, headers: req.headers }, pr => {
        res.writeHead(pr.statusCode, pr.headers); pr.pipe(res);
      });
      p.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'API server is not reachable' })); });
      req.pipe(p); return;
    }
    const clean = decodeURIComponent(req.url.split('?')[0]);
    let file = path.resolve(path.join(DIST, clean));
    if (!file.startsWith(DIST + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(WEB_PORT);
}

// ── CDP diagnostics ──────────────────────────────────────────────────────────
// Metadata only (direction, id, method, session, size, time): CDP message contents can include session cookies,
// so they are never written. The logs live in the OS temp folder, outside the synced project.
const CDP_LOG = path.join(os.tmpdir(), `we360-cdp-${INSTANCE}.log`);
const CHROME_LOG = path.join(os.tmpdir(), `we360-chrome-${INSTANCE}.log`);
const cdpRecent = [];
const cdpStats = { sent: 0, received: 0, bytesIn: 0, lastInAt: 0, closed: null };
let cdpShuttingDown = false;
function cdpNote(entry) {
  cdpRecent.push({ t: Date.now(), ...entry });
  if (cdpRecent.length > 500) cdpRecent.shift();
}
function cdpDump(reason) {
  const lines = [`== ${new Date().toISOString()} ${reason} stats=${JSON.stringify(cdpStats)}`, ...cdpRecent.map(e => JSON.stringify(e))];
  fs.appendFileSync(CDP_LOG, lines.join('\n') + '\n');
}

// ── Minimal CDP client ───────────────────────────────────────────────────────
class Browser {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = []; }
  static async connect() {
    const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const b = new Browser(ws);
    ws.onmessage = ev => {
      const size = typeof ev.data === 'string' ? ev.data.length : (ev.data?.byteLength ?? 0);
      cdpStats.received++; cdpStats.bytesIn += size; cdpStats.lastInAt = Date.now();
      const m = JSON.parse(ev.data);
      cdpNote({ dir: 'in', id: m.id, method: m.method, session: (m.sessionId ?? '').slice(0, 8), bytes: size, error: m.error?.message });
      if (m.id && b.pending.has(m.id)) {
        const { res, rej } = b.pending.get(m.id); b.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      } else if (m.method) b.listeners.forEach(l => l(m));
    };
    // If Chrome drops the connection, fail everything waiting on it at once and say so, instead of timing out blind.
    ws.onclose = ev => {
      if (cdpShuttingDown) return; // Chrome is being stopped at the end of the run: expected
      cdpStats.closed = { code: ev.code, reason: ev.reason, at: Date.now() };
      console.log(`[cdp] connection closed: code=${ev.code} reason=${ev.reason || '-'} pending=${b.pending.size}`);
      cdpDump(`websocket closed code=${ev.code}`);
      for (const { rej } of b.pending.values()) rej(new Error(`CDP connection closed by Chrome (code ${ev.code})`));
      b.pending.clear();
    };
    ws.onerror = ev => {
      if (cdpShuttingDown) return;
      console.log(`[cdp] websocket error: ${ev.message ?? ev.type}`);
      cdpNote({ dir: 'err', error: String(ev.message ?? ev.type) });
    };
    b.listeners.push(m => {
      if (['Target.detachedFromTarget', 'Target.targetCrashed', 'Inspector.detached', 'Inspector.targetCrashed'].includes(m.method)) {
        console.log(`[cdp] ${m.method} ${JSON.stringify(m.params ?? {}).slice(0, 200)}`);
      }
    });
    return b;
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP connection is not open (state ${this.ws.readyState}) for ${method}`));
    const payload = JSON.stringify({ id, method, params, sessionId });
    cdpStats.sent++;
    cdpNote({ dir: 'out', id, method, session: (sessionId ?? '').slice(0, 8), bytes: payload.length });
    this.ws.send(payload);
    // A reply that never arrives fails the current step instead of hanging the whole run.
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const quiet = cdpStats.lastInAt ? Date.now() - cdpStats.lastInAt : -1;
        cdpDump(`timeout id=${id} ${method} session=${(sessionId ?? '').slice(0, 8)} socketState=${this.ws.readyState} msSinceLastMessage=${quiet} pending=${this.pending.size}`);
        rej(new Error(`Chrome did not answer ${method} within 60s (socket state ${this.ws.readyState}, last message ${quiet} ms ago)`));
      }, 60_000);
      this.pending.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
    });
  }
  async newPage({ incognito = false, label }) {
    let browserContextId;
    if (incognito) ({ browserContextId } = await this.send('Target.createBrowserContext'));
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, label);
    await page.init();
    return page;
  }
}

const HELPERS = `
window.__t = {
  norm(s) { return (s || '').replace(/\\s+/g, ' ').trim().toLowerCase(); },
  visible(e) { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; },
  byLabel(text, scope) {
    const root = scope ? document.querySelector(scope) : document;
    const want = this.norm(text);
    const labels = [...root.querySelectorAll('label')].filter(l => this.norm(l.textContent).replace(/\\*$/, '').trim().startsWith(want));
    for (const l of labels) {
      const c = l.control || l.parentElement.querySelector('input,textarea,select');
      if (c) return c;
    }
    return null;
  },
  setValue(el, v) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },
  find(text, sel, scope) {
    const root = scope ? document.querySelector(scope) : document;
    if (!root) return null;
    const want = this.norm(text);
    const els = [...root.querySelectorAll(sel || 'button,a,[role=tab],[role=option],label')].filter(e => this.visible(e));
    return els.find(e => this.norm(e.textContent) === want || this.norm(e.getAttribute('aria-label')) === want)
        || els.find(e => this.norm(e.textContent).includes(want) || this.norm(e.getAttribute('aria-label')).includes(want));
  },
  a11y() {
    const issues = [];
    const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim()
      || [...e.querySelectorAll('img')].map(i => i.alt).join('').trim()
      || (e.getAttribute('aria-labelledby') ? (document.getElementById(e.getAttribute('aria-labelledby'))?.textContent || '').trim() : '');
    for (const b of document.querySelectorAll('button,a[href],[role=button]')) if (this.visible(b) && !name(b)) issues.push('unnamed ' + b.tagName.toLowerCase() + ' ' + (b.className || '').toString().slice(0, 60));
    for (const i of document.querySelectorAll('input:not([type=hidden]),select,textarea')) {
      if (!this.visible(i)) continue;
      const labelled = (i.labels && i.labels.length) || i.getAttribute('aria-label') || i.getAttribute('aria-labelledby') || i.closest('label');
      if (!labelled) issues.push('unlabelled ' + i.tagName.toLowerCase() + '[' + (i.type || '') + '] placeholder=' + (i.placeholder || ''));
    }
    for (const img of document.querySelectorAll('img')) if (!img.hasAttribute('alt')) issues.push('img without alt ' + img.src.slice(-40));
    const ids = {}; for (const e of document.querySelectorAll('[id]')) ids[e.id] = (ids[e.id] || 0) + 1;
    for (const [k, n] of Object.entries(ids)) if (n > 1) issues.push('duplicate id #' + k);
    return issues;
  },
  brand() {
    // Product logos and marks actually on screen (the closed mobile drawer is off to the left), and where they sit.
    const where = e => e.closest('#main-sidebar') ? 'sidebar' : e.closest('header') ? 'header' : e.closest('footer') ? 'footer' : 'page';
    const shown = e => { const r = e.getBoundingClientRect(); return this.visible(e) && r.right > 0 && r.left < innerWidth; };
    const logos = [...document.querySelectorAll('[data-brand="product-logo"]')].filter(shown).map(e => ({ label: e.getAttribute('aria-label'), text: e.textContent.trim(), where: where(e) }));
    const marks = [...document.querySelectorAll('[data-brand="product-mark"]')].filter(shown).map(e => ({ label: e.getAttribute('alt'), where: where(e) }));
    const broken = [...document.images].filter(i => i.complete && i.naturalWidth === 0).map(i => i.src.slice(-60));
    // Any spelling other than the official two: the product "WorkeasyBooking" and the company "WorkEasy360". The old
    // product name "WorkEasy360 Booking" counts as a wrong spelling.
    const variants = [
      ...[...document.body.innerText.matchAll(/work\\s*-?\\s*easy\\s*-?\\s*360(\\s+booking)?/gi)].map(m => m[0]).filter(s => s !== 'WorkEasy360'),
      ...[...document.body.innerText.matchAll(/work\\s*-?\\s*easy\\s*-?\\s*booking/gi)].map(m => m[0]).filter(s => s !== 'WorkeasyBooking'),
    ];
    return { logos, marks, broken, variants, title: document.title, text: document.body.innerText };
  },
  overflow(device = 375) {
    // Mobile Chrome widens the layout viewport to fit oversized content, so compare against the device width.
    const w = device;
    if (window.innerWidth <= w + 1 && document.documentElement.scrollWidth <= w + 1) return [];
    const culprits = [...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().width > w + 1 && !e.closest("header") && ![...e.children].some(c => c.getBoundingClientRect().width > w + 1));
    if (culprits.length) return culprits.slice(0, 5).map(e => e.tagName.toLowerCase() + "." + String(e.className).split(" ").slice(0, 4).join(".") + " w=" + Math.round(e.getBoundingClientRect().width) + (e.closest("[class*=overflow-x-auto],[class*=overflow-auto]") ? " (inside scroll container)" : ""));
    // Elements pushed past the right edge (not wider than the screen themselves), ignoring fixed chrome such as the header.
    const beyond = [...document.querySelectorAll('body *')].filter(e => {
      const r = e.getBoundingClientRect();
      if (!(r.right > w + 1 && r.width > 0) || e.closest('header') || e.closest('[class*=overflow-x-auto],[class*=overflow-auto]')) return false;
      for (let p = e; p; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return false;
      return true;
    });
    const deepest = beyond.filter(e => !beyond.some(o => o !== e && e.contains(o)));
    return deepest.slice(0, 5).map(e => e.tagName.toLowerCase() + '.' + (e.className || '').toString().split(' ').slice(0, 4).join('.') + ' right=' + Math.round(e.getBoundingClientRect().right) + ' text=' + JSON.stringify((e.textContent || '').trim().slice(0, 30)));
  },
};`;

class Page {
  constructor(browser, sessionId, label) { this.b = browser; this.s = sessionId; this.label = label; }
  send(m, p) { return this.b.send(m, p, this.s); }
  async init() {
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('Log.enable'); await this.send('Network.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
    this.b.listeners.push(m => {
      if (m.sessionId !== this.s) return;
      if (m.method === 'Runtime.exceptionThrown') consoleIssues.push({ step: current, page: this.label, kind: 'exception', text: m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text });
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleIssues.push({ step: current, page: this.label, kind: 'console.error', text: m.params.args.map(a => a.value ?? a.description).join(' ').slice(0, 300) });
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') consoleIssues.push({ step: current, page: this.label, kind: 'log', text: `${m.params.entry.text} ${m.params.entry.url ?? ''}`.slice(0, 300) });
      if (ISOLATED && m.method === 'Network.requestWillBeSent' && !isLocalUrl(m.params.request.url) && !/^(data|blob|about|chrome|devtools):/.test(m.params.request.url)) {
        externalRequests.set(m.params.request.url, externalRequests.get(m.params.request.url) ?? { step: current, answered: false });
      }
      if (ISOLATED && m.method === 'Network.responseReceived' && !isLocalUrl(m.params.response.url) && /^https?:/.test(m.params.response.url)) {
        externalRequests.set(m.params.response.url, { ...(externalRequests.get(m.params.response.url) ?? { step: current }), answered: true, status: m.params.response.status, remote: m.params.response.remoteIPAddress ?? '' });
      }
    });
  }
  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }
  async goto(p) {
    await this.send('Page.navigate', { url: ORIGIN + p });
    await this.waitFor('document.readyState === "complete" && !!window.__t');
    await sleep(300);
  }
  /** Opens an absolute URL (e.g. a link from an email) as a fresh page load. */
  async gotoUrl(url) {
    await this.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete" && !!window.__t');
    await sleep(300);
  }
  async reload() { await this.send('Page.reload'); await sleep(500); await this.waitFor('document.readyState === "complete" && !!window.__t'); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async waitFor(expr, ms = 10000) {
    const end = Date.now() + ms; let last;
    while (Date.now() < end) {
      try { if (await this.eval(`!!(${expr})`)) return true; } catch (e) { last = e; }
      await sleep(150);
    }
    throw new Error(`timed out waiting for: ${expr}${last ? ' (' + last.message + ')' : ''}`);
  }
  waitText(t, ms) { return this.waitFor(`document.body && document.body.innerText.includes(${JSON.stringify(t)})`, ms); }
  hasText(t) { return this.eval(`document.body.innerText.includes(${JSON.stringify(t)})`); }
  path() { return this.eval('location.pathname'); }
  async fill(label, value, scope) {
    try { await this.waitFor(`!!__t.byLabel(${JSON.stringify(label)}, ${JSON.stringify(scope ?? null)})`, 6000); } catch { /* reported below */ }
    const ok = await this.eval(`(() => { const el = __t.byLabel(${JSON.stringify(label)}, ${JSON.stringify(scope ?? null)}); if (!el) return false; el.focus(); __t.setValue(el, ${JSON.stringify(value)}); return true; })()`);
    if (!ok) throw new Error(`field not found: ${label}`);
  }
  async fillSel(selector, value) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); __t.setValue(el, ${JSON.stringify(value)}); return true; })()`);
    if (!ok) throw new Error(`element not found: ${selector}`);
  }
  async selectOption(label, optionText) {
    const ok = await this.eval(`(() => { const el = __t.byLabel(${JSON.stringify(label)}); if (!el) return 'nofield';
      const o = [...el.options].find(o => o.textContent.trim().toLowerCase().includes(${JSON.stringify(optionText.toLowerCase())}));
      if (!o) return 'nooption: ' + [...el.options].map(o => o.textContent).join('|'); __t.setValue(el, o.value); return true; })()`);
    if (ok !== true) throw new Error(`select ${label}: ${ok}`);
  }
  async click(text, sel, scope) {
    try { await this.waitFor(`!!__t.find(${JSON.stringify(text)}, ${JSON.stringify(sel ?? null)}, ${JSON.stringify(scope ?? null)})`, 6000); } catch { /* reported below */ }
    const ok = await this.eval(`(() => { const e = __t.find(${JSON.stringify(text)}, ${JSON.stringify(sel ?? null)}, ${JSON.stringify(scope ?? null)}); if (!e) return 'missing'; if (e.disabled) return 'disabled'; e.scrollIntoView({block:'center'}); e.click(); return true; })()`);
    if (ok !== true) throw new Error(`click "${text}": ${ok}`);
    await sleep(250);
  }
  async clickSel(selector) {
    const ok = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return 'missing'; if (e.disabled) return 'disabled'; e.scrollIntoView({block:'center'}); e.click(); return true; })()`);
    if (ok !== true) throw new Error(`click ${selector}: ${ok}`);
    await sleep(250);
  }
  async key(key, code = key, keyCode) {
    const text = key === 'Enter' ? String.fromCharCode(13) : undefined;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    await sleep(80);
  }
  // Calls the API from inside the page, like the app does: session cookie plus, for changes, the CSRF token.
  async api(method, p, body) {
    return this.eval(`(async () => {
      const headers = { 'Content-Type': 'application/json' };
      if (${JSON.stringify(method)} !== 'GET') {
        const me = await fetch('/api/auth/me', { credentials: 'include' }).then(r => (r.ok ? r.json() : null)).catch(() => null);
        if (me && me.data && me.data.csrfToken) headers['X-CSRF-Token'] = me.data.csrfToken;
      }
      const r = await fetch(${JSON.stringify('/api' + p)}, { method: ${JSON.stringify(method)}, credentials: 'include', headers, body: ${body === undefined ? 'undefined' : JSON.stringify(JSON.stringify(body))} });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    })()`);
  }
  /** Web fonts (Inter comes from Google Fonts) finish loading first, so screenshots are comparable between runs. */
  async fontsReady() {
    // Every Inter weight the app uses, then whatever else the page requested; weights load lazily otherwise.
    try { await this.eval('Promise.all(["300", "400", "500", "600", "700"].map(w => document.fonts.load(w + " 16px Inter"))).then(() => document.fonts.ready).then(() => true)'); } catch { /* offline: the fallback font is what users would see */ }
    try { await this.waitFor('document.fonts && document.fonts.status === "loaded"', 8000); } catch { /* shoot anyway */ }
    await sleep(150);
  }
  async shot(name) {
    await this.fontsReady();
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  }
  /** Screenshot of the whole page, below the fold too (footers). */
  async shotFull(name) {
    await this.fontsReady();
    const m = await this.send('Page.getLayoutMetrics');
    const size = m.cssContentSize ?? m.contentSize;
    const clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 6000), scale: 1 };
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  }
  /** Calls fn(params) for this page's `method` events; returns a function that stops listening. */
  on(method, fn) {
    const l = m => { if (m.sessionId === this.s && m.method === method) fn(m.params); };
    this.b.listeners.push(l);
    return () => { const i = this.b.listeners.indexOf(l); if (i >= 0) this.b.listeners.splice(i, 1); };
  }
  /** Shows the given HTML (an email body) in this page, to check how it renders. */
  async renderHtml(html) {
    await this.send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    const { frameTree } = await this.send('Page.getFrameTree');
    await this.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await sleep(300);
  }
}

// ── Test plumbing ────────────────────────────────────────────────────────────
async function step(name, page, fn) {
  // Without the DevTools connection nothing can run: stop here with one clear failure instead of a cascade.
  if (cdpStats.closed) throw new Error(`DevTools connection lost (code ${cdpStats.closed.code}) at ${new Date(cdpStats.closed.at).toLocaleTimeString()}; steps from "${name}" on were not run`);
  current = name;
  try { await fn(); record(name, true); }
  catch (e) {
    record(name, false, e.message);
    if (page) { try { await page.shot('FAIL-' + name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)); } catch { /* best effort */ } }
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

/** The 6-digit code an authenticator app shows for a base32 key, `offset` 30-second steps from now (RFC 6238). */
function totp(base32Key, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const bytes = [];
  for (const ch of base32Key.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
}

/** A small real PNG (solid colour), for the upload step. */
function tinyPng(w = 64, h = 32) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x30)]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** Chooses a value in a <select> the way a person does (React sees a real change event). */
const chooseIn = (page, selector, value) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);

const pad2 = n => String(n).padStart(2, '0');
const isoLocal = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Dates are computed in the business time zone (Asia/Kolkata), which this suite configures. */
function bizToday() { return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function addDays(date, n) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function dow(date) { return new Date(`${date}T12:00:00Z`).getUTCDay(); }
function nextWeekday(minDaysAhead) { let d = addDays(bizToday(), minDaysAhead); while (dow(d) === 0 || dow(d) === 6) d = addDays(d, 1); return d; }
function nextDow(target, minDaysAhead = 1) { let d = addDays(bizToday(), minDaysAhead); while (dow(d) !== target) d = addDays(d, 1); return d; }

// ── Local SMTP catcher: real SMTP delivery that never leaves the machine ─────
const SMTP_PORT = 2526;
const mail = [];
let smtpServer;
async function startSmtp() {
  const req = createRequire(path.join(SERVER_DIR, 'package.json'));
  const { SMTPServer } = req('smtp-server');
  smtpServer = new SMTPServer({
    authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'], logger: false,
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', c => { raw += c.toString('latin1'); }); // keep raw bytes; decoded as UTF-8 below
      stream.on('end', () => {
        // Undo quoted-printable (soft breaks, =XX byte escapes), then decode the bytes as UTF-8.
        const qp = raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        const body = Buffer.from(qp, 'latin1').toString('utf8');
        const headers = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' '); // unfold long header lines
        mail.push({ to: session.envelope.rcptTo.map(r => r.address), subject: (headers.match(/^Subject: (.*)$/m) || [])[1] ?? '', body });
        cb();
      });
    },
  });
  await new Promise(r => smtpServer.listen(SMTP_PORT, '127.0.0.1', r));
}
const mailTo = addr => mail.filter(m => m.to.includes(addr));
/** The HTML part of a captured message (quoted-printable already undone by the catcher). */
function htmlPart(raw) {
  return raw.match(/Content-Type: text\/html[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--[^\r\n]+/)?.[1] ?? null;
}

// ── Product identity: the platform's own. A business's name, page title and theme always come from its data. ──
const PRODUCT = 'WorkeasyBooking';
const ATTRIBUTION = 'A WorkEasy360 Product';
const POWERED_BY = `Powered by ${PRODUCT}`;
const DESCRIPTION = 'Smart appointment scheduling for businesses';
const COPYRIGHT = `© ${new Date().getFullYear()} WorkEasy360`;
const tabTitle = page => `${page} — ${PRODUCT}`;
/** The server's answer to every request that names an email address (sign-up, new link, forgot password). */
const GENERIC_EMAIL_REPLY = 'We’ll send an email with the next steps if the address can be used for this request.';

/** The path and #token of the newest captured email to `addr` that links to `linkPath` (waits for delivery). */
async function emailedLink(addr, linkPath, ms = 15000) {
  const re = new RegExp(`${ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(${linkPath}#token=[A-Za-z0-9_-]+)`);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = [...mailTo(addr)].reverse().find(x => re.test(x.body));
    if (m) return { path: re.exec(m.body)[1], subject: m.subject };
    await sleep(150);
  }
  throw new Error(`no email to ${addr} with a ${linkPath} link`);
}

/** A new business owner signs up through the UI: "Check your email", the emailed link, "Confirm my email", then a normal sign-in. */
async function signUpThroughUi(page, who, shots = false) {
  await page.goto('/signup');
  await page.fill('Full name', who.name); await page.fill('Work email', who.email);
  await page.fill('Company / workspace name', who.company);
  await page.fill('Password', who.password); await page.fill('Confirm password', who.password);
  await page.clickSel('form button[type=submit]');
  await page.waitText('Check your email');
  await page.waitText(GENERIC_EMAIL_REPLY);
  expect((await page.path()) === '/signup', 'sign-up navigated away instead of asking to check email');
  expect((await page.api('GET', '/auth/me')).status === 401, 'sign-up signed the visitor in before the email was confirmed');
  if (shots) await page.shot('auth_check_email');
  const link = await emailedLink(who.email, '/verify-email');
  await page.goto(link.path);
  await page.waitText('Confirm my email');
  expect(await page.eval('location.hash === ""'), 'the confirmation token stayed in the address bar');
  if (shots) await page.shot('auth_verify_email');
  await page.click('Confirm my email', 'button');
  await page.waitText('Your email is confirmed');
  expect((await page.api('GET', '/auth/me')).status === 401, 'confirming the email signed the visitor in');
  if (shots) await page.shot('auth_verify_done');
  await page.click('Sign in', 'a');
  await page.waitFor('location.pathname === "/login"');
  await page.fillSel('#login-email', who.email); await page.fillSel('#login-password', who.password);
  await page.clickSel('form button[type=submit]');
  await page.waitFor('location.pathname === "/dashboard"');
}
/** Page states captured during a flow (they cannot be revisited), asserted in a branding step afterwards. */
const seen = {};
/** Email HTML captured during the run, rendered and checked at desktop and phone widths near the end. */
const emailRenders = {};
/** Who the page presents as its identity: business header, tab title, platform credit, product logos on screen. */
function identityOf(p) {
  return p.eval('({ identity: document.querySelector("[data-business-name]")?.textContent.trim(), title: document.title, credit: document.querySelector("[data-brand=powered-by]")?.innerText.trim(), logos: __t.brand().logos.length })');
}

// ── Scenario ─────────────────────────────────────────────────────────────────
const owner = { name: 'Browser Owner', email: `browser-${RUN}@example.com`, company: `Browser Org ${RUN}`, password: 'Browser123' };
const names = { service: `Browser Consult ${RUN}`, service2: `Browser Consult Edited ${RUN}`, staff1: `Ada Browser ${RUN}`, staff2: `Ben Browser ${RUN}`,
  customer: `Cora Customer ${RUN}`, resource: `Table Six ${RUN}`, workspace: `North Room ${RUN}`, page: `Browser Page ${RUN}` };
const petra = { name: 'Petra Public', email: `petra-${RUN}@example.com` };
const ids = {};

async function waitCalendar(p) {
  await p.waitFor('document.querySelector("[data-date]") && !document.querySelector("[aria-label=\\"Loading available dates\\"]")', 15000);
}
async function showMonthWith(p, date) {
  // Steps month by month toward the date's month, in whichever direction it lies (only the shown month's days carry
  // data-date). Searching forward first and then back a fixed number of times could not return to an earlier month,
  // e.g. on 24 October 2026, after showing Sunday 1 November, it never found Wednesday 28 October again.
  for (let i = 0; i < 12 && !(await p.eval(`!!document.querySelector('[data-date="${date}"]')`)); i++) {
    const firstShown = await p.eval(`[...document.querySelectorAll('[data-date]')].map(e => e.dataset.date).sort()[0] ?? ''`);
    await p.click(firstShown && date < firstShown ? 'Previous month' : 'Next month');
    await waitCalendar(p);
  }
}

async function main() {
  startKeepAwake();
  await startSmtp();
  await startApi();
  if (SAME_ORIGIN) console.log(`[same-origin] the API serves the web app at ${ORIGIN}`); else startWeb();
  await waitHttp(ORIGIN + '/');
  // Chrome's own log goes to the temp folder so a stall can be correlated with what the browser reported.
  const chromeLog = fs.openSync(CHROME_LOG, 'w');
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--enable-logging=stderr', '--log-level=0', ...(ISOLATED ? ISOLATION_ARGS : []), 'about:blank'], { stdio: ['ignore', 'ignore', chromeLog] });
  if (ISOLATED) console.log('[isolation] Chrome may reach only localhost/127.0.0.1; other requests are recorded');
  chrome.on('exit', (code, signal) => console.log(`[chrome] exited code=${code} signal=${signal}`));
  console.log(`[diagnostics] CDP log: ${CDP_LOG}`);
  console.log(`[diagnostics] Chrome log: ${CHROME_LOG}`);
  console.log(`[diagnostics] Chrome profile (outside the project): ${PROFILE}`);
  await waitHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const browser = await Browser.connect();
  const admin = await browser.newPage({ label: 'admin' });
  await admin.viewport(1280, 860);
  // The owner signs up from a browser on Indian time (the business is created in that zone).
  await admin.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Kolkata' });

  // 0. Product identity on the sign-in pages; icons and manifest
  await step('sign-in and sign-up pages show WorkeasyBooking, its description and "A WorkEasy360 Product"', admin, async () => {
    for (const [p, title, subtitle] of [['/login', tabTitle('Sign in'), `Sign in to ${PRODUCT}`], ['/signup', tabTitle('Create your account'), 'Start managing bookings in minutes'], ['/forgot-password', tabTitle('Forgot password'), 'We’ll email you a link to choose a new one']]) {
      await admin.goto(p);
      await admin.waitFor('document.querySelector("form") && [...document.images].every(i => i.complete)');
      const b = await admin.eval('__t.brand()');
      expect(b.logos.length === 1 && b.logos[0].label === PRODUCT && b.logos[0].where === 'header', `${p}: product logos ${JSON.stringify(b.logos)}`);
      for (const t of [DESCRIPTION, subtitle, ATTRIBUTION, COPYRIGHT]) expect(b.text.includes(t), `${p}: "${t}" missing`);
      expect(b.title === title, `${p}: tab title "${b.title}"`);
      expect(!b.broken.length && !b.variants.length, `${p}: broken images ${b.broken.join(', ')}; name variants ${b.variants.join(', ')}`);
      await admin.shot('brand' + p.replace(/\//g, '_'));
    }
  });
  await step('favicon, home-screen icon and web manifest load and show the official mark', admin, async () => {
    const links = await admin.eval(`(async () => {
      const out = [];
      for (const l of document.querySelectorAll('link[rel=icon], link[rel=apple-touch-icon], link[rel=manifest]')) {
        const res = await fetch(l.href);
        const entry = { rel: l.rel, href: l.getAttribute('href'), status: res.status, type: res.headers.get('content-type'), declared: l.getAttribute('sizes') };
        if (l.rel === 'manifest') entry.name = (await res.json()).name;
        else { const bmp = await createImageBitmap(await res.blob()); entry.size = bmp.width + 'x' + bmp.height; }
        out.push(entry);
      }
      return out;
    })()`);
    expect(links.length === 4, `expected 4 icon and manifest links, found ${links.length}`);
    for (const l of links) {
      expect(l.status === 200, `${l.href}: HTTP ${l.status}`);
      if (l.rel === 'manifest') expect(l.name === PRODUCT && l.type.startsWith('application/manifest+json'), `manifest: ${JSON.stringify(l)}`);
      else expect(l.type === 'image/png' && l.size === l.declared, `${l.href}: ${l.type} ${l.size} (declared ${l.declared})`);
    }
  });

  // 1. Auth
  await step('sign-up through the UI: "Check your email", the emailed link confirms the address, then a normal sign-in reaches the dashboard', admin, async () => {
    await signUpThroughUi(admin, owner, true);
    await admin.waitText('Dashboard');
  });
  await step('a business created from a browser on Indian time starts in Asia/Kolkata', admin, async () => {
    const settings = (await admin.api('GET', '/settings')).body.data;
    expect(settings.timezone === 'Asia/Kolkata', `new business time zone ${settings.timezone}`);
  });
  await step('a business created from a browser in London starts in Europe/London (India is not hardcoded)', null, async () => {
    const london = await browser.newPage({ incognito: true, label: 'london' });
    await london.viewport(1280, 860);
    await london.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/London' });
    await signUpThroughUi(london, { name: 'London Owner', email: `london-${RUN}@example.com`, company: `London Org ${RUN}`, password: owner.password });
    const tz = (await london.api('GET', '/settings')).body.data.timezone;
    expect(tz === 'Europe/London', `new business time zone ${tz}`);
  });
  await step('session survives a full page refresh', admin, async () => {
    await admin.reload();
    await admin.waitFor('location.pathname === "/dashboard"');
    await admin.waitText(owner.name);
  });
  await step('logout via the account menu returns to login', admin, async () => {
    await admin.click(`Account menu for ${owner.name}`);
    await admin.click('Sign Out');
    await admin.waitFor('location.pathname === "/login"');
    await admin.goto('/dashboard');
    await admin.waitFor('location.pathname === "/login"');
  });
  await step('forgot password: the same answer for a registered and an unknown address; only the registered one gets an email', admin, async () => {
    await admin.goto('/login');
    await admin.fillSel('#login-email', owner.email);
    await admin.click('Forgot password?', 'a');
    await admin.waitFor('location.pathname === "/forgot-password"');
    expect(await admin.eval(`document.getElementById('forgot-email').value === ${JSON.stringify(owner.email)}`), 'the address typed on the sign-in page was not carried over');
    const unknown = `nobody-${RUN}@example.com`;
    await admin.fillSel('#forgot-email', unknown);
    await admin.clickSel('form button[type=submit]');
    await admin.waitText(GENERIC_EMAIL_REPLY);
    const unknownText = await admin.eval('document.querySelector("main").innerText');
    await admin.click('Use a different email', 'button');
    await admin.fillSel('#forgot-email', owner.email);
    await admin.clickSel('form button[type=submit]');
    await admin.waitText(GENERIC_EMAIL_REPLY);
    const knownText = await admin.eval('document.querySelector("main").innerText');
    expect(knownText === unknownText, 'the page answered differently for a registered address');
    await admin.shot('auth_forgot_sent');
    await emailedLink(owner.email, '/reset-password');
    await sleep(500);
    expect(!mailTo(unknown).length, 'an email was sent to an address without an account');
  });
  await step('reset password from the emailed link: no automatic sign-in, every session ends, the old password stops working, the link works once', null, async () => {
    // Another device, signed in before the reset.
    const device = await browser.newPage({ incognito: true, label: 'other-device' });
    await device.viewport(1280, 860);
    await device.goto('/login');
    await device.fillSel('#login-email', owner.email); await device.fillSel('#login-password', owner.password);
    await device.clickSel('form button[type=submit]');
    await device.waitFor('location.pathname === "/dashboard"');
    const link = await emailedLink(owner.email, '/reset-password');
    await admin.goto(link.path);
    await admin.waitText('Save new password');
    expect(await admin.eval('location.hash === ""'), 'the reset token stayed in the address bar');
    await admin.fillSel('#reset-password', 'Short1'); await admin.fillSel('#reset-confirm', 'Short1');
    await admin.click('Save new password', 'button');
    await admin.waitText('Password must be at least 8 characters');
    const newPassword = 'Browser456';
    await admin.fillSel('#reset-password', newPassword); await admin.fillSel('#reset-confirm', newPassword + 'x');
    await admin.click('Save new password', 'button');
    await admin.waitText('The passwords do not match');
    await admin.shot('auth_reset_form');
    await admin.fillSel('#reset-confirm', newPassword);
    await admin.click('Save new password', 'button');
    await admin.waitText('Your password has been changed');
    expect((await admin.path()) === '/reset-password', 'the reset page navigated away');
    expect((await admin.api('GET', '/auth/me')).status === 401, 'the reset signed the visitor in');
    await admin.shot('auth_reset_done');
    expect((await device.api('GET', '/auth/me')).status === 401, 'a device signed in before the reset is still signed in');
    await device.click('Customers', 'a');
    await device.waitFor('location.pathname === "/login"', 8000);
    expect((await admin.api('POST', '/auth/login', { email: owner.email, password: owner.password })).status === 401, 'the old password still signs in');
    await admin.goto(link.path);
    await admin.waitText('already been used');
    await admin.shot('auth_reset_used');
    owner.password = newPassword; // the sign-ins below use the new password
    await sleep(500);
    expect(mailTo(owner.email).some(m => /password was changed/i.test(m.subject)), 'no password-changed notice was emailed');
  });
  await step('keyboard-only login (Tab through fields, Enter submits)', admin, async () => {
    await admin.goto('/login');
    await admin.eval('document.getElementById("login-email").focus()');
    await admin.send('Input.insertText', { text: owner.email });
    await admin.key('Tab', 'Tab', 9);
    const focused = await admin.eval('document.activeElement && document.activeElement.id');
    expect(focused === 'login-password', `Tab moved focus to "${focused}" instead of the password field`);
    await admin.send('Input.insertText', { text: owner.password });
    await admin.key('Enter', 'Enter', 13);
    await admin.waitFor('location.pathname === "/dashboard"');
  });
  if ((await admin.path()) !== '/dashboard') {
    current = 'fallback login';
    await admin.goto('/login');
    await admin.fillSel('#login-email', owner.email); await admin.fillSel('#login-password', owner.password);
    await admin.clickSel('form button[type=submit]');
    await admin.waitFor('location.pathname === "/dashboard"');
  }

  await step('app shell: WorkeasyBooking in the navigation, help menu and footer; the business name stays in view', admin, async () => {
    await admin.goto('/dashboard'); await admin.waitText('Dashboard');
    await admin.waitFor(`document.getElementById('main-sidebar').innerText.includes(${JSON.stringify(owner.company)})`, 8000);
    await admin.waitFor('[...document.images].every(i => i.complete)');
    const b = await admin.eval('__t.brand()');
    expect(b.logos.length === 1 && b.logos[0].where === 'sidebar' && b.logos[0].label === PRODUCT, `product logos: ${JSON.stringify(b.logos)}`);
    // The sidebar's "Dashboard" link appears before the page itself; its title is set when the page has mounted.
    await admin.waitFor(`document.title === ${JSON.stringify(tabTitle('Dashboard'))}`, 8000).catch(() => {});
    const title = await admin.eval('document.title');
    expect(title === tabTitle('Dashboard'), `tab title "${title}"`);
    expect(!b.broken.length && !b.variants.length, `broken images ${b.broken.join(', ')}; name variants ${b.variants.join(', ')}`);
    const footer = await admin.eval('document.querySelector("[data-brand=app-footer]")?.innerText.replace(/\\s+/g, " ").trim() ?? ""');
    expect(footer.includes(`${PRODUCT} · ${ATTRIBUTION}`) && footer.includes(COPYRIGHT), `footer: "${footer}"`);
    await admin.click('Help and support');
    await admin.waitFor('!!document.querySelector("[data-brand=about]")');
    const about = await admin.eval('document.querySelector("[data-brand=about]").innerText.replace(/\\s+/g, " ").trim()');
    expect(about === `${PRODUCT} ${DESCRIPTION} ${ATTRIBUTION}`, `help menu: "${about}"`);
    await admin.shot('brand_dashboard_help');
    await admin.click('Help and support');
    await admin.click('Collapse sidebar');
    const c = await admin.eval('__t.brand()');
    expect(c.logos.length === 0 && c.marks.some(m => m.where === 'sidebar' && m.label === PRODUCT), `collapsed navigation: logos ${JSON.stringify(c.logos)}, marks ${JSON.stringify(c.marks)}`);
    await admin.shot('brand_sidebar_collapsed');
    await admin.click('Expand sidebar');
    await admin.shotFull('brand_dashboard_full');
  });

  // 2. Business time zone and INR through Settings
  await step('set business time zone (Asia/Kolkata) and currency (INR) in Settings', admin, async () => {
    await admin.goto('/settings');
    await admin.click('Language & Region', 'button');
    await admin.waitFor('__t.byLabel("Currency") && !__t.byLabel("Currency").disabled');
    await admin.selectOption('Timezone', 'Asia/Kolkata');
    await admin.selectOption('Currency', 'INR');
    await admin.click('Save Changes', 'button');
    await admin.waitText('Language & region settings saved');
    await admin.reload();
    await admin.click('Language & Region', 'button');
    await admin.waitFor('__t.byLabel("Currency") && __t.byLabel("Currency").value === "INR" && __t.byLabel("Timezone").value === "Asia/Kolkata"');
  });

  // 3. Service in INR
  await step('create a service priced in INR with Indian digit grouping', admin, async () => {
    await admin.goto('/services/new');
    await admin.waitFor('!!__t.byLabel("Service Name") && __t.byLabel("Currency").value === "INR"', 10000);
    expect(await admin.eval('[...document.querySelectorAll("span,div")].some(e => e.textContent.trim() === "₹")'), 'price field does not show the ₹ symbol');
    await admin.fill('Service Name', names.service);
    await admin.fill('Price', '123456');
    await admin.click('Create Service');
    await admin.waitFor('location.pathname === "/services"');
    await admin.waitText(names.service);
    await admin.waitText('₹1,23,456.00');
    ids.service = (await admin.api('GET', '/services')).body.data.find(s => s.name === names.service)?.id;
    expect(ids.service, 'service not found via API after UI create');
  });

  // 4. Staff onboarding through the visible button
  await step('Staff page offers "Add Staff Member" (no fake invite)', admin, async () => {
    await admin.goto('/staff');
    await admin.waitText('No staff yet');
    expect(!(await admin.hasText('Invite Staff')), 'fake invite button still present');
    await admin.click('Add Staff Member', 'button');
    await admin.waitFor('location.pathname === "/staff/new"');
  });
  await step('create an active, bookable staff member with Saturday hours', admin, async () => {
    await admin.waitFor('!!__t.byLabel("Full Name")');
    await admin.fill('Full Name', names.staff1);
    await admin.fill('Email Address', owner.email);
    await admin.fill('Phone Number', '+91 98765 43210');
    await admin.waitText('Not bookable yet: no services assigned');
    await admin.click(names.service, 'label');
    await admin.click('Works on Sat', 'button');
    await admin.waitText('Bookable online for 1 service');
    await admin.click('Create Staff');
    await admin.waitFor('location.pathname === "/staff"');
    await admin.waitText(names.staff1);
    expect(!(await admin.hasText('Not bookable:')), 'new staff shown as not bookable');
    ids.staff1 = (await admin.api('GET', '/staff')).body.data.find(s => s.name === names.staff1)?.id;
    expect(ids.staff1, 'staff not created');
  });
  await step('staff form rejects a duplicate email and an invalid phone', admin, async () => {
    await admin.goto('/staff/new');
    await admin.waitFor('!!__t.byLabel("Full Name")');
    await admin.fill('Full Name', 'Duplicate Person');
    await admin.fill('Phone Number', 'call me');
    await admin.fill('Email Address', owner.email.toUpperCase());
    await admin.click('Create Staff');
    await admin.waitText('Use digits, spaces, dashes or brackets');
    expect((await admin.path()) === '/staff/new', 'navigated away with invalid phone');
    await admin.fill('Phone Number', '');
    await admin.click('Create Staff');
    await admin.waitText('already exists in your organization');
    expect((await admin.path()) === '/staff/new', 'navigated away after duplicate');
  });
  await step('service detail lists the staff assigned from the staff side', admin, async () => {
    await admin.goto(`/services/${ids.service}`);
    await admin.waitText(names.service);
    await admin.click('Staff', '[role=tab],button');
    await admin.waitText(names.staff1);
  });
  await step('assign a second staff member from the service side; it shows on their profile', admin, async () => {
    await admin.goto('/staff/new');
    await admin.waitFor('!!__t.byLabel("Full Name")');
    await admin.fill('Full Name', names.staff2);
    await admin.fill('Email Address', `ben-${RUN}@example.com`);
    await admin.click('Create Staff');
    await admin.waitFor('location.pathname === "/staff"');
    ids.staff2 = (await admin.api('GET', '/staff')).body.data.find(s => s.name === names.staff2)?.id;
    await admin.goto(`/services/${ids.service}/edit`);
    await admin.waitFor('!!__t.byLabel("Service Name")');
    await admin.click(names.staff2, 'label,button');
    await admin.fill('Service Name', names.service2);
    await admin.click('Save Changes');
    await admin.waitFor(`location.pathname === "/services"`);
    await admin.goto(`/staff/${ids.staff2}`);
    await admin.waitText(names.staff2);
    await admin.click('Services', '[role=tab],button');
    await admin.waitText(names.service2);
  });
  await step('deactivate and reactivate staff from the list; state persists', admin, async () => {
    await admin.goto('/staff');
    await admin.click(`Deactivate ${names.staff2}`, 'button');
    await admin.click('Deactivate', '[role=dialog] button');
    await admin.waitText('Not bookable: inactive');
    await admin.reload();
    await admin.waitText('Not bookable: inactive');
    expect(!(await admin.api('GET', `/staff/${ids.staff2}`)).body.data.isActive, 'server still active');
    await admin.click(`Activate ${names.staff2}`, 'button');
    await admin.waitFor('!document.body.innerText.includes("Not bookable: inactive")');
    expect((await admin.api('GET', `/staff/${ids.staff2}`)).body.data.isActive, 'reactivation not saved');
  });

  // 5. Customer + admin appointment visible everywhere
  const adminDay = dow(bizToday()) === 0 ? addDays(bizToday(), 1) : bizToday(); // staff 1 is off on Sundays
  await step('create a customer and see it in list and detail', admin, async () => {
    await admin.goto('/customers/new');
    await admin.waitFor('!!__t.byLabel("Full Name")');
    await admin.fill('Full Name', names.customer);
    await admin.fill('Email Address', `cora-${RUN}@example.com`);
    await admin.fill('Phone', '+91 98765 40142');
    await admin.click('Create Customer');
    await admin.goto('/customers');
    await admin.waitText(names.customer);
    ids.customer = (await admin.api('GET', '/customers')).body.data.find(c => c.name === names.customer)?.id;
    await admin.goto(`/customers/${ids.customer}`);
    await admin.waitText(`cora-${RUN}@example.com`);
  });
  await step('create an appointment through the New Appointment form (customer is emailed)', admin, async () => {
    await admin.goto('/appointments/new');
    await admin.waitFor('!!__t.byLabel("Service") && __t.byLabel("Service").options.length > 1', 15000);
    await admin.selectOption('Service', names.service2);
    await admin.selectOption('Staff Member', names.staff1);
    await admin.fill('Date', adminDay);
    // Times come from the staff member's real availability once service, staff and date are chosen.
    await admin.waitFor('__t.byLabel("Time Slot").options.length > 1', 10000);
    await admin.selectOption('Time Slot', '10:00');
    await admin.selectOption('Customer', names.customer);
    await admin.click('Create Appointment');
    await admin.waitFor('location.pathname === "/appointments"', 10000);
    await admin.waitText('The customer was sent a confirmation email');
    ids.appt = (await admin.api('GET', `/appointments?customerId=${ids.customer}`)).body.data[0]?.id;
    expect(ids.appt, 'appointment not found after create');
    expect(mailTo(`cora-${RUN}@example.com`).some(m => m.subject.startsWith('Booking confirmed')), 'no confirmation email captured');
  });
  await step('admin booking outside working hours: the form does not offer it and the server refuses it with a clear reason', admin, async () => {
    const day = nextWeekday(2);
    await admin.goto('/appointments/new');
    await admin.waitFor('!!__t.byLabel("Service") && __t.byLabel("Service").options.length > 1', 15000);
    await admin.selectOption('Service', names.service2);
    await admin.selectOption('Staff Member', names.staff1);
    await admin.fill('Date', day);
    await admin.waitFor('__t.byLabel("Time Slot").options.length > 1', 10000);
    const offered = await admin.eval('[...__t.byLabel("Time Slot").options].map(o => o.textContent.trim())');
    // Ada works 9:00-17:00: a 60-minute appointment can start at 4:00 PM at the latest.
    expect(offered.includes('4:00 PM') && !offered.includes('4:30 PM') && !offered.includes('5:30 PM') && !offered.includes('8:30 AM'), `times offered: ${offered.join(', ')}`);
    const refused = await admin.api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff1, customerId: ids.customer, date: day, startTime: '17:30' });
    expect(refused.status === 400 && /outside/.test(refused.body.error), `server answered ${refused.status} ${JSON.stringify(refused.body)}`);
    expect((await admin.path()) === '/appointments/new', 'navigated away');
  });
  await step('appointment appears in Appointments list', admin, async () => {
    await admin.goto('/appointments'); await admin.waitText(names.customer);
  });
  await step('appointment appears in Calendar', admin, async () => {
    await admin.goto('/calendar'); await admin.waitText(names.service2, 15000);
  });
  await step('appointment appears in Customer history', admin, async () => {
    await admin.goto(`/customers/${ids.customer}`); await admin.waitText(names.service2);
  });
  if (adminDay === bizToday()) {
    await step('appointment appears on Dashboard (today)', admin, async () => {
      await admin.goto('/dashboard'); await admin.waitText(names.customer);
    });
    await step('MySpace shows the signed-in staff member\'s schedule', admin, async () => {
      await admin.goto('/my-space'); await admin.waitText(names.customer);
      expect(!(await admin.hasText('No staff profile uses your sign-in email')), 'identity warning shown although staff email matches');
    });
  }
  await step('double-booking the same staff and time: the form no longer offers it and the server rejects it', admin, async () => {
    await admin.goto('/appointments/new');
    await admin.waitFor('!!__t.byLabel("Service") && __t.byLabel("Service").options.length > 1', 15000);
    await admin.selectOption('Service', names.service2);
    await admin.selectOption('Staff Member', names.staff1);
    await admin.fill('Date', adminDay);
    await admin.waitFor('__t.byLabel("Time Slot").options.length > 1', 10000);
    const offered = await admin.eval('[...__t.byLabel("Time Slot").options].map(o => o.textContent.trim())');
    expect(!offered.includes('10:00 AM') && offered.includes('11:00 AM'), `booked 10:00 AM still offered: ${offered.join(', ')}`);
    const clash = await admin.api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff1, customerId: ids.customer, date: adminDay, startTime: '10:00' });
    expect(clash.status === 409 && /no longer available/.test(clash.body.error), `server answered ${clash.status} ${JSON.stringify(clash.body)}`);
    expect((await admin.path()) === '/appointments/new', 'navigated away despite conflict');
  });
  await step('save internal notes on the appointment', admin, async () => {
    await admin.goto(`/appointments/${ids.appt}`);
    await admin.waitText(names.service2);
    const ok = await admin.eval(`(() => { const t = [...document.querySelectorAll('textarea')].find(x => __t.visible(x)); if (!t) return false; t.focus(); __t.setValue(t, 'Bring referral letter'); return true; })()`);
    expect(ok, 'notes textarea missing');
    await admin.click('Save', 'button');
    await admin.reload();
    await admin.waitFor('[...document.querySelectorAll("textarea")].some(t => t.value === "Bring referral letter")');
  });
  const resDate = nextWeekday(3);
  await step('reschedule through the Reschedule page (customer is emailed)', admin, async () => {
    await admin.click('Reschedule');
    await admin.waitFor('location.pathname.endsWith("/reschedule")');
    await admin.fill('New Date', resDate);
    // The times offered are the server's free times for that date; wait for them before choosing one.
    await admin.waitFor('[...document.querySelectorAll("select.input-field option")].some(o => o.value === "11:00")', 10000);
    await admin.fillSel('select.input-field', '11:00');
    await admin.click('Confirm Reschedule');
    await admin.waitFor(`location.pathname === "/appointments/${ids.appt}"`);
    const a = await admin.api('GET', `/appointments/${ids.appt}`);
    expect(a.body.data.date === resDate && a.body.data.startTime === '11:00', `server has ${a.body.data.date} ${a.body.data.startTime}`);
    expect(mailTo(`cora-${RUN}@example.com`).some(m => m.subject.startsWith('Booking rescheduled')), 'no reschedule email captured');
  });
  await step('cancel the appointment; status and email history show everywhere', admin, async () => {
    await admin.goto(`/appointments/${ids.appt}`);
    await admin.waitText(names.service2);
    await admin.click('Cancel', 'button');
    await admin.click('Cancel Appointment', '[role=dialog] button');
    await admin.waitText('Cancelled');
    await admin.waitText('Customer Emails');
    await admin.waitFor('document.body.innerText.split("Cancellation").length > 1');
    await admin.goto(`/customers/${ids.customer}`); await admin.waitText('Cancelled');
  });

  // 6. Booking rules change public availability
  // 7. Booking page
  await step('create and publish a booking page with a required custom question', admin, async () => {
    await admin.goto('/booking-pages/new');
    await admin.click('Branding', '[role=tab],button');
    await admin.fill('Page Title', names.page);
    await admin.click('Page Setup', '[role=tab],button');
    await admin.click(names.service2, 'label');
    await admin.click('Form Fields', '[role=tab],button');
    await admin.click('Add Question');
    await admin.fill('Field Label', 'Reason for visit', '[role=dialog]');
    await admin.eval(`(() => { const d = document.querySelector('[role=dialog]'); const row = [...d.querySelectorAll('p')].find(p => p.textContent.trim() === 'Required'); row.parentElement.querySelector('button').click(); })()`);
    await admin.click('Add Field', '[role=dialog] button');
    await admin.click('Create & Publish');
    await admin.waitFor('/^\\/booking-pages\\/bp-/.test(location.pathname)', 10000);
    const p = (await admin.api('GET', '/booking-pages')).body.data.find(x => x.title === names.page);
    expect(p?.isPublished && p.formFields.length === 1 && p.formFields[0].required, 'page not published with required question');
    ids.slug = p.slug;
  });
  // Runs after publishing: only services on a published page have public availability.
  await step('booking rules save, reload with the same values, and change public availability', admin, async () => {
    await admin.goto('/settings');
    await admin.click('Booking Rules', 'button,a,[role=tab]');
    await admin.waitFor('!!__t.byLabel("Minimum booking notice")');
    await admin.fill('Minimum booking notice', '48');
    await admin.click('Save Changes', 'button');
    await admin.waitText('Booking rules saved');
    await admin.reload();
    await admin.click('Booking Rules', 'button,a,[role=tab]');
    await admin.waitFor('__t.byLabel("Minimum booking notice") && __t.byLabel("Minimum booking notice").value === "48"');
    const tomorrow = addDays(bizToday(), 1);
    const res = await admin.api('GET', `/public/availability/days?serviceId=${ids.service}&staffId=${ids.staff1}&from=${tomorrow}&to=${tomorrow}`);
    const blocked = res.body.data?.[0]?.available === false;
    // Restore the rule before asserting, so a failure here cannot skew the public booking steps that follow.
    await admin.fill('Minimum booking notice', '0');
    await admin.click('Save Changes', 'button');
    await admin.waitText('Booking rules saved');
    expect(blocked, `tomorrow still bookable with 48h notice (HTTP ${res.status})`);
  });


  // 8. Public booking in a private window
  const pub = await browser.newPage({ incognito: true, label: 'public' });
  await pub.viewport(1280, 860);
  const bookDate = nextWeekday(4);
  const sat = nextDow(6, 2);
  const sun = nextDow(0, 2);
  await step('public page shows the INR price and that online payment is not available', pub, async () => {
    await pub.goto(`/book/${ids.slug}`);
    await pub.waitText(names.page);
    const cookies = (await pub.send('Network.getCookies', { urls: [ORIGIN] })).cookies;
    expect(cookies.length === 0, 'private window unexpectedly has cookies');
    await pub.waitText('₹1,23,456.00');
  });
  await step("a business's booking page leads with the business; the platform is only a small credit at the bottom", pub, async () => {
    await pub.waitFor('[...document.images].every(i => i.complete)');
    const b = await pub.eval('__t.brand()');
    expect(b.logos.length === 0, `platform logo on the business's page: ${JSON.stringify(b.logos)}`);
    const h1 = await pub.eval('document.querySelector("h1").textContent.trim()');
    expect(h1 === names.page && b.text.includes(owner.company), `heading "${h1}"; business name shown: ${b.text.includes(owner.company)}`);
    const credit = await pub.eval('document.querySelector("[data-brand=powered-by]")?.innerText.trim()');
    expect(credit === POWERED_BY, `credit "${credit}"`);
    expect(b.text.indexOf(owner.company) < b.text.indexOf(POWERED_BY), 'the platform credit comes before the business');
    expect(b.title === `${names.page} · ${owner.company} — ${PRODUCT}`, `tab title "${b.title}"`);
    expect(!b.broken.length && !b.variants.length, `broken images ${b.broken.join(', ')}; name variants ${b.variants.join(', ')}`);
    await pub.shotFull('brand_public_wizard');
  });
  await step('calendar enables Saturday (scheduled) and disables Sunday (day off) for the chosen staff member', pub, async () => {
    await pub.click(names.service2);
    await pub.click('Continue');
    await pub.waitText(names.staff1);
    await pub.click(names.staff1, 'button');
    await pub.click('Continue');
    await waitCalendar(pub);
    await pub.waitText('business time zone (Asia/Kolkata)');
    await showMonthWith(pub, sat);
    expect(await pub.eval(`document.querySelector('[data-date="${sat}"]').dataset.available === 'true'`), `Saturday ${sat} not bookable`);
    await showMonthWith(pub, sun);
    expect(await pub.eval(`document.querySelector('[data-date="${sun}"]').disabled`), `Sunday ${sun} selectable`);
    const yesterday = addDays(bizToday(), -1);
    if (yesterday.slice(0, 7) === bizToday().slice(0, 7)) {
      await showMonthWith(pub, yesterday);
      expect(await pub.eval(`document.querySelector('[data-date="${yesterday}"]').disabled`), 'yesterday selectable');
    }
  });
  await step('book with the chosen staff: time range, answer and real confirmation email', pub, async () => {
    await showMonthWith(pub, bookDate);
    await pub.clickSel(`[data-date="${bookDate}"]`);
    await pub.click('Continue');
    await pub.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "10:00 AM" && !b.disabled)', 10000);
    await pub.click('10:00 AM');
    await pub.click('Continue');
    await pub.fill('Full Name', petra.name); await pub.fill('Email Address', petra.email);
    await pub.fill('Phone Number', '+91 98765 40177');
    expect(await pub.eval('[...document.querySelectorAll("button")].find(b => b.textContent.includes("Continue")).disabled'), 'Continue enabled although the required question is empty');
    await pub.fill('Reason for visit', 'Knee pain');
    await pub.click('Continue');
    await pub.waitText('Knee pain');
    await pub.waitText('10:00 AM – 11:00 AM');
    await pub.click('Book Now');
    await pub.waitFor('location.pathname.endsWith("/confirmation")', 15000);
    // The page arrives just after the address changes: wait for the reference itself before reading it.
    await pub.waitFor('/WE-[A-Z0-9_-]{8}/.test(document.body.innerText)', 15000);
    ids.ref = await pub.eval('(document.body.innerText.match(/WE-[A-Z0-9_-]{8}/) || [])[0]');
    expect(ids.ref, 'no booking reference on confirmation');
    await pub.waitText(`We sent a confirmation email to ${petra.email}`);
    const m = mailTo(petra.email).find(x => x.subject.includes(ids.ref));
    expect(m && m.subject.startsWith('Booking confirmed'), 'confirmation email not received by the SMTP catcher');
    expect(m.body.includes('10:00 AM–11:00 AM') && m.body.includes('Asia/Kolkata'), 'email missing time or time zone');
    // The manage link carries a signed token, never just the reference.
    ids.manageLink = (m.body.match(/https?:\/\/[^\s"<>]+\/book\/lookup\/manage#token=[\w.%-]+/) || [])[0];
    expect(ids.manageLink && !m.body.includes(`manage?ref=${ids.ref}`), 'email has no signed manage link');
  });
  await step('confirmation page and email lead with the business and carry the product credit', pub, async () => {
    const m = mailTo(petra.email).find(x => x.subject.includes(ids.ref) && x.subject.startsWith('Booking confirmed'));
    expect(m, 'confirmation email missing');
    const html = htmlPart(m.body);
    emailRenders.confirmation = html;
    expect(await pub.eval('location.pathname.endsWith("/confirmation")'), 'not on the confirmation page');
    const identity = await pub.eval('document.querySelector("[data-business-name]")?.textContent.trim()');
    expect(identity === owner.company, `business identity "${identity}"`);
    await pub.waitText(`Your appointment with ${owner.company} has been scheduled.`);
    const b = await pub.eval('__t.brand()');
    expect(b.logos.length === 0 && b.text.includes(POWERED_BY), 'platform branding is not limited to the footer credit');
    expect(b.title === `Booking confirmed · ${owner.company} — ${PRODUCT}`, `tab title "${b.title}"`);
    await pub.shotFull('brand_confirmation');
    expect(m.body.includes(`Sent by ${PRODUCT} on behalf of ${owner.company}.`) && m.body.includes(`${PRODUCT} · ${ATTRIBUTION}`), 'email footer missing');
    expect(html && /<span[^>]*font-weight:700[^>]*>WorkeasyBooking<\/span>/.test(html) && !/WorkEasy360 Booking/i.test(html), 'email has no WorkeasyBooking header');
    expect(html.includes(`>${owner.company}</div>`), 'email does not open with the business name');
  });
  await step('the same slot is no longer offered for that staff member', pub, async () => {
    await pub.goto(`/book/${ids.slug}`);
    await pub.click(names.service2); await pub.click('Continue');
    await pub.click(names.staff1, 'button'); await pub.click('Continue');
    await waitCalendar(pub);
    await showMonthWith(pub, bookDate);
    await pub.clickSel(`[data-date="${bookDate}"]`);
    await pub.click('Continue');
    await pub.waitFor('document.querySelector("button[aria-label^=\\"10:00 AM\\"]")', 10000);
    expect(await pub.eval('document.querySelector("button[aria-label^=\\"10:00 AM\\"]").disabled'), '10:00 AM still selectable');
  });
  await step('server rejects a direct conflicting booking for the same staff and time', pub, async () => {
    const page = (await admin.api('GET', '/booking-pages')).body.data.find(p => p.slug === ids.slug);
    const r = await pub.api('POST', '/public/book', { pageSlug: ids.slug, serviceId: ids.service, staffId: ids.staff1, date: bookDate, startTime: '10:00',
      customer: { name: 'Second Try', email: `second-${RUN}@example.com`, phone: '+91 98765 40101' }, customerAnswers: page.formFields.map(f => ({ fieldId: f.id, answer: 'x' })) });
    expect(r.status === 409, `double booking returned ${r.status}`);
  });
  await step('admin sees the public booking: reference, status, times, customer, answer and email', admin, async () => {
    await admin.goto('/appointments');
    await admin.waitText(petra.name);
    const row = (await admin.api('GET', `/appointments?q=${ids.ref}`)).body.data[0];
    expect(row.status === 'scheduled' && row.startTime === '10:00' && row.endTime === '11:00' && row.staffId === ids.staff1 && row.currency === 'INR', JSON.stringify(row));
    ids.publicAppt = row.id;
    await admin.goto(`/appointments/${row.id}`);
    await admin.waitText(ids.ref);
    await admin.waitText('Knee pain');
    await admin.waitText('Scheduled');
    await admin.waitFor('document.body.innerText.includes("Confirmation") && document.body.innerText.includes("Sent")');
    await admin.goto('/customers');
    await admin.waitText(petra.name);
  });
  await step('public booking appears in the admin calendar (month view)', admin, async () => {
    await admin.goto('/calendar');
    await admin.click('Month', 'button');
    const title = `${names.service2} — ${petra.name}`;
    for (let i = 0; i < 3 && !(await admin.hasText(title)); i++) { await admin.click('Next', 'button'); await sleep(400); }
    await admin.waitText(title);
  });
  await step('a booking reference alone shows nothing; reference + booking email unlocks it', pub, async () => {
    await pub.goto('/book');
    await pub.fill('Already booked?', ids.ref);
    await pub.click('Find');
    await pub.waitFor('!!__t.byLabel("Email address")');
    expect(await pub.eval('__t.byLabel("Booking reference").value') === ids.ref, 'reference not carried over');
    const leaked = await pub.eval(`[${JSON.stringify(names.service2)}, ${JSON.stringify(petra.name)}, ${JSON.stringify(petra.email)}].filter(s => document.body.innerText.includes(s))`);
    expect(!leaked.length, `reference alone revealed: ${leaked.join(', ')}`);
    await pub.fill('Email address', `not-${petra.email}`);
    await pub.click('Find my booking');
    await pub.waitText("We couldn't find a booking with that reference and email address.");
    await pub.fill('Email address', petra.email.toUpperCase());
    await pub.click('Find my booking');
    await pub.waitText(names.service2);
    await pub.waitText('Cancel Booking');
    expect(!(await pub.hasText(petra.name)), 'customer name shown on the public manage page');
  });
  await step('manage from the email link: reschedule then cancel, with emails', pub, async () => {
    await pub.eval('sessionStorage.clear()');
    expect(ids.manageLink, 'no manage link captured from the confirmation email');
    await pub.gotoUrl(ids.manageLink);
    await pub.waitText(names.service2);
    expect(!(await pub.eval('location.href.includes("token=")')), 'token left in the address bar');
    await pub.reload();
    await pub.waitText(names.service2); // the tab keeps access after a reload
    seen.manageDetails = await identityOf(pub);
    await pub.shotFull('brand_manage_details');
    await pub.click('Reschedule');
    await waitCalendar(pub);
    seen.manageReschedule = await identityOf(pub);
    const newDate = nextWeekday(6);
    await showMonthWith(pub, newDate);
    await pub.clickSel(`[data-date="${newDate}"]`);
    await pub.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "2:00 PM" && !b.disabled)', 10000);
    await pub.click('2:00 PM');
    await pub.click('Confirm Reschedule');
    await pub.waitText('Cancel Booking', 10000);
    await pub.waitText('2:00 PM – 3:00 PM');
    const after = (await admin.api('GET', `/appointments?q=${ids.ref}`)).body.data[0];
    expect(after.date === newDate && after.startTime === '14:00' && after.endTime === '15:00', `admin sees ${after.date} ${after.startTime}-${after.endTime}`);
    expect(mailTo(petra.email).some(m => m.subject.startsWith('Booking rescheduled')), 'no reschedule email');
    await pub.click('Cancel Booking');
    await pub.click('Yes, cancel booking', '[role=dialog] button');
    await pub.waitText('Booking Cancelled');
    seen.manageCancelled = await identityOf(pub);
    await pub.shotFull('brand_manage_cancelled');
    expect((await admin.api('GET', `/appointments?q=${ids.ref}`)).body.data[0].status === 'cancelled', 'admin does not see cancellation');
    expect(mailTo(petra.email).some(m => m.subject.startsWith('Booking cancelled')), 'no cancellation email');
  });
  await step('manage, reschedule and cancelled pages lead with the business; those emails carry the product credit', pub, async () => {
    const cancelled = mailTo(petra.email).find(x => x.subject.startsWith('Booking cancelled'));
    emailRenders.cancellation = cancelled && htmlPart(cancelled.body);
    for (const [view, page] of [['manageDetails', 'Your booking'], ['manageReschedule', 'Reschedule your booking'], ['manageCancelled', 'Booking cancelled']]) {
      const s = seen[view];
      expect(s, `${view} was not reached`);
      expect(s.identity === owner.company && s.credit === POWERED_BY && s.logos === 0, `${view}: ${JSON.stringify(s)}`);
      expect(s.title === `${page} · ${owner.company} — ${PRODUCT}`, `${view}: tab title "${s.title}"`);
    }
    for (const kind of ['Booking rescheduled', 'Booking cancelled']) {
      const m = mailTo(petra.email).find(x => x.subject.startsWith(kind));
      expect(m && m.body.includes(`Sent by ${PRODUCT} on behalf of ${owner.company}.`) && m.body.includes(`${PRODUCT} · ${ATTRIBUTION}`), `${kind} email lacks the product credit`);
    }
  });

  await step('"Any available staff": the customer books without choosing a person and the server assigns a free one', pub, async () => {
    await pub.goto(`/book/${ids.slug}`);
    await pub.click(names.service2); await pub.click('Continue');
    await pub.waitText('Any available staff');
    await pub.click('Any available staff', 'button');
    await pub.click('Continue');
    await waitCalendar(pub);
    expect(!(await pub.hasText('are required')), 'the availability request was refused');
    const d = nextWeekday(9);
    await showMonthWith(pub, d);
    expect(await pub.eval(`document.querySelector('[data-date="${d}"]').dataset.available === 'true'`), `${d} not bookable with any staff`);
    await pub.clickSel(`[data-date="${d}"]`);
    await pub.click('Continue');
    await pub.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "3:00 PM" && !b.disabled)', 10000);
    await pub.click('3:00 PM'); await pub.click('Continue');
    await pub.fill('Full Name', 'Ana Any'); await pub.fill('Email Address', `ana-any-${RUN}@example.com`);
    await pub.fill('Phone Number', '+91 98765 40199'); await pub.fill('Reason for visit', 'Any staff check');
    await pub.click('Continue');
    await pub.click('Book Now');
    await pub.waitFor('location.pathname.endsWith("/confirmation")', 15000);
    // The page arrives just after the address changes: wait for the reference itself before reading it.
    await pub.waitFor('/WE-[A-Z0-9_-]{8}/.test(document.body.innerText)', 15000);
    const ref = await pub.eval('(document.body.innerText.match(/WE-[A-Z0-9_-]{8}/) || [])[0]');
    const found = await admin.api('GET', `/appointments?q=${ref}`);
    const row = found.body.data?.[0];
    expect(row && [ids.staff1, ids.staff2].includes(row.staffId) && row.date === d && row.startTime === '15:00',
      `booked: ${JSON.stringify(row)}; reference "${ref}", lookup HTTP ${found.status}, ${found.body.data?.length ?? 'no'} row(s)`);
    expect(mailTo(`ana-any-${RUN}@example.com`).some(m => m.subject.startsWith('Booking confirmed')), 'no confirmation email');
  });
  await step('SMS and WhatsApp with the development stand-in: set up, the customer agrees on the booking page, history and calendar are accurate', pub, async () => {
    try {
      await admin.goto('/integrations'); await admin.waitText('Text messages and WhatsApp');
      await admin.waitFor('!!document.querySelector("[data-provider-mode=mock]")', 8000);
      for (const ch of ['sms', 'whatsapp']) {
        await admin.click('Use the development stand-in', 'button', `[data-messaging="${ch}"]`);
        await admin.waitFor(`document.querySelector('[data-messaging="${ch}"]').innerText.includes('Connected (development stand-in)')`, 8000);
      }
      await admin.fill('Test number (development stand-in: nothing is sent)', '+91 98765 40111', '[data-messaging="sms"]');
      await admin.click('Send a test to the stand-in', 'button', '[data-messaging="sms"]');
      await admin.waitText('Accepted by the development stand-in (nothing was sent)');
      await admin.goto('/notifications'); await admin.waitText('Who gets what');
      for (const rule of ['confirmed:customer:sms', 'confirmed:customer:whatsapp']) {
        await admin.clickSel(`[data-rule="${rule}"]`);
        await admin.waitFor(`document.querySelector('[data-rule="${rule}"]').checked`, 8000);
      }
      await admin.reload();
      await admin.waitFor('document.querySelector(\'[data-rule="confirmed:customer:sms"]\')?.checked === true', 8000);
      expect(await admin.eval('document.querySelector(\'[data-rule="confirmed:customer:email"]\').disabled'), 'the customer booking email can be switched off');

      // Book; the form asks for consent (nothing ticked for the customer); agree to SMS only.
      await pub.goto(`/book/${ids.slug}`);
      await pub.click(names.service2); await pub.click('Continue');
      await pub.waitText('Any available staff');
      await pub.click('Any available staff', 'button'); await pub.click('Continue');
      await waitCalendar(pub);
      const d = nextWeekday(15); // a day and time no other step books
      await showMonthWith(pub, d);
      await pub.clickSel(`[data-date="${d}"]`);
      await pub.click('Continue');
      await pub.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "2:00 PM" && !b.disabled)', 10000);
      await pub.click('2:00 PM'); await pub.click('Continue');
      await pub.fill('Full Name', 'Sita Sms'); await pub.fill('Email Address', `sita-sms-${RUN}@example.com`);
      await pub.fill('Phone Number', '+91 98765 40188'); await pub.fill('Reason for visit', 'Consent check');
      await pub.waitFor('!!document.querySelector("#bw-consent-sms") && !!document.querySelector("#bw-consent-whatsapp")', 8000);
      expect(await pub.eval('!document.querySelector("#bw-consent-sms").checked && !document.querySelector("#bw-consent-whatsapp").checked'), 'consent was ticked for the customer');
      await pub.clickSel('#bw-consent-sms');
      await pub.click('Continue');
      await pub.click('Book Now');
      await pub.waitFor('location.pathname.endsWith("/confirmation")', 15000);
      await pub.waitFor('/WE-[A-Z0-9_-]{8}/.test(document.body.innerText)', 15000);
      const ref = await pub.eval('(document.body.innerText.match(/WE-[A-Z0-9_-]{8}/) || [])[0]');
      await pub.waitFor('!!document.querySelector("[data-message-status=sms]")', 8000);
      const note = await pub.eval('document.querySelector("[data-message-status=sms]").innerText');
      expect(/text message/.test(note) && !/could not/.test(note), `SMS note: "${note}"`);
      expect(await pub.eval('!document.querySelector("[data-message-status=whatsapp]")'), 'a WhatsApp note for a customer who did not agree');
      const google = await pub.eval('document.querySelector("[data-calendar=google]").href');
      expect(google.startsWith('https://calendar.google.com/calendar/render?') && /dates=\d{8}T\d{6}Z%2F\d{8}T\d{6}Z/.test(google), `Google link: ${google.slice(0, 120)}`);
      expect(await pub.eval('document.querySelector("[data-calendar=outlook]").href.startsWith("https://outlook.live.com/calendar/0/deeplink/compose?")'), 'no Outlook link');
      await pub.clickSel('[data-calendar=ics]');
      await sleep(1500);
      expect(await pub.eval('!document.querySelector("[data-add-to-calendar] [role=status]")'), 'the calendar file could not be downloaded');
      expect(!(await pub.hasText('not yet connected')), 'the old "not yet connected" calendar message is still shown');

      // The appointment shows what happened per channel, and the customer's agreement is recorded.
      const row = (await admin.api('GET', `/appointments?q=${ref}`)).body.data?.[0];
      expect(row, `booking ${ref} not found`);
      await admin.goto(`/appointments/${row.id}`);
      await admin.waitFor('!!document.querySelector(\'[data-job="confirmed:customer:sms"]\')', 10000);
      for (let i = 0; i < 20 && (await admin.eval('document.querySelector(\'[data-job="confirmed:customer:sms"]\').dataset.jobStatus')) !== 'sent'; i++) { await sleep(500); await admin.reload(); await admin.waitFor('!!document.querySelector(\'[data-job="confirmed:customer:sms"]\')', 10000); }
      const sms = await admin.eval('document.querySelector(\'[data-job="confirmed:customer:sms"]\').innerText');
      expect(sms.includes('Sent (accepted by provider) (development stand-in)'), `SMS history: ${sms}`);
      const wa = await admin.eval('document.querySelector(\'[data-job="confirmed:customer:whatsapp"]\')?.innerText ?? ""');
      expect(wa.includes('Not sent') && /not agreed/.test(wa), `WhatsApp history: ${wa}`);
      await admin.goto(`/customers/${row.customerId}`);
      await admin.waitFor('!!document.querySelector("[data-consent-channel=sms]")', 10000);
      expect(await admin.eval('document.querySelector("[data-consent-channel=sms]").innerText.includes("Agreed")'), 'SMS consent not shown as agreed');
      expect(await admin.eval('document.querySelector("[data-consent-channel=whatsapp]").innerText.includes("Not asked yet") || document.querySelector("[data-consent-channel=whatsapp]").innerText.includes("Withdrawn")'), 'WhatsApp consent shown as agreed');
    } finally {
      await admin.api('PUT', '/notifications/settings/rules', { rules: [
        { event: 'confirmed', role: 'customer', channel: 'sms', enabled: false }, { event: 'confirmed', role: 'customer', channel: 'whatsapp', enabled: false }] });
      for (const ch of ['sms', 'whatsapp']) await admin.api('DELETE', `/notifications/connections/${ch}`);
    }
  });
  await step('a service with no staff is not offered: the page shows its existing empty state and never asks for availability', pub, async () => {
    const svc = await admin.api('POST', '/services', { name: `No Staff ${RUN}`, category: 'consultation', duration: 30, price: 100, maxAdvance: 60 });
    expect(svc.status === 201, `service not created (${svc.status})`);
    const slug = `no-staff-${RUN}`;
    const page = await admin.api('POST', '/booking-pages', { title: `No Staff Page ${RUN}`, slug, serviceIds: [svc.body.data.id], isPublished: true });
    expect(page.status === 201, `page not published (${page.status} ${JSON.stringify(page.body)})`);
    const requested = [];
    const stop = pub.on('Network.requestWillBeSent', p => { if (/\/api\/public\/(availability|services)/.test(p.request.url)) requested.push(p.request.url); });
    try {
      await pub.goto(`/book/${slug}`);
      await pub.waitText('No services available on this booking page.');
      expect(!(await pub.hasText(`No Staff ${RUN}`)), 'a service without staff is offered');
      expect(await pub.eval('[...document.querySelectorAll("button")].find(b => b.textContent.includes("Continue")).disabled'), 'Continue is enabled without a service');
      expect(!(await pub.hasText('are required')), 'the missing-parameter error is shown');
      expect(!requested.length, `availability or staff was requested: ${requested.join(' ')}`);
    } finally { stop(); }
  });
  await step("a business's own booking-page branding is kept: colour, heading and footer text, through to the confirmation", pub, async () => {
    const page = (await admin.api('GET', '/booking-pages')).body.data.find(p => p.slug === ids.slug);
    const original = page.theme ?? {};
    const heading = `Glow Studio ${RUN}`, footerText = `Thank you for choosing Glow Studio ${RUN}`, purple = 'rgb(124, 58, 237)';
    const put = await admin.api('PUT', `/booking-pages/${page.id}`, { theme: { ...original, primaryColor: '#7C3AED', headerText: heading, footerText, showLogo: true } });
    expect(put.status === 200, `could not save the booking page theme (HTTP ${put.status})`);
    try {
      await pub.goto(`/book/${ids.slug}`);
      await pub.waitText(footerText);
      const h1 = await pub.eval('document.querySelector("h1").textContent.trim()');
      expect(h1 === heading, `heading "${h1}"`);
      const monogram = await pub.eval('getComputedStyle(document.querySelector(".booking-theme [aria-hidden=true].bg-primary")).backgroundColor');
      expect(monogram === purple, `business colour not applied (${monogram})`);
      const b = await pub.eval('__t.brand()');
      expect(b.logos.length === 0 && b.text.includes(POWERED_BY), 'platform branding competes with the business');
      expect(b.text.indexOf(footerText) < b.text.indexOf(POWERED_BY), "the platform credit comes before the business's own footer");
      expect(b.title === `${heading} · ${owner.company} — ${PRODUCT}`, `tab title "${b.title}"`);
      await pub.shotFull('brand_public_business_theme');
      // Book once more: the confirmation keeps the business's name and colour.
      await pub.click(names.service2); await pub.click('Continue');
      await pub.click(names.staff1, 'button'); await pub.click('Continue');
      await waitCalendar(pub);
      const d = nextWeekday(11);
      await showMonthWith(pub, d);
      await pub.clickSel(`[data-date="${d}"]`);
      await pub.click('Continue');
      await pub.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "11:00 AM" && !b.disabled)', 10000);
      await pub.click('11:00 AM'); await pub.click('Continue');
      await pub.fill('Full Name', 'Theo Theme'); await pub.fill('Email Address', `theo-${RUN}@example.com`);
      await pub.fill('Phone Number', '+91 98765 40188'); await pub.fill('Reason for visit', 'Branding check');
      await pub.click('Continue');
      await pub.click('Book Now');
      await pub.waitFor('location.pathname.endsWith("/confirmation")', 15000);
      // The page arrives just after the address changes: wait for the reference itself before reading it.
      await pub.waitFor('/WE-[A-Z0-9_-]{8}/.test(document.body.innerText)', 15000);
      // The confirmation page is loaded on demand: wait for its content, not just the address, before reading styles.
      await pub.waitFor('!!document.querySelector("[data-business-identity] .bg-primary") && [...document.querySelectorAll(".bg-primary")].some(e => e.textContent.includes("Booking Reference"))', 15000);
      const conf = await pub.eval(`({ identity: document.querySelector('[data-business-name]')?.textContent.trim(),
        monogram: getComputedStyle(document.querySelector('[data-business-identity] .bg-primary')).backgroundColor,
        reference: getComputedStyle([...document.querySelectorAll('.bg-primary')].find(e => e.textContent.includes('Booking Reference'))).backgroundColor })`);
      expect(conf.identity === owner.company && conf.monogram === purple && conf.reference === purple, `confirmation: ${JSON.stringify(conf)}`);
      await pub.shotFull('brand_confirmation_business_theme');
      // The same confirmation on a phone: nothing wider than the screen, footer included.
      await pub.viewport(375, 812, true);
      await sleep(400);
      const o = await pub.eval('__t.overflow()');
      expect(!o.length, `confirmation at 375px: ${o.join('; ')}`);
      await pub.shotFull('mobile_public_confirmation');
    } finally {
      await pub.viewport(1280, 860);
      await admin.api('PUT', `/booking-pages/${page.id}`, { theme: original });
    }
  });
  await step('booking-page layouts: Classic, Modern and Minimal each render differently and still lead to the details step', pub, async () => {
    const page = (await admin.api('GET', '/booking-pages')).body.data.find(p => p.slug === ids.slug);
    const original = page.theme ?? {};
    const seen = {};
    try {
      for (const layout of ['classic', 'modern', 'minimal']) {
        const put = await admin.api('PUT', `/booking-pages/${page.id}`, { theme: { ...original, layout, showLogo: true } });
        expect(put.status === 200, `could not save layout ${layout} (HTTP ${put.status})`);
        await pub.goto(`/book/${ids.slug}`);
        await pub.waitFor(`document.querySelector('[data-layout="${layout}"]')`, 10000);
        seen[layout] = await pub.eval(`(() => {
          const root = document.querySelector('[data-layout]');
          const h1 = root.querySelector('h1');
          return {
            progressbar: !!root.querySelector('[role="progressbar"]'),
            stepText: /Step 1 of 6/.test(root.innerText),
            circles: [...root.querySelectorAll('div')].some(d => d.className.includes('rounded-full') && d.innerText.trim() === '2'),
            mark: !!root.querySelector('img[aria-hidden="true"], div[aria-hidden="true"].rounded-xl'),
            centred: getComputedStyle(h1.parentElement.parentElement).textAlign === 'center',
            title: getComputedStyle(h1).fontSize,
            overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        })()`);
      }
      const c = seen.classic, m = seen.modern, n = seen.minimal;
      expect(c.circles && !c.progressbar && c.mark && !c.centred, `classic: ${JSON.stringify(c)}`);
      expect(m.progressbar && m.mark && m.centred && m.title !== c.title, `modern: ${JSON.stringify(m)}`);
      expect(n.stepText && !n.progressbar && !n.circles && !n.mark, `minimal: ${JSON.stringify(n)}`);
      expect(![c, m, n].some(x => x.overflow), 'a layout overflows the page');
      // The same booking flow in a non-default layout: choose the service and reach the next step.
      await pub.waitFor(`[...document.querySelectorAll('[data-layout="minimal"] button')].some(b => b.innerText.includes('Continue'))`);
      await pub.eval(`[...document.querySelectorAll('[data-layout="minimal"] button')].find(b => b.innerText.includes('Browser Consult'))?.click()`);
      await pub.eval(`[...document.querySelectorAll('button')].find(b => b.innerText.includes('Continue') && !b.disabled)?.click()`);
      await pub.waitFor(`/Step [2-3] of 6/.test(document.body.innerText)`, 8000);
    } finally {
      await admin.api('PUT', `/booking-pages/${page.id}`, { theme: original });
    }
  });
  await step('the /book entry page and unknown addresses carry the product name (they belong to no business)', pub, async () => {
    await pub.goto('/book');
    await pub.waitFor('[...document.images].every(i => i.complete)');
    let b = await pub.eval('__t.brand()');
    expect(b.logos.length === 1 && b.text.includes(DESCRIPTION) && b.text.includes(ATTRIBUTION) && b.text.includes(COPYRIGHT) && !b.text.includes(POWERED_BY), `/book: logos ${JSON.stringify(b.logos)}`);
    expect(b.title === tabTitle('Book an appointment'), `/book tab title "${b.title}"`);
    await pub.shotFull('brand_book_entry');
    await pub.goto(`/no-such-page-${RUN}`);
    await pub.waitText('Page not found');
    await pub.waitFor('[...document.images].every(i => i.complete)');
    b = await pub.eval('__t.brand()');
    expect(b.logos.length === 1 && b.text.includes(ATTRIBUTION), '404 page lacks the product identity');
    expect(b.title === tabTitle('Page not found'), `404 tab title "${b.title}"`);
    expect(!b.broken.length && !b.variants.length, `broken images ${b.broken.join(', ')}; name variants ${b.variants.join(', ')}`);
    await pub.shot('brand_404');
  });

  // 9. Resources and workspaces
  await step('resource create → edit → refresh → delete', admin, async () => {
    await admin.goto('/resources/new');
    await admin.waitFor('!!__t.byLabel("Resource Name")');
    await admin.fill('Resource Name', names.resource);
    await admin.selectOption('Type', 'Table');
    await admin.fill('Capacity', '4');
    await admin.click('Create Resource');
    await admin.waitFor('location.pathname === "/resources"');
    await admin.waitText(names.resource);
    const id = (await admin.api('GET', '/resources')).body.data.find(r => r.name === names.resource).id;
    await admin.goto(`/resources/${id}/edit`);
    await admin.waitFor('__t.byLabel("Capacity") && __t.byLabel("Capacity").value === "4"');
    await admin.fill('Capacity', '6');
    await admin.click('Save Changes');
    await admin.goto(`/resources/${id}`); await admin.reload();
    await admin.waitText('6 bookings at a time');
    await admin.click('Delete', 'button');
    await admin.click('Delete Resource', '[role=dialog] button');
    await admin.waitFor('location.pathname === "/resources"');
    expect((await admin.api('GET', `/resources/${id}`)).status === 404, 'resource still exists');
  });
  await step('workspace create → choose its services → edit → sidebar link → delete', admin, async () => {
    await admin.goto('/workspaces/new');
    await admin.waitFor('!!__t.byLabel("Workspace Name")');
    await admin.fill('Workspace Name', names.workspace);
    await admin.click('Create Workspace');
    await admin.waitFor('location.pathname === "/workspaces"');
    await admin.waitText(names.workspace);
    const id = (await admin.api('GET', '/workspaces')).body.data.find(w => w.name === names.workspace).id;
    await admin.goto(`/workspaces/${id}/edit`);
    await admin.waitFor(`__t.byLabel("Workspace Name") && __t.byLabel("Workspace Name").value === ${JSON.stringify(names.workspace)}`);
    await admin.fill('Description', 'Edited in browser');
    // The services offered here can be chosen (a new workspace used to show "0 services" with no way to change it).
    await admin.waitFor(`[...document.querySelectorAll('[data-workspace-services] label')].some(l => l.textContent.includes(${JSON.stringify(names.service2)}))`, 8000);
    const ticked = await admin.eval(`(() => { const l = [...document.querySelectorAll('[data-workspace-services] label')].find(x => x.textContent.includes(${JSON.stringify(names.service2)})); const i = l && l.querySelector('input'); if (!i) return false; if (!i.checked) i.click(); return i.checked; })()`);
    expect(ticked, 'the service could not be chosen for the workspace');
    await admin.click('Save Changes');
    await admin.waitFor('location.pathname === "/workspaces"');
    await admin.reload();
    await admin.waitFor(`[...document.querySelectorAll('.card')].some(c => c.textContent.includes(${JSON.stringify(names.workspace)}) && /(^|[^0-9])1 service(?!s)/.test(c.textContent))`, 8000);
    const svcAfter = (await admin.api('GET', '/services')).body.data.find(x => x.name === names.service2);
    expect(svcAfter && svcAfter.workspaceIds.includes(id), 'the service does not list the workspace it was chosen for');
    await admin.click(`Organization:`);
    await admin.click(names.workspace, 'a');
    await admin.waitFor(`location.pathname === "/workspaces/${id}"`);
    await admin.waitText('Edited in browser');
    // The workspace's services are listed on its Services tab (the page opens on Overview).
    await admin.click('Services', 'button');
    await admin.waitText(names.service2);
    await admin.click('Delete', 'button');
    await admin.click('Delete', '[role=dialog] button');
    await admin.waitFor('location.pathname === "/workspaces"');
    const svcGone = (await admin.api('GET', '/services')).body.data.find(x => x.name === names.service2);
    expect(svcGone && !svcGone.workspaceIds.includes(id), 'the deleted workspace is still listed on the service');
  });
  await step('global search finds the customer', admin, async () => {
    await admin.goto('/dashboard');
    await admin.fillSel('input[placeholder^="Search appointments"]', 'Cora');
    await admin.waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.includes(${JSON.stringify(names.customer)}))`, 8000);
  });
  await step('local assistant answers from the knowledge base without any external AI call', admin, async () => {
    const external = [];
    const watch = m => {
      if (m.sessionId === admin.s && m.method === 'Network.requestWillBeSent') {
        const u = m.params.request.url;
        if (!u.startsWith(ORIGIN) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.includes('fonts.g')) external.push(u);
      }
    };
    browser.listeners.push(watch);
    await admin.goto('/dashboard');
    await admin.click('Open AI assistant');
    await admin.waitText('Workeasy Ai Agent');
    await admin.fillSel('textarea[aria-label="Message input"]', 'How do I add a new staff member?');
    await admin.click('Send message');
    await admin.waitFor('[...document.querySelectorAll("[role=log] *")].some(e => /Sources:|staff/i.test(e.textContent) && e.textContent.length > 80)', 15000);
    browser.listeners.splice(browser.listeners.indexOf(watch), 1);
    expect(!external.length, 'external requests: ' + external.join(', '));
    await admin.click('Close AI assistant');
  });

  // 10. Isolation and access control
  await step('another organization cannot see or open this organization\'s data', null, async () => {
    const other = await browser.newPage({ incognito: true, label: 'other-org' });
    await other.viewport(1280, 860);
    await signUpThroughUi(other, { name: 'Other Owner', email: `other-${RUN}@example.com`, company: `Other Org ${RUN}`, password: owner.password });
    expect((await other.api('GET', `/appointments/${ids.publicAppt}`)).status === 404, 'other org can read the appointment');
    expect((await other.api('PUT', `/staff/${ids.staff1}`, { isActive: false })).status === 404, 'other org can edit staff');
    await other.goto(`/appointments/${ids.publicAppt}`);
    await other.waitFor('/not found/i.test(document.body.innerText)', 8000);
    await other.goto('/staff');
    await other.waitText('No staff yet');
    expect(!(await other.hasText(names.staff1)), 'other org sees staff');
  });
  await step('logged-out visitors are sent to login and the API refuses them', null, async () => {
    const anon = await browser.newPage({ incognito: true, label: 'anonymous' });
    await anon.goto('/staff');
    await anon.waitFor('location.pathname === "/login"', 8000);
    expect((await anon.api('GET', '/staff')).status === 401, 'API served staff to an anonymous visitor');
    expect((await anon.api('POST', '/appointments', {})).status === 401, 'API accepted an anonymous write');
  });

  // 10b. Staff sign-in by invitation (token only in the email; staff see only their own work)
  const benEmail = `ben-${RUN}@example.com`;
  const benPassword = 'BenStaff123';
  const benDay = nextWeekday(5);
  let staffPage;
  await step('admin invites a staff member; the link arrives only by email', admin, async () => {
    const ben = await admin.api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff2, customerId: ids.customer, date: benDay, startTime: '11:00' });
    expect(ben.status === 201, `could not book Ben: ${JSON.stringify(ben.body)}`);
    ids.benAppt = ben.body.data.id;
    await admin.goto(`/staff/${ids.staff2}`);
    await admin.waitText('Sign-in access');
    await admin.waitFor('[...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Send invitation" && !b.disabled)', 10000);
    await admin.selectOption('Sign-in role', 'Staff — sees only their own schedule');
    await admin.click('Send invitation', 'button');
    await admin.waitText(`Invitation emailed to ${benEmail}`);
    await admin.waitFor('!!document.querySelector("[data-invite-status=pending]")', 8000);
    const m = mailTo(benEmail).find(x => /invited you to/.test(x.subject));
    expect(m, 'invitation email not received by the SMTP catcher');
    ids.inviteLink = (m.body.match(/https?:\/\/[^\s"<>]+\/accept-invite#token=[\w%-]+/) || [])[0];
    expect(ids.inviteLink, 'no invitation link in the email');
    const token = decodeURIComponent(ids.inviteLink.split('#token=')[1]);
    const list = await admin.api('GET', `/staff/${ids.staff2}/invitations`);
    expect(list.status === 200 && !JSON.stringify(list.body).includes(token), 'the invitation token is exposed by the API');
    await admin.goto('/staff');
    await admin.waitFor(`!!document.querySelector('[data-account-status="invited"]')`, 8000);
  });
  await step('the invited person chooses a password and lands on their own schedule', null, async () => {
    staffPage = await browser.newPage({ incognito: true, label: 'staff' });
    await staffPage.viewport(1280, 860);
    await staffPage.gotoUrl(ids.inviteLink);
    await staffPage.waitText(`Join ${owner.company}`);
    await staffPage.waitText(benEmail);
    await staffPage.waitFor('[...document.images].every(i => i.complete)');
    seen.acceptInvite = await staffPage.eval('__t.brand()');
    await staffPage.shot('brand_accept_invite');
    expect(!(await staffPage.eval('location.href.includes("token=")')), 'token left in the address bar');
    await staffPage.fill('Password', 'short');
    await staffPage.fill('Confirm password', 'short');
    await staffPage.click('Create my sign-in', 'button');
    await staffPage.waitText('Use at least 8 characters');
    await staffPage.fill('Password', benPassword);
    await staffPage.fill('Confirm password', benPassword);
    await staffPage.click('Create my sign-in', 'button');
    await staffPage.waitFor('location.pathname === "/my-space"', 10000);
    await staffPage.waitText('My Availability');
    await staffPage.waitText(names.customer);
    const reuse = await staffPage.api('POST', '/auth/invitations/accept', { token: decodeURIComponent(ids.inviteLink.split('#token=')[1]), password: benPassword, confirmPassword: benPassword });
    expect(reuse.status === 410, `invitation link worked twice (${reuse.status})`);
  });
  await step('the invitation page and email name WorkeasyBooking and the business being joined', null, async () => {
    const m = mailTo(benEmail).find(x => /invited you to/.test(x.subject));
    emailRenders.invitation = m && htmlPart(m.body);
    const b = seen.acceptInvite;
    expect(b, 'the invitation page was not reached');
    expect(b.logos.length === 1 && b.logos[0].label === PRODUCT, `product logos ${JSON.stringify(b.logos)}`);
    expect(b.text.includes(`Join ${owner.company}`) && b.text.includes(ATTRIBUTION), 'business or attribution missing');
    expect(b.title === tabTitle(`Join ${owner.company}`), `tab title "${b.title}"`);
    expect(!b.broken.length && !b.variants.length, `broken images ${b.broken.join(', ')}; name variants ${b.variants.join(', ')}`);
    expect(m.subject.endsWith(`invited you to ${owner.company} on ${PRODUCT}`), `subject "${m.subject}"`);
    expect(m.body.includes(`Sent by ${PRODUCT} on behalf of ${owner.company}.`) && m.body.includes(`${PRODUCT} · ${ATTRIBUTION}`), 'invitation email lacks the product credit');
    expect(emailRenders.invitation?.includes(`>${owner.company}</div>`), 'invitation email does not open with the business name');
  });
  await step('a staff sign-in only sees its own work: navigation, pages and API are limited', null, async () => {
    const nav = await staffPage.eval('[...document.querySelectorAll("#main-sidebar nav a")].map(a => a.textContent.trim())');
    expect(JSON.stringify(nav) === JSON.stringify(['My Space', 'Appointments', 'Calendar', 'Settings']), 'staff navigation: ' + nav.join(', '));
    expect(!(await staffPage.hasText('New Appointment')), 'staff offered "New Appointment"');
    await staffPage.goto('/customers');
    await staffPage.waitText("You don't have access to this page");
    await staffPage.goto('/dashboard');
    await staffPage.waitText("You don't have access to this page");
    expect((await staffPage.api('GET', '/customers')).status === 403, 'API listed customers for staff');
    expect((await staffPage.api('GET', '/reports/summary')).status === 403, 'API served reports to staff');
    const apts = (await staffPage.api('GET', '/appointments')).body.data;
    expect(apts.length === 1 && apts[0].id === ids.benAppt, `staff sees ${apts.length} appointments`);
    expect((await staffPage.api('GET', `/appointments/${ids.publicAppt}`)).status === 404, "staff can open a colleague's appointment");
    expect((await staffPage.api('POST', '/appointments', { serviceId: ids.service, staffId: ids.staff2, customerId: ids.customer, date: benDay, startTime: '14:00' })).status === 403, 'staff can create appointments');
    await staffPage.goto(`/appointments/${ids.benAppt}`);
    await staffPage.waitText(names.customer);
    expect(!(await staffPage.hasText('Mark Complete')) && !(await staffPage.hasText('Customer Emails')), 'staff offered actions or email history');
    await staffPage.goto('/settings');
    await staffPage.waitText('Change Password');
    await staffPage.click('Roles & Permissions', 'button');
    await staffPage.waitText('See their own appointments');
    expect(!(await staffPage.hasText('Business Profile')), 'staff can open business settings');
  });
  await step('turning off sign-in ends the staff session; turning it on again restores access', admin, async () => {
    await admin.goto(`/staff/${ids.staff2}`);
    await admin.click('Turn off sign-in', 'button');
    await admin.click('Turn off sign-in', '[role=dialog] button');
    await admin.waitText('Sign-in is turned off');
    await staffPage.goto('/appointments');
    await staffPage.waitFor('location.pathname === "/login"', 10000);
    const refused = await staffPage.api('POST', '/auth/login', { email: benEmail, password: benPassword });
    expect(refused.status === 401, `turned-off sign-in still works (${refused.status})`);
    await admin.click('Turn sign-in back on', 'button');
    await admin.waitText(`can sign in with ${benEmail}`);
    await staffPage.fill('Email', benEmail);
    await staffPage.fill('Password', benPassword);
    await staffPage.clickSel('form button[type=submit]');
    await staffPage.waitFor('location.pathname === "/my-space"', 10000);
  });

  await step('business hours saved in Settings narrow what customers and the New Appointment form are offered', admin, async () => {
    const day = nextWeekday(12);
    const publicFree = async () => (await admin.api('GET', `/public/availability?date=${day}&serviceId=${ids.service}&staffId=${ids.staff1}`)).body.data.filter(s => s.available).map(s => s.start);
    const before = await publicFree();
    expect(before[0] === '09:00' && before[before.length - 1] === '16:00', `before: ${before.join(' ')}`);
    try {
      await admin.goto('/settings');
      await admin.click('Working Hours', 'button');
      await admin.waitText('Set your default business operating hours');
      // The existing controls: set Monday to 10:00-15:00, apply it to every active day, save.
      await admin.eval(`(() => {
        const row = [...document.querySelectorAll('div')].find(d => d.children.length >= 3 && /^Monday/.test(d.innerText.trim()) && d.querySelectorAll('select').length === 2);
        const [start, end] = row.querySelectorAll('select');
        __t.setValue(start, '10:00'); __t.setValue(end, '15:00');
      })()`);
      await admin.click('Apply to all active days', 'button');
      await admin.click('Save Changes', 'button');
      await admin.waitText('Working hours saved');
      const after = await publicFree();
      expect(after[0] === '10:00' && after[after.length - 1] === '14:00', `public after: ${after.join(' ')}`);
      await admin.goto('/appointments/new');
      await admin.waitFor('!!__t.byLabel("Service") && __t.byLabel("Service").options.length > 1', 15000);
      await admin.selectOption('Service', names.service2);
      await admin.selectOption('Staff Member', names.staff1);
      await admin.fill('Date', day);
      await admin.waitFor('__t.byLabel("Time Slot").options.length > 1', 10000);
      const offered = await admin.eval('[...__t.byLabel("Time Slot").options].slice(1).map(o => o.textContent.trim())');
      expect(offered[0] === '10:00 AM' && offered[offered.length - 1] === '2:00 PM', `New Appointment offers: ${offered.join(', ')}`);
    } finally {
      await admin.api('PUT', '/settings', { workingHours: {} }); // back to staff hours only, as the rest of the suite expects
    }
  });

  // 11. Pages, labels, accessibility (desktop)
  const expectedHeading = { '/dashboard': 'Dashboard', '/my-space': 'My Availability', '/appointments': 'Appointments', '/calendar': 'Today', '/services': 'Services', '/staff': 'Staff', '/customers': 'Customers', '/resources': 'Resources', '/workspaces': 'Workspaces', '/booking-pages': 'Booking Pages', '/notifications': 'Notifications', '/integrations': 'Integrations', '/reports': 'Reports', '/settings': 'Settings' };
  const pagesToAudit = Object.keys(expectedHeading);
  const a11y = {};
  await step('every sidebar link resolves (no 404), pages load without exceptions, one product logo and a branded tab title each', admin, async () => {
    const before = consoleIssues.filter(c => c.kind === 'exception').length;
    const bad = [];
    for (const p of pagesToAudit) {
      await admin.goto(p);
      await sleep(600);
      if (await admin.eval('/not found|404/i.test(document.title + " " + (document.querySelector("h1")?.textContent || ""))')) bad.push(p + ' (404)');
      try { await admin.waitText(expectedHeading[p], 6000); } catch { bad.push(p + ' (missing "' + expectedHeading[p] + '")'); }
      const b = await admin.eval('__t.brand()');
      if (b.logos.length !== 1) bad.push(`${p} (${b.logos.length} product logos)`);
      if (!b.title.endsWith(` — ${PRODUCT}`)) bad.push(`${p} (tab title "${b.title}")`);
      if (b.broken.length) bad.push(`${p} (broken images ${b.broken.join(', ')})`);
      if (b.variants.length) bad.push(`${p} (name spelled ${b.variants.join(', ')})`);
      a11y[p] = await admin.eval('__t.a11y()');
    }
    for (const p of ['/staff/new', `/appointments/${ids.publicAppt}`]) { await admin.goto(p); await sleep(800); a11y[p] = await admin.eval('__t.a11y()'); }
    expect(!bad.length, 'not found: ' + bad.join(', '));
    expect(consoleIssues.filter(c => c.kind === 'exception').length === before, 'uncaught exceptions while visiting pages');
  });
  await step('Notifications: reminders, staff alerts, rules, language and email texts are real settings that save and reload; channels show their real state', admin, async () => {
    await admin.goto('/notifications'); await admin.waitText('Email delivery is configured (SMTP)');
    for (const t of ['Reminders to customers', 'Alerts to staff', 'Who gets what', 'Business recipients', 'Business calendar', 'Delivery channels', 'Language for customers', 'Email texts']) await admin.waitText(t);
    // Development mode is announced, and nothing unconnected is shown as connected.
    expect(await admin.eval('!!document.querySelector("[data-provider-mode=mock]")'), 'no development-mode notice');
    expect(await admin.eval('document.querySelector("[data-channel-status=sms]").innerText.includes("Not set up")'), 'SMS not shown as "Not set up"');
    expect(!(await admin.eval('document.querySelector("[data-section=delivery-channels]").innerText.includes("Connected")')), 'a channel is shown as connected before any setup');
    expect(!(await admin.hasText('Planned notifications')), 'the old draft list is still shown');
    try {
      await admin.clickSel('[data-setting="reminders"]');
      await admin.waitFor('document.querySelector(\'[data-setting="reminders"]\').checked', 8000);
      await admin.fillSel('#tpl-confirmation-subject', 'Booked: {serviceName} ({bookingRef})');
      await admin.click('Preview', 'button', '[data-template="confirmation"]');
      await admin.waitText('Booked: Consultation (WE-SAMPLE01)');
      await admin.click('Save', 'button', '[data-template="confirmation"]');
      await admin.waitFor('[...document.querySelectorAll("[data-template=confirmation] span")].some(x => x.textContent === "Your own text")', 8000);
      await admin.reload();
      await admin.waitFor('document.querySelector(\'[data-setting="reminders"]\')?.checked === true', 8000);
      expect(await admin.eval('document.querySelector("#tpl-confirmation-subject").value') === 'Booked: {serviceName} ({bookingRef})', 'the email text did not persist');
      const bad = await admin.api('PUT', '/settings/email-templates/reminder', { subject: 'Hi {firstName}', intro: 'x' });
      expect(bad.status === 400 && /Unknown placeholder/.test(bad.body.error), 'an unknown placeholder was accepted');
    } finally {
      await admin.api('DELETE', '/settings/email-templates/confirmation');
      await admin.api('PUT', '/settings/notifications', { remindersEnabled: false });
    }
    await admin.goto(`/staff/${ids.staff1}`); await admin.waitText('Time-off tracking is not implemented yet');
  });

  await step('appointment history: who booked, moved and cancelled, oldest first, on the appointment page', admin, async () => {
    await admin.goto(`/appointments/${ids.publicAppt}`); await admin.waitText('History');
    await admin.waitText('The customer, on the booking page');
    const titles = await admin.eval('[...document.querySelectorAll(\'[aria-label="Appointment history, oldest first"] li\')].map(li => li.querySelector("p").textContent)');
    expect(titles[0] === 'Booked' && titles.includes('Rescheduled') && titles.includes('Cancelled'), `history: ${JSON.stringify(titles)}`);
    await admin.waitText('The customer, with their booking link');
    const api = await admin.api('GET', `/appointments/${ids.publicAppt}/history`);
    expect(api.status === 200 && api.body.data.length === titles.length, 'API and page disagree');
    expect((await admin.api('DELETE', `/appointments/${ids.publicAppt}/history`)).status === 404, 'history can be deleted');
  });

  await step('lost the email: the lookup page emails a new manage link to the address on the booking, with a neutral answer', pub, async () => {
    const before = mailTo(petra.email).length;
    await pub.goto('/book/lookup/manage');
    await pub.eval('sessionStorage.removeItem("we360_manage_token")'); // an earlier step left a manage link in this tab
    await pub.reload();
    await pub.fill('Booking reference', 'WE-NOTREAL1'); await pub.fill('Email address', petra.email);
    await pub.click('Lost the email? Email me a link to manage my booking', 'button');
    await pub.waitText("we've emailed a link");
    await sleep(1500);
    expect(mailTo(petra.email).length === before, 'an email was sent for an unknown reference');
    // The real booking was cancelled earlier in this run, so it cannot be changed: also no email, same answer.
    await pub.fillSel('#manage-ref', ids.ref);
    await pub.click('Lost the email? Email me a link to manage my booking', 'button');
    await pub.waitText("we've emailed a link");
    await sleep(1500);
    expect(mailTo(petra.email).length === before, 'a manage link was sent for a booking that can no longer be changed');
  });

  await step('two-factor sign-in: set up with the QR code and key, sign in elsewhere with a code, then turned off', admin, async () => {
    await admin.goto('/settings/security'); await admin.waitText('Two-Factor Authentication');
    await admin.click('Set up two-factor sign-in', 'button');
    await admin.fillSel('#two-factor-password', owner.password);
    await admin.click('Continue', 'button');
    await admin.waitFor('!!document.querySelector("[data-setup-key]")', 8000);
    expect(await admin.eval('!!document.querySelector(\'svg[role="img"][aria-label^="QR code"] path\')'), 'no QR code drawn');
    const key = (await admin.eval('document.querySelector("[data-setup-key]").textContent')).replace(/\s/g, '');
    await admin.fillSel('#two-factor-setup-code', totp(key, 0));
    await admin.click('Turn on', 'button');
    await admin.waitFor('!!document.querySelector("[data-recovery-codes]")', 8000);
    const codes = await admin.eval('[...document.querySelectorAll("[data-recovery-codes] li")].map(li => li.textContent)');
    expect(codes.length === 10 && new Set(codes).size === 10, 'ten different recovery codes');
    await admin.click('I have saved them', 'button');
    await admin.waitFor('!!document.querySelector("[data-two-factor=on]")', 8000);
    try {
      const other = await browser.newPage({ incognito: true, label: 'two-factor' });
      await other.goto('/login');
      await other.fill('Email', owner.email); await other.fill('Password', owner.password);
      await other.click('Sign in', 'button');
      await other.waitText('Two-factor sign-in');
      expect(!(await other.api('GET', '/auth/me')).body.data, 'the password alone signed in');
      await other.fill('Authentication code', totp(key, 1));
      await other.click('Verify and sign in', 'button');
      await other.waitFor('location.pathname === "/dashboard"', 10000);
    } finally {
      const off = await admin.api('POST', '/auth/2fa/disable', { password: owner.password, recoveryCode: codes[0] });
      expect(off.status === 200, `two-factor sign-in was not turned off (${off.status})`);
    }
  });

  await step('logo upload: chosen in Branding with the file picker, shown on the public booking page, then removed', admin, async () => {
    const file = path.join(os.tmpdir(), `we360-logo-${RUN}.png`);
    fs.writeFileSync(file, tinyPng());
    try {
      await admin.goto('/settings/branding'); await admin.waitText('Branding');
      await admin.waitFor('!!document.querySelector("input[type=file]") && !document.querySelector("input[type=file]").disabled', 8000);
      const { root } = await admin.send('DOM.getDocument', { depth: -1 });
      const { nodeId } = await admin.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
      await admin.send('DOM.setFileInputFiles', { files: [file], nodeId });
      await admin.waitFor('!!document.querySelector(\'img[alt="Current logo"]\')', 10000);
      const src = await admin.eval('document.querySelector(\'img[alt="Current logo"]\').getAttribute("src")');
      expect(/^\/api\/public\/media\/[A-Za-z0-9_-]{21}$/.test(src), `logo address ${src}`);
      expect(await admin.eval('document.querySelector(\'img[alt="Current logo"]\').naturalWidth') === 64, 'the uploaded logo does not load');
      await pub.goto(`/book/${ids.slug}`);
      await pub.waitFor(`!!document.querySelector('img[src="${src}"]') && document.querySelector('img[src="${src}"]').naturalWidth === 64`, 10000);
      const svg = await admin.eval(`fetch('/api/settings/logo', { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'image/png' }, body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }).then(r => r.status)`);
      expect(svg === 403 || svg === 415, `an SVG upload answered ${svg}`);
    } finally {
      await admin.api('DELETE', '/settings/logo');
      fs.rmSync(file, { force: true });
    }
  });

  await step('rooms: a service that needs the only room is not offered to another staff member while the room is taken', admin, async () => {
    const room = (await admin.api('POST', '/resources', { name: `Browser Room ${RUN}`, type: 'room', capacity: 1 })).body.data;
    const svc = (await admin.api('POST', '/services', { name: `Room Service ${RUN}`, category: 'consultation', duration: 30, price: 0, maxAdvance: 365, staffIds: [ids.staff1, ids.staff2], resourceIds: [room.id] })).body.data;
    let appt = null;
    try {
      let day = null, start = null;
      for (let i = 30; i < 45 && !start; i++) {
        const d = isoLocal(new Date(Date.now() + i * 86400000));
        const a = (await admin.api('GET', `/appointments/availability?date=${d}&serviceId=${svc.id}&staffId=${ids.staff1}`)).body.data ?? [];
        const b = (await admin.api('GET', `/appointments/availability?date=${d}&serviceId=${svc.id}&staffId=${ids.staff2}`)).body.data ?? [];
        const both = a.find(x => x.available && b.some(y => y.start === x.start && y.available));
        if (both) { day = d; start = both.start; }
      }
      expect(start, 'no time when both staff members are free');
      appt = (await admin.api('POST', '/appointments', { serviceId: svc.id, staffId: ids.staff1, customerId: ids.customer, date: day, startTime: start })).body.data;
      expect(appt?.resourceIds?.[0] === room.id, 'the booking did not take the room');
      const other = (await admin.api('GET', `/appointments/availability?date=${day}&serviceId=${svc.id}&staffId=${ids.staff2}`)).body.data.find(x => x.start === start);
      expect(other && !other.available, 'the taken room was still offered');
      const clash = await admin.api('POST', '/appointments', { serviceId: svc.id, staffId: ids.staff2, customerId: ids.customer, date: day, startTime: start });
      expect(clash.status === 409, `a second booking took the room (${clash.status})`);
      await admin.goto('/resources'); await admin.waitText(`Browser Room ${RUN}`); await admin.waitText('1 booking at a time');
      await admin.goto(`/appointments/${appt.id}`); await admin.waitText('Resources Booked'); await admin.waitText(`Browser Room ${RUN}`);
    } finally {
      if (appt) await admin.api('PUT', `/appointments/${appt.id}`, { status: 'cancelled' });
      await admin.api('PUT', `/services/${svc.id}`, { isActive: false });
      await admin.api('PUT', `/resources/${room.id}`, { isActive: false });
    }
  });

  await step('Hindi: the booking page switches to Hindi (text, dates, statuses) and back, and remembers the choice', pub, async () => {
    await pub.goto(`/book/${ids.slug}`);
    await pub.waitFor('!!document.querySelector("[data-language-switch]")', 10000);
    try {
      await chooseIn(pub, '[data-language-switch]', 'hi');
      await pub.waitText('सेवा चुनें');
      expect(await pub.eval('document.documentElement.lang') === 'hi', 'the page language attribute is not hi');
      expect(await pub.hasText('चरण 1 / 6') || await pub.hasText('सेवा'), 'steps not in Hindi');
      await pub.reload(); await pub.waitText('सेवा चुनें');
      await pub.goto('/book/lookup/manage');
      await pub.eval('sessionStorage.removeItem("we360_manage_token")');
      await pub.reload();
      await pub.waitText('अपनी बुकिंग प्रबंधित करें');
    } finally {
      await pub.goto(`/book/${ids.slug}`);
      await pub.waitFor('!!document.querySelector("[data-language-switch]")', 10000);
      await chooseIn(pub, '[data-language-switch]', 'en');
      await pub.waitText('Select a Service');
    }
  });

  await step('webhooks: add a receiver, send a signed test event, remove it; accounts and payments say plainly they are not set up', admin, async () => {
    const got = [];
    const receiver = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.end('ok'); }); });
    await new Promise(r => receiver.listen(0, '127.0.0.1', r));
    try {
      await admin.goto('/integrations'); await admin.waitText('Webhooks and Zapier');
      await admin.waitText('Not set up on this server'); await admin.waitText('Customers cannot pay online yet'); await admin.waitText('Text messages and WhatsApp');
      expect(await admin.eval('document.querySelector("[data-messaging=sms]").innerText.includes("Not set up")'), 'SMS not shown as "Not set up"');
      await admin.fill('Address (https)', `http://127.0.0.1:${receiver.address().port}/hook`);
      await admin.click('Add webhook', 'button');
      await admin.waitFor('!!document.querySelector("[data-webhook-secret]")', 8000);
      const secret = await admin.eval('document.querySelector("[data-webhook-secret]").textContent');
      await admin.click('Send test', 'button');
      await admin.waitText('Test event delivered');
      expect(got.length === 1 && got[0].headers['x-workeasy360-event'] === 'ping', `received ${got.length} request(s)`);
      const [t, v1] = String(got[0].headers['x-workeasy360-signature']).split(',').map(p => p.split('=')[1]);
      expect(v1 === createHmac('sha256', secret).update(`${t}.${got[0].body}`).digest('hex'), 'the signature does not verify with the shown secret');
      await admin.click('Remove', 'button');
      await admin.waitText('No webhook addresses yet.');
    } finally {
      receiver.close();
      for (const e of (await admin.api('GET', '/integrations/webhooks')).body.data?.endpoints ?? []) await admin.api('DELETE', `/integrations/webhooks/${e.id}`);
    }
  });
  await step('reports show revenue in INR', admin, async () => {
    await admin.goto('/reports');
    await admin.waitFor('[...document.querySelectorAll("p")].some(p => /^₹/.test(p.textContent.trim()))', 10000);
  });
  await step('a page whose code fails to load shows a branded error inside the app; reloading recovers', admin, async () => {
    await admin.goto('/dashboard'); await admin.waitText('Dashboard');
    // As after an update that removed old files: the Integrations page's code cannot be fetched.
    await admin.send('Network.setCacheDisabled', { cacheDisabled: true });
    await admin.send('Fetch.enable', { patterns: [{ urlPattern: '*IntegrationsPage-*.js', requestStage: 'Request' }] });
    const blocked = [];
    const stop = admin.on('Fetch.requestPaused', p => { blocked.push(p.request.url); admin.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {}); });
    try {
      await admin.reload(); // a fresh copy of the app, so that page's code is requested again
      await admin.waitText('Dashboard');
      await admin.click('Integrations', 'a');
      await admin.waitFor('!!document.querySelector("[data-brand=error-page]")', 10000);
      expect(blocked.length > 0, 'the page code was never requested');
      await admin.waitText('This page could not be loaded');
      expect(await admin.eval('!!document.getElementById("main-sidebar") && !!document.querySelector("[data-brand=app-footer]")'), 'the error replaced the whole app instead of one page');
      const title = await admin.eval('document.title');
      expect(title === tabTitle('Page could not be loaded'), `tab title "${title}"`);
      await admin.shot('brand_error_page');
    } finally {
      stop();
      await admin.send('Fetch.disable');
      await admin.send('Network.setCacheDisabled', { cacheDisabled: false });
    }
    await admin.click('Reload page', 'button');
    await admin.waitFor('location.pathname === "/integrations"');
    await admin.waitText('Webhooks and Zapier', 15000);
  });

  // 11b. Settings routes: direct links, refresh, back and forward (a direct /settings/security once showed a blank page)
  await step('every settings section opens by its own URL, after a refresh, and with back/forward', admin, async () => {
    const SECTIONS = [
      ['business', 'Business Profile'], ['branding', 'Branding'], ['hours', 'Working Hours'], ['booking', 'Booking Rules'],
      ['cancellation', 'Cancellation Policy'], ['notifications', 'Notifications'], ['roles', 'Roles & Permissions'],
      ['security', 'Security'], ['language', 'Language & Region'],
    ];
    // The section shown: the nav item marked current, and the content beside it (never blank, never the error page).
    const shown = () => admin.eval(`(() => {
      const nav = document.querySelector('nav[aria-label="Settings sections"]');
      const current = nav && nav.querySelector('[aria-current="page"]');
      const content = nav && nav.parentElement && nav.parentElement.querySelector(':scope > div');
      return { current: current ? current.innerText.trim() : null, contentLength: content ? content.innerText.trim().length : 0,
        error: document.body.innerText.includes('This page could not be loaded') || document.body.innerText.includes('Page not found') };
    })()`);
    const problems = [];
    for (const [id, label] of SECTIONS) {
      for (const how of ['direct', 'refresh']) {
        if (how === 'direct') await admin.goto(`/settings/${id}`); else await admin.reload();
        try { await admin.waitFor(`(() => { const c = document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]'); return c && c.innerText.trim() === ${JSON.stringify(label)}; })()`, 8000); } catch { /* reported below */ }
        await sleep(400);
        const s = await shown();
        if (s.current !== label || s.contentLength < 20 || s.error || (await admin.path()) !== `/settings/${id}`) problems.push(`${how} /settings/${id}: ${JSON.stringify(s)}`);
      }
    }
    expect(!problems.length, problems.join(' | '));
    // Back and forward move between sections that were opened from the menu.
    await admin.goto('/settings/business');
    // The menu renders after the page loads; click only once it is there.
    await admin.waitFor(`[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].some(b => b.innerText.trim() === 'Security')`, 8000);
    await admin.eval(`[...document.querySelectorAll('nav[aria-label="Settings sections"] button')].find(b => b.innerText.trim() === 'Security').click()`);
    await admin.waitFor('location.pathname === "/settings/security"');
    await admin.eval('history.back()');
    await admin.waitFor('location.pathname === "/settings/business"');
    await admin.waitFor(`document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]').innerText.trim() === 'Business Profile'`);
    await admin.eval('history.forward()');
    await admin.waitFor('location.pathname === "/settings/security"');
    await admin.waitFor(`document.querySelector('nav[aria-label="Settings sections"] [aria-current="page"]').innerText.trim() === 'Security'`);
    // An unknown address shows the not-found page, never a blank screen.
    await admin.goto('/no-such-page-anywhere');
    await admin.waitText('Page not found');
  });

  // 11c. The appointments table at tablet, medium and wide widths
  await step('appointments table: references stay on one line and the page never overflows at 768, 1024 and 1440px', admin, async () => {
    const problems = [];
    for (const width of [768, 1024, 1440]) {
      await admin.viewport(width, 900);
      await admin.goto('/appointments');
      await admin.waitFor('document.querySelector("[data-booking-ref]")', 10000);
      const r = await admin.eval(`(() => {
        const refs = [...document.querySelectorAll('[data-booking-ref]')];
        const wrapped = refs.filter(el => el.getClientRects().length > 1 || el.getBoundingClientRect().height > 24).map(el => el.innerText);
        const view = [...document.querySelectorAll('table button')].filter(b => b.innerText.trim() === 'View');
        return { refs: refs.length, wrapped, views: view.length, pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
      })()`);
      if (!r.refs || r.wrapped.length || r.views !== r.refs || r.pageOverflow) problems.push(`${width}px: ${JSON.stringify(r)}`);
    }
    await admin.viewport(1280, 860); // the size the rest of this suite uses
    expect(!problems.length, problems.join(' | '));
  });

  // 12. Mobile 375px
  const mobile = {};
  await step('375px: no horizontal overflow on admin pages; navigation menu opens', admin, async () => {
    await admin.viewport(375, 812, true);
    const offenders = [];
    for (const p of ['/dashboard', '/my-space', '/appointments', '/appointments/new', '/calendar', '/customers', `/customers/${ids.customer}`, '/staff', '/staff/new', `/appointments/${ids.publicAppt}`, '/settings', '/booking-pages', '/notifications', '/reports']) {
      await admin.goto(p); await sleep(700);
      const o = await admin.eval('__t.overflow()');
      mobile[p] = o;
      if (o.length) offenders.push(`${p}: ${o.join('; ')}`);
      await admin.shot('mobile' + p.replace(/\//g, '_'));
    }
    await admin.goto('/dashboard');
    // The header fits the screen and leaves room to search; on phones the product logo lives in the navigation drawer.
    const hdr = await admin.eval(`(() => {
      const h = document.querySelector('header');
      const rects = [...h.querySelectorAll('*')].filter(e => __t.visible(e)).map(e => e.getBoundingClientRect());
      return { left: Math.round(Math.min(...rects.map(r => r.left))), right: Math.round(Math.max(...rects.map(r => r.right))),
        height: Math.round(h.getBoundingClientRect().height), search: Math.round(h.querySelector('input[type=search]').getBoundingClientRect().width) };
    })()`);
    if (!(hdr.left >= 0 && hdr.right <= 375 && hdr.height <= 56 && hdr.search >= 80)) offenders.push(`header: ${JSON.stringify(hdr)}`);
    await admin.click('Open navigation menu');
    await admin.waitFor('getComputedStyle(document.getElementById("main-sidebar")).transform === "none" || document.getElementById("main-sidebar").getBoundingClientRect().left >= 0');
    await sleep(300);
    const drawer = await admin.eval('__t.brand().logos');
    if (!(drawer.length === 1 && drawer[0].where === 'sidebar')) offenders.push(`navigation drawer logos: ${JSON.stringify(drawer)}`);
    await admin.shot('mobile_nav_open');
    expect(!offenders.length, offenders.join(' | '));
  });
  await step('375px: public booking pages, calendar and time step fit the screen', pub, async () => {
    await pub.viewport(375, 812, true);
    const offenders = [];
    for (const p of ['/book', `/book/${ids.slug}`, `/book/lookup/manage?ref=${ids.ref}`, '/accept-invite', '/login', '/signup', '/forgot-password', '/reset-password', '/verify-email', `/no-such-page-${RUN}`]) {
      await pub.goto(p); await sleep(700);
      const o = await pub.eval('__t.overflow()');
      if (o.length) offenders.push(`${p}: ${o.join('; ')}`);
      await pub.shot('mobile_public' + p.replace(/[/?=]/g, '_'));
    }
    await pub.goto(`/book/${ids.slug}`);
    await pub.click(names.service2); await pub.click('Continue');
    await pub.click(names.staff1, 'button'); await pub.click('Continue');
    await waitCalendar(pub);
    let o = await pub.eval('__t.overflow()'); if (o.length) offenders.push(`calendar: ${o.join('; ')}`);
    await pub.shot('mobile_public_calendar');
    const d = nextWeekday(8);
    await showMonthWith(pub, d);
    await pub.clickSel(`[data-date="${d}"]`);
    await pub.click('Continue');
    await pub.waitFor('[...document.querySelectorAll("button")].some(b => /^\\d{1,2}:\\d{2} [AP]M$/.test(b.textContent.trim()))', 10000);
    o = await pub.eval('__t.overflow()'); if (o.length) offenders.push(`time step: ${o.join('; ')}`);
    await pub.shot('mobile_public_times');
    expect(!offenders.length, offenders.join(' | '));
  });
  await step('375px: sign-up confirmation and password reset screens fit the screen and are labelled', pub, async () => {
    await pub.viewport(375, 812, true);
    const offenders = [];
    const check = async name => {
      const o = await pub.eval('__t.overflow()'); if (o.length) offenders.push(`${name}: ${o.join('; ')}`);
      const a = await pub.eval('__t.a11y()'); if (a.length) offenders.push(`${name}: ${a.join('; ')}`);
      await pub.shot('mobile_' + name);
    };
    const who = { name: 'Phone Owner', email: `phone-${RUN}@example.com`, company: `Phone Org ${RUN}`, password: 'Phone1234' };
    await pub.goto('/signup');
    await pub.fill('Full name', who.name); await pub.fill('Work email', who.email);
    await pub.fill('Company / workspace name', who.company);
    await pub.fill('Password', who.password); await pub.fill('Confirm password', who.password);
    await pub.clickSel('form button[type=submit]');
    await pub.waitText(GENERIC_EMAIL_REPLY);
    await check('auth_check_email');
    // "Send a new link": the new link replaces the first one.
    const first = await emailedLink(who.email, '/verify-email');
    await pub.click('Send a new link', 'button');
    await pub.waitFor('document.querySelectorAll("[role=status]").length >= 2');
    let second = first;
    for (let i = 0; i < 100 && second.path === first.path; i++) { await sleep(150); second = await emailedLink(who.email, '/verify-email'); }
    expect(second.path !== first.path && /new link/i.test(second.subject), `no new confirmation link was emailed (subject "${second.subject}")`);
    await pub.goto(first.path);
    await pub.waitText('A newer confirmation link was sent');
    await check('auth_verify_replaced');
    await pub.goto(second.path);
    await pub.waitText('Confirm my email');
    await check('auth_verify_email');
    await pub.click('Confirm my email', 'button');
    await pub.waitText('Your email is confirmed');
    await check('auth_verify_done');
    await pub.goto('/forgot-password');
    await pub.fillSel('#forgot-email', who.email);
    await pub.clickSel('form button[type=submit]');
    await pub.waitText(GENERIC_EMAIL_REPLY);
    await check('auth_forgot_sent');
    await pub.goto((await emailedLink(who.email, '/reset-password')).path);
    await pub.waitText('Save new password');
    await check('auth_reset_form');
    await pub.fillSel('#reset-password', 'Phone5678'); await pub.fillSel('#reset-confirm', 'Phone5678');
    await pub.click('Save new password', 'button');
    await pub.waitText('Your password has been changed');
    await check('auth_reset_done');
    // Signing up with an address that already has an account looks exactly the same; only the mailbox learns more.
    await pub.goto('/signup');
    await pub.fill('Full name', 'Someone Else'); await pub.fill('Work email', owner.email);
    await pub.fill('Company / workspace name', `Duplicate Org ${RUN}`);
    await pub.fill('Password', 'Another123'); await pub.fill('Confirm password', 'Another123');
    await pub.clickSel('form button[type=submit]');
    await pub.waitText(GENERIC_EMAIL_REPLY);
    expect(await pub.hasText('Check your email'), 'a registered address got a different page');
    const help = Date.now() + 15000;
    while (Date.now() < help && !mailTo(owner.email).some(m => /sign-in help/i.test(m.subject))) await sleep(150);
    expect(mailTo(owner.email).some(m => /sign-in help/i.test(m.subject)), 'no sign-in help email for the registered address');
    expect((await pub.api('GET', '/auth/me')).status === 401, 'a phone flow signed the visitor in');
    expect(!offenders.length, offenders.join(' | '));
  });
  await admin.viewport(1280, 860);

  await step('booking and invitation emails render with the product header, the business first and the footer (desktop and phone widths)', null, async () => {
    const viewer = await browser.newPage({ incognito: true, label: 'email-viewer' });
    for (const name of ['confirmation', 'cancellation', 'invitation']) {
      const html = emailRenders[name];
      expect(html, `${name} email HTML was not captured`);
      for (const width of [640, 375]) {
        await viewer.viewport(width, 900, width < 500);
        await viewer.renderHtml(html);
        const r = await viewer.eval(`({ text: document.body.innerText.replace(/\\s+/g, ' ').trim(), wide: document.documentElement.scrollWidth > ${width} + 1, images: document.images.length })`);
        expect(r.text.startsWith(`${PRODUCT} ${owner.company}`), `${name} at ${width}px starts "${r.text.slice(0, 80)}"`);
        expect(r.text.endsWith(`${PRODUCT} · ${ATTRIBUTION}`), `${name} at ${width}px ends "${r.text.slice(-80)}"`);
        expect(!r.wide && r.images === 0, `${name} at ${width}px: wider than the screen ${r.wide}, images ${r.images}`);
        await viewer.shotFull(`email_${name}_${width}`);
      }
    }
  });

  await step('account emails (confirm, new link, sign-in help, reset, password changed) render with the product header and the platform footer (desktop and phone widths)', null, async () => {
    const viewer = await browser.newPage({ incognito: true, label: 'account-email-viewer' });
    const kinds = { verify: 'Confirm your email for', verify_again: 'Your new link to confirm', existing_account: 'Sign-in help for', password_reset: 'Reset your', password_changed: 'password was changed' };
    for (const [kind, subject] of Object.entries(kinds)) {
      const m = mail.find(x => x.subject.includes(subject) && x.subject.includes(PRODUCT));
      expect(m, `no "${subject}" email was captured`);
      const html = htmlPart(m.body);
      expect(html, `${kind}: no HTML part`);
      for (const width of [640, 375]) {
        await viewer.viewport(width, 900, width < 500);
        await viewer.renderHtml(html);
        const r = await viewer.eval(`({ text: document.body.innerText.replace(/\\s+/g, ' ').trim(), wide: document.documentElement.scrollWidth > ${width} + 1, images: document.images.length, links: [...document.querySelectorAll('a[href]')].map(a => a.getAttribute('href')) })`);
        expect(r.text.startsWith(PRODUCT), `${kind} at ${width}px starts "${r.text.slice(0, 80)}"`);
        expect(r.text.includes(`Sent by ${PRODUCT}.`) && r.text.endsWith(`${PRODUCT} · ${ATTRIBUTION}`), `${kind} at ${width}px ends "${r.text.slice(-100)}"`);
        expect(!r.wide && r.images === 0, `${kind} at ${width}px: wider than the screen ${r.wide}, images ${r.images}`);
        expect(r.links.length && r.links.every(h => h.startsWith(ORIGIN + '/') && !/[?&]token=/.test(h)), `${kind}: links ${r.links.join(', ')}`);
        await viewer.shotFull(`email_account_${kind}_${width}`);
      }
    }
  });

  // 13. Failure handling, restart, expired session
  await step('server offline: pages show errors and Settings refuses to save', admin, async () => {
    await admin.goto('/dashboard'); await admin.waitText('Dashboard');
    await stopApi();
    try {
      await admin.click('Appointments', 'a');
      await admin.waitText('Failed to load appointments');
      expect((await admin.path()) === '/appointments', 'redirected away instead of showing the error');
      await admin.click('Settings', 'a');
      await admin.click('Booking Rules', 'button,a,[role=tab]');
      await admin.waitText('Could not load current settings');
      const disabled = await admin.eval('[...document.querySelectorAll("button")].filter(b => b.textContent.includes("Save Changes")).every(b => b.disabled)');
      expect(disabled, 'Save Changes enabled while settings failed to load');
      await admin.click('Dashboard', 'a');
      await admin.waitText('Could not load dashboard data');
      if (SAME_ORIGIN) {
        // The stopped process also served the page, so a full reload cannot load the app at all (the browser shows
        // its own error); the in-app outage messages above are what this mode can check.
        console.log('[same-origin] outage + full reload not checked: the process that serves the app is the one stopped');
      } else {
        await admin.reload();
        await admin.waitText(`Cannot reach the ${PRODUCT} server`);
        expect((await admin.path()) !== '/login', 'outage sent the user to the login page');
        await admin.shot('offline_reload');
      }
    } finally { await startApi(); }
    // Default mode: Retry on the connection screen shown after the reload. Same origin: no such screen; the app recovers
    // with the next navigation once the server is back.
    if (SAME_ORIGIN) await admin.goto('/dashboard'); else await admin.click('Retry');
    await admin.waitText('Dashboard');
  });
  await step('a session check that never answers ends on the connection screen with Retry, not an endless loader', admin, async () => {
    await admin.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/auth/me', requestStage: 'Request' }] });
    const held = [];
    const stop = admin.on('Fetch.requestPaused', p => { held.push(p.requestId); }); // accepted, never answered
    try {
      await admin.send('Page.navigate', { url: ORIGIN + '/appointments/new' });
      await admin.waitText(`Cannot reach the ${PRODUCT} server`, 25000);
      expect(held.length > 0, 'the session check was not held');
      await admin.waitText('The server did not answer within 15 seconds');
    } finally {
      stop();
      for (const requestId of held) await admin.send('Fetch.continueRequest', { requestId }).catch(() => {});
      await admin.send('Fetch.disable');
    }
    await admin.click('Retry');
    await admin.waitFor('!!document.querySelector("main h1") && document.querySelector("main h1").textContent.includes("New Appointment")', 15000);
  });
  await step('data persists after a backend restart (bookings, staff, currency, emails)', admin, async () => {
    await admin.goto(`/customers/${ids.customer}`);
    await admin.waitText(names.customer);
    await admin.waitText('Cancelled');
    const pubAppt = (await admin.api('GET', `/appointments?q=${ids.ref}`)).body.data[0];
    expect(pubAppt.status === 'cancelled' && pubAppt.startTime === '14:00', 'public booking state lost');
    expect((await admin.api('GET', `/staff/${ids.staff1}`)).body.data.workingHours.saturday.enabled === true, 'staff hours lost');
    expect((await admin.api('GET', '/settings')).body.data.currency === 'INR', 'currency lost');
    expect((await admin.api('GET', `/appointments/${ids.publicAppt}/emails`)).body.data.length >= 3, 'email history lost');
  });
  await step('expired session redirects to login on the next action', admin, async () => {
    await admin.goto('/dashboard'); await admin.waitText('Dashboard');
    await admin.send('Network.clearBrowserCookies');
    await admin.click('Customers', 'a');
    await admin.waitFor('location.pathname === "/login"', 8000);
  });

  // ── Report
  const a11yFlat = Object.entries(a11y).flatMap(([p, list]) => list.map(i => `${p}: ${i}`));
  fs.writeFileSync(path.join(OUT, 'report.json'), redactSecrets(JSON.stringify({ results, consoleIssues, a11y, mobile, emails: mail.map(m => ({ to: m.to, subject: m.subject })) }, null, 2)));
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} browser checks passed`);
  console.log(`emails captured by the local SMTP catcher: ${mail.length}`);
  console.log(`console issues: ${consoleIssues.length} (exceptions: ${consoleIssues.filter(c => c.kind === 'exception').length})`);
  console.log(`accessibility findings: ${a11yFlat.length}`);
  if (ISOLATED) {
    const answered = [...externalRequests.entries()].filter(([, v]) => v.answered);
    console.log(`[isolation] page requests to outside hosts: ${externalRequests.size} attempted, ${answered.length} answered`);
    for (const host of [...new Set([...externalRequests.keys()].map(u => new URL(u).host))]) console.log(`  [isolation] attempted host: ${host}`);
    for (const [u, v] of answered) console.log(`  [isolation] ANSWERED ${v.status} from ${v.remote || '?'}: ${u.slice(0, 120)}`);
  }
  for (const i of [...new Set(a11yFlat)].slice(0, 40)) console.log('  a11y', i);
  const grouped = {};
  for (const c of consoleIssues) { const k = `${c.kind}: ${c.text.slice(0, 140)}`; grouped[k] = (grouped[k] ?? []).concat(c.step); }
  for (const [k, steps] of Object.entries(grouped)) console.log(`  console x${steps.length} [${[...new Set(steps)].slice(0, 3).join(' / ')}] ${k}`);
}

try { await main(); }
catch (e) {
  record(cdpStats.closed ? 'harness aborted' : 'harness crashed', false, cdpStats.closed ? e.message : e.stack);
  if (cdpStats.closed) {
    const events = powerEventsDuringRun();
    console.log(events.length ? `[diagnostics] system power events during the run:\n  ${events.join('\n  ')}` : '[diagnostics] no system power events were recorded during the run');
  }
}
finally {
  try { keepAwake?.kill(); } catch { /* ignore */ }
  cdpShuttingDown = true;
  try { chrome?.kill(); } catch { /* ignore */ }
  web?.close();
  await stopApi();
  await new Promise(r => (smtpServer ? smtpServer.close(r) : r()));
  await sleep(500);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(DB_FILE + suffix, { force: true, maxRetries: 10, retryDelay: 200 }); }
    catch (e) { console.log(`[cleanup] could not remove ${DB_FILE + suffix}: ${e.code ?? e.message}`); }
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* chrome may still hold files */ }
  cdpDump('end of run');
  console.log(`[diagnostics] CDP messages sent=${cdpStats.sent} received=${cdpStats.received} bytesIn=${cdpStats.bytesIn} closed=${JSON.stringify(cdpStats.closed)}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
