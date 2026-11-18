import { createHash } from 'crypto';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { applyCleanup } from '../db/cleanup';
import { DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT, newBusinessLocale } from '../services/business-locale';
import type { AnswerStore } from './entitlements';
import type { JoinRole } from './config';

// Everything WorkEasy360 sign-in keeps, in the same SQLite database as the rest of the app (migration
// 018_workeasy360_sso). Every instance of the API that opens this database file sees the same rows, so a sign-in flow,
// a logout token or an entitlement answer recorded by one instance holds for all of them.

/**
 * A stored password hash that no password can match: bcrypt hashes are 60 characters, and bcryptjs answers false for
 * anything else. Accounts created by WorkEasy360 sign-in have no password of their own.
 */
export const NO_PASSWORD = '!workeasy360-no-password';

const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function audit(action: string, detail: Record<string, unknown>): void {
  db.prepare('INSERT INTO workeasy360_audit (action, detail) VALUES (?, ?)').run(action, JSON.stringify(detail));
}

// ─── Sign-in flows ────────────────────────────────────────────────────────────

export interface LoginFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  organizationId: string | null;
  returnTo: string | null;
}

/** Keeps a flow server-side under the hash of the browser's random flow id. */
export function saveLoginFlow(flowId: string, flow: LoginFlow, ttlSeconds: number): void {
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM workeasy360_login_flows WHERE expires_at < ?').run(now());
    db.prepare(
      `INSERT INTO workeasy360_login_flows (id_hash, state, nonce, code_verifier, organization_hint, return_to, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(hash(flowId), flow.state, flow.nonce, flow.codeVerifier, flow.organizationId, flow.returnTo, expires);
  })();
}

/** Takes (deletes) the flow: a flow is used once, whatever happens next. Undefined when unknown or expired. */
export function takeLoginFlow(flowId: string): LoginFlow | undefined {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM workeasy360_login_flows WHERE id_hash = ?').get(hash(flowId)) as
      | { state: string; nonce: string; code_verifier: string; organization_hint: string | null; return_to: string | null; expires_at: string }
      | undefined;
    if (!row) return undefined;
    db.prepare('DELETE FROM workeasy360_login_flows WHERE id_hash = ?').run(hash(flowId));
    if (Date.parse(row.expires_at) <= Date.now()) return undefined;
    return { state: row.state, nonce: row.nonce, codeVerifier: row.code_verifier, organizationId: row.organization_hint, returnTo: row.return_to };
  }).immediate();
}

// ─── Entitlement answers shared by every instance ─────────────────────────────

export const sqliteAnswerStore: AnswerStore = {
  async get(key) {
    const row = db.prepare('SELECT value, expires_at FROM workeasy360_entitlements WHERE key = ?').get(key) as
      | { value: string; expires_at: string | null }
      | undefined;
    if (!row) return null;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
    return row.value;
  },
  async set(key, value, ttlSeconds) {
    const expires = ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString();
    db.prepare(
      `INSERT INTO workeasy360_entitlements (key, value, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
    ).run(key, value, expires);
  },
};

// ─── Organizations ────────────────────────────────────────────────────────────

/** The WorkEasy360 organization a business here is linked to, if any. */
export function linkedW360Organization(organizationId: string): string | undefined {
  const row = db.prepare('SELECT w360_organization_id FROM workeasy360_organizations WHERE organization_id = ?').get(organizationId) as
    | { w360_organization_id: string }
    | undefined;
  return row?.w360_organization_id;
}

// ─── Sign-in: identity and organization ───────────────────────────────────────

export interface SignInIdentity {
  issuer: string;
  subject: string;
  organizationId: string;
  organizationName?: string | undefined;
  email: string;
  name?: string | undefined;
}

export type ProvisionOutcome =
  | { kind: 'ok'; userId: string; organizationId: string; role: string; staffId: string | null; email: string; name: string; organizationCreated: boolean; userCreated: boolean }
  | { kind: 'refused'; code: 'account_conflict' | 'other_organization' | 'identity_conflict' | 'account_disabled' | 'no_business' | 'business_unavailable'; detail: string };

