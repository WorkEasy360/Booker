import { createHash, randomBytes } from 'crypto';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { emailTransportName, sendInvitationEmail, type DeliveryResult } from './email/notify';
import { revokeUserSessions } from '../auth/session';
import { disableTwoFactor } from './two-factor';

// Staff sign-in by invitation. The admin never sees the token: it exists only in the email to the staff member's
// address, so accepting it proves they control that inbox. Tokens are random, stored as SHA-256 hashes,
// single-use, expire after 72 hours, and a newer invitation replaces older ones for the same person.

export const INVITE_TTL_MS = 72 * 60 * 60_000;
export type InviteRole = 'staff' | 'manager';
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface InvitationRow {
  id: string; organization_id: string; staff_id: string; email: string; role: InviteRole;
  invited_by: string; created_at: string; expires_at: string;
  accepted_at: string | null; revoked_at: string | null; delivery_status: string | null; delivery_error: string | null;
}

function statusOf(row: InvitationRow, now = Date.now()): InvitationStatus {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (Date.parse(row.expires_at) <= now) return 'expired';
  return 'pending';
}

function publicInvitation(row: InvitationRow) {
  return {
    id: row.id, email: row.email, role: row.role, status: statusOf(row),
    createdAt: row.created_at, expiresAt: row.expires_at, acceptedAt: row.accepted_at,
    delivery: row.delivery_status ? { status: row.delivery_status, error: row.delivery_error } : null,
  };
}

/** Sign-in state of each staff member, for the staff list. */
type AccountSummary = { status: 'active' | 'disabled' | 'invited' | 'none'; role?: string; expiresAt?: string; twoFactor?: boolean };

export function accountSummaries(orgId: string): Map<string, AccountSummary> {
  const out = new Map<string, AccountSummary>();
  const users = db.prepare(
    `SELECT u.staff_id, u.role, u.is_active, t.enabled_at IS NOT NULL AS two_factor
     FROM users u LEFT JOIN user_two_factor t ON t.user_id = u.id
     WHERE u.organization_id = ? AND u.staff_id IS NOT NULL`
  ).all(orgId) as Array<{ staff_id: string; role: string; is_active: number; two_factor: number }>;
  for (const u of users) out.set(u.staff_id, { status: u.is_active ? 'active' : 'disabled', role: u.role, twoFactor: !!u.two_factor });
  const pending = db.prepare(
    `SELECT staff_id, role, expires_at FROM staff_invitations
     WHERE organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`
  ).all(orgId) as Array<{ staff_id: string; role: string; expires_at: string }>;
  for (const p of pending) if (!out.has(p.staff_id)) out.set(p.staff_id, { status: 'invited', role: p.role, expiresAt: p.expires_at });
  return out;
}

type Failure = { ok: false; status: number; error: string; code: string };

