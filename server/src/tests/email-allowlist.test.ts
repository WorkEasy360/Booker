// EMAIL_ALLOWED_RECIPIENTS: the matching rules, configuration that fails closed, and every kind of email refused
// before the mail server is contacted (booking, invitation, sign-up confirmation, new link, sign-in help, password
// reset, password changed, account-email retries, `npm run email:test`). An SMTP server inside this test counts every
// connection and recipient, so "never reached the transport" is observed, not inferred from a return value.
// Synthetic addresses at reserved names only (example.test, *.example, attacker.test); nothing leaves the machine and
// server/.env is never read (child processes get DOTENV_CONFIG_PATH pointing at a file that does not exist).

import request from 'supertest';
import { spawn } from 'child_process';
import fs from 'fs';
import net, { type AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { SMTPServer } from 'smtp-server';
import app from '../index';
import db from '../db/init';
import {
  readEmailConfig, parseRecipientAllowlist, isRecipientAllowed, recipientAllowlistDescription, RECIPIENT_NOT_ALLOWED,
} from '../services/email/config';
import {
  initEmail, testOutbox, accountEmailsSettled, processDueEmails, processDueAccountEmails, sendAccountEmail,
} from '../services/email/notify';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(120_000);

const RUN = Date.now().toString(36);
const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), `we360-allowlist-${RUN}-`));
const NO_DOTENV = path.join(TMP, 'no-such-dotenv-file');
const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv;
const PASSWORD = 'StartPass123';
const GENERIC = { data: { message: 'We’ll send an email with the next steps if the address can be used for this request.' } };

// The allowlist used by the flow tests: two exact addresses (one a plus-address) and one domain.
const EXACT = `qa-${RUN}@example.test`;
const EXACT_PLUS = `qa-${RUN}+cust1@example.test`;
const OTHER_PLUS = `qa-${RUN}+cust2@example.test`;
const ALLOW = ` ${EXACT} , ${EXACT_PLUS},@allowed.example `;

afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows may hold a handle briefly */ } });

// ─── The rules ───────────────────────────────────────────────────────────────

