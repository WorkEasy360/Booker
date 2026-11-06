import { createHash, randomBytes } from 'crypto';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { revokeUserSessions } from '../auth/session';
import {
  sendAccountEmail, queueAccountEmail, registerAccountEmailRetry, supersedeQueuedSignupEmails, supersedeQueuedResetEmails,
  supersedeQueuedEmailForSignupRequest, supersedeQueuedEmailForPasswordReset, type AccountQueueRow, type AccountEmailRetry,
} from './email/notify';
import { DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT } from './business-locale';

// Email verification of new sign-ups and password reset by email.
//
// Tokens are 32 random bytes, sent only inside an email link (in the URL fragment) and stored only as SHA-256
// hashes. Each is single-use (consumed with a conditional update inside a write-locked transaction, so two concurrent
// uses cannot both succeed), expires (verification 24 hours, reset 60 minutes), and is replaced by a newer one for the
// same address or account. None of these functions tells the caller whether an account exists: the routes answer every
// request the same way, and the outcome only ever reaches the mailbox owner.
//
// Each email is queued (account_email_queue, migration 009) in the transaction that creates its request, so a
// temporary delivery failure is retried even across a restart. Whatever replaces or uses a link also cancels the
// queued retries of the earlier email, and a retry always carries a new link with the original expiry
// (prepareAccountEmailRetry), never a used, replaced or expired one.

export const VERIFY_TTL_MS = 24 * 60 * 60_000;
export const RESET_TTL_MS = 60 * 60_000;

export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();
const plausible = (token: unknown): token is string => typeof token === 'string' && token.length >= 20 && token.length <= 200;

export type TokenFailure = { ok: false; status: 404 | 409 | 410; code: string; error: string };

function failure(status: TokenFailure['status'], code: string, error: string): TokenFailure {
  return { ok: false, status, code, error };
}

// ─── Sign-up and email verification ──────────────────────────────────────────

export interface SignupInput {
  email: string;            // lower-case
  name: string;
  company: string;
  passwordHash: string;     // bcrypt
  timezone: string;
  country: string | null;
}

interface SignupRow {
  id: string; email: string; name: string; company: string; password_hash: string; timezone: string | null;
  country: string | null; created_at: string; expires_at: string; verified_at: string | null; superseded_at: string | null;
}

const VERIFY = {
  invalid: failure(404, 'VERIFY_INVALID', 'This confirmation link is not valid. Use the newest link we emailed you, or request a new one.'),
  expired: failure(410, 'VERIFY_EXPIRED', 'This confirmation link has expired. Request a new one below.'),
  used: failure(410, 'VERIFY_USED', 'This email address is already confirmed. Sign in to continue.'),
  replaced: failure(410, 'VERIFY_REPLACED', 'A newer confirmation link was sent for this address. Use the newest email, or request a new link below.'),
  accountExists: failure(409, 'VERIFY_ACCOUNT_EXISTS', 'An account with this email address already exists. Sign in instead.'),
};

function signupState(row: SignupRow, now = Date.now()): 'valid' | 'used' | 'replaced' | 'expired' {
  if (row.verified_at) return 'used';
  if (row.superseded_at) return 'replaced';
  if (Date.parse(row.expires_at) <= now) return 'expired';
  return 'valid';
}

function signupByToken(token: unknown): SignupRow | undefined {
  if (!plausible(token)) return undefined;
  return db.prepare('SELECT * FROM signup_requests WHERE token_hash = ?').get(hashToken(token)) as SignupRow | undefined;
}

