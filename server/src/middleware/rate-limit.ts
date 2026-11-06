import type { Request, Response, NextFunction } from 'express';

// In-memory sliding-window limits. The API runs as a single process (SQLite), so one process sees all traffic;
// a multi-instance deployment would need a shared store instead.
//
// Limits that protect secrets (passwords, booking lookups) count failures only, so a busy office or school network
// sharing one address is not blocked by its own successful sign-ins.

export interface RateRule { id: string; limit: number; windowMs: number }

const MIN = 60_000;

export const RULES = {
  loginAccountIp:   { id: 'login:account-ip', limit: 5, windowMs: 15 * MIN },
  loginIp:          { id: 'login:ip', limit: 30, windowMs: 15 * MIN },
  loginAccount:     { id: 'login:account', limit: 20, windowMs: 60 * MIN },
  signupIp:         { id: 'signup:ip', limit: 10, windowMs: 60 * MIN },
  // Account emails: every request counts, whether or not the address has an account, so the limits reveal nothing.
  signupEmail:      { id: 'signup:email', limit: 3, windowMs: 60 * MIN },
  verifyResendIp:   { id: 'verify-resend:ip', limit: 10, windowMs: 15 * MIN },
  verifyResendEmail:{ id: 'verify-resend:email', limit: 3, windowMs: 60 * MIN },
  forgotIp:         { id: 'forgot:ip', limit: 10, windowMs: 15 * MIN },
  forgotEmail:      { id: 'forgot:email', limit: 3, windowMs: 60 * MIN },
  accountTokenIp:   { id: 'account-token:ip', limit: 10, windowMs: 15 * MIN },  // failed link checks
  passwordUser:     { id: 'password:user', limit: 5, windowMs: 15 * MIN },
  twoFactorUser:    { id: 'two-factor:user', limit: 5, windowMs: 15 * MIN },   // failed second-step codes
  twoFactorIp:      { id: 'two-factor:ip', limit: 20, windowMs: 15 * MIN },
  twoFactorManage:  { id: 'two-factor:manage', limit: 10, windowMs: 15 * MIN }, // wrong password or code in settings
  bookIp:           { id: 'book:ip', limit: 30, windowMs: 10 * MIN },
  bookEmail:        { id: 'book:email', limit: 5, windowMs: 60 * MIN },
  lookupIp:         { id: 'lookup:ip', limit: 10, windowMs: 15 * MIN },
  lookupRef:        { id: 'lookup:ref', limit: 5, windowMs: 15 * MIN },
  manageIp:         { id: 'manage:ip', limit: 20, windowMs: 15 * MIN },
  manageBooking:    { id: 'manage:booking', limit: 6, windowMs: 60 * MIN },
  manageLinkIp:     { id: 'manage-link:ip', limit: 5, windowMs: 15 * MIN },  // each may send an email
  manageLinkRef:    { id: 'manage-link:ref', limit: 3, windowMs: 60 * MIN },
  publicReadIp:     { id: 'public-read:ip', limit: 600, windowMs: 5 * MIN },
  resendAppointment:{ id: 'resend:appointment', limit: 3, windowMs: 10 * MIN },
  resendOrg:        { id: 'resend:org', limit: 30, windowMs: 60 * MIN },
  inviteSendOrg:    { id: 'invite-send:org', limit: 20, windowMs: 60 * MIN },
  inviteTokenIp:    { id: 'invite-token:ip', limit: 10, windowMs: 15 * MIN },
  reindexOrg:       { id: 'reindex:org', limit: 3, windowMs: 10 * MIN },
  uploadOrg:        { id: 'upload:org', limit: 30, windowMs: 60 * MIN },     // logo and staff photo uploads
  // Questions answered by the language model (each one is a paid call to Google); the local assistant is not limited.
  assistantUser:    { id: 'assistant:user', limit: 30, windowMs: 10 * MIN },
  assistantOrg:     { id: 'assistant:org', limit: 300, windowMs: 60 * MIN },
} satisfies Record<string, RateRule>;

const MAX_KEYS = 100_000;
const buckets = new Map<string, number[]>();
let clock: () => number = () => Date.now();

function enabled(): boolean {
  return process.env.RATE_LIMITS !== 'off';
}

