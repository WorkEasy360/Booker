// SMTP transport security: which TLS mode each configuration gives, the exact Nodemailer options the server uses,
// and real SMTP conversations with local test servers that check what actually happens on the wire.
// Nothing leaves the machine: every server listens on 127.0.0.1, and the test certificate is valid only for localhost.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AddressInfo } from 'net';
import { connect as tlsConnect } from 'tls';
import nodemailer from 'nodemailer';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { readEmailConfig, smtpTransportOptions, isLoopbackHost, type SmtpConfig } from '../services/email/config';
import { initEmail, sendAccountEmail, accountEmailsSettled } from '../services/email/notify';

jest.setTimeout(30_000);

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const CERT_FILE = path.join(__dirname, 'fixtures', 'smtp-tls', 'localhost-cert.pem');
const TLS_FILES = { key: fs.readFileSync(path.join(__dirname, 'fixtures', 'smtp-tls', 'localhost-key.pem')), cert: fs.readFileSync(CERT_FILE) };
const CLIENT = path.join(__dirname, 'smtp-tls-client.ts');
const WRONG_HOST_CERT_FILE = path.join(__dirname, 'fixtures', 'smtp-tls', 'wrong-host-cert.pem');
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173', EMAIL_FROM: 'Test <test@example.com>' };

// Clearly fake credentials; tests check they never reach the wire unencrypted, the logs or error messages.
const USER = 'test-smtp-user';
const PASS = 'test-smtp-password-not-real';
const BASE = { EMAIL_TRANSPORT: 'smtp', EMAIL_FROM: 'WorkeasyBooking <bookings@example.test>', PUBLIC_APP_URL: 'https://book.example.test' };
const PRODUCTION = { ...BASE, NODE_ENV: 'production', SMTP_USER: USER, SMTP_PASS: PASS };

const smtpConfig = (env: Record<string, string | undefined>) => readEmailConfig(env as NodeJS.ProcessEnv) as SmtpConfig;
const refusal = (env: Record<string, string | undefined>) => {
  try { readEmailConfig(env as NodeJS.ProcessEnv); return null; } catch (e) { return (e as Error).message; }
};

afterAll(() => { initEmail(MEMORY_ENV); });

