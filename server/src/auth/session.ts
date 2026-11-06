import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import db from '../db/init';
import { securityConfig } from '../config/security';
import type { AuthPayload, StaffRole } from '../types';

// Sessions are stored server-side so they can be revoked. The signed token only names the user and session;
// every request re-reads role, organization and active state from the database.

export interface IssuedSession { token: string; sessionId: string; expiresAt: string; csrfToken: string }

/** A key for one purpose, derived from JWT_SECRET so no extra secret has to be configured. */
export function deriveKey(purpose: string): Buffer {
  return createHmac('sha256', securityConfig().jwtSecret).update(`we360:${purpose}`).digest();
}

export function createSession(userId: string, orgId: string): IssuedSession {
  const { sessionTtlMs, jwtSecret } = securityConfig();
  const sessionId = randomBytes(18).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
  db.prepare('INSERT INTO user_sessions (id, user_id, organization_id, expires_at) VALUES (?, ?, ?, ?)')
    .run(sessionId, userId, orgId, expiresAt);
  // Housekeeping: forget sessions that ended more than 30 days ago.
  db.prepare(`DELETE FROM user_sessions WHERE user_id = ? AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')`).run(userId);
  const token = jwt.sign({ sub: userId, sid: sessionId }, jwtSecret, {
    algorithm: 'HS256',
    expiresIn: Math.floor(sessionTtlMs / 1000),
  });
  return { token, sessionId, expiresAt, csrfToken: csrfTokenFor(sessionId) };
}

interface SessionRow {
  user_id: string; session_org: string; expires_at: string; revoked_at: string | null;
  email: string; role: string; is_active: number; user_org: string;
  staff_id: string | null; staff_active: number | null; staff_org: string | null;
}

/** Returns the signed-in user for a token, or null when the token, session or user is no longer valid. */
export function resolveSession(token: string): AuthPayload | null {
  let claims: { sub?: unknown; sid?: unknown };
  try {
    claims = jwt.verify(token, securityConfig().jwtSecret, { algorithms: ['HS256'] }) as typeof claims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null; // tokens from before server-side sessions
  const row = db.prepare(
    `SELECT s.user_id, s.organization_id AS session_org, s.expires_at, s.revoked_at,
            u.email, u.role, u.is_active, u.organization_id AS user_org, u.staff_id,
            st.is_active AS staff_active, st.organization_id AS staff_org
     FROM user_sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN staff st ON st.id = u.staff_id
     WHERE s.id = ?`
  ).get(claims.sid) as SessionRow | undefined;
  if (!row || row.user_id !== claims.sub) return null;
  if (row.revoked_at || Date.parse(row.expires_at) <= Date.now()) return null;
  if (!row.is_active || row.user_org !== row.session_org) return null;
  // A staff sign-in only works while its staff record is active and in the same organization.
  if (row.staff_id && (!row.staff_active || row.staff_org !== row.user_org)) return null;
  return { sub: row.user_id, email: row.email, orgId: row.user_org, role: row.role as StaffRole, sid: claims.sid, staffId: row.staff_id };
}

/** Active sessions of a user, newest first (no addresses or device data are stored). */
export function listUserSessions(userId: string): Array<{ id: string; createdAt: string; expiresAt: string }> {
  return db.prepare(
    `SELECT id, created_at AS createdAt, expires_at AS expiresAt FROM user_sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
     ORDER BY created_at DESC`
  ).all(userId) as Array<{ id: string; createdAt: string; expiresAt: string }>;
}

export function revokeSession(sessionId: string): void {
  db.prepare(`UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL`)
    .run(sessionId);
}

/** Ends every session of a user, optionally keeping the one making the request. */
export function revokeUserSessions(userId: string, exceptSessionId?: string): number {
  return db.prepare(
    `UPDATE user_sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`
  ).run(userId, exceptSessionId ?? null).changes;
}

/** CSRF token bound to one session: an attacker's page can neither read it nor compute it. */
export function csrfTokenFor(sessionId: string): string {
  return createHmac('sha256', deriveKey('csrf-v1')).update(sessionId).digest('base64url');
}

export function csrfTokenValid(sessionId: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId));
  const actual = Buffer.from(presented);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
