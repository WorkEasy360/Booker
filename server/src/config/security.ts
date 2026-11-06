// Security-relevant settings, validated once at startup.
// Production refuses to start with unsafe values; development only warns.
// Messages name the variable and the problem, never its value.

export interface SecurityConfig {
  production: boolean;
  jwtSecret: string;
  sessionTtlMs: number;
  /** Exact origins (scheme://host[:port]) allowed to call the API from a browser. */
  allowedOrigins: string[];
  /** Passed to Express `trust proxy`; false means the socket address is the client address. */
  trustProxy: boolean | number | string;
  cookieName: string;
  cookieSecure: boolean;
  /** Key for authenticator secrets (TWO_FACTOR_ENCRYPTION_KEY), or null to derive one from JWT_SECRET. */
  twoFactorKey: Buffer | null;
  /** SIGNUP_MODE: open (anyone may create a business) or closed (accounts are created by the operator, npm run org:create). */
  signupOpen: boolean;
  warnings: string[];
}

const PLACEHOLDER = /replace[_-]?with|change[_-]?me|your[_-]?secret|placeholder|example|test[_-]?secret|^secret$|^password$/i;
const MIN_SECRET_LENGTH = 32;

function parseDuration(raw: string | undefined, fallbackMs: number): number | null {
  if (!raw) return fallbackMs;
  const m = /^(\d+)\s*([smhd])$/.exec(raw.trim());
  if (!m) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

function parseOrigin(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // An origin has no path, query or fragment.
    if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = raw?.trim();
  if (!v || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // e.g. "loopback" or a comma-separated list of addresses/subnets
}

/** 32 bytes written as 64 hex characters or as base64; anything else is null. */
function parseKey(raw: string): Buffer | null {
  const v = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  return null;
}

function isLocalOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function readSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env.NODE_ENV === 'production';
  const test = env.NODE_ENV === 'test';
  const errors: string[] = [];
  const warnings: string[] = [];
  // Problems that block production and are reported as warnings elsewhere.
  const unsafe = (msg: string) => (production ? errors : warnings).push(msg);

  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret) {
    if (!test) errors.push('JWT_SECRET is required (generate one with: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))")');
  } else {
    if (jwtSecret.length < MIN_SECRET_LENGTH) unsafe(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    if (!test && PLACEHOLDER.test(jwtSecret)) unsafe('JWT_SECRET still contains a placeholder value; generate a random secret');
    if (new Set(jwtSecret).size < 10) unsafe('JWT_SECRET has too little variety to be a random secret');
  }

  const sessionTtlMs = parseDuration(env.JWT_EXPIRES_IN, 7 * 86_400_000);
  if (sessionTtlMs === null) errors.push('JWT_EXPIRES_IN must look like 30m, 12h or 7d');
  else if (sessionTtlMs < 5 * 60_000 || sessionTtlMs > 30 * 86_400_000) errors.push('JWT_EXPIRES_IN must be between 5 minutes and 30 days');

  const originList = (env.CORS_ORIGIN ?? (production ? '' : 'http://localhost:5173'))
    .split(',').map(s => s.trim()).filter(Boolean);
  const allowedOrigins: string[] = [];
  if (!originList.length) errors.push('CORS_ORIGIN is required in production (the https origin of the WorkEasy360 web app)');
  for (const o of originList) {
    if (o === '*') { errors.push('CORS_ORIGIN cannot be "*" because the API uses cookies'); continue; }
    const origin = parseOrigin(o);
    if (!origin) { errors.push('CORS_ORIGIN entries must be origins such as https://app.example.com (no path)'); continue; }
    if (production && origin.startsWith('http:') && !isLocalOrigin(origin)) errors.push('CORS_ORIGIN must use https in production');
    allowedOrigins.push(origin);
  }

  if (env.PUBLIC_APP_URL) {
    let appOrigin: string | null = null;
    try { appOrigin = parseOrigin(new URL(env.PUBLIC_APP_URL).origin); } catch { /* reported below */ }
    if (!appOrigin) errors.push('PUBLIC_APP_URL must be an absolute URL such as https://book.example.com');
    else {
      if (production && appOrigin.startsWith('http:')) errors.push('PUBLIC_APP_URL must use https in production (it is used in customer email links)');
      if (!allowedOrigins.includes(appOrigin)) allowedOrigins.push(appOrigin);
    }
  } else if (production) {
    errors.push('PUBLIC_APP_URL is required in production (it is used in customer email links)');
  }

  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  if (production && trustProxy === false) {
    warnings.push('TRUST_PROXY is not set: if the API runs behind a reverse proxy or load balancer, set it (for example TRUST_PROXY=1) or rate limits will treat every visitor as the proxy');
  }
  if (trustProxy === true) {
    warnings.push('TRUST_PROXY=true trusts any X-Forwarded-For header; prefer the number of proxy hops (for example 1) unless the API is reachable only through the proxy');
  }

  if (production && (env.EMAIL_TRANSPORT ?? 'disabled') === 'disabled') {
    warnings.push('EMAIL_TRANSPORT is disabled: customers will not receive booking emails, and new sign-ups and password reset are unavailable');
  }

  let twoFactorKey: Buffer | null = null;
  if (env.TWO_FACTOR_ENCRYPTION_KEY) {
    twoFactorKey = parseKey(env.TWO_FACTOR_ENCRYPTION_KEY);
    if (!twoFactorKey) errors.push('TWO_FACTOR_ENCRYPTION_KEY must be 32 random bytes written as 64 hex characters or base64 (generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
    else if (new Set(twoFactorKey).size < 8) unsafe('TWO_FACTOR_ENCRYPTION_KEY has too little variety to be a random key');
  } else if (production) {
    warnings.push('TWO_FACTOR_ENCRYPTION_KEY is not set: authenticator secrets are encrypted with a key derived from JWT_SECRET, so changing JWT_SECRET would stop existing authenticator apps from working (recovery codes would still work)');
  }

  const signupMode = (env.SIGNUP_MODE ?? 'open').trim().toLowerCase();
  if (signupMode !== 'open' && signupMode !== 'closed') errors.push('SIGNUP_MODE must be open or closed');

  // Data that must survive restarts and redeploys: a relative or missing DB_PATH depends on the start directory.
  if (production && (!env.DB_PATH || !/^([a-zA-Z]:[\\/]|\/)/.test(env.DB_PATH))) {
    warnings.push('DB_PATH is not an absolute path: set it to the database file on the persistent disk (for example /var/lib/workeasy360/workeasy360.db), or data can be lost on redeploy');
  }
  if (production && env.NOTIFICATIONS_PROVIDER_MODE?.trim() === 'mock') {
    warnings.push('NOTIFICATIONS_PROVIDER_MODE=mock: text messages, WhatsApp messages and calendar updates go to the development stand-in and reach nobody');
  }

  if (errors.length) {
    throw new Error(`Invalid security configuration:\n - ${errors.join('\n - ')}`);
  }

  return {
    production,
    jwtSecret,
    sessionTtlMs: sessionTtlMs ?? 7 * 86_400_000,
    allowedOrigins,
    trustProxy,
    // __Host- cookies must be Secure, host-only and path=/; this blocks subdomains from planting a session cookie.
    cookieName: production ? '__Host-we360_session' : 'we360_session',
    cookieSecure: production,
    twoFactorKey,
    signupOpen: signupMode !== 'closed',
    warnings,
  };
}

let current: SecurityConfig | null = null;

export function initSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  current = readSecurityConfig(env);
  return current;
}

export function securityConfig(): SecurityConfig {
  return current ?? initSecurityConfig();
}