describe('SMTP configuration: the TLS mode and transport options each setting gives', () => {
  it('port 465 with SMTP_SECURE=true: TLS from the first byte, TLS 1.2 or later, certificates verified', () => {
    const cfg = smtpConfig({ ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true' });
    expect(cfg.tls).toBe('implicit');
    const options = smtpTransportOptions(cfg);
    expect(options).toEqual({
      host: 'smtp.example.test', port: 465, secure: true, requireTLS: false, tls: { minVersion: 'TLSv1.2' },
      auth: { user: USER, pass: PASS }, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
    });
  });

  it('port 587 in production: STARTTLS is required, not merely used when offered', () => {
    const cfg = smtpConfig({ ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'false' });
    expect(cfg.tls).toBe('starttls');
    expect(smtpTransportOptions(cfg)).toMatchObject({ secure: false, requireTLS: true, tls: { minVersion: 'TLSv1.2' } });
  });

  it('SMTP_SECURE defaults to false, which means STARTTLS required (never plaintext) for a real mail server', () => {
    const cfg = smtpConfig({ ...PRODUCTION, SMTP_HOST: 'smtp.example.test' });
    expect(cfg.port).toBe(587);
    expect(smtpTransportOptions(cfg)).toMatchObject({ secure: false, requireTLS: true });
  });

  it('nothing in the options can weaken TLS: no certificate bypass, no ignoreTLS, no opportunistic fallback', () => {
    for (const env of [
      { ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true' },
      { ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' },
      { ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' },
    ]) {
      const options = smtpTransportOptions(smtpConfig(env)) as Record<string, unknown>;
      const text = JSON.stringify(options);
      expect(text).not.toMatch(/rejectUnauthorized|ignoreTLS|opportunisticTLS|checkServerIdentity|ciphers/);
      expect(options.tls).toEqual({ minVersion: 'TLSv1.2' });
    }
  });

  it('production requires SMTP_USER and SMTP_PASS (authenticated SMTP)', () => {
    const withoutBoth = refusal({ ...BASE, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' });
    expect(withoutBoth).toMatch(/SMTP_USER and SMTP_PASS are required in production/);
    const withoutPass = refusal({ ...BASE, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.test', SMTP_USER: USER });
    expect(withoutPass).toMatch(/Set both SMTP_USER and SMTP_PASS, or neither/);
    expect(withoutPass).not.toContain(USER);
  });

  it('production never uses the local plaintext exception, not even for 127.0.0.1 or localhost', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      const cfg = smtpConfig({ ...PRODUCTION, SMTP_HOST: host, SMTP_PORT: '1025' });
      expect(cfg.tls).toBe('starttls');
      expect(smtpTransportOptions(cfg).requireTLS).toBe(true);
    }
  });

  it('outside production a real (non-loopback) mail server needs STARTTLS too', () => {
    for (const nodeEnv of [undefined, 'development', 'test']) {
      const cfg = smtpConfig({ ...BASE, NODE_ENV: nodeEnv, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '2525' });
      expect(cfg.tls).toBe('starttls');
      expect(smtpTransportOptions(cfg).requireTLS).toBe(true);
    }
  });

  it('the local mail catcher (127.0.0.1:1025, no credentials, not production) stays allowed without TLS', () => {
    for (const nodeEnv of [undefined, 'development', 'test']) {
      for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
        const cfg = smtpConfig({ ...BASE, NODE_ENV: nodeEnv, SMTP_HOST: host, SMTP_PORT: '1025', SMTP_SECURE: 'false' });
        expect(cfg.tls).toBe('local-plaintext');
        expect(smtpTransportOptions(cfg)).toMatchObject({ secure: false, requireTLS: false, auth: undefined });
      }
    }
  });

  it('only exact loopback addresses count as local; look-alike names and other addresses do not', () => {
    for (const host of ['localhost', '127.0.0.1', '127.8.9.10', '::1', '[::1]', '0:0:0:0:0:0:0:1']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['localhost.example.test', '127.0.0.1.nip.io', 'my-localhost', '0.0.0.0', '10.0.0.5', '192.168.1.20', '128.0.0.1', '::2', 'smtp.example.test']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it('a missing or invalid host or port is refused at startup', () => {
    expect(refusal({ ...BASE })).toMatch(/SMTP_HOST is required/);
    for (const host of ['smtp://smtp.example.test', 'smtp.example.test:587', 'smtp example.test', 'smtp.example.test/x', '-', '...']) {
      expect(refusal({ ...BASE, SMTP_HOST: host })).toMatch(/SMTP_HOST must be only a host name or IP address/);
    }
    for (const port of ['0', '70000', 'abc', '587.5', '-25']) {
      expect(refusal({ ...BASE, SMTP_HOST: 'smtp.example.test', SMTP_PORT: port })).toMatch(/SMTP_PORT must be a whole number from 1 to 65535/);
    }
    expect(refusal({ ...BASE, SMTP_HOST: 'smtp.example.test', SMTP_SECURE: 'yes' })).toMatch(/SMTP_SECURE: must be true or false/);
  });

  it('port and TLS settings that can never connect are refused: 465 without TLS, 587 with TLS from the start', () => {
    expect(refusal({ ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'false' })).toMatch(/port 465 uses TLS from the start: set SMTP_SECURE=true/);
    expect(refusal({ ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_SECURE: 'true' })).toMatch(/port 587 uses STARTTLS: set SMTP_SECURE=false/);
  });

  it('error messages name the settings, never their values', () => {
    const values = { user: 'user-VALUE-4567', pass: 'pass-VALUE-8901', host: 'bad host VALUE-2345', from: 'x' };
    const cases = [
      { ...BASE, NODE_ENV: 'production', SMTP_HOST: 'smtp.example.test', SMTP_PASS: values.pass },
      { ...BASE, SMTP_HOST: values.host, SMTP_USER: values.user, SMTP_PASS: values.pass },
      { ...BASE, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'false', SMTP_USER: values.user, SMTP_PASS: values.pass },
      { ...BASE, EMAIL_FROM: values.from, SMTP_HOST: 'smtp.example.test', SMTP_USER: values.user, SMTP_PASS: values.pass },
    ];
    for (const env of cases) {
      const message = refusal(env);
      expect(message).toMatch(/^Invalid email configuration: /);
      for (const v of [values.user, values.pass, 'VALUE-2345']) expect(message).not.toContain(v);
    }
  });

  it('the server builds its transport from exactly these options', () => {
    const spy = jest.spyOn(nodemailer, 'createTransport');
    try {
      const env = { ...PRODUCTION, SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587' };
      initEmail(env as NodeJS.ProcessEnv);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toEqual(smtpTransportOptions(smtpConfig(env)));
      expect(spy.mock.calls[0][0]).toMatchObject({ requireTLS: true, secure: false });
    } finally {
      spy.mockRestore();
      initEmail(MEMORY_ENV);
    }
  });
});

// ─── Real SMTP conversations ──────────────────────────────────────────────────

interface TestServer { port: number; connections: number; auths: Array<{ secure: boolean; user: string }>; messages: Array<{ secure: boolean }>; close: () => Promise<void> }

async function startServer(options: Partial<SMTPServerOptions>, authReply?: (user: string, pass: string) => Error | null): Promise<TestServer> {
  const state = { connections: 0, auths: [] as TestServer['auths'], messages: [] as TestServer['messages'] };
  const server = new SMTPServer({
    logger: false,
    authOptional: true,
    ...options,
    onAuth(auth, session, callback) {
      state.auths.push({ secure: !!session.secure, user: String(auth.username) });
      const err = authReply?.(String(auth.username), String(auth.password));
      if (err) { callback(err); return; }
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      stream.on('data', () => undefined);
      stream.on('end', () => { state.messages.push({ secure: !!session.secure }); callback(); });
    },
  });
  server.server.on('connection', () => { state.connections++; });
  // A client that refuses the certificate closes the socket mid-handshake; the server reports that as an error event.
  server.on('error', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return Object.assign(state, { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }) as TestServer;
}

/** Sends one message with the given configuration's exact options, in this process (where the test certificate is not trusted). */
async function sendHere(env: Record<string, string | undefined>): Promise<{ ok: boolean; code?: string; message?: string }> {
  const transport = nodemailer.createTransport(smtpTransportOptions(smtpConfig(env)));
  try {
    await transport.sendMail({ from: BASE.EMAIL_FROM, to: 'tls-check@example.test', subject: 'TLS check', text: 'TLS check' });
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: err.message };
  } finally {
    transport.close();
  }
}

/** Sends one message from a new Node process that trusts the test certificate (NODE_EXTRA_CA_CERTS). */
function sendTrusted(env: Record<string, string>, caFile = CERT_FILE): Promise<{ ok: boolean; code?: string; message?: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, NODE_EXTRA_CA_CERTS: caFile };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLIENT], { cwd: SERVER_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errOut += d; });
    child.on('error', reject);
    child.on('close', () => {
      const line = out.trim().split(/\r?\n/).pop() ?? '';
      try { resolve(JSON.parse(line)); } catch { reject(new Error(`client printed no result: ${errOut.slice(0, 500)}`)); }
    });
  });
}

describe('real SMTP conversations use TLS as configured, and never fall back to plaintext', () => {
  it('(why requireTLS is set) with Nodemailer\'s defaults, a server that does not offer STARTTLS receives the password in plaintext', async () => {
    const server = await startServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true });
    try {
      const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.port, secure: false, auth: { user: USER, pass: PASS } });
      await transport.sendMail({ from: BASE.EMAIL_FROM, to: 'tls-check@example.test', subject: 'x', text: 'x' });
      transport.close();
      expect(server.auths).toEqual([{ secure: false, user: USER }]);
    } finally { await server.close(); }
  });

  it('STARTTLS required: a server without STARTTLS gets no sign-in and no message, and there is no second plaintext attempt', async () => {
    const server = await startServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true });
    try {
      const result = await sendHere({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'false' });
      expect(result).toMatchObject({ ok: false, code: 'ETLS' });
      expect(result.message).toMatch(/STARTTLS/);
      expect(server.auths).toHaveLength(0);
      expect(server.messages).toHaveLength(0);
      expect(server.connections).toBe(1);
    } finally { await server.close(); }
  });

  it('STARTTLS with a certificate this process does not trust: the connection stops (verification is not skipped)', async () => {
    const server = await startServer({ ...TLS_FILES, allowInsecureAuth: false });
    try {
      const result = await sendHere({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'false' });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/certificate/i);
      expect(server.auths).toHaveLength(0);
      expect(server.messages).toHaveLength(0);
      expect(server.connections).toBe(1);
    } finally { await server.close(); }
  });

  it('implicit TLS with a certificate this process does not trust: the connection stops the same way', async () => {
    const server = await startServer({ ...TLS_FILES, secure: true });
    try {
      const result = await sendHere({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'true' });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/certificate/i);
      expect(server.auths).toHaveLength(0);
      expect(server.messages).toHaveLength(0);
      expect(server.connections).toBe(1);
    } finally { await server.close(); }
  });

  it('with the certificate trusted, STARTTLS delivers and signs in only after the connection is encrypted', async () => {
    const server = await startServer({ ...TLS_FILES }, (user, pass) => (user === USER && pass === PASS ? null : new Error('wrong credentials')));
    try {
      const result = await sendTrusted({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'false' });
      expect(result).toMatchObject({ ok: true });
      expect(server.auths).toEqual([{ secure: true, user: USER }]);
      expect(server.messages).toEqual([{ secure: true }]);
    } finally { await server.close(); }
  });

  it('with the certificate trusted, implicit TLS (the port 465 mode) delivers', async () => {
    const server = await startServer({ ...TLS_FILES, secure: true }, (user, pass) => (user === USER && pass === PASS ? null : new Error('wrong credentials')));
    try {
      const result = await sendTrusted({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'true' });
      expect(result).toMatchObject({ ok: true });
      expect(server.auths).toEqual([{ secure: true, user: USER }]);
      expect(server.messages).toEqual([{ secure: true }]);
    } finally { await server.close(); }
  });

  it('a mail server that offers only TLS 1.1 is refused, with STARTTLS and with implicit TLS, although its certificate is trusted', async () => {
    // The server really speaks TLS 1.1 (shown by a client that allows it); the app's minimum of TLS 1.2 refuses it.
    const tls11 = { ...TLS_FILES, minVersion: 'TLSv1' as const, maxVersion: 'TLSv1.1' as const, ciphers: 'DEFAULT@SECLEVEL=0' };
    const implicit = await startServer({ ...tls11, secure: true }, () => null);
    try {
      const legacy = await new Promise<string>(resolve => {
        const socket = tlsConnect({ host: '127.0.0.1', port: implicit.port, ca: TLS_FILES.cert, minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' }, () => {
          resolve(String(socket.getProtocol())); socket.destroy();
        });
        socket.on('error', e => resolve(`error: ${e.message}`));
      });
      expect(legacy).toBe('TLSv1.1');
      const result = await sendTrusted({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(implicit.port), SMTP_SECURE: 'true' });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/protocol|version/i);
      expect(implicit.auths).toHaveLength(0);
      expect(implicit.messages).toHaveLength(0);
    } finally { await implicit.close(); }

    const starttls = await startServer({ ...tls11 }, () => null);
    try {
      const result = await sendTrusted({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(starttls.port), SMTP_SECURE: 'false' });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/protocol|version/i);
      expect(starttls.auths).toHaveLength(0);
      expect(starttls.messages).toHaveLength(0);
    } finally { await starttls.close(); }
  });

  it('host names are checked: a trusted certificate issued for another name is refused', async () => {
    // The client trusts this certificate (NODE_EXTRA_CA_CERTS), but it names wrong-host.example.test, not 127.0.0.1.
    const wrongHost = { key: fs.readFileSync(path.join(__dirname, 'fixtures', 'smtp-tls', 'wrong-host-key.pem')), cert: fs.readFileSync(WRONG_HOST_CERT_FILE) };
    for (const secure of [true, false]) {
      const server = await startServer({ ...wrongHost, secure }, () => null);
      try {
        const result = await sendTrusted({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: String(secure) }, WRONG_HOST_CERT_FILE);
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/altnames|does not match|not in the cert/i);
        expect(server.auths).toHaveLength(0);
        expect(server.messages).toHaveLength(0);
      } finally { await server.close(); }
    }
  });

  it('the same trusted server is refused when the client does not trust its certificate (the trust comes only from the CA file)', async () => {
    const server = await startServer({ ...TLS_FILES, secure: true });
    try {
      const result = await sendHere({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'true' });
      expect(result.ok).toBe(false);
      expect(server.messages).toHaveLength(0);
    } finally { await server.close(); }
  });

  it('the local mail catcher setup (127.0.0.1, no credentials, not production) still delivers without TLS', async () => {
    const server = await startServer({ disabledCommands: ['AUTH', 'STARTTLS'] });
    try {
      const result = await sendHere({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'false' });
      expect(result).toEqual({ ok: true });
      expect(server.messages).toEqual([{ secure: false }]);
    } finally { await server.close(); }
  });
});

