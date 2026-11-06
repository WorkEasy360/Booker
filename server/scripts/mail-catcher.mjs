// A local test inbox for development: an SMTP server on 127.0.0.1:1025 and a web inbox on http://127.0.0.1:8025
// (the same ports as Mailpit, so the same settings work for either). Nothing is relayed anywhere: every message stays in
// this process's memory and is gone when it stops. It only listens on 127.0.0.1, so other machines cannot read it.
//
//   cd server
//   npm run mail:catcher                    # or: npm run mail:catcher -- --smtp 1025 --http 8025
//
// Then point the API at it (see "Local email testing" in docs/EMAIL.md): EMAIL_TRANSPORT=smtp, SMTP_HOST=127.0.0.1,
// SMTP_PORT=1025, SMTP_SECURE=false, no SMTP_USER/SMTP_PASS.
//
// Failure simulation, for testing how the app handles a mail server that refuses a message:
//   a recipient whose address starts with "bounce"   is refused permanently  (550, like a mailbox that does not exist)
//   a recipient whose address starts with "tempfail" is refused temporarily  (451, like a busy server; the app retries)
//
// The console shows one line per message (time, subject, recipients), never the message body or its links.
// JSON for scripts: GET /api/messages (newest first), GET /api/messages/<id>, DELETE /api/messages.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const { SMTPServer } = createRequire(import.meta.url)('smtp-server');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(v) || v < 1 || v > 65535) { console.error(`${name} must be a port number`); process.exit(2); }
  return v;
};
const SMTP_PORT = arg('--smtp', 1025);
const HTTP_PORT = arg('--http', 8025);
const HOST = '127.0.0.1';
const KEEP = 200;                      // newest messages kept
const MAX_SIZE = 10 * 1024 * 1024;     // bytes per message
const messages = [];
const formToken = randomBytes(16).toString('hex');

// ─── Minimal MIME reading (enough for the app's own emails: multipart, quoted-printable, base64, UTF-8) ──────────

function splitHead(raw) {
  const at = raw.search(/\r?\n\r?\n/);
  const head = at < 0 ? raw : raw.slice(0, at);
  const body = at < 0 ? '' : raw.slice(at).replace(/^\r?\n\r?\n/, '');
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2];
  }
  return { headers, body };
}

function decodeWords(s = '') {
  // Whitespace between two encoded words is not part of the text (RFC 2047), so drop it before decoding.
  return s.replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset, enc, text) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return /utf-?8/i.test(charset) ? bytes.toString('utf8') : bytes.toString('latin1');
  });
}

function decodeBody(body, encoding = '') {
  const enc = encoding.toLowerCase();
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (enc === 'quoted-printable') {
    const latin = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(latin, 'latin1').toString('utf8');
  }
  return Buffer.from(body, 'latin1').toString('utf8');
}

function readParts(raw, out = { text: '', html: '' }) {
  const { headers, body } = splitHead(raw);
  const type = headers['content-type'] ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      readParts(part.replace(/^\r?\n/, ''), out);
    }
  } else if (/^text\/html/i.test(type) && !out.html) {
    out.html = decodeBody(body, headers['content-transfer-encoding']);
  } else if (/^text\/plain/i.test(type) && !out.text) {
    out.text = decodeBody(body, headers['content-transfer-encoding']);
  }
  return out;
}

function store(raw, envelope) {
  const { headers } = splitHead(raw);
  const { text, html } = readParts(raw);
  const msg = {
    id: randomBytes(6).toString('hex'),
    receivedAt: new Date().toISOString(),
    from: decodeWords(headers.from),
    to: envelope.rcptTo.map(r => r.address),
    subject: decodeWords(headers.subject),
    messageId: headers['message-id'] ?? null,
    size: Buffer.byteLength(raw, 'latin1'),
    text,
    html,
  };
  messages.unshift(msg);
  messages.length = Math.min(messages.length, KEEP);
  console.log(`${msg.receivedAt.slice(11, 19)}  received  "${msg.subject}"  to ${msg.to.join(', ')}`);
}

// ─── SMTP ─────────────────────────────────────────────────────────────────────

const smtp = new SMTPServer({
  // Plain local SMTP without sign-in: leave SMTP_USER and SMTP_PASS unset, so no credentials are ever sent here.
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  size: MAX_SIZE,
  logger: false,
  onRcptTo(address, _session, callback) {
    const local = address.address.toLowerCase();
    const refuse = (code, text) => {
      console.log(`${new Date().toISOString().slice(11, 19)}  refused   ${address.address} (simulated ${code})`);
      callback(Object.assign(new Error(text), { responseCode: code }));
    };
    if (local.startsWith('bounce')) return refuse(550, '5.1.1 Mailbox unavailable (simulated by the local mail catcher)');
    if (local.startsWith('tempfail')) return refuse(451, '4.3.0 Temporary failure, try again later (simulated by the local mail catcher)');
    callback();
  },
  onData(stream, session, callback) {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      if (stream.sizeExceeded) return callback(Object.assign(new Error('5.3.4 Message too big for the local mail catcher'), { responseCode: 552 }));
      store(Buffer.concat(chunks).toString('latin1'), session.envelope);
      callback();
    });
  },
});
smtp.on('error', e => console.error(`SMTP error: ${e.message}`));

