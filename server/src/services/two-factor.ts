import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { deriveKey } from '../auth/session';
import { securityConfig } from '../config/security';
import { COMPANY_NAME } from '../brand';

// Two-factor sign-in with an authenticator app: TOTP (RFC 6238) with SHA-1, 6 digits and 30-second steps, the
// settings every common authenticator app uses. Secrets are stored encrypted (AES-256-GCM, bound to the user id) and
// never returned after setup. Each code works once (last_used_step). Recovery codes are 80-bit random values stored
// only as SHA-256 hashes, each usable once. Tables: user_two_factor, user_recovery_codes (migration 011_two_factor).

export const TOTP_PERIOD_S = 30;
export const TOTP_DIGITS = 6;
export const RECOVERY_CODE_COUNT = 10;
export const SETUP_TTL_MS = 10 * 60_000;
export const CHALLENGE_TTL_MS = 5 * 60_000;

// ─── Base32 (RFC 4648), the encoding authenticator apps expect ───────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ─── TOTP ────────────────────────────────────────────────────────────────────

/** HOTP (RFC 4226) for one counter value. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / TOTP_PERIOD_S);

/** The 30-second step a code belongs to, accepting one step of clock drift either way, or null. */
export function matchingStep(key: Buffer, code: string, now = Date.now()): number | null {
  const presented = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(presented)) return null;
  const current = stepAt(now);
  let found: number | null = null;
  // Every candidate is compared (no early exit), so timing does not reveal which step matched.
  for (const step of [current - 1, current, current + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(presented))) found = step;
  }
  return found;
}

// ─── Secrets at rest ─────────────────────────────────────────────────────────

function encryptionKey(): Buffer {
  return securityConfig().twoFactorKey ?? deriveKey('two-factor-secret-v1');
}
const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** v1.<key id>.<iv>.<tag>.<ciphertext>; the user id is authenticated data, so a value cannot be moved to another user. */
export function sealSecret(userId: string, secret: Buffer): string {
  const key = encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`totp:${userId}`));
  const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ['v1', keyId(key), iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

/** The secret, or null when the value was sealed with another key, altered, or belongs to another user. */
export function openSecret(userId: string, sealed: string): Buffer | null {
  const parts = sealed.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const key = encryptionKey();
  if (parts[1] !== keyId(key)) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'));
    decipher.setAAD(Buffer.from(`totp:${userId}`));
    decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]);
  } catch {
    return null;
  }
}

// ─── Recovery codes ──────────────────────────────────────────────────────────

const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, '');
const hashRecoveryCode = (code: string) => createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

function newRecoveryCode(): string {
  const raw = base32Encode(randomBytes(10)).toLowerCase(); // 16 characters, 80 bits
  return raw.match(/.{4}/g)!.join('-');
}

/** Replaces the user's recovery codes; the new ones are returned once and stored only as hashes. */
function replaceRecoveryCodes(userId: string): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)');
  for (const code of codes) insert.run(`rc-${nanoid(12)}`, userId, hashRecoveryCode(code));
  return codes;
}

// ─── Per-user state ──────────────────────────────────────────────────────────

interface Row {
  user_id: string; secret_enc: string | null; enabled_at: string | null;
  pending_secret_enc: string | null; pending_expires_at: string | null; last_used_step: number | null;
}
const rowFor = (userId: string) => db.prepare('SELECT * FROM user_two_factor WHERE user_id = ?').get(userId) as Row | undefined;
const nowIso = () => new Date().toISOString();

export function twoFactorEnabled(userId: string): boolean {
  return !!rowFor(userId)?.enabled_at;
}

export function twoFactorStatus(userId: string): { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number } {
  const row = rowFor(userId);
  const left = (db.prepare('SELECT COUNT(*) c FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL').get(userId) as { c: number }).c;
  return { enabled: !!row?.enabled_at, enabledAt: row?.enabled_at ?? null, recoveryCodesLeft: row?.enabled_at ? left : 0 };
}