describe('matching rules', () => {
  const list = parseRecipientAllowlist('staging-test@example.test, staging-test+cust1@example.test, @allowed.example')!;
  const allowed = (to: unknown) => isRecipientAllowed(list, to);

  it('1. an exact address that is listed is allowed', () => {
    expect(allowed('staging-test@example.test')).toBe(true);
  });

  it('2. an exact address that is not listed is refused', () => {
    expect(allowed('someone@example.test')).toBe(false);
    expect(allowed('staging-test@example.org')).toBe(false);
  });

  it('3–4. a plus-address is allowed only when it is listed itself; the base and other tags are separate', () => {
    expect(allowed('staging-test+cust1@example.test')).toBe(true);
    expect(allowed('staging-test+cust2@example.test')).toBe(false);
    expect(allowed('staging-test+@example.test')).toBe(false);
    const baseOnly = parseRecipientAllowlist('staging-test@example.test')!;
    expect(isRecipientAllowed(baseOnly, 'staging-test+cust1@example.test')).toBe(false); // the base allows no tags
    const plusOnly = parseRecipientAllowlist('staging-test+cust1@example.test')!;
    expect(isRecipientAllowed(plusOnly, 'staging-test@example.test')).toBe(false);       // a tag does not allow the base
  });

  it('5–6. a domain entry allows exactly that domain, nothing else', () => {
    expect(allowed('anyone@allowed.example')).toBe(true);
    expect(allowed('first.last+tag@allowed.example')).toBe(true);
    expect(allowed('anyone@blocked.example')).toBe(false);
    expect(allowed('anyone@example.test')).toBe(false);
  });

  it('7. names that only look like the allowed domain are refused', () => {
    for (const to of [
      'user@allowed.example.attacker.test', 'user@attackerallowed.example', 'user@allowed-example.test',
      'allowed.example@attacker.test', 'user@allowed.example.', 'user@allowed.examplf',
    ]) expect([to, allowed(to)]).toEqual([to, false]);
  });

  it('8. a subdomain is not the domain', () => {
    expect(allowed('user@mail.allowed.example')).toBe(false);
    expect(allowed('user@a.b.allowed.example')).toBe(false);
  });

  it('9. lists, display names, header injection and malformed input never pass', () => {
    for (const to of [
      'staging-test@example.test,evil@attacker.test', 'staging-test@example.test;evil@attacker.test',
      'staging-test@example.test evil@attacker.test', '"Staging" <staging-test@example.test>', '<staging-test@example.test>',
      'staging-test@example.test\r\nBcc: evil@attacker.test', 'staging-test@example.test\nevil@attacker.test',
      'user%attacker.test@allowed.example', 'attacker.test!user@allowed.example', '"user"@allowed.example',
      'user(comment)@allowed.example', 'user@[127.0.0.1]', 'staging-test@@example.test', 'staging-test', '@allowed.example',
      'staging-test@', '', '   ', 'group:staging-test@example.test;', `${'a'.repeat(65)}@allowed.example`,
      'Karen@allowed.example', 'staging-tеst@example.test', // Kelvin sign; Cyrillic "е"
    ]) expect([to, allowed(to)]).toEqual([to, false]);
    for (const to of [undefined, null, 42, ['staging-test@example.test'], { address: 'staging-test@example.test' }]) {
      expect(allowed(to)).toBe(false);
    }
  });

  it('10. letter case and surrounding spaces are ignored, in the setting and in the recipient', () => {
    expect(allowed('  Staging-Test@Example.TEST ')).toBe(true);
    expect(allowed('ANYONE@ALLOWED.EXAMPLE')).toBe(true);
    const mixed = parseRecipientAllowlist('  QA@Example.Test ,  @Allowed.EXAMPLE  ')!;
    expect([...mixed.addresses, ...mixed.domains]).toEqual(['qa@example.test', 'allowed.example']);
    expect(isRecipientAllowed(mixed, 'qa@example.test')).toBe(true);
    expect(allowed('staging-test@example.test\t')).toBe(true); // surrounding whitespace only; inner whitespace never passes
    expect(allowed('staging test@example.test')).toBe(false);
  });

  it('11. a malformed setting is a configuration error, for every transport, and the message never repeats the value', () => {
    const bad = [
      '', '   ', ',', 'qa@example.test,', 'qa@example.test,,other@example.test', '*@example.test', 'qa+*@example.test',
      '@*.example.test', '@', '@example', '@.example.test', '@example.test.', '@-example.test', 'qa@', 'qa',
      'qa@@example.test', '<qa@example.test>', 'QA Team <qa@example.test>', 'qa@example.test; other@example.test',
      'q a@example.test', 'qä@example.test', 'qa@exämple.test', 'qa@example.test\nother@attacker.test', '@127.0.0.1',
      Array.from({ length: 101 }, (_, i) => `qa${i}@example.test`).join(','),
    ];
    for (const value of bad) {
      for (const transport of ['disabled', 'memory', 'smtp']) {
        let message = '';
        try {
          readEmailConfig({ EMAIL_TRANSPORT: transport, EMAIL_ALLOWED_RECIPIENTS: value, PUBLIC_APP_URL: 'http://localhost:5173',
            EMAIL_FROM: 'Bookings <bookings@example.test>', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525' } as NodeJS.ProcessEnv);
        } catch (e) { message = (e as Error).message; }
        expect([value, transport, message]).toEqual([value, transport, expect.stringMatching(/^Invalid email configuration: EMAIL_ALLOWED_RECIPIENTS: /)]);
        expect(message).not.toMatch(/example\.test|attacker|exämple|qä|127\.0\.0\.1|\bqa\b/);
      }
    }
  });

  it('17. without the setting nothing is restricted, as before', () => {
    expect(parseRecipientAllowlist(undefined)).toBeNull();
    const cfg = readEmailConfig(MEMORY_ENV);
    expect(cfg.allowedRecipients).toBeNull();
    expect(isRecipientAllowed(cfg.allowedRecipients, 'anyone@anywhere.example')).toBe(true);
    expect(recipientAllowlistDescription(null)).toBe('not restricted (EMAIL_ALLOWED_RECIPIENTS is not set)');
    const restricted = readEmailConfig({ ...MEMORY_ENV, EMAIL_ALLOWED_RECIPIENTS: ALLOW });
    expect(recipientAllowlistDescription(restricted.allowedRecipients)).toBe('restricted by EMAIL_ALLOWED_RECIPIENTS to 2 address(es) and 1 domain(s)');
  });
});

// ─── Every kind of email, through a real SMTP conversation ───────────────────

const smtp = { connections: 0, recipients: [] as string[], messages: [] as string[] };
const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  onConnect(_session, callback) { smtp.connections++; callback(); },
  onRcptTo(address, _session, callback) { smtp.recipients.push(address.address); callback(); },
  onData(stream, _session, callback) {
    let raw = '';
    stream.on('data', (c: Buffer) => { raw += c.toString(); });
    stream.on('end', () => { smtp.messages.push(raw); callback(); });
  },
});
server.on('error', () => undefined);
let smtpPort = 0;
beforeAll(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  smtpPort = (server.server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>(r => server.close(() => r())); });
const smtpEnv = (allow?: string): NodeJS.ProcessEnv => ({
  EMAIL_TRANSPORT: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false', SMTP_USER: '', SMTP_PASS: '',
  EMAIL_FROM: 'WorkeasyBooking <bookings@example.test>', PUBLIC_APP_URL: 'http://localhost:5173',
  ...(allow === undefined ? {} : { EMAIL_ALLOWED_RECIPIENTS: allow }),
}) as NodeJS.ProcessEnv;
const resetSmtp = () => { smtp.connections = 0; smtp.recipients.length = 0; smtp.messages.length = 0; };

