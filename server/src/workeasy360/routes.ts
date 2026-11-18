import { randomBytes } from 'crypto';
import express, { Router, type Request, type Response } from 'express';
import { securityConfig } from '../config/security';
import { createSession, resolveSession, revokeSession } from '../auth/session';
import { Workeasy360Error } from './client';
import { workeasy360 } from './runtime';
import { endSessionsForLogoutToken, providerSessionEnded, provisionSignIn, saveLoginFlow, takeLoginFlow } from './store';
import { log } from './log';
import { START_PATH } from './config';

/** How long a sign-in may take between the redirect to WorkEasy360 and the callback. */
export const FLOW_TTL_SECONDS = 600;
/** A logout token is a compact JWS of well under 2 KB; anything much larger is not one. */
const MAX_LOGOUT_TOKEN_LENGTH = 16 * 1024;
const MAX_CODE_LENGTH = 2048;
/** Sign-ins this process starts per minute, at most (bounds the stored flows). */
const MAX_STARTS_PER_MINUTE = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pages of the web app someone may be sent back to after signing in. */
const RETURN_TO = /^\/(?!\/)(?!api(\/|$))[A-Za-z0-9/_.-]{0,300}$/;

/**
 * Why a WorkEasy360 sign-in did not complete, as the sign-in page shows it (`/login?sso_error=<code>`).
 * A fixed vocabulary: never a token, a code, a state or a provider's description.
 */
export type SsoErrorCode =
  | 'expired' | 'unavailable' | 'rate_limited' | 'cancelled' | 'refused' | 'invalid_token' | 'wrong_product'
  | 'no_organization' | 'email_unverified' | 'wrong_organization' | 'not_entitled' | 'membership_inactive'
  | 'organization_inactive' | 'integration_suspended' | 'access_policy_denied' | 'access_unverified'
  | 'account_conflict' | 'other_organization' | 'identity_conflict' | 'account_disabled' | 'no_business'
  | 'business_unavailable' | 'session_ended';

/** The provider's OAuth error codes (OIDC contract section 7) shown with a specific message. */
const PROVIDER_ERRORS: Record<string, SsoErrorCode> = {
  access_denied: 'cancelled',
  invalid_grant: 'expired',
  product_not_entitled: 'not_entitled',
  membership_inactive: 'membership_inactive',
  organization_inactive: 'organization_inactive',
  integration_suspended: 'integration_suspended',
  access_policy_denied: 'access_policy_denied',
  temporarily_unavailable: 'unavailable',
  server_error: 'unavailable',
};

/** Entitlement reasons (entitlement API section 4) the sign-in page explains. */
const DENIAL_REASONS = new Set(['not_entitled', 'expired', 'suspended', 'read_only', 'membership_inactive', 'no_seat']);

class SignInRefused extends Error {
  constructor(readonly code: SsoErrorCode, readonly detail: string, readonly reason?: string) {
    super(detail);
  }
}

function codeForError(err: unknown): SsoErrorCode {
  if (err instanceof SignInRefused) return err.code;
  if (err instanceof Workeasy360Error) {
    switch (err.code) {
      case 'state_mismatch': return 'expired';
      case 'sign_in_refused': return PROVIDER_ERRORS[err.detail] ?? 'refused';
      case 'wrong_product':
      case 'no_organization':
      case 'email_unverified':
      case 'invalid_token':
      case 'rate_limited':
        return err.code;
      case 'provider_refused': return 'access_unverified';
      default: return 'unavailable';
    }
  }
  return 'unavailable';
}

function describe(err: unknown): string {
  if (err instanceof SignInRefused || err instanceof Workeasy360Error) return err.detail || (err instanceof Workeasy360Error ? err.code : '');
  return err instanceof Error ? err.name : 'unknown';
}

function flowCookieName(): string {
  // __Host-: only this exact host can set it, so a sibling domain cannot plant a flow (login CSRF).
  return securityConfig().production ? '__Host-we360_w360_flow' : 'we360_w360_flow';
}