interface UserRow { id: string; organization_id: string; email: string; name: string; role: string; is_active: number; staff_id: string | null; staff_active: number | null }

function userById(id: string): UserRow | undefined {
  return db.prepare(
    `SELECT u.id, u.organization_id, u.email, u.name, u.role, u.is_active, u.staff_id, st.is_active AS staff_active
     FROM users u LEFT JOIN staff st ON st.id = u.staff_id AND st.organization_id = u.organization_id WHERE u.id = ?`
  ).get(id) as UserRow | undefined;
}

/**
 * Turns a verified WorkEasy360 sign-in into a user of one business here, in one transaction:
 *
 * - the person is the user linked on (issuer, sub), never matched by email; an unlinked account that already uses the
 *   address is `account_conflict` (an operator links it deliberately with `npm run w360:link-user`);
 * - the WorkEasy360 organization is the business linked to it; the first sign-in of an unlinked organization creates
 *   its business (unless provisioning is off) with this person as its administrator;
 * - a user belongs to exactly one business, so a person already here for another organization is
 *   `other_organization`: one sign-in never reaches two businesses;
 * - someone new to an existing business joins with the configured role (staff unless set to manager).
 */
export function provisionSignIn(identity: SignInIdentity, options: { defaultRole: JoinRole; provision: boolean }): ProvisionOutcome {
  return db.transaction((): ProvisionOutcome => {
    const linked = db.prepare('SELECT user_id FROM workeasy360_identities WHERE issuer = ? AND subject = ?').get(identity.issuer, identity.subject) as
      | { user_id: string }
      | undefined;
    if (!linked) {
      const elsewhere = db.prepare('SELECT issuer FROM workeasy360_identities WHERE subject = ? AND issuer != ?').get(identity.subject, identity.issuer) as
        | { issuer: string }
        | undefined;
      // The same person under the provider's previous name: refuse rather than create a second account (w360:move-issuer).
      if (elsewhere) return { kind: 'refused', code: 'identity_conflict', detail: 'the subject is linked under another issuer' };
    }
    const orgLink = db.prepare(
      `SELECT l.organization_id, o.id AS present FROM workeasy360_organizations l LEFT JOIN organizations o ON o.id = l.organization_id
       WHERE l.w360_organization_id = ?`
    ).get(identity.organizationId) as { organization_id: string; present: string | null } | undefined;
    if (orgLink && !orgLink.present) return { kind: 'refused', code: 'business_unavailable', detail: 'the linked business no longer exists' };

    if (linked) {
      const user = userById(linked.user_id);
      if (!user) return { kind: 'refused', code: 'account_disabled', detail: 'the linked user no longer exists' };
      if (!orgLink || orgLink.organization_id !== user.organization_id) {
        return { kind: 'refused', code: 'other_organization', detail: 'the person belongs to another business here' };
      }
      if (!user.is_active || (user.staff_id && !user.staff_active)) return { kind: 'refused', code: 'account_disabled', detail: 'the user is deactivated' };
      db.prepare('UPDATE workeasy360_identities SET last_sign_in_at = ? WHERE issuer = ? AND subject = ?').run(now(), identity.issuer, identity.subject);
      return { kind: 'ok', userId: user.id, organizationId: user.organization_id, role: user.role, staffId: user.staff_id, email: user.email, name: user.name, organizationCreated: false, userCreated: false };
    }

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(identity.email)) {
      return { kind: 'refused', code: 'account_conflict', detail: 'an unlinked account already uses this email address' };
    }

    let organizationId: string;
    let organizationCreated = false;
    let role: string = options.defaultRole;
    if (orgLink) {
      organizationId = orgLink.organization_id;
    } else {
      if (!options.provision) return { kind: 'refused', code: 'no_business', detail: 'the organization is not linked to a business and provisioning is off' };
      organizationId = `org-${nanoid(8)}`;
      const locale = newBusinessLocale({});
      db.prepare(
        `INSERT INTO organizations (id, name, email, timezone, country, currency, date_format, time_format, working_hours, booking_rules)
         VALUES (?, ?, ?, ?, COALESCE(?, ?), ?, ?, '12h', '{}', '{}')`
      ).run(organizationId, (identity.organizationName ?? 'My Business').slice(0, 100), identity.email, locale.timezone, locale.country, DEFAULT_COUNTRY, DEFAULT_CURRENCY, DEFAULT_DATE_FORMAT);
      db.prepare(`INSERT INTO workeasy360_organizations (w360_organization_id, organization_id, linked_by) VALUES (?, ?, 'first_sign_in')`)
        .run(identity.organizationId, organizationId);
      organizationCreated = true;
      // The person whose sign-in creates the business is its first administrator, as with a web sign-up.
      role = 'admin';
    }
    const userId = `user-${nanoid(8)}`;
    const name = (identity.name ?? identity.email).slice(0, 100);
    db.prepare('INSERT INTO users (id, organization_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, organizationId, identity.email, NO_PASSWORD, name, role);
    db.prepare(
      `INSERT INTO workeasy360_identities (issuer, subject, user_id, email_at_link, linked_by, last_sign_in_at) VALUES (?, ?, ?, ?, 'sign_in', ?)`
    ).run(identity.issuer, identity.subject, userId, identity.email, now());
    audit('workeasy360.sign_in_provisioned', { userId, organizationId, w360OrganizationId: identity.organizationId, organizationCreated, role });
    return { kind: 'ok', userId, organizationId, role, staffId: null, email: identity.email, name, organizationCreated, userCreated: true };
  }).immediate();
}

