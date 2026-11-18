import fs from 'fs';
import { createPrivateKey } from 'crypto';

// Sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md). Off until WORKEASY360_ISSUER is set.
// The names are those of the WorkEasy360 integration kit's .env.example. Validated once at startup: a bad value stops
// the server with a message that names the variable and the problem, never its value.

export const CALLBACK_PATH = '/api/auth/workeasy360/callback';
export const BACKCHANNEL_PATH = '/api/auth/workeasy360/backchannel-logout';
export const START_PATH = '/api/auth/workeasy360/start';

export type JoinRole = 'staff' | 'manager';

export interface Workeasy360Settings {
  /** Exactly the issuer WorkEasy360's discovery document names (no trailing slash). */
  issuer: string;
  clientId: string;
  /** Must equal the ID token's product_code. */
  productCode: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  keyId: string;
  /** PEM, RSA or EC P-256. Never logged. */
  privateKeyPem: string;
  scopes: string[];
  /** WorkEasy360 is the only way in: password sign-in and its sessions are refused. */
  ssoOnly: boolean;
  /** Role of someone joining an organization that already exists here (the first person of a new one is admin). */
  defaultRole: JoinRole;
  /** Whether a WorkEasy360 organization's first sign-in creates its business here. */
  provisionOrganizations: boolean;
  /** "Get WorkeasyBooking" link on the no-access message. */
  purchaseUrl: string;
  /** Plain-http provider endpoints, for a loopback provider outside production only. */
  allowInsecureRequests: boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopback(url: URL): boolean {
  return LOOPBACK.has(url.hostname);
}

function bool(raw: string | undefined, fallback: boolean, name: string, errors: string[]): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  errors.push(`${name} must be true or false`);
  return fallback;
}

function readPrivateKey(env: NodeJS.ProcessEnv, errors: string[]): string {
  const literal = env.WORKEASY360_PRIVATE_KEY?.trim();
  if (literal) return literal.replace(/\\n/g, '\n');
  const file = env.WORKEASY360_PRIVATE_KEY_FILE?.trim();
  if (!file) return '';
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    errors.push('WORKEASY360_PRIVATE_KEY_FILE could not be read');
    return '';
  }
}

/**
 * The WorkEasy360 settings, or null when the integration is off (WORKEASY360_ISSUER unset).
 * Throws with every problem found when the configuration is unusable.
 */