function flowCookieOptions() {
  const cfg = securityConfig();
  return { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' as const, path: cfg.production ? '/' : '/api/auth/workeasy360' };
}

/**
 * "Continue with WorkEasy360", mounted at /api/auth/workeasy360 (docs/workeasy360-sso.md):
 *
 * - `GET /config` tells the sign-in page whether WorkEasy360 sign-in is on and whether it is the only way in;
 * - `GET /start[?organization=<uuid>][&returnTo=/path]` keeps state, nonce and the PKCE verifier server-side (single
 *   use, 10 minutes), gives the browser only a random flow id in an httpOnly cookie, and redirects to WorkEasy360;
 * - `GET /callback` takes the flow first whatever happens next, compares the state, exchanges the code
 *   (private_key_jwt + PKCE), verifies the ID token, asks the entitlement endpoint, maps the organization to its
 *   business, ends any session this browser already holds and opens one bound to that business;
 * - `POST /backchannel-logout` is the OpenID Connect Back-Channel Logout receiver (server to server; the provider's
 *   signature is the authentication, so no cookie or CSRF token is involved).
 *
 * Failures land on /login?sso_error=<code>; details go to the log only.
 */
export function workeasy360Router(): Router {
  const router = Router();
  let windowStart = 0;
  let startsInWindow = 0;

  router.get('/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    const runtime = workeasy360();
    res.json({ data: { enabled: !!runtime, ssoOnly: !!runtime?.settings.ssoOnly, startUrl: runtime ? START_PATH : null } });
  });

  function loginPage(code: SsoErrorCode, reason?: string): string {
    const runtime = workeasy360();
    const target = new URL('/login', runtime ? runtime.settings.redirectUri : 'http://localhost/');
    target.searchParams.set('sso_error', code);
    if (reason && DENIAL_REASONS.has(reason)) target.searchParams.set('reason', reason);
    return runtime ? target.toString() : `${target.pathname}${target.search}`;
  }

  function fail(res: Response, code: SsoErrorCode, detail: string, reason?: string): void {
    log.warn({ code, detail }, 'sign-in failed');
    res.redirect(303, loginPage(code, reason));
  }

  router.get('/start', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const runtime = workeasy360();
    if (!runtime) { res.status(404).json({ error: 'Not found' }); return; }
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== windowStart) { windowStart = minute; startsInWindow = 0; }
    if (++startsInWindow > MAX_STARTS_PER_MINUTE) { fail(res, 'rate_limited', 'too many sign-ins started this minute'); return; }
    const raw = typeof req.query.organization === 'string' ? req.query.organization : '';
    // Only a UUID is forwarded; anything else is dropped and WorkEasy360 shows its own chooser.
    const organizationId = UUID.test(raw) ? raw.toLowerCase() : undefined;
    const returnTo = typeof req.query.returnTo === 'string' && RETURN_TO.test(req.query.returnTo) ? req.query.returnTo : null;
    try {
      const request = await runtime.client.beginLogin({ organizationId });
      const flowId = randomBytes(32).toString('base64url');
      saveLoginFlow(flowId, { state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier, organizationId: organizationId ?? null, returnTo }, FLOW_TTL_SECONDS);
      res.cookie(flowCookieName(), flowId, { ...flowCookieOptions(), maxAge: FLOW_TTL_SECONDS * 1000 });
      res.redirect(302, request.url.toString());
    } catch (err) {
      fail(res, codeForError(err), describe(err));
    }
  });

  router.get('/callback', async (req: Request, res) => {
    res.set('Cache-Control', 'no-store');
    const runtime = workeasy360();
    if (!runtime) { res.status(404).json({ error: 'Not found' }); return; }
    const { client, entitlements, settings } = runtime;
    // The flow is single use: taken (and its cookie dropped) before anything is checked.
    res.clearCookie(flowCookieName(), flowCookieOptions());
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const flowId = cookies[flowCookieName()];
    let flow;
    try {
      flow = typeof flowId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(flowId) ? takeLoginFlow(flowId) : undefined;
    } catch (err) {
      fail(res, 'unavailable', describe(err));
      return;
    }
    const query = new URLSearchParams();
    for (const name of ['code', 'state', 'error', 'iss']) {
      const value = req.query[name];
      if (typeof value === 'string') query.set(name, value.slice(0, MAX_CODE_LENGTH + 1));
    }
    if (!flow) {
      const providerError = query.get('error');
      if (providerError) { fail(res, PROVIDER_ERRORS[providerError] ?? 'refused', `provider returned ${providerError.slice(0, 64)} without a pending flow`); return; }
      fail(res, 'expired', 'no pending sign-in for this browser');
      return;
    }
    if (!query.get('error') && (query.get('code') ?? '').length > MAX_CODE_LENGTH) { fail(res, 'refused', 'no usable code'); return; }

    try {
      const identity = await client.completeLogin(query, flow);
      if (flow.organizationId && identity.organizationId !== flow.organizationId) {
        // The launcher asked for one organization and the token is for another: land nowhere.
        throw new SignInRefused('wrong_organization', 'organization_id differs from the launcher\'s');
      }
      // A sign-in still in flight when WorkEasy360 ended it (a logout token already named its sid) opens nothing.
      if (identity.sid && providerSessionEnded(identity.issuer, identity.sid)) throw new SignInRefused('session_ended', 'the provider sign-in was already ended');

      // Entitlement when the person arrives (integration guide section 7): a denial has a page of its own.
      const access = await entitlements.check(identity.organizationId, { subject: identity.subject, fresh: true });
      if (access.status === 'refused') throw new SignInRefused('access_unverified', 'the provider refused this product\'s client');
      if (!access.allowed) throw new SignInRefused('not_entitled', `entitlement denied (${access.reason})`, access.reason);

      const outcome = provisionSignIn(
        { issuer: identity.issuer, subject: identity.subject, organizationId: identity.organizationId, organizationName: identity.organizationName, email: identity.email, name: identity.name },
        { defaultRole: settings.defaultRole, provision: settings.provisionOrganizations },
      );
      if (outcome.kind === 'refused') throw new SignInRefused(outcome.code, outcome.detail);

      // Account switching and fixation: whatever session this browser holds ends here.
      const presented = cookies[securityConfig().cookieName];
      const previous = presented ? resolveSession(presented) : null;
      if (previous?.sid) revokeSession(previous.sid);

      const session = createSession(outcome.userId, outcome.organizationId, {
        issuer: identity.issuer,
        subject: identity.subject,
        sid: identity.sid,
        organizationId: identity.organizationId,
        idToken: identity.idToken,
      });
      const cfg = securityConfig();
      res.cookie(cfg.cookieName, session.token, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/', maxAge: cfg.sessionTtlMs });
      log.info(
        { userId: outcome.userId, organizationId: outcome.organizationId, organizationCreated: outcome.organizationCreated, userCreated: outcome.userCreated, entitlement: access.status, sid: Boolean(identity.sid) },
        'signed in with WorkEasy360',
      );
      res.redirect(303, new URL(flow.returnTo ?? '/', settings.redirectUri).toString());
    } catch (err) {
      fail(res, codeForError(err), describe(err), err instanceof SignInRefused ? err.reason : undefined);
    }
  });

  router.post('/backchannel-logout', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const runtime = workeasy360();
    if (!runtime) { res.status(404).json({ error: 'Not found' }); return; }
    const body = req.body as Record<string, unknown> | undefined;
    const raw = req.is('application/x-www-form-urlencoded') ? body?.logout_token : undefined;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LOGOUT_TOKEN_LENGTH) {
      log.warn({ detail: 'no logout_token form field' }, 'logout token rejected');
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    let token;
    try {
      token = await runtime.client.verifyLogoutToken(raw);
    } catch (err) {
      if (err instanceof Workeasy360Error && err.code === 'invalid_token') {
        log.warn({ detail: err.detail }, 'logout token rejected');
        res.status(400).json({ error: 'invalid_request' });
        return;
      }
      // The key set could not be read: not the token's fault, so WorkEasy360 delivers it again.
      log.error({ detail: describe(err) }, 'logout token could not be verified');
      res.status(503).json({ error: 'temporarily_unavailable' });
      return;
    }
    try {
      const outcome = endSessionsForLogoutToken({ issuer: runtime.client.issuer, jti: token.jti, subject: token.sub, sid: token.sid, acceptableUntil: token.acceptableUntil });
      log.info({ by: token.sid ? 'sid' : 'sub', replayed: outcome.replayed, sessionsEnded: outcome.sessionsEnded }, 'back-channel logout');
      // A duplicate is answered 200 too and ends nothing: delivery is at least once.
      res.status(200).end();
    } catch (err) {
      log.error({ detail: describe(err) }, 'back-channel logout failed');
      res.status(503).json({ error: 'temporarily_unavailable' });
    }
  });

  return router;
}
