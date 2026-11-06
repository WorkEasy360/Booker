import net from 'net';
import { z } from 'zod';

// EMAIL_TRANSPORT:
//   disabled (default) — nothing is sent; every attempt is recorded as not_configured.
//   smtp               — real delivery through SMTP_HOST (an email provider or a local catcher such as Mailpit).
//   memory             — tests only: messages are kept in process memory and never leave the machine.
//
// SMTP connections are always encrypted, with one exception (see smtpTlsMode):
//   SMTP_SECURE=true  — TLS from the first byte (implicit TLS, port 465).
//   SMTP_SECURE=false — STARTTLS is REQUIRED: a server that does not offer it, or a connection where the offer was
//                       removed in transit, fails instead of continuing in plaintext.
//   Plaintext only outside production AND to a loopback address (a local mail catcher such as Mailpit or
//   `npm run mail:catcher` on 127.0.0.1:1025), so it can never cross a network.
// Certificates are always verified (Node's defaults are never relaxed), and TLS 1.2 is the minimum.

// ─── EMAIL_ALLOWED_RECIPIENTS ────────────────────────────────────────────────
// Optional. When set, email goes ONLY to the listed recipients: every other recipient is refused before the mail
// server is contacted, for every kind of email and for `npm run email:test`. For staging and other restricted servers.
// Comma-separated entries, each either
//   - an exact address, e.g. staging-test@example.test. A plus-address is a separate address that must be listed
//     itself (staging-test+cust1@example.test): a listed address never allows its plus variants, nor the reverse;
//   - "@" and a domain, e.g. @test-mail.example.test: any address at exactly that domain, never at a subdomain of it
//     or at a longer name that merely ends in it.
// Surrounding spaces and letter case are ignored. Addresses may contain only ASCII letters, digits and . _ + - before
// the @ (checked before letter case is ignored, so no other character can fold into a listed address). No wildcards.
// A value that is set but empty, or any entry that does not fit these rules, is a configuration error (the server
// does not start); it never widens the list. Unset: no restriction, as before (production emails real customers).
export interface RecipientAllowlist { readonly addresses: ReadonlySet<string>; readonly domains: ReadonlySet<string> }

const MAX_ALLOWED_RECIPIENTS = 100;
const LOCAL_PART = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*$/;
const DOMAIN_NAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** One plain mailbox in lower case, or null. Only these ASCII characters are accepted, before lower-casing. */
function plainAddress(value: string): { address: string; domain: string } | null {
  const v = value.trim();
  if (v.length > 254 || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(v)) return null;
  const address = v.toLowerCase();
  const [local, domain] = address.split('@');
  return local.length <= 64 && LOCAL_PART.test(local) && DOMAIN_NAME.test(domain) ? { address, domain } : null;
}

/** Parses EMAIL_ALLOWED_RECIPIENTS: null when unset; throws (naming the entry's position, never its value) when malformed. */
export function parseRecipientAllowlist(raw: string | undefined): RecipientAllowlist | null {
  if (raw === undefined) return null;
  if (!raw.trim()) throw new Error('is set but empty: list at least one address or @domain, or remove the setting');
  const entries = raw.split(',');
  if (entries.length > MAX_ALLOWED_RECIPIENTS) throw new Error(`has more than ${MAX_ALLOWED_RECIPIENTS} entries`);
  const addresses = new Set<string>();
  const domains = new Set<string>();
  entries.forEach((entry, i) => {
    const e = entry.trim();
    if (!e) throw new Error(`entry ${i + 1} is empty (a doubled or trailing comma?)`);
    if (/[*?]/.test(e)) throw new Error(`entry ${i + 1}: wildcards are not supported; list exact addresses or @domain`);
    if (e.startsWith('@')) {
      const domain = e.slice(1);
      if (!/^[A-Za-z0-9.-]+$/.test(domain) || !DOMAIN_NAME.test(domain.toLowerCase())) throw new Error(`entry ${i + 1} is not a valid @domain`);
      domains.add(domain.toLowerCase());
    } else {
      const p = plainAddress(e);
      if (!p) throw new Error(`entry ${i + 1} is not a plain email address or @domain`);
      addresses.add(p.address);
    }
  });
  return { addresses, domains };
}

/**
 * Whether email may go to `to`. Without an allowlist, always. With one: only a single plain mailbox that is listed
 * exactly, or whose domain is listed exactly; lists, display names, line breaks and anything else are refused.
 */
export function isRecipientAllowed(allowlist: RecipientAllowlist | null | undefined, to: unknown): boolean {
  if (!allowlist) return true;
  if (typeof to !== 'string') return false;
  const p = plainAddress(to);
  return !!p && (allowlist.addresses.has(p.address) || allowlist.domains.has(p.domain));
}

export const RECIPIENT_NOT_ALLOWED = 'Recipient not allowed on this server (EMAIL_ALLOWED_RECIPIENTS)';