// ─── Web inbox ────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = s => esc(s).replace(/https?:\/\/[^\s<>"']+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
const STYLE = `body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#13222E}header{background:#13222E;color:#fff;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}header a{color:#fff}main{padding:16px 20px;max-width:1000px}table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;word-break:break-word;background:#fff;padding:12px;border:1px solid #e5e7eb}iframe{width:100%;height:640px;border:1px solid #e5e7eb;background:#fff}button{cursor:pointer}.muted{color:#6b7280}`;
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — local test inbox</title><style>${STYLE}</style></head><body><header><strong>Local test inbox</strong><span>SMTP 127.0.0.1:${SMTP_PORT}</span><a href="/">All messages (${messages.length})</a></header><main>${body}</main></body></html>`;

function listPage() {
  const rows = messages.map(m => `<tr><td class="muted">${esc(m.receivedAt.replace('T', ' ').slice(0, 19))}</td><td>${esc(m.to.join(', '))}</td><td><a href="/message/${m.id}">${esc(m.subject || '(no subject)')}</a></td></tr>`).join('');
  return page('Inbox', `<form method="post" action="/clear"><input type="hidden" name="token" value="${formToken}"><button>Clear inbox</button> <span class="muted">Messages live in memory only; stopping the catcher deletes them.</span></form><p></p>`
    + (messages.length ? `<table><tr><th>Received (UTC)</th><th>To</th><th>Subject</th></tr>${rows}</table>` : '<p>No messages yet.</p>'));
}

function messagePage(m) {
  const html = m.html ? `<h3>HTML</h3><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(`<base target="_blank">${m.html}`)}"></iframe>` : '';
  return page(m.subject, `<h2>${esc(m.subject)}</h2><p class="muted">From ${esc(m.from)}<br>To ${esc(m.to.join(', '))}<br>Received ${esc(m.receivedAt)} · ${m.size} bytes</p><h3>Text</h3><pre>${linkify(m.text || '(no text part)')}</pre>${html}`);
}

const web = http.createServer((req, res) => {
  // Only answer requests addressed to this machine by name, so another website cannot reach the inbox through DNS tricks.
  if (!new Set([`127.0.0.1:${HTTP_PORT}`, `localhost:${HTTP_PORT}`]).has(req.headers.host ?? '')) { res.writeHead(421); res.end(); return; }
  const send = (status, type, body) => {
    res.writeHead(status, {
      'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; form-action 'self'; base-uri 'none'",
    });
    res.end(body);
  };
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const id = /^\/(?:api\/messages|message)\/([0-9a-f]+)$/.exec(url.pathname)?.[1];
  const found = id && messages.find(m => m.id === id);

  if (req.method === 'GET' && url.pathname === '/') return send(200, 'text/html; charset=utf-8', listPage());
  if (req.method === 'GET' && url.pathname.startsWith('/message/')) return found ? send(200, 'text/html; charset=utf-8', messagePage(found)) : send(404, 'text/plain', 'Not found');
  if (req.method === 'GET' && url.pathname === '/api/messages') return send(200, 'application/json', JSON.stringify(messages));
  if (req.method === 'GET' && url.pathname.startsWith('/api/messages/')) return found ? send(200, 'application/json', JSON.stringify(found)) : send(404, 'application/json', '{"error":"not found"}');
  if (req.method === 'DELETE' && url.pathname === '/api/messages') { messages.length = 0; return send(204, 'text/plain', ''); }
  if (req.method === 'POST' && url.pathname === '/clear') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1000) req.destroy(); });
    req.on('end', () => {
      if (new URLSearchParams(body).get('token') !== formToken) return send(403, 'text/plain', 'Refused');
      messages.length = 0;
      res.writeHead(303, { Location: '/' }); res.end();
    });
    return;
  }
  send(404, 'text/plain', 'Not found');
});

const fail = what => e => { console.error(`Could not start the ${what}: ${e.code === 'EADDRINUSE' ? 'the port is already in use (is Mailpit or another catcher running?)' : e.message}`); process.exit(1); };
smtp.server.once('error', fail(`SMTP server on ${HOST}:${SMTP_PORT}`));
web.once('error', fail(`web inbox on ${HOST}:${HTTP_PORT}`));
smtp.listen(SMTP_PORT, HOST, () => {
  web.listen(HTTP_PORT, HOST, () => {
    console.log(`Local test inbox running. Nothing is relayed; messages stay in memory until you stop it (Ctrl+C).`);
    console.log(`  SMTP  ${HOST}:${SMTP_PORT}   (EMAIL_TRANSPORT=smtp SMTP_HOST=${HOST} SMTP_PORT=${SMTP_PORT} SMTP_SECURE=false, no SMTP_USER/SMTP_PASS)`);
    console.log(`  Inbox http://localhost:${HTTP_PORT}`);
    console.log('  Addresses starting with "bounce" are refused with 550, "tempfail" with 451 (to test failure handling).');
  });
});
const stop = () => { web.close(); smtp.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
