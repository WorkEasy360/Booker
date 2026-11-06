import { Request, Response, NextFunction } from 'express';
import { securityConfig } from '../config/security';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function loopbackVariants(origin: string): string[] {
  const u = new URL(origin);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return [origin];
  const port = u.port ? `:${u.port}` : '';
  return ['localhost', '127.0.0.1', '[::1]'].map(h => `${u.protocol}//${h}${port}`);
}

/** Origins accepted for state-changing requests: the configured app origins (plus loopback aliases outside production). */
export function trustedOrigins(): Set<string> {
  const cfg = securityConfig();
  return new Set(cfg.production ? cfg.allowedOrigins : cfg.allowedOrigins.flatMap(loopbackVariants));
}

/**
 * Rejects state-changing requests that a browser sent from another site.
 * Browsers always send Origin on cross-site POST/PUT/DELETE; requests without Origin or Referer
 * come from non-browser clients, which cannot ride on a visitor's cookies.
 */
export function originGuard(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) { next(); return; }
  const allowed = trustedOrigins();
  const origin = req.get('origin');
  let source: string | null = null;
  if (origin !== undefined) source = origin;
  else {
    const referer = req.get('referer');
    if (referer) {
      try { source = new URL(referer).origin; } catch { source = 'invalid'; }
    }
  }
  if (source !== null && !allowed.has(source)) {
    res.status(403).json({ error: 'Requests from this website are not allowed', code: 'ORIGIN_NOT_ALLOWED' });
    return;
  }
  next();
}
