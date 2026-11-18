import type { Response } from 'express';
import type { AuthPayload } from '../types';
import { linkedW360Organization } from './store';
import { workeasy360 } from './runtime';
import type { EntitlementAccess } from './entitlements';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Paths a signed-in person reaches whatever the entitlement says, so the app can explain it and offer sign-out. */
const ALWAYS_REACHABLE = new Set(['/api/auth/me']);

function pathOf(originalUrl: string): string {
  const q = originalUrl.indexOf('?');
  return q === -1 ? originalUrl : originalUrl.slice(0, q);
}

/** The WorkEasy360 organization (and person) whose entitlement governs this session, if any. */
export function governingOrganization(user: AuthPayload): { organizationId: string; subject?: string } | null {
  if (user.w360) return { organizationId: user.w360.organizationId, subject: user.w360.subject };
  const linked = linkedW360Organization(user.orgId);
  return linked ? { organizationId: linked } : null;
}

/** The entitlement answer for this session, or null when no WorkEasy360 organization governs it (or sign-in is off). */
export async function accessFor(user: AuthPayload): Promise<EntitlementAccess | null> {
  const runtime = workeasy360();
  const governing = runtime ? governingOrganization(user) : null;
  if (!runtime || !governing) return null;
  return runtime.entitlements.check(governing.organizationId, { subject: governing.subject });
}

/**
 * The WorkEasy360 rules for an authenticated request, after its session resolved (middleware/auth.ts requireAuth).
 * Answers the request and returns true when it is refused:
 *
 * 1. SSO-only: a session not opened by WorkEasy360 is refused at once (401 WORKEASY360_SIGN_IN_REQUIRED).
 * 2. A WorkEasy360 session is only good for the issuer this server trusts and for the business its organization is
 *    linked to; anything else is refused (401), so a session never reaches another organization's business.
 * 3. A business linked to a WorkEasy360 organization is used only while WorkEasy360 says the organization (and, for a
 *    WorkEasy360 session, the person) is entitled, asked on WorkEasy360's schedule, never per request:
 *    403 WORKEASY360_ACCESS_ENDED (with the reason), 403 WORKEASY360_ACCESS_UNVERIFIED when WorkEasy360 refused this
 *    product's own client, 403 WORKEASY360_READ_ONLY for a change while the organization is read-only. The session
 *    stays valid, and GET /api/auth/me stays reachable, so the app can say why and offer sign-out.
 */
export async function workeasy360Gate(req: { method: string; originalUrl: string }, res: Response, user: AuthPayload): Promise<boolean> {
  const runtime = workeasy360();
  if (!runtime) return false;
  const { settings } = runtime;
  if (settings.ssoOnly && !user.w360) {
    res.status(401).json({ error: 'Sign in with WorkEasy360 to continue.', code: 'WORKEASY360_SIGN_IN_REQUIRED' });
    return true;
  }
  if (user.w360) {
    if (user.w360.issuer !== settings.issuer || linkedW360Organization(user.orgId) !== user.w360.organizationId) {
      res.status(401).json({ error: 'Your session has ended. Please sign in again.', code: 'SESSION_INVALID' });
      return true;
    }
  }
  const path = pathOf(req.originalUrl);
  if (ALWAYS_REACHABLE.has(path)) return false;
  const access = await accessFor(user);
  if (!access) return false;
  if (access.status === 'refused') {
    res.status(403).json({ error: 'WorkeasyBooking cannot confirm your access with WorkEasy360 right now. Try again in a few minutes.', code: 'WORKEASY360_ACCESS_UNVERIFIED' });
    return true;
  }
  if (!access.allowed) {
    res.status(403).json({ error: 'Your organization’s access to WorkeasyBooking has ended.', code: 'WORKEASY360_ACCESS_ENDED', reason: access.reason });
    return true;
  }
  // Changes to the person's own sign-in (sign out other sessions, two-factor) are not changes to the business.
  const write = !SAFE_METHODS.has(req.method) && !path.startsWith('/api/auth/');
  if (write && !access.writeAllowed) {
    res.status(403).json({ error: 'Your organization can view its data but not make changes until its subscription is renewed.', code: 'WORKEASY360_READ_ONLY' });
    return true;
  }
  return false;
}