export function readWorkeasy360Config(env: NodeJS.ProcessEnv = process.env): Workeasy360Settings | null {
  const production = env.NODE_ENV === 'production';
  const errors: string[] = [];
  const issuer = env.WORKEASY360_ISSUER?.trim() ?? '';
  const clientId = env.WORKEASY360_CLIENT_ID?.trim() ?? '';
  const keyId = env.WORKEASY360_KEY_ID?.trim() ?? '';
  const privateKeyPem = readPrivateKey(env, errors);
  const ssoOnly = bool(env.WORKEASY360_SSO_ONLY, false, 'WORKEASY360_SSO_ONLY', errors);

  const required = { WORKEASY360_ISSUER: issuer, WORKEASY360_CLIENT_ID: clientId, WORKEASY360_KEY_ID: keyId, 'WORKEASY360_PRIVATE_KEY_FILE (or WORKEASY360_PRIVATE_KEY)': privateKeyPem };
  const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length === Object.keys(required).length) {
    if (ssoOnly) errors.push('WORKEASY360_SSO_ONLY=true needs WorkEasy360 sign-in to be configured (WORKEASY360_ISSUER and the rest)');
    if (errors.length) throw new Error(`Invalid WorkEasy360 configuration:\n - ${errors.join('\n - ')}`);
    return null;
  }
  if (missing.length) errors.push(`set all of the WorkEasy360 sign-in settings or none; missing: ${missing.join(', ')}`);

  let issuerUrl: URL | null = null;
  try { issuerUrl = new URL(issuer); } catch { errors.push('WORKEASY360_ISSUER must be an absolute URL such as https://accounts.workeasy360.com'); }
  if (issuerUrl) {
    if (issuer.endsWith('/')) errors.push('WORKEASY360_ISSUER must not end with a slash (it is compared exactly)');
    if (issuerUrl.search || issuerUrl.hash) errors.push('WORKEASY360_ISSUER must not have a query or fragment');
    if (issuerUrl.protocol !== 'https:') {
      if (issuerUrl.protocol !== 'http:' || production || !isLoopback(issuerUrl)) {
        errors.push('WORKEASY360_ISSUER must use https (plain http only for a loopback issuer outside production)');
      }
    }
  }

  const appUrl = env.PUBLIC_APP_URL?.trim().replace(/\/+$/, '') ?? '';
  const redirectUri = env.WORKEASY360_REDIRECT_URI?.trim() || (appUrl ? `${appUrl}${CALLBACK_PATH}` : '');
  const postLogoutRedirectUri = env.WORKEASY360_POST_LOGOUT_REDIRECT_URI?.trim() || (appUrl ? `${appUrl}/login` : '');
  for (const [name, value, path] of [
    ['WORKEASY360_REDIRECT_URI', redirectUri, CALLBACK_PATH],
    ['WORKEASY360_POST_LOGOUT_REDIRECT_URI', postLogoutRedirectUri, null],
  ] as const) {
    if (!value) { errors.push(`${name} is required (or set PUBLIC_APP_URL)`); continue; }
    let u: URL;
    try { u = new URL(value); } catch { errors.push(`${name} must be an absolute URL`); continue; }
    if (u.protocol !== 'https:' && (production || u.protocol !== 'http:' || !isLoopback(u))) errors.push(`${name} must use https (http only on a loopback host outside production)`);
    if (u.hash) errors.push(`${name} must not have a fragment`);
    if (path && u.pathname !== path) errors.push(`${name} must point at ${path} on this app's origin`);
  }

  if (privateKeyPem) {
    try {
      const key = createPrivateKey(privateKeyPem);
      const ok = key.asymmetricKeyType === 'rsa' || (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1');
      if (!ok) errors.push('the WorkEasy360 private key must be RSA or EC P-256');
    } catch {
      errors.push('the WorkEasy360 private key is not a readable PEM private key');
    }
  }

  const scopes = (env.WORKEASY360_SCOPES?.trim() || 'openid email profile organization').split(/[\s,]+/).filter(Boolean);
  if (!scopes.includes('openid') || !scopes.includes('email')) errors.push('WORKEASY360_SCOPES must include openid and email (email_verified comes with email)');

  const defaultRole = (env.WORKEASY360_DEFAULT_ROLE?.trim().toLowerCase() || 'staff') as JoinRole;
  if (defaultRole !== 'staff' && defaultRole !== 'manager') errors.push('WORKEASY360_DEFAULT_ROLE must be staff or manager');

  const productCode = env.WORKEASY360_PRODUCT_CODE?.trim() || 'workeasy_booking';
  if (!/^[a-z0-9_]{2,64}$/.test(productCode)) errors.push('WORKEASY360_PRODUCT_CODE must be 2-64 of a-z, 0-9 and _');

  const purchaseUrl = env.WORKEASY360_PURCHASE_URL?.trim() || issuer;
  const provisionOrganizations = bool(env.WORKEASY360_PROVISION_ORGANIZATIONS, true, 'WORKEASY360_PROVISION_ORGANIZATIONS', errors);

  if (errors.length) throw new Error(`Invalid WorkEasy360 configuration:\n - ${errors.join('\n - ')}`);
  return {
    issuer,
    clientId,
    productCode,
    redirectUri,
    postLogoutRedirectUri,
    keyId,
    privateKeyPem,
    scopes,
    ssoOnly,
    defaultRole,
    provisionOrganizations,
    purchaseUrl,
    allowInsecureRequests: !production && issuerUrl !== null && issuerUrl.protocol === 'http:' && isLoopback(issuerUrl),
  };
}

let current: Workeasy360Settings | null | undefined;

export function initWorkeasy360Config(env: NodeJS.ProcessEnv = process.env): Workeasy360Settings | null {
  current = readWorkeasy360Config(env);
  return current;
}

/** The settings read at startup (null: WorkEasy360 sign-in is off). */
export function workeasy360Config(): Workeasy360Settings | null {
  if (current === undefined) current = readWorkeasy360Config();
  return current;
}