/** Whether a provider sign-in (sid) has already been ended by a logout token: a sign-in still in flight is refused. */
export function providerSessionEnded(issuer: string, sid: string): boolean {
  return !!db.prepare('SELECT 1 FROM workeasy360_ended_sids WHERE issuer = ? AND sid = ?').get(issuer, sid);
}

// ─── Back-channel logout ──────────────────────────────────────────────────────

/**
 * In one transaction: records the jti once per issuer, then ends the sessions the token names (by sid, narrowed to sub
 * when both are present; by sub alone: every session of that person). A jti seen before ends nothing.
 */
export function endSessionsForLogoutToken(input: { issuer: string; jti: string; subject?: string; sid?: string; acceptableUntil: Date }): { replayed: boolean; sessionsEnded: number } {
  return db.transaction(() => {
    db.prepare('DELETE FROM workeasy360_logout_tokens WHERE acceptable_until < ?').run(now());
    const inserted = db.prepare(
      'INSERT INTO workeasy360_logout_tokens (issuer, jti, acceptable_until) VALUES (?, ?, ?) ON CONFLICT(issuer, jti) DO NOTHING'
    ).run(input.issuer, input.jti, input.acceptableUntil.toISOString()).changes;
    if (!inserted) return { replayed: true, sessionsEnded: 0 };
    const stamp = now();
    let ended = 0;
    if (input.sid) {
      db.prepare('INSERT INTO workeasy360_ended_sids (issuer, sid) VALUES (?, ?) ON CONFLICT(issuer, sid) DO NOTHING').run(input.issuer, input.sid);
      ended = input.subject
        ? db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND w360_issuer = ? AND w360_sid = ? AND w360_subject = ?`)
          .run(stamp, input.issuer, input.sid, input.subject).changes
        : db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND w360_issuer = ? AND w360_sid = ?`)
          .run(stamp, input.issuer, input.sid).changes;
    } else if (input.subject) {
      ended = db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND w360_issuer = ? AND w360_subject = ?`)
        .run(stamp, input.issuer, input.subject).changes;
    }
    return { replayed: false, sessionsEnded: ended };
  }).immediate();
}

// ─── Operator commands (server/scripts/workeasy360.ts) ────────────────────────

export type OperatorResult = { ok: true; message: string } | { ok: false; message: string };

/** What a business must not have for `--replace-empty` to delete it. */
const EMPTY_BUSINESS_TABLES = ['customers', 'appointments', 'services', 'staff', 'workspaces', 'resources', 'booking_pages'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sign-ins from a WorkEasy360 organization land in this existing business. A business already linked to another
 * organization is never re-pointed. If a first sign-in already created a business for the organization, this refuses,
 * unless `replaceEmpty` is given and that business is still empty (no customers, appointments, services, staff,
 * workspaces, resources or booking pages): it is then deleted with its sign-ins and sessions, so the people who
 * created it join this business on their next sign-in.
 */
export function linkOrganization(organizationId: string, w360OrganizationId: string, options: { replaceEmpty?: boolean; actor: string }): OperatorResult {
  if (!UUID.test(w360OrganizationId)) return { ok: false, message: 'the WorkEasy360 organization id must be a UUID' };
  const w360 = w360OrganizationId.toLowerCase();
  return db.transaction((): OperatorResult => {
    if (!db.prepare('SELECT 1 FROM organizations WHERE id = ?').get(organizationId)) return { ok: false, message: `no business ${organizationId}` };
    const current = linkedW360Organization(organizationId);
    if (current === w360) return { ok: true, message: `${organizationId} is already linked to ${w360}` };
    if (current) return { ok: false, message: `${organizationId} is already linked to another WorkEasy360 organization; it is never re-pointed` };
    const holder = db.prepare('SELECT organization_id FROM workeasy360_organizations WHERE w360_organization_id = ?').get(w360) as { organization_id: string } | undefined;
    if (holder) {
      if (!options.replaceEmpty) return { ok: false, message: `WorkEasy360 organization ${w360} already signs in to business ${holder.organization_id}; add --replace-empty to replace it if that business is empty` };
      const used = EMPTY_BUSINESS_TABLES.reduce((n, t) =>
        n + (db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE organization_id = ?`).get(holder.organization_id) as { c: number }).c, 0);
      if (used) return { ok: false, message: `business ${holder.organization_id} is not empty (${EMPTY_BUSINESS_TABLES.join(', ')}); it is not replaced` };
      const name = (db.prepare('SELECT name FROM organizations WHERE id = ?').get(holder.organization_id) as { name: string }).name;
      // The same deletion as the test-data cleanup tool: rows without a cascading key first, then the business.
      applyCleanup(db, [{ table: 'organizations', id: holder.organization_id, expect: name }]);
      audit('workeasy360.organization_replaced', { organizationId: holder.organization_id, w360OrganizationId: w360, actor: options.actor });
    }
    db.prepare(`INSERT INTO workeasy360_organizations (w360_organization_id, organization_id, linked_by) VALUES (?, ?, ?)`)
      .run(w360, organizationId, `operator:${options.actor}`);
    audit('workeasy360.organization_linked', { organizationId, w360OrganizationId: w360, actor: options.actor, replaced: holder?.organization_id ?? null });
    return { ok: true, message: `${organizationId} is now linked to WorkEasy360 organization ${w360}` };
  }).immediate();
}