function insertSignupRequest(r: Omit<SignupRow, 'id' | 'created_at' | 'expires_at' | 'verified_at' | 'superseded_at'>, token: string): { id: string; at: number; expiresAt: string } {
  const at = Date.now();
  const id = `signup-${nanoid(12)}`;
  // Earlier links for this address stop working (and their queued retries are cancelled); old unconfirmed requests
  // (and their password hashes) are forgotten.
  supersedeQueuedSignupEmails(r.email, at);
  db.prepare(`UPDATE signup_requests SET superseded_at = ? WHERE email = ? AND verified_at IS NULL AND superseded_at IS NULL`)
    .run(nowIso(at), r.email);
  db.prepare(`DELETE FROM signup_requests WHERE verified_at IS NULL AND expires_at < ?`).run(nowIso(at - 7 * 86_400_000));
  db.prepare(
    `INSERT INTO signup_requests (id, email, name, company, password_hash, timezone, country, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, r.email, r.name, r.company, r.password_hash, r.timezone, r.country, hashToken(token), nowIso(at), nowIso(at + VERIFY_TTL_MS));
  return { id, at, expiresAt: nowIso(at + VERIFY_TTL_MS) };
}

/** Records a new confirmation request and its queued email, in one write-locked transaction. Returns the queue id. */
function createSignupRequest(kind: 'verify' | 'verify_again', r: Parameters<typeof insertSignupRequest>[0], token: string): string {
  return db.transaction(() => {
    const request = insertSignupRequest(r, token);
    return queueAccountEmail(kind, { signupRequestId: request.id }, { linkExpiresAt: request.expiresAt, now: request.at });
  }).immediate();
}

/** The account-information email for an address that already has an account (no link: nothing to replace). */
function sendExistingAccountEmail(email: string, user: { id: string; name: string }): void {
  sendAccountEmail('existing_account', email, { name: user.name }, queueAccountEmail('existing_account', { userId: user.id }));
}

/**
 * A sign-up request. A new address gets a confirmation link; the account is created only when the link is used.
 * An address that already has an account gets an account-information email instead, so the person asking learns
 * nothing either way.
 */
export function requestSignup(input: SignupInput): void {
  const existing = db.prepare('SELECT id, name FROM users WHERE email = ?').get(input.email) as { id: string; name: string } | undefined;
  if (existing) {
    sendExistingAccountEmail(input.email, existing);
    return;
  }
  const token = newToken();
  const queueId = createSignupRequest('verify', {
    email: input.email, name: input.name, company: input.company, password_hash: input.passwordHash,
    timezone: input.timezone, country: input.country,
  }, token);
  sendAccountEmail('verify', input.email, { name: input.name, company: input.company, token }, queueId);
}

/** A new confirmation link for an unconfirmed sign-up (the previous link stops working). Same silence as above. */
export function resendVerification(email: string): void {
  const existing = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email) as { id: string; name: string } | undefined;
  if (existing) {
    sendExistingAccountEmail(email, existing);
    return;
  }
  const latest = db.prepare(
    'SELECT * FROM signup_requests WHERE email = ? AND verified_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1'
  ).get(email) as SignupRow | undefined;
  if (!latest) return;
  const token = newToken();
  const queueId = createSignupRequest('verify_again', {
    email: latest.email, name: latest.name, company: latest.company, password_hash: latest.password_hash,
    timezone: latest.timezone, country: latest.country,
  }, token);
  sendAccountEmail('verify_again', email, { name: latest.name, company: latest.company, token }, queueId);
}

/** What the confirmation page shows before the person confirms (the token holder is the mailbox owner). */
export function inspectVerification(token: unknown): { ok: true; data: { email: string; businessName: string; expiresAt: string } } | TokenFailure {
  const row = signupByToken(token);
  if (!row) return VERIFY.invalid;
  const state = signupState(row);
  if (state !== 'valid') return VERIFY[state];
  return { ok: true, data: { email: row.email, businessName: row.company, expiresAt: row.expires_at } };
}

/** Confirms the address and creates the business and its administrator. No session is created: the person signs in. */
export function verifySignup(token: unknown): { ok: true; email: string } | TokenFailure {
  if (!plausible(token)) return VERIFY.invalid;
  const hash = hashToken(token);
  return db.transaction((): { ok: true; email: string } | TokenFailure => {
    const row = db.prepare('SELECT * FROM signup_requests WHERE token_hash = ?').get(hash) as SignupRow | undefined;
    if (!row) return VERIFY.invalid;
    const state = signupState(row);
    if (state !== 'valid') return VERIFY[state];
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(row.email)) return VERIFY.accountExists;
    const consumed = db.prepare(
      `UPDATE signup_requests SET verified_at = ?, password_hash = '' WHERE id = ? AND verified_at IS NULL AND superseded_at IS NULL`
    ).run(nowIso(), row.id).changes;
    if (!consumed) return VERIFY.used;
    // The link was used: a queued retry of its email is never sent.
    supersedeQueuedEmailForSignupRequest(row.id);

    const orgId = `org-${nanoid(8)}`;
    const userId = `user-${nanoid(8)}`;
    // The person who creates the business is its first administrator.
    db.prepare(
      `INSERT INTO organizations (id, name, email, timezone, country, currency, date_format, time_format, working_hours, booking_rules)
       VALUES (?, ?, ?, ?, COALESCE(?, ?), ?, ?, '12h', '{}', '{}')`
    ).run(orgId, row.company, row.email, row.timezone, row.country, DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT);
    db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, 'admin')`)
      .run(userId, orgId, row.email, row.password_hash, row.name);
    db.prepare('UPDATE signup_requests SET user_id = ? WHERE id = ?').run(userId, row.id);
    return { ok: true, email: row.email };
  }).immediate();
}