/** Starts setup: a new secret that becomes active only once a code from the app confirms it. */
export function beginSetup(userId: string, accountEmail: string): { secret: string; otpauthUrl: string; expiresAt: string } | { error: string } {
  if (twoFactorEnabled(userId)) return { error: 'Two-factor sign-in is already on. Turn it off first to set up a new app.' };
  const secret = randomBytes(20);
  const expiresAt = new Date(Date.now() + SETUP_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO user_two_factor (user_id, pending_secret_enc, pending_expires_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET pending_secret_enc = excluded.pending_secret_enc,
       pending_expires_at = excluded.pending_expires_at, updated_at = excluded.updated_at`
  ).run(userId, sealSecret(userId, secret), expiresAt, nowIso());
  const encoded = base32Encode(secret);
  const label = encodeURIComponent(`${COMPANY_NAME}:${accountEmail}`);
  return {
    secret: encoded,
    otpauthUrl: `otpauth://totp/${label}?secret=${encoded}&issuer=${encodeURIComponent(COMPANY_NAME)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_S}`,
    expiresAt,
  };
}

/** Finishes setup with a code from the app. Returns the recovery codes (shown once). */
export function confirmSetup(userId: string, code: string, now = Date.now()): { recoveryCodes: string[] } | { error: string } {
  return db.transaction((): { recoveryCodes: string[] } | { error: string } => {
    const row = rowFor(userId);
    if (row?.enabled_at) return { error: 'Two-factor sign-in is already on.' };
    if (!row?.pending_secret_enc || !row.pending_expires_at || Date.parse(row.pending_expires_at) <= now) {
      return { error: 'Setup has expired. Start again to get a new QR code.' };
    }
    const secret = openSecret(userId, row.pending_secret_enc);
    const step = secret ? matchingStep(secret, code, now) : null;
    if (!secret || step === null) return { error: 'That code is not correct. Check the time on your phone and try the newest code.' };
    db.prepare(
      `UPDATE user_two_factor SET secret_enc = ?, enabled_at = ?, last_used_step = ?, pending_secret_enc = NULL,
         pending_expires_at = NULL, updated_at = ? WHERE user_id = ?`
    ).run(sealSecret(userId, secret), nowIso(), step, nowIso(), userId);
    return { recoveryCodes: replaceRecoveryCodes(userId) };
  }).immediate();
}

/**
 * Checks a second factor: an authenticator code (each works once) or an unused recovery code (used up here).
 * Only for users with two-factor on.
 */
export function verifySecondFactor(userId: string, input: { code?: string; recoveryCode?: string }, now = Date.now()): boolean {
  return db.transaction((): boolean => {
    const row = rowFor(userId);
    if (!row?.enabled_at || !row.secret_enc) return false;
    if (input.recoveryCode !== undefined) {
      if (normalizeRecoveryCode(input.recoveryCode).length !== 16) return false;
      return db.prepare('UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .run(nowIso(), userId, hashRecoveryCode(input.recoveryCode)).changes === 1;
    }
    const secret = openSecret(userId, row.secret_enc);
    const step = secret ? matchingStep(secret, input.code ?? '', now) : null;
    if (step === null) return false;
    // A code is accepted once: never again, and never an older one after a newer one was used.
    return db.prepare(
      'UPDATE user_two_factor SET last_used_step = ?, updated_at = ? WHERE user_id = ? AND (last_used_step IS NULL OR last_used_step < ?)'
    ).run(step, nowIso(), userId, step).changes === 1;
  }).immediate();
}

/** Turns two-factor sign-in off and removes the secret and recovery codes. */
export function disableTwoFactor(userId: string): boolean {
  return db.transaction((): boolean => {
    const had = db.prepare('DELETE FROM user_two_factor WHERE user_id = ?').run(userId).changes > 0;
    db.prepare('DELETE FROM user_recovery_codes WHERE user_id = ?').run(userId);
    return had;
  })();
}

export function regenerateRecoveryCodes(userId: string): string[] | null {
  return db.transaction((): string[] | null => (twoFactorEnabled(userId) ? replaceRecoveryCodes(userId) : null))();
}

// ─── Sign-in challenge ───────────────────────────────────────────────────────
// After a correct password, a user with two-factor on gets a short-lived signed challenge instead of a session. It
// names the user and is bound to the current password and authenticator, so it stops working if either changes.

function stateFingerprint(userId: string): string | null {
  const row = db.prepare(
    `SELECT u.password_hash, t.secret_enc, t.enabled_at FROM users u JOIN user_two_factor t ON t.user_id = u.id
     WHERE u.id = ? AND u.is_active = 1 AND t.enabled_at IS NOT NULL`
  ).get(userId) as { password_hash: string; secret_enc: string; enabled_at: string } | undefined;
  return row ? createHash('sha256').update(`${row.password_hash}|${row.secret_enc}|${row.enabled_at}`).digest('base64url') : null;
}

function signChallenge(userId: string, exp: number, nonce: string, fingerprint: string): string {
  return createHmac('sha256', deriveKey('two-factor-challenge-v1')).update(`${userId}.${exp}.${nonce}.${fingerprint}`).digest('base64url');
}

export function issueChallenge(userId: string, now = Date.now()): { challenge: string; expiresAt: string } {
  const exp = Math.floor((now + CHALLENGE_TTL_MS) / 1000);
  const nonce = randomBytes(12).toString('base64url');
  const fingerprint = stateFingerprint(userId) ?? '';
  const id = Buffer.from(userId).toString('base64url');
  return { challenge: ['v1', id, exp.toString(36), nonce, signChallenge(userId, exp, nonce, fingerprint)].join('.'), expiresAt: new Date(exp * 1000).toISOString() };
}

/** The user a challenge was issued to, or null when it is altered, expired, or the password or authenticator changed. */
export function verifyChallenge(challenge: unknown, now = Date.now()): string | null {
  if (typeof challenge !== 'string' || challenge.length > 400) return null;
  const parts = challenge.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const userId = Buffer.from(parts[1], 'base64url').toString('utf8');
  const exp = parseInt(parts[2], 36);
  if (!userId || !Number.isSafeInteger(exp) || exp * 1000 <= now) return null;
  const fingerprint = stateFingerprint(userId);
  if (!fingerprint) return null;
  const expected = Buffer.from(signChallenge(userId, exp, parts[3], fingerprint));
  const presented = Buffer.from(parts[4]);
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? userId : null;
}