function live(bucketKey: string, windowMs: number, now: number): number[] {
  const hits = buckets.get(bucketKey);
  if (!hits) return [];
  const cutoff = now - windowMs;
  let expired = 0;
  while (expired < hits.length && hits[expired] <= cutoff) expired++;
  if (expired) hits.splice(0, expired);
  if (!hits.length) buckets.delete(bucketKey);
  return hits;
}

function record(bucketKey: string, now: number): void {
  const hits = buckets.get(bucketKey) ?? [];
  buckets.delete(bucketKey); // re-insert so the most recently used keys survive trimming
  hits.push(now);
  buckets.set(bucketKey, hits);
  if (buckets.size > MAX_KEYS) {
    for (const oldest of buckets.keys()) {
      buckets.delete(oldest);
      if (buckets.size <= MAX_KEYS * 0.9) break;
    }
  }
}

function unrecord(bucketKey: string, at: number): void {
  const hits = buckets.get(bucketKey);
  if (!hits) return;
  const i = hits.lastIndexOf(at);
  if (i >= 0) hits.splice(i, 1);
  if (!hits.length) buckets.delete(bucketKey);
}

export interface LimitEntry { rule: RateRule; key: string | null | undefined }

export interface Consumption {
  allowed: boolean;
  retryAfterMs: number;
  /** Takes back the attempts recorded by this call (used when the attempt turned out to be legitimate). */
  refund: () => void;
}

/** Checks every entry and, when all have room, records one attempt against each. */
export function consume(entries: LimitEntry[]): Consumption {
  const noop = { allowed: true, retryAfterMs: 0, refund: () => {} };
  if (!enabled()) return noop;
  const now = clock();
  const active = entries.filter((e): e is { rule: RateRule; key: string } => !!e.key);
  let retryAfterMs = 0;
  for (const { rule, key } of active) {
    const hits = live(`${rule.id}|${key}`, rule.windowMs, now);
    if (hits.length >= rule.limit) retryAfterMs = Math.max(retryAfterMs, hits[0] + rule.windowMs - now);
  }
  if (retryAfterMs > 0) return { allowed: false, retryAfterMs, refund: () => {} };
  for (const { rule, key } of active) record(`${rule.id}|${key}`, now);
  let refunded = false;
  return {
    allowed: true,
    retryAfterMs: 0,
    refund: () => {
      if (refunded) return;
      refunded = true;
      for (const { rule, key } of active) unrecord(`${rule.id}|${key}`, now);
    },
  };
}

/** Forgets earlier failures, e.g. after a successful sign-in. */
export function clearLimit(rule: RateRule, key: string): void {
  buckets.delete(`${rule.id}|${key}`);
}

export function sendRateLimited(res: Response, retryAfterMs: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const minutes = Math.ceil(seconds / 60);
  res.setHeader('Retry-After', String(seconds));
  res.status(429).json({
    error: `Too many attempts. Please wait ${minutes <= 1 ? 'a minute' : `about ${minutes} minutes`} and try again.`,
    code: 'RATE_LIMITED',
    retryAfterSeconds: seconds,
  });
}

/**
 * Middleware form. With `countIf`, an attempt stays counted only when the response status matches
 * (for example 401 for a wrong password); it is counted up front so parallel requests cannot slip past the limit.
 */
export function rateLimit(entries: (req: Request) => LimitEntry[], opts: { countIf?: (status: number) => boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = consume(entries(req));
    if (!result.allowed) { sendRateLimited(res, result.retryAfterMs); return; }
    if (opts.countIf) {
      const countIf = opts.countIf;
      res.on('finish', () => { if (!countIf(res.statusCode)) result.refund(); });
    }
    next();
  };
}

/** Client address used for limits; IPv6 clients are grouped by their /64 network, which one user usually controls. */
export function clientKey(req: Request): string {
  let ip = (req.ip ?? req.socket?.remoteAddress ?? 'unknown').split('%')[0];
  if (ip.startsWith('::ffff:') && ip.includes('.')) ip = ip.slice(7);
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map(g => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export const rateLimitTesting = {
  reset(): void { buckets.clear(); },
  setClock(fn: (() => number) | null): void { clock = fn ?? (() => Date.now()); },
};