// ─── Password reset ──────────────────────────────────────────────────────────

interface ResetRow { id: string; user_id: string; expires_at: string; used_at: string | null; superseded_at: string | null }

const RESET = {
  invalid: failure(404, 'RESET_INVALID', 'This password-reset link is not valid. Request a new one.'),
  expired: failure(410, 'RESET_EXPIRED', 'This password-reset link has expired. Request a new one.'),
  used: failure(410, 'RESET_USED', 'This password-reset link has already been used. Request a new one if you still need to.'),
  replaced: failure(410, 'RESET_REPLACED', 'This password-reset link is no longer valid because a newer one was requested or the password was changed. Use the newest email, or request a new link.'),
};

function resetState(row: ResetRow, now = Date.now()): 'valid' | 'used' | 'replaced' | 'expired' {
  if (row.used_at) return 'used';
  if (row.superseded_at) return 'replaced';
  if (Date.parse(row.expires_at) <= now) return 'expired';
  return 'valid';
}

/** Accounts that can sign in: active, and for staff sign-ins an active staff record. */
const SIGN_IN_CAPABLE = `u.is_active = 1 AND (u.staff_id IS NULL OR EXISTS (SELECT 1 FROM staff st WHERE st.id = u.staff_id AND st.is_active = 1))`;

/** Ends every unused reset link of an account and cancels their queued emails (a newer link was requested, or the password changed). */
export function supersedePasswordResets(userId: string): void {
  db.transaction(() => {
    const at = Date.now();
    supersedeQueuedResetEmails(userId, at);
    db.prepare(`UPDATE password_resets SET superseded_at = ? WHERE user_id = ? AND used_at IS NULL AND superseded_at IS NULL`).run(nowIso(at), userId);
  })();
}