/** A recipient outside EMAIL_ALLOWED_RECIPIENTS: permanent, never retried. The message names no address. */
export class RecipientNotAllowedError extends Error {
  readonly transient = false;
  readonly code = 'ERECIPIENTNOTALLOWED';
  constructor() { super(RECIPIENT_NOT_ALLOWED); }
}

/** For the startup log and `npm run email:test`: counts only, never the addresses. */
export function recipientAllowlistDescription(allowlist: RecipientAllowlist | null | undefined): string {
  return allowlist
    ? `restricted by EMAIL_ALLOWED_RECIPIENTS to ${allowlist.addresses.size} address(es) and ${allowlist.domains.size} domain(s)`
    : 'not restricted (EMAIL_ALLOWED_RECIPIENTS is not set)';
}

const Base = z.object({
  EMAIL_TRANSPORT: z.enum(['disabled', 'smtp', 'memory'], { errorMap: () => ({ message: 'must be disabled, smtp or memory' }) }).default('disabled'),
  EMAIL_FROM: z.string().trim().optional(),
  PUBLIC_APP_URL: z.string().trim().url('PUBLIC_APP_URL must be an absolute URL such as https://book.example.com').optional(),
  EMAIL_ALLOWED_RECIPIENTS: z.string().optional().transform((v, ctx) => {
    try { return parseRecipientAllowlist(v); } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
      return z.NEVER;
    }
  }),
});

/** A host name or an IP address, nothing else (no scheme, port, path or spaces). */
function isHostOnly(host: string): boolean {
  if (net.isIP(host.replace(/^\[(.*)\]$/, '$1'))) return true;
  return host.length <= 253 && /^(?=.*[A-Za-z0-9])[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.?$/.test(host);
}

const Smtp = z.object({
  EMAIL_FROM: z.string().trim().min(3, 'EMAIL_FROM is required, e.g. "Acme Bookings <bookings@acme.com>"'),
  PUBLIC_APP_URL: z.string().trim().url('PUBLIC_APP_URL must be an absolute URL such as https://book.example.com'),
  SMTP_HOST: z.string({ required_error: 'SMTP_HOST is required' }).trim().min(1, 'SMTP_HOST is required')
    .refine(isHostOnly, 'SMTP_HOST must be only a host name or IP address (no scheme, port, path or spaces)'),
  SMTP_PORT: z.coerce.number({ invalid_type_error: 'SMTP_PORT must be a whole number from 1 to 65535' })
    .int('SMTP_PORT must be a whole number from 1 to 65535').min(1, 'SMTP_PORT must be a whole number from 1 to 65535')
    .max(65535, 'SMTP_PORT must be a whole number from 1 to 65535').default(587),
  SMTP_SECURE: z.enum(['true', 'false'], { errorMap: () => ({ message: 'must be true or false' }) }).default('false').transform(v => v === 'true'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
}).refine(c => !c.SMTP_USER === !c.SMTP_PASS, { message: 'Set both SMTP_USER and SMTP_PASS, or neither', path: ['SMTP_PASS'] })
  // These combinations can never connect; refusing them at startup beats a send that hangs or fails later.
  .refine(c => !(c.SMTP_PORT === 465 && !c.SMTP_SECURE), { message: 'port 465 uses TLS from the start: set SMTP_SECURE=true', path: ['SMTP_SECURE'] })
  .refine(c => !(c.SMTP_PORT === 587 && c.SMTP_SECURE), { message: 'port 587 uses STARTTLS: set SMTP_SECURE=false (STARTTLS is then required)', path: ['SMTP_SECURE'] });

/**
 * How the SMTP connection is protected:
 *   implicit         — TLS from the first byte (SMTP_SECURE=true, usually port 465).
 *   starttls         — STARTTLS required; without it nothing is sent (SMTP_SECURE=false, usually port 587).
 *   local-plaintext  — no TLS required: only outside production, and only to a loopback address (a local mail catcher).
 */
export type SmtpTlsMode = 'implicit' | 'starttls' | 'local-plaintext';

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** Exactly "localhost" or a loopback IP (127.0.0.0/8, ::1). Names that merely resolve to one do not count. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (h === 'localhost') return true;
  const family = net.isIP(h);
  return family !== 0 && LOOPBACK.check(h, family === 6 ? 'ipv6' : 'ipv4');
}

function smtpTlsMode(secure: boolean, host: string, production: boolean): SmtpTlsMode {
  if (secure) return 'implicit';
  return !production && isLoopbackHost(host) ? 'local-plaintext' : 'starttls';
}

export const DEFAULT_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

// Retry schedule: waits after the 1st, 2nd, 3rd … failed attempt (comma-separated milliseconds), and how often the
// background worker looks for due retries. The defaults suit production; tests shorten them.
const Retry = z.object({
  EMAIL_RETRY_DELAYS_MS: z.string().trim().optional().transform((v, ctx) => {
    if (!v) return DEFAULT_RETRY_DELAYS_MS;
    const delays = v.split(',').map(x => Number(x.trim()));
    if (!delays.length || delays.length > 10 || delays.some(d => !Number.isInteger(d) || d < 100 || d > 86_400_000)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'EMAIL_RETRY_DELAYS_MS must be 1-10 comma-separated whole milliseconds between 100 and 86400000' });
      return z.NEVER;
    }
    return delays;
  }),
  EMAIL_WORKER_INTERVAL_MS: z.coerce.number().int().min(100).max(3_600_000).default(30_000),
});