/** Runs `npm run email:test` (the script) in its own process. server/.env is never read: DOTENV_CONFIG_PATH points nowhere. */
function runEmailTest(env: Record<string, string>, args: string[], trustTestCertificate: boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, DOTENV_CONFIG_PATH: path.join(SERVER_ROOT, 'no-such-dotenv-file-for-tests') };
  delete childEnv.NODE_EXTRA_CA_CERTS;
  if (trustTestCertificate) childEnv.NODE_EXTRA_CA_CERTS = CERT_FILE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'email-test.ts'), ...args], { cwd: SERVER_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

describe('npm run email:test (the staging delivery check) uses the same TLS rules and never prints credentials', () => {
  const okAuth = (user: string, pass: string) => (user === USER && pass === PASS ? null : new Error('wrong credentials'));
  const prodEnv = (port: number) => ({ ...PRODUCTION, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_SECURE: 'false' }) as Record<string, string>;

  it('--verify-only connects, requires STARTTLS, signs in over TLS, and sends nothing', async () => {
    const server = await startServer({ ...TLS_FILES }, okAuth);
    try {
      const run = await runEmailTest(prodEnv(server.port), ['--verify-only'], true);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/STARTTLS required/);
      expect(run.stdout).toMatch(/Connection, TLS and sign-in: OK/);
      expect(run.stdout).toMatch(/No email was sent \(--verify-only\)/);
      expect(server.auths).toEqual([{ secure: true, user: USER }]);
      expect(server.messages).toHaveLength(0);
      expect(run.stdout + run.stderr).not.toContain(PASS);
    } finally { await server.close(); }
  });

  it('--to sends exactly one message and says that acceptance is not delivery', async () => {
    const server = await startServer({ ...TLS_FILES }, okAuth);
    try {
      const run = await runEmailTest(prodEnv(server.port), ['--to', 'inbox-check@example.test'], true);
      expect(run.code).toBe(0);
      expect(server.messages).toEqual([{ secure: true }]);
      expect(run.stdout).toMatch(/Accepted by the mail server: yes/);
      expect(run.stdout).toMatch(/Message-ID: </);
      expect(run.stdout).toMatch(/Mail server reply: 250/);
      expect(run.stdout).toMatch(/Accepted is not delivered/);
      expect(run.stdout + run.stderr).not.toContain(PASS);
    } finally { await server.close(); }
  });

  it('a refused sign-in names SMTP_USER and SMTP_PASS, even when the server repeats them, without printing either', async () => {
    const server = await startServer({ ...TLS_FILES }, (user, pass) => new Error(`Authentication failed for ${user} using ${pass}`));
    try {
      const run = await runEmailTest(prodEnv(server.port), ['--verify-only'], true);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/Not OK at: connect, TLS and sign-in/);
      expect(run.stderr).toMatch(/What to check: Sign-in was refused: check SMTP_USER and SMTP_PASS/);
      expect(run.stderr).toContain('[redacted]');
      expect(run.stdout + run.stderr).not.toContain(USER);
      expect(run.stdout + run.stderr).not.toContain(PASS);
      expect(server.messages).toHaveLength(0);
    } finally { await server.close(); }
  });

  it('an untrusted certificate is reported as a TLS problem; nothing is signed in or sent', async () => {
    const server = await startServer({ ...TLS_FILES }, okAuth);
    try {
      const run = await runEmailTest(prodEnv(server.port), ['--to', 'inbox-check@example.test'], false);
      expect(run.code).toBe(1);
      expect(run.stderr).toMatch(/What to check: TLS failed: check that SMTP_HOST/);
      expect(server.auths).toHaveLength(0);
      expect(server.messages).toHaveLength(0);
    } finally { await server.close(); }
  });

  it('an unreachable mail server names SMTP_HOST and SMTP_PORT', async () => {
    const server = await startServer({ ...TLS_FILES }, okAuth);
    const closedPort = server.port;
    await server.close();
    const run = await runEmailTest(prodEnv(closedPort), ['--verify-only'], true);
    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/What to check: Could not connect: check SMTP_HOST and SMTP_PORT/);
  });

  it('production settings without credentials are refused before any connection', async () => {
    const server = await startServer({ ...TLS_FILES }, okAuth);
    try {
      const env = { ...BASE, NODE_ENV: 'production', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_USER: '', SMTP_PASS: '' } as Record<string, string>;
      const run = await runEmailTest(env, ['--verify-only'], true);
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/SMTP_USER and SMTP_PASS are required in production/);
      expect(server.connections).toBe(0);
    } finally { await server.close(); }
  });

  it('without --to or --verify-only it only prints how to use it', async () => {
    const run = await runEmailTest({ ...BASE, SMTP_HOST: '127.0.0.1' } as Record<string, string>, [], true);
    expect(run.code).toBe(2);
    expect(run.stderr).toMatch(/--verify-only/);
  });
});