/** Emails a reset link when the address belongs to an account that can sign in. Silent otherwise. */
export function requestPasswordReset(email: string): void {
  const user = db.prepare(`SELECT u.id, u.name FROM users u WHERE u.email = ? AND ${SIGN_IN_CAPABLE}`).get(email) as { id: string; name: string } | undefined;
  if (!user) return;
  const token = newToken();
  const at = Date.now();
  const queueId = db.transaction(() => {
    supersedePasswordResets(user.id);
    db.prepare(`DELETE FROM password_resets WHERE created_at < ?`).run(nowIso(at - 30 * 86_400_000));
    const id = `reset-${nanoid(12)}`;
    db.prepare(`INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, user.id, hashToken(token), nowIso(at), nowIso(at + RESET_TTL_MS));
    return queueAccountEmail('password_reset', { userId: user.id, passwordResetId: id }, { linkExpiresAt: nowIso(at + RESET_TTL_MS), now: at });
  }).immediate();
  sendAccountEmail('password_reset', email, { name: user.name, token }, queueId);
}

function resetByToken(token: unknown): ResetRow | undefined {
  if (!plausible(token)) return undefined;
  return db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hashToken(token)) as ResetRow | undefined;
}

/** Whether a reset link can still be used (shown before the person types a new password). */
export function inspectPasswordReset(token: unknown): { ok: true; data: { expiresAt: string } } | TokenFailure {
  const row = resetByToken(token);
  if (!row) return RESET.invalid;
  const state = resetState(row);
  if (state !== 'valid') return RESET[state];
  if (!db.prepare(`SELECT 1 FROM users u WHERE u.id = ? AND ${SIGN_IN_CAPABLE}`).get(row.user_id)) return RESET.invalid;
  return { ok: true, data: { expiresAt: row.expires_at } };
}

/**
 * Sets the new password (already hashed), consumes the link, ends every other reset link and every session of the
 * account, and emails a notice. Exactly one of several concurrent uses of the same link can succeed.
 */
export function completePasswordReset(token: unknown, passwordHash: string): { ok: true; email: string } | TokenFailure {
  if (!plausible(token)) return RESET.invalid;
  const hash = hashToken(token);
  const result = db.transaction((): { ok: true; email: string; name: string; changedAt: string; queueId: string } | TokenFailure => {
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hash) as ResetRow | undefined;
    if (!row) return RESET.invalid;
    const state = resetState(row);
    if (state !== 'valid') return RESET[state];
    const user = db.prepare(`SELECT u.id, u.email, u.name FROM users u WHERE u.id = ? AND ${SIGN_IN_CAPABLE}`).get(row.user_id) as { id: string; email: string; name: string } | undefined;
    if (!user) return RESET.invalid;
    const consumed = db.prepare(
      `UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ?`
    ).run(nowIso(), row.id, nowIso()).changes;
    if (!consumed) return RESET.used;
    // This link was used, and every other one ends: none of their queued emails is sent.
    supersedeQueuedEmailForPasswordReset(row.id);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    supersedePasswordResets(user.id);
    revokeUserSessions(user.id);
    const changedAt = nowIso();
    const queueId = queueAccountEmail('password_changed', { userId: user.id }, { changedAt });
    return { ok: true, email: user.email, name: user.name, changedAt, queueId };
  }).immediate();
  if (!result.ok) return result;
  sendAccountEmail('password_changed', result.email, { name: result.name, changedAt: result.changedAt }, result.queueId);
  return { ok: true, email: result.email };
}

// ─── Account email retries ───────────────────────────────────────────────────

const NOT_SENT = { superseded: { send: false, outcome: 'superseded' }, expired: { send: false, outcome: 'expired' } } as const;

/**
 * What the retry of a queued account email sends (called by the email worker for a row it has claimed). Links are
 * stored only as hashes, so a retry issues a NEW link with the ORIGINAL expiry and the earlier link stops working
 * (newest link wins, as for any new request). A link that was used or replaced, or whose expiry has been reached, is
 * never sent again; neither is a reset link for an account that can no longer sign in.
 */
export function prepareAccountEmailRetry(row: AccountQueueRow, now = Date.now()): AccountEmailRetry {
  return db.transaction((): AccountEmailRetry => {
    switch (row.kind) {
      case 'verify':
      case 'verify_again': {
        const request = db.prepare('SELECT * FROM signup_requests WHERE id = ?').get(row.signup_request_id) as SignupRow | undefined;
        if (!request) return NOT_SENT.superseded;
        const state = signupState(request, now);
        if (state === 'expired') return NOT_SENT.expired;
        if (state !== 'valid' || db.prepare('SELECT 1 FROM users WHERE email = ?').get(request.email)) return NOT_SENT.superseded;
        const token = newToken();
        const id = `signup-${nanoid(12)}`;
        db.prepare('UPDATE signup_requests SET superseded_at = ? WHERE id = ? AND verified_at IS NULL AND superseded_at IS NULL').run(nowIso(now), request.id);
        db.prepare(
          `INSERT INTO signup_requests (id, email, name, company, password_hash, timezone, country, token_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, request.email, request.name, request.company, request.password_hash, request.timezone, request.country, hashToken(token), nowIso(now), request.expires_at);
        db.prepare('UPDATE account_email_queue SET signup_request_id = ? WHERE id = ?').run(id, row.id);
        return { send: true, to: request.email, data: { name: request.name, company: request.company, token } };
      }
      case 'password_reset': {
        const reset = db.prepare('SELECT * FROM password_resets WHERE id = ?').get(row.password_reset_id) as ResetRow | undefined;
        if (!reset) return NOT_SENT.superseded;
        const state = resetState(reset, now);
        if (state === 'expired') return NOT_SENT.expired;
        if (state !== 'valid') return NOT_SENT.superseded;
        const user = db.prepare(`SELECT u.id, u.email, u.name FROM users u WHERE u.id = ? AND ${SIGN_IN_CAPABLE}`).get(reset.user_id) as { id: string; email: string; name: string } | undefined;
        if (!user) return NOT_SENT.superseded;
        const token = newToken();
        const id = `reset-${nanoid(12)}`;
        db.prepare('UPDATE password_resets SET superseded_at = ? WHERE id = ? AND used_at IS NULL AND superseded_at IS NULL').run(nowIso(now), reset.id);
        db.prepare('INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, user.id, hashToken(token), nowIso(now), reset.expires_at);
        db.prepare('UPDATE account_email_queue SET password_reset_id = ? WHERE id = ?').run(id, row.id);
        return { send: true, to: user.email, data: { name: user.name, token } };
      }
      case 'existing_account':
      case 'password_changed': {
        // No link: the same notice is sent again, to the account's current address.
        const user = db.prepare('SELECT email, name FROM users WHERE id = ?').get(row.user_id) as { email: string; name: string } | undefined;
        if (!user) return NOT_SENT.superseded;
        return { send: true, to: user.email, data: row.kind === 'password_changed' ? { name: user.name, changedAt: row.changed_at ?? undefined } : { name: user.name } };
      }
    }
  }).immediate();
}

registerAccountEmailRetry(prepareAccountEmailRetry);