export type EmailConfig = (
  | { transport: 'disabled'; from?: string; appUrl?: string }
  | { transport: 'memory'; from: string; appUrl: string }
  | SmtpConfig
) & { retryDelaysMs: number[]; workerIntervalMs: number; allowedRecipients: RecipientAllowlist | null };

export interface SmtpConfig {
  transport: 'smtp'; from: string; appUrl: string; host: string; port: number; secure: boolean; tls: SmtpTlsMode; user?: string; pass?: string;
}

/** Parses email settings; throws with field names only (never values) when they are invalid. */
export function readEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const base = Base.safeParse(env);
  if (!base.success) throw new Error(`Invalid email configuration: ${base.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
  const { EMAIL_TRANSPORT } = base.data;
  const retry = Retry.safeParse(env);
  if (!retry.success) throw new Error(`Invalid email configuration: ${retry.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
  const schedule = {
    retryDelaysMs: retry.data.EMAIL_RETRY_DELAYS_MS, workerIntervalMs: retry.data.EMAIL_WORKER_INTERVAL_MS,
    allowedRecipients: base.data.EMAIL_ALLOWED_RECIPIENTS,
  };

  if (EMAIL_TRANSPORT === 'disabled') return { transport: 'disabled', from: base.data.EMAIL_FROM, appUrl: base.data.PUBLIC_APP_URL, ...schedule };
  if (EMAIL_TRANSPORT === 'memory') {
    // The test catcher records emails as sent without delivering them; a live server must never report that.
    if (env.NODE_ENV === 'production') throw new Error('Invalid email configuration: EMAIL_TRANSPORT=memory is for automated tests only (use smtp or disabled)');
    return { transport: 'memory', from: base.data.EMAIL_FROM || 'Test <test@example.com>', appUrl: base.data.PUBLIC_APP_URL || 'http://localhost:5173', ...schedule };
  }
  const smtp = Smtp.safeParse(env);
  if (!smtp.success) throw new Error(`Invalid email configuration: ${smtp.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
  const c = smtp.data;
  const production = env.NODE_ENV === 'production';
  // Production signs in to the mail server, and smtpTlsMode never allows plaintext there.
  if (production && !c.SMTP_USER) {
    throw new Error('Invalid email configuration: SMTP_USER and SMTP_PASS are required in production (the server signs in to the mail provider over TLS)');
  }
  return {
    transport: 'smtp', from: c.EMAIL_FROM, appUrl: c.PUBLIC_APP_URL.replace(/\/+$/, ''),
    host: c.SMTP_HOST, port: c.SMTP_PORT, secure: c.SMTP_SECURE, tls: smtpTlsMode(c.SMTP_SECURE, c.SMTP_HOST, production),
    user: c.SMTP_USER || undefined, pass: c.SMTP_PASS || undefined,
    ...schedule,
  };
}

/**
 * The Nodemailer options for an SMTP configuration: the only place the transport's security is decided. The server
 * and `npm run email:test` both use it. Certificates are verified with Node's defaults (nothing here relaxes them),
 * TLS 1.2 is the minimum, and STARTTLS is required unless the configuration is a local mail catcher.
 */
export function smtpTransportOptions(cfg: SmtpConfig) {
  return {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls === 'implicit',
    // Nodemailer otherwise continues in plaintext (and signs in there) when the server does not offer STARTTLS.
    requireTLS: cfg.tls === 'starttls',
    tls: { minVersion: 'TLSv1.2' as const },
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 15_000,
  };
}

/**
 * Makes a mail server's message safe to log or print: removes the given secrets (the SMTP user name and password; some
 * servers repeat them in a sign-in error) and any email address, and caps the length. Shared by the server and
 * `npm run email:test`.
 */
export function redactSmtpMessage(message: string, secrets: Array<string | undefined> = []): string {
  const withoutSecrets = secrets
    .filter((s): s is string => !!s && s.length >= 3)
    .reduce((m, secret) => m.split(secret).join('[redacted]'), message);
  return withoutSecrets.replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, '[email]').replace(/\s+/g, ' ').slice(0, 300);
}

/** The TLS mode in words, for the startup log and `npm run email:test` (no host, user or password). */
export function smtpTlsDescription(cfg: SmtpConfig): string {
  return {
    implicit: 'TLS from the start',
    starttls: 'STARTTLS required',
    'local-plaintext': 'plaintext to a local mail catcher on this machine; allowed only outside production',
  }[cfg.tls];
}
