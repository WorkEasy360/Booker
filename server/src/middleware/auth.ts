import { Request, Response, NextFunction } from 'express';
import type { AuthPayload } from '../types';
import { resolveSession, csrfTokenValid } from '../auth/session';
import { can, type Permission } from '../auth/permissions';
import { securityConfig } from '../config/security';

export type { AuthPayload };

export interface AuthRequest extends Request {
  user?: AuthPayload;
  authVia?: 'cookie' | 'bearer';
  cookies: Record<string, string>;
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The session token and how it was presented. An explicit Authorization header wins over the cookie. */
export function readSessionToken(req: AuthRequest): { token: string; via: 'cookie' | 'bearer' } | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return { token: auth.slice(7).trim(), via: 'bearer' };
  const cookie = req.cookies?.[securityConfig().cookieName];
  return cookie ? { token: cookie, via: 'cookie' } : null;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const presented = readSessionToken(req);
  if (!presented) {
    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
    return;
  }

  const user = resolveSession(presented.token);
  if (!user) {
    res.status(401).json({ error: 'Your session has ended. Please sign in again.', code: 'SESSION_INVALID' });
    return;
  }

  // Browsers attach cookies automatically, so a cookie-authenticated change must also prove it came from our app.
  // Bearer tokens are never attached automatically and need no CSRF token.
  if (presented.via === 'cookie' && UNSAFE_METHODS.has(req.method) && !csrfTokenValid(user.sid!, req.get('x-csrf-token'))) {
    res.status(403).json({ error: 'Security check failed. Refresh the page and try again.', code: 'CSRF_FAILED' });
    return;
  }

  req.user = user;
  req.authVia = presented.via;
  next();
}

/** Requires at least one of the permissions. Use after requireAuth. */
export function requirePermission(...permissions: Permission[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (permissions.some(p => can(req.user?.role, p))) { next(); return; }
    res.status(403).json({ error: 'You do not have permission to do this', code: 'FORBIDDEN' });
  };
}

/** Organization administrators only. Use after requireAuth. */
export const requireAdmin = requirePermission('staff:manage');