/**
 * The operator vouches that an existing account (a password or invited staff account) is this WorkEasy360 person. It
 * keeps its business, role and staff record; from now on it signs in with WorkEasy360 only: its password is retired and
 * its open sessions end. Refused when the WorkEasy360 identity already has its own user, or the account is linked.
 */
export function linkUser(userId: string, subject: string, options: { issuer: string; actor: string }): OperatorResult {
  if (!subject || subject.length > 255) return { ok: false, message: 'the subject must be 1-255 characters' };
  return db.transaction((): OperatorResult => {
    const user = userById(userId);
    if (!user) return { ok: false, message: `no user ${userId}` };
    const existing = db.prepare('SELECT user_id FROM workeasy360_identities WHERE issuer = ? AND subject = ?').get(options.issuer, subject) as { user_id: string } | undefined;
    if (existing) return { ok: false, message: existing.user_id === userId ? 'already linked' : `that WorkEasy360 identity already has its own user ${existing.user_id}` };
    if (db.prepare('SELECT 1 FROM workeasy360_identities WHERE user_id = ? AND issuer = ?').get(userId, options.issuer)) {
      return { ok: false, message: `${userId} is already linked to another WorkEasy360 identity` };
    }
    db.prepare(`INSERT INTO workeasy360_identities (issuer, subject, user_id, email_at_link, linked_by) VALUES (?, ?, ?, ?, ?)`)
      .run(options.issuer, subject, userId, user.email, `operator:${options.actor}`);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(NO_PASSWORD, userId);
    db.prepare('UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(now(), userId);
    audit('workeasy360.user_linked', { userId, issuer: options.issuer, actor: options.actor });
    return { ok: true, message: `${userId} now signs in with WorkEasy360 only (password retired, sessions ended)` };
  }).immediate();
}

/** Promotes or demotes someone who joined through WorkEasy360 (they have no staff record for the Staff page). */
export function setRole(userId: string, role: string, actor: string): OperatorResult {
  if (!['admin', 'manager', 'staff'].includes(role)) return { ok: false, message: 'role must be admin, manager or staff' };
  return db.transaction((): OperatorResult => {
    if (!userById(userId)) return { ok: false, message: `no user ${userId}` };
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
    audit('workeasy360.role_set', { userId, role, actor });
    return { ok: true, message: `${userId} is now ${role}` };
  }).immediate();
}

/**
 * The identity move of an issuer change (WorkEasy360's move to accounts.workeasy360.com): every (from, sub) becomes
 * (to, sub), with its open sessions. Without `apply` it only reports. Refuses when a subject already has an identity
 * under the new issuer: two accounts are never merged.
 */
export function moveIssuer(from: string, to: string, options: { apply: boolean; actor: string }): OperatorResult {
  if (!from || !to || from === to) return { ok: false, message: '--from and --to must be two different issuers' };
  return db.transaction((): OperatorResult => {
    const moving = (db.prepare('SELECT COUNT(*) AS c FROM workeasy360_identities WHERE issuer = ?').get(from) as { c: number }).c;
    const clashes = db.prepare(
      `SELECT a.subject, a.user_id AS from_user, b.user_id AS to_user FROM workeasy360_identities a
       JOIN workeasy360_identities b ON b.subject = a.subject AND b.issuer = ? WHERE a.issuer = ?`
    ).all(to, from) as Array<{ subject: string; from_user: string; to_user: string }>;
    if (clashes.length) {
      return { ok: false, message: `refused: ${clashes.length} subject(s) already have a user under ${to}: ${clashes.map(c => `${c.subject} (${c.from_user} / ${c.to_user})`).join(', ')}` };
    }
    const sessions = (db.prepare('SELECT COUNT(*) AS c FROM user_sessions WHERE w360_issuer = ? AND revoked_at IS NULL').get(from) as { c: number }).c;
    if (!options.apply) return { ok: true, message: `would move ${moving} identity(ies) and ${sessions} open session(s) from ${from} to ${to} (dry run: add --apply)` };
    db.prepare('UPDATE workeasy360_identities SET issuer = ? WHERE issuer = ?').run(to, from);
    db.prepare('UPDATE user_sessions SET w360_issuer = ? WHERE w360_issuer = ?').run(to, from);
    audit('workeasy360.issuer_moved', { from, to, identities: moving, sessions, actor: options.actor });
    return { ok: true, message: `moved ${moving} identity(ies) and ${sessions} open session(s) from ${from} to ${to}` };
  }).immediate();
}

/** Users and open sessions per issuer, and linked businesses. */
export function identityReport(): { issuers: Array<{ issuer: string; users: number; openSessions: number }>; linkedBusinesses: number } {
  const issuers = db.prepare(
    `SELECT i.issuer, COUNT(DISTINCT i.user_id) AS users,
            (SELECT COUNT(*) FROM user_sessions s WHERE s.w360_issuer = i.issuer AND s.revoked_at IS NULL AND s.expires_at > ?) AS openSessions
     FROM workeasy360_identities i GROUP BY i.issuer ORDER BY i.issuer`
  ).all(now()) as Array<{ issuer: string; users: number; openSessions: number }>;
  const linkedBusinesses = (db.prepare('SELECT COUNT(*) AS c FROM workeasy360_organizations').get() as { c: number }).c;
  return { issuers, linkedBusinesses };
}