describe('credentials stay out of logs and error messages', () => {
  it('a server that repeats the user name and password in its sign-in error does not get them into the log', async () => {
    const server = await startServer({ disabledCommands: ['STARTTLS'], allowInsecureAuth: true }, (user, pass) => new Error(`Authentication failed for ${user} using ${pass}`));
    const lines: string[] = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
    try {
      // Local catcher mode (not production, loopback), with credentials, so the server can answer the sign-in.
      initEmail({ ...BASE, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.port), SMTP_SECURE: 'false', SMTP_USER: USER, SMTP_PASS: PASS } as NodeJS.ProcessEnv);
      sendAccountEmail('password_reset', 'reset-check@example.test', { name: 'Check', token: 'T'.repeat(43) });
      await accountEmailsSettled();
      const text = lines.join('\n');
      expect(server.auths).toHaveLength(1);
      expect(text).toMatch(/\[email\] account password_reset: FAILED via smtp after 1 attempt\(s\)/);
      expect(text).toContain('[redacted]');
      expect(text).not.toContain(USER);
      expect(text).not.toContain(PASS);
      expect(text).not.toContain('T'.repeat(43));
    } finally {
      warn.mockRestore();
      log.mockRestore();
      initEmail(MEMORY_ENV);
      await server.close();
    }
  });
});