describe('every kind of email obeys it', () => {
  const lines: string[] = [];
  let spies: jest.SpyInstance[] = [];
  let owner = '';
  let serviceId = '';
  const staff: Record<'allowed' | 'blocked', string> = { allowed: '', blocked: '' };
  const customers: Record<'allowed' | 'blocked', string> = { allowed: '', blocked: '' };
  const blockedOwner = `owner-${RUN}@blocked.example`;
  const auth = () => ({ Authorization: `Bearer ${owner}` });
  const post = (p: string, body: unknown) => request(app).post(`/api/auth${p}`).send(body as object);
  const date = (() => { const d = new Date(); d.setDate(d.getDate() + 21); return d.toISOString().slice(0, 10); })();
  const book = (customerId: string, startTime: string) => request(app).post('/api/appointments').set(auth())
    .send({ serviceId, staffId: staff.allowed, customerId, date, startTime });
  const queueRows = (email: string) => db.prepare(
    `SELECT q.kind, q.status, q.attempts, q.next_attempt_at, q.last_error FROM account_email_queue q
       LEFT JOIN users u ON u.id = q.user_id LEFT JOIN signup_requests s ON s.id = q.signup_request_id
      WHERE u.email = ? OR s.email = ? ORDER BY q.created_at, q.rowid`
  ).all(email, email) as Array<{ kind: string; status: string; attempts: number; next_attempt_at: string | null; last_error: string | null }>;
  const memoryToken = (email: string, page: string) => {
    const mail = [...testOutbox.messages].reverse().find(m => m.to === email && m.text.includes(`/${page}#token=`));
    return mail ? decodeURIComponent(new RegExp(`/${page}#token=([A-Za-z0-9_%-]+)`).exec(mail.text)![1]) : '';
  };

  beforeAll(async () => {
    initEmail(MEMORY_ENV); // accounts and records are created without the restriction
    const res = await signUpAndSignIn(app, { name: 'Allowlist Owner', email: `owner-${RUN}@allowed.example`, company: `Allowlist ${RUN}`, password: PASSWORD });
    owner = sessionToken(res);
    await signUpAndSignIn(app, { name: 'Blocked Owner', email: blockedOwner, company: `Blocked ${RUN}`, password: PASSWORD });
    serviceId = (await request(app).post('/api/services').set(auth()).send({ name: 'Allowlist Service', category: 'consultation', duration: 60, price: 10, maxAdvance: 365 })).body.data.id;
    const hours = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '07:00', end: '21:00' }]));
    for (const [key, email] of [['allowed', `staff-${RUN}@allowed.example`], ['blocked', `staff-${RUN}@blocked.example`]] as const) {
      staff[key] = (await request(app).post('/api/staff').set(auth()).send({ name: `Staff ${key}`, email, serviceIds: [serviceId], workingHours: hours })).body.data.id;
    }
    for (const [key, email] of [['allowed', EXACT_PLUS], ['blocked', OTHER_PLUS]] as const) {
      customers[key] = (await request(app).post('/api/customers').set(auth()).send({ name: `Customer ${key}`, email })).body.data.id;
    }
    expect(Object.values({ ...staff, ...customers }).every(Boolean)).toBe(true);
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    spies = [jest.spyOn(console, 'log').mockImplementation(capture), jest.spyOn(console, 'warn').mockImplementation(capture), jest.spyOn(console, 'error').mockImplementation(capture)];
  });
  beforeEach(() => { testOutbox.clear(); resetSmtp(); initEmail(smtpEnv(ALLOW)); });
  afterAll(() => {
    spies.forEach(s => s.mockRestore());
    initEmail(MEMORY_ENV);
  });

  it('12. a booking email to a recipient outside the list is refused before connecting, recorded and never retried', async () => {
    const ok = await book(customers.allowed, '09:00');
    expect([ok.status, ok.body.data.email.status]).toEqual([201, 'sent']);
    expect(smtp.recipients).toEqual([EXACT_PLUS]); // positive control: this server does deliver
    const connectionsBefore = smtp.connections;

    const refused = await book(customers.blocked, '11:00');
    expect(refused.status).toBe(201); // the booking itself is kept
    expect(refused.body.data.email).toEqual({ status: 'failed', error: RECIPIENT_NOT_ALLOWED });
    const id = refused.body.data.id;
    // Failed (not pending): the outbox worker only picks up pending rows, so it is never tried again.
    expect(db.prepare('SELECT status, attempts, last_error FROM email_outbox WHERE appointment_id = ?').all(id))
      .toEqual([{ status: 'failed', attempts: 1, last_error: RECIPIENT_NOT_ALLOWED }]);
    expect(db.prepare('SELECT status, error FROM email_deliveries WHERE appointment_id = ?').all(id))
      .toEqual([{ status: 'failed', error: RECIPIENT_NOT_ALLOWED }]);
    expect((await processDueEmails(Date.now() + 2 * 60 * 60_000)).attempted).toBe(0);
    // A manual resend cannot get round it either.
    const resend = await request(app).post(`/api/appointments/${id}/emails`).set(auth()).send({ kind: 'confirmation' });
    expect(resend.body.data).toMatchObject({ status: 'failed', error: RECIPIENT_NOT_ALLOWED });
    expect(smtp.connections).toBe(connectionsBefore);
    expect(smtp.recipients).toEqual([EXACT_PLUS]);
  });

  it('13. an invitation to a recipient outside the list is refused before connecting, and no invitation stays open', async () => {
    const refused = await request(app).post(`/api/staff/${staff.blocked}/invitations`).set(auth()).send({ role: 'staff' });
    expect([refused.status, refused.body.code]).toEqual([502, 'INVITE_NOT_DELIVERED']);
    expect(refused.body.error).toContain(RECIPIENT_NOT_ALLOWED);
    expect(db.prepare('SELECT delivery_status, delivery_error, revoked_at IS NOT NULL AS revoked FROM staff_invitations WHERE staff_id = ?').all(staff.blocked))
      .toEqual([{ delivery_status: 'failed', delivery_error: RECIPIENT_NOT_ALLOWED, revoked: 1 }]);
    expect([smtp.connections, smtp.recipients]).toEqual([0, []]);
    const ok = await request(app).post(`/api/staff/${staff.allowed}/invitations`).set(auth()).send({ role: 'staff' });
    expect(ok.status).toBe(201);
    expect(smtp.recipients).toEqual([`staff-${RUN}@allowed.example`]);
  });

  it('14. sign-up confirmation, "Send a new link" and password reset outside the list: refused, failed, never retried', async () => {
    const blocked = `newcomer-${RUN}@blocked.example`;
    const allowed = `newcomer-${RUN}@allowed.example`;
    const a = await post('/signup', { name: 'New', email: blocked, company: 'New Co', password: PASSWORD, confirmPassword: PASSWORD });
    const b = await post('/signup', { name: 'New', email: allowed, company: 'New Co', password: PASSWORD, confirmPassword: PASSWORD });
    expect([a.status, a.body, b.status, b.body]).toEqual([202, GENERIC, 202, GENERIC]); // the same answer either way
    expect((await post('/verify-email/resend', { email: blocked })).body).toEqual(GENERIC);
    expect((await post('/password/forgot', { email: blockedOwner })).body).toEqual(GENERIC);
    await accountEmailsSettled();

    const failed = { status: 'failed', attempts: 1, next_attempt_at: null, last_error: RECIPIENT_NOT_ALLOWED };
    expect(queueRows(blocked)).toEqual([{ kind: 'verify', ...failed }, { kind: 'verify_again', ...failed }]);
    expect(queueRows(blockedOwner).filter(r => r.kind === 'password_reset')).toEqual([{ kind: 'password_reset', ...failed }]);
    expect(queueRows(allowed)).toEqual([{ kind: 'verify', status: 'sent', attempts: 1, next_attempt_at: null, last_error: null }]);
    expect(smtp.recipients).toEqual([allowed]);
    expect((await processDueAccountEmails(Date.now() + 2 * 60 * 60_000)).attempted).toBe(0);
    expect(smtp.recipients).toEqual([allowed]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM account_email_queue WHERE status IN ('pending', 'sending')").get()).toEqual({ n: 0 });
  });

  it('15. the sign-in help email and the password-changed notice obey it too', async () => {
    // A reset link obtained while unrestricted, used once the restriction is on.
    initEmail(MEMORY_ENV);
    await post('/password/forgot', { email: blockedOwner });
    await accountEmailsSettled();
    const token = memoryToken(blockedOwner, 'reset-password');
    expect(token).not.toBe('');
    initEmail(smtpEnv(ALLOW));
    testOutbox.clear();

    const help = await post('/signup', { name: 'Again', email: blockedOwner, company: 'Again Co', password: PASSWORD, confirmPassword: PASSWORD });
    expect(help.body).toEqual(GENERIC);
    expect((await post('/password/reset', { token, password: 'Fresh0Pass', confirmPassword: 'Fresh0Pass' })).status).toBe(200);
    await accountEmailsSettled();
    const rows = queueRows(blockedOwner);
    expect(rows.filter(r => r.kind === 'existing_account').at(-1)).toMatchObject({ status: 'failed', attempts: 1, last_error: RECIPIENT_NOT_ALLOWED });
    expect(rows.filter(r => r.kind === 'password_changed').at(-1)).toMatchObject({ status: 'failed', attempts: 1, next_attempt_at: null, last_error: RECIPIENT_NOT_ALLOWED });
    expect([smtp.connections, smtp.recipients, testOutbox.messages]).toEqual([0, [], []]);
  });

  it('18. a retry whose recipient has since left the list fails once, for good', async () => {
    const email = `retry-${RUN}@allowed.example`;
    initEmail(MEMORY_ENV);
    await signUpAndSignIn(app, { name: 'Retry Owner', email, company: `Retry ${RUN}`, password: PASSWORD });
    initEmail({ ...MEMORY_ENV, EMAIL_ALLOWED_RECIPIENTS: '@allowed.example' });
    testOutbox.clear();
    testOutbox.failNextSends(1, 'transient');
    await post('/password/forgot', { email });
    await accountEmailsSettled();
    const pending = queueRows(email).at(-1)!;
    expect(pending).toMatchObject({ kind: 'password_reset', status: 'pending', attempts: 1 });

    initEmail({ ...MEMORY_ENV, EMAIL_ALLOWED_RECIPIENTS: `${EXACT}` }); // the domain is no longer allowed
    const run = await processDueAccountEmails(Date.parse(pending.next_attempt_at!));
    expect(run).toMatchObject({ attempted: 1, failed: 1, sent: 0, retrying: 0 });
    expect(queueRows(email).at(-1)).toEqual({ kind: 'password_reset', status: 'failed', attempts: 2, next_attempt_at: null, last_error: RECIPIENT_NOT_ALLOWED });
    expect((await processDueAccountEmails(Date.now() + 2 * 60 * 60_000)).attempted).toBe(0);
    expect(testOutbox.messages).toEqual([]);
    expect(lines).toContainEqual(`[email] account password_reset: FAILED via memory after 2 attempt(s): ${RECIPIENT_NOT_ALLOWED}`);
  });

  it('a refused recipient never reaches even the in-memory transport', async () => {
    initEmail({ ...MEMORY_ENV, EMAIL_ALLOWED_RECIPIENTS: ALLOW });
    testOutbox.clear();
    testOutbox.failNextSends(1, 'transient'); // the transport's next send fails; a refused recipient must not use it up
    sendAccountEmail('password_changed', OTHER_PLUS, { name: 'Refused', changedAt: new Date().toISOString() });
    await accountEmailsSettled();
    sendAccountEmail('password_changed', EXACT, { name: 'Allowed', changedAt: new Date().toISOString() });
    await accountEmailsSettled();
    expect(lines.slice(-2)).toEqual([
      `[email] account password_changed: FAILED via memory after 1 attempt(s): ${RECIPIENT_NOT_ALLOWED}`,
      expect.stringMatching(/^\[email\] account password_changed: FAILED via memory after 1 attempt\(s\): Simulated transient delivery failure for \[email\]$/),
    ]);
    // Letter case does not matter; the transport's failure was used up by the allowed address, so this one arrives.
    sendAccountEmail('password_changed', EXACT.toUpperCase(), { name: 'Allowed', changedAt: new Date().toISOString() });
    await accountEmailsSettled();
    expect(testOutbox.messages.map(m => m.to)).toEqual([EXACT.toUpperCase()]);
  });

  it('19. no address, token or link in the logs or in any stored error', () => {
    const emailLines = lines.filter(l => l.startsWith('[email]'));
    expect(emailLines.filter(l => l.includes(RECIPIENT_NOT_ALLOWED)).length).toBeGreaterThanOrEqual(8);
    for (const line of emailLines) {
      expect(line).not.toMatch(/@|#token=|https?:\/\//);
    }
    const stored = [
      ...db.prepare('SELECT last_error AS e FROM email_outbox').all(), ...db.prepare('SELECT error AS e FROM email_deliveries').all(),
      ...db.prepare('SELECT last_error AS e FROM account_email_queue').all(), ...db.prepare('SELECT delivery_error AS e FROM staff_invitations').all(),
    ] as Array<{ e: string | null }>;
    for (const { e } of stored) if (e) expect(e).not.toMatch(/@|#token=|https?:\/\//);
  });
});

// ─── npm run email:test ──────────────────────────────────────────────────────

describe('16. npm run email:test cannot get round it', () => {
  const runEmailTest = (env: Record<string, string>, args: string[]) => new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join('scripts', 'email-test.ts'), ...args], {
      cwd: SERVER_ROOT, env: { ...process.env, ...env, DOTENV_CONFIG_PATH: NO_DOTENV } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out }));
  });
  const env = (allow: string) => smtpEnv(allow) as Record<string, string>;

  beforeEach(resetSmtp);

  it('a --to address outside the list: refused before any connection, and not printed', async () => {
    const r = await runEmailTest(env(ALLOW), ['--to', OTHER_PLUS]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('Not sent: the --to address is not allowed by EMAIL_ALLOWED_RECIPIENTS on this server. No connection was made.');
    expect(r.out).not.toContain(OTHER_PLUS);
    expect([smtp.connections, smtp.recipients]).toEqual([0, []]);
  });

  it('a --to address on the list (any letter case, surrounding spaces) is sent once', async () => {
    const r = await runEmailTest(env(ALLOW), ['--to', ` ${EXACT.toUpperCase()} `]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Recipients: restricted by EMAIL_ALLOWED_RECIPIENTS to 2 address(es) and 1 domain(s)');
    expect(r.out).toContain('Accepted by the mail server: yes');
    expect(smtp.recipients.map(a => a.toLowerCase())).toEqual([EXACT]);
  });

  it('a malformed list stops it before any connection, without echoing the value', async () => {
    const r = await runEmailTest(env(`${EXACT},*@attacker.test`), ['--to', EXACT]);
    expect(r.code).toBe(2);
    expect(r.out).toContain('Invalid email configuration: EMAIL_ALLOWED_RECIPIENTS: entry 2: wildcards are not supported');
    expect(r.out).not.toMatch(/attacker\.test/);
    expect(smtp.connections).toBe(0);
  });
});