export async function inviteStaff(orgId: string, staffId: string, role: InviteRole, invitedBy: { id: string; name: string }):
  Promise<{ ok: true; invitation: ReturnType<typeof publicInvitation>; email: DeliveryResult } | Failure> {
  const staff = db.prepare('SELECT id, name, email, is_active FROM staff WHERE id = ? AND organization_id = ?')
    .get(staffId, orgId) as { id: string; name: string; email: string | null; is_active: number } | undefined;
  if (!staff) return { ok: false, status: 404, error: 'Staff member not found', code: 'NOT_FOUND' };
  if (!staff.is_active) return { ok: false, status: 409, error: 'Activate this staff member before inviting them to sign in.', code: 'STAFF_INACTIVE' };
  const email = staff.email?.trim().toLowerCase();
  if (!email) return { ok: false, status: 409, error: 'Add an email address to this staff member first.', code: 'NO_EMAIL' };
  if (db.prepare('SELECT 1 FROM users WHERE staff_id = ?').get(staffId)) {
    return { ok: false, status: 409, error: 'This staff member already has a sign-in.', code: 'ALREADY_LINKED' };
  }
  // An existing sign-in in this business is reported to its admin. One in another business is not: that would let any
  // admin (and anyone can create a business) test whether an address has an account anywhere. That invitation is sent
  // like any other, and accepting it is refused (one email address belongs to one business), which tells only the
  // owner of the inbox.
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND organization_id = ?').get(email, orgId)) {
    return { ok: false, status: 409, error: 'An account with this email address already exists. A staff sign-in needs its own email address.', code: 'EMAIL_IN_USE' };
  }
  // Without email delivery there is no way to prove the address, so no invitation is created.
  if (emailTransportName() === 'disabled') {
    return { ok: false, status: 409, error: 'Email sending is not configured, so invitations cannot be delivered. Set up email first (see Notifications).', code: 'EMAIL_NOT_CONFIGURED' };
  }

  const token = randomBytes(32).toString('base64url');
  const id = `inv-${nanoid(12)}`;
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  db.transaction(() => {
    // A new invitation replaces any earlier one that is still open.
    db.prepare(`UPDATE staff_invitations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                WHERE staff_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`).run(staffId);
    db.prepare(`INSERT INTO staff_invitations (id, organization_id, staff_id, email, role, token_hash, invited_by, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, orgId, staffId, email, role, hashInviteToken(token), invitedBy.id, expiresAt);
  })();

  const org = db.prepare('SELECT name, timezone FROM organizations WHERE id = ?').get(orgId) as { name: string; timezone: string | null };
  const result = await sendInvitationEmail(email, {
    businessName: org.name, staffName: staff.name, inviterName: invitedBy.name, role, expiresAt, timezone: org.timezone ?? 'UTC',
  }, token);
  // A link that was never delivered must not stay usable.
  db.prepare(`UPDATE staff_invitations SET delivery_status = ?, delivery_error = ?,
              revoked_at = CASE WHEN ? = 'sent' THEN revoked_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END
              WHERE id = ?`).run(result.status, result.error ?? null, result.status, id);
  const row = db.prepare('SELECT * FROM staff_invitations WHERE id = ?').get(id) as InvitationRow;
  return { ok: true, invitation: publicInvitation(row), email: result };
}

export function listInvitations(orgId: string, staffId: string) {
  return (db.prepare('SELECT * FROM staff_invitations WHERE organization_id = ? AND staff_id = ? ORDER BY created_at DESC')
    .all(orgId, staffId) as InvitationRow[]).map(publicInvitation);
}

export function revokeInvitation(orgId: string, staffId: string, invitationId: string): boolean {
  return db.prepare(
    `UPDATE staff_invitations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ? AND organization_id = ? AND staff_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
  ).run(invitationId, orgId, staffId).changes > 0;
}

/** Revokes every open invitation for a staff member (e.g. when their email changes). */
export function revokeOpenInvitations(staffId: string): void {
  db.prepare(`UPDATE staff_invitations SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
              WHERE staff_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`).run(staffId);
}

/** Turns a staff member's sign-in off (or back on). Turning off also ends their sessions and open invitations. */
export function setStaffAccess(orgId: string, staffId: string, enabled: boolean): 'ok' | 'no_account' {
  const user = db.prepare('SELECT id FROM users WHERE staff_id = ? AND organization_id = ?').get(staffId, orgId) as { id: string } | undefined;
  if (!enabled) revokeOpenInvitations(staffId);
  if (!user) return 'no_account';
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(enabled ? 1 : 0, user.id);
  if (!enabled) revokeUserSessions(user.id);
  return 'ok';
}

/** Turns off two-factor sign-in for a staff member's account (lost phone and codes) and signs it out everywhere. */
export function resetStaffTwoFactor(orgId: string, staffId: string): 'ok' | 'no_account' | 'not_enabled' {
  const user = db.prepare('SELECT id FROM users WHERE staff_id = ? AND organization_id = ?').get(staffId, orgId) as { id: string } | undefined;
  if (!user) return 'no_account';
  if (!disableTwoFactor(user.id)) return 'not_enabled';
  revokeUserSessions(user.id);
  return 'ok';
}

export function endStaffSessions(staffId: string): void {
  const user = db.prepare('SELECT id FROM users WHERE staff_id = ?').get(staffId) as { id: string } | undefined;
  if (user) revokeUserSessions(user.id);
}

function findByToken(token: string): InvitationRow | undefined {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return undefined;
  return db.prepare('SELECT * FROM staff_invitations WHERE token_hash = ?').get(hashInviteToken(token)) as InvitationRow | undefined;
}

const UNUSABLE: Record<Exclude<InvitationStatus, 'pending'>, Failure> = {
  accepted: { ok: false, status: 410, error: 'This invitation has already been used. Sign in with your email and password.', code: 'INVITE_USED' },
  expired: { ok: false, status: 410, error: 'This invitation has expired. Ask your administrator to send a new one.', code: 'INVITE_EXPIRED' },
  revoked: { ok: false, status: 410, error: 'This invitation is no longer valid. Ask your administrator to send a new one.', code: 'INVITE_REVOKED' },
};
const INVALID: Failure = { ok: false, status: 404, error: 'This invitation link is not valid.', code: 'INVITE_INVALID' };

/** What the invitee sees before choosing a password. */
export function inspectInvitation(token: string) {
  const row = findByToken(token);
  if (!row) return INVALID;
  const status = statusOf(row);
  if (status !== 'pending') return UNUSABLE[status];
  const info = db.prepare(
    `SELECT o.name AS org_name, s.name AS staff_name FROM organizations o JOIN staff s ON s.id = ? WHERE o.id = ?`
  ).get(row.staff_id, row.organization_id) as { org_name: string; staff_name: string } | undefined;
  if (!info) return INVALID;
  return { ok: true as const, data: { businessName: info.org_name, staffName: info.staff_name, email: row.email, role: row.role, expiresAt: row.expires_at } };
}

/**
 * Creates the staff sign-in. Everything is re-checked inside one write transaction, and the invitation is
 * consumed with a conditional update, so two simultaneous accepts cannot both succeed.
 */
export function acceptInvitation(token: string, passwordHash: string):
  { ok: true; user: { id: string; email: string; name: string; role: InviteRole; organization_id: string; staff_id: string } } | Failure {
  const row = findByToken(token);
  if (!row) return INVALID;
  return db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM staff_invitations WHERE id = ?').get(row.id) as InvitationRow;
    const status = statusOf(fresh);
    if (status !== 'pending') return UNUSABLE[status];
    const staff = db.prepare('SELECT id, name, email, is_active FROM staff WHERE id = ? AND organization_id = ?')
      .get(fresh.staff_id, fresh.organization_id) as { id: string; name: string; email: string | null; is_active: number } | undefined;
    // The address the invitation proved must still be this staff member's address.
    if (!staff || !staff.is_active || staff.email?.trim().toLowerCase() !== fresh.email) return UNUSABLE.revoked;
    if (db.prepare('SELECT 1 FROM users WHERE staff_id = ? OR email = ?').get(staff.id, fresh.email)) {
      return { ok: false, status: 409, error: 'An account for this email address already exists. Sign in instead.', code: 'EMAIL_IN_USE' } as Failure;
    }
    const consumed = db.prepare(
      `UPDATE staff_invitations SET accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL`
    ).run(fresh.id).changes;
    if (!consumed) return UNUSABLE.accepted;
    const userId = `user-${nanoid(10)}`;
    db.prepare(`INSERT INTO users (id, organization_id, email, password_hash, name, role, staff_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, fresh.organization_id, fresh.email, passwordHash, staff.name, fresh.role, staff.id);
    db.prepare('UPDATE staff_invitations SET accepted_user_id = ? WHERE id = ?').run(userId, fresh.id);
    return { ok: true as const, user: { id: userId, email: fresh.email, name: staff.name, role: fresh.role, organization_id: fresh.organization_id, staff_id: staff.id } };
  }).immediate();
}