// ─── The server itself ───────────────────────────────────────────────────────

describe('server startup', () => {
  async function freePort(): Promise<number> {
    const s = net.createServer();
    await new Promise<void>(r => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise(r => s.close(r));
    return port;
  }
  async function start(allow: string, waitFor: RegExp): Promise<{ code: number | null; out: string }> {
    const port = await freePort();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: SERVER_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port), DB_PATH: path.join(TMP, `startup-${port}.db`), DOTENV_CONFIG_PATH: NO_DOTENV,
        ...MEMORY_ENV, EMAIL_ALLOWED_RECIPIENTS: allow } as NodeJS.ProcessEnv,
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const exited = new Promise<number | null>(r => child.once('exit', code => r(code)));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !waitFor.test(out) && child.exitCode === null) await new Promise(r => setTimeout(r, 100));
    if (child.exitCode === null) child.kill();
    return { code: await exited, out };
  }

  it('11. refuses to start with a malformed list, naming the setting but not the value', async () => {
    const r = await start(`${EXACT},@allowed.example,no-at-sign-here`, /never printed/);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('Invalid email configuration: EMAIL_ALLOWED_RECIPIENTS: entry 3 is not a plain email address or @domain');
    expect(r.out).not.toContain('no-at-sign-here');
    expect(r.out).not.toContain('WorkEasy360 API running');
  });

  it('reports the restriction at startup with counts only', async () => {
    const r = await start(ALLOW, /Email recipients: [^\n]*\n/);
    expect(r.out).toContain('Email recipients: restricted by EMAIL_ALLOWED_RECIPIENTS to 2 address(es) and 1 domain(s)');
    expect(r.out).not.toMatch(/allowed\.example|example\.test/);
  });
});
