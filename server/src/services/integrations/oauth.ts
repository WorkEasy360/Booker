import { createHash, randomBytes } from 'crypto';
import db from '../../db/init';
import { seal, open } from './seal';

// Connecting a business's own account at Google (Calendar and Meet), Microsoft (Outlook calendar), Zoom or Mailchimp
// with OAuth 2.0 (authorization code + PKCE). Each needs the app's client id and secret in the environment; none is
// configured in this project, so connecting answers "not configured" and nothing here has run against a real provider.
//  - Scopes are the least each feature needs (listed below); nothing else is requested.
//  - The state sent to the provider is encrypted and authenticated, names the business, the signed-in user and the
//    provider, carries the PKCE verifier, and expires after 10 minutes; the callback must come back to the same user.
//  - Tokens are stored encrypted (bound to business + provider); disconnecting revokes them at the provider when it
//    offers that, and deletes them here in any case.

export type OAuthProvider = 'google' | 'microsoft' | 'zoom' | 'mailchimp';

interface ProviderSpec {
  name: string; authorizeUrl: string; tokenUrl: string; revokeUrl?: string; scopes: string[];
  clientIdEnv: string; clientSecretEnv: string; extra?: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<OAuthProvider, ProviderSpec> = {
  google: {
    name: 'Google Calendar and Meet', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke', scopes: ['https://www.googleapis.com/auth/calendar.events'],
    clientIdEnv: 'GOOGLE_CLIENT_ID', clientSecretEnv: 'GOOGLE_CLIENT_SECRET', extra: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    name: 'Outlook calendar', authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scopes: ['offline_access', 'Calendars.ReadWrite'],
    clientIdEnv: 'MICROSOFT_CLIENT_ID', clientSecretEnv: 'MICROSOFT_CLIENT_SECRET',
  },
  zoom: {
    name: 'Zoom', authorizeUrl: 'https://zoom.us/oauth/authorize', tokenUrl: 'https://zoom.us/oauth/token', revokeUrl: 'https://zoom.us/oauth/revoke',
    scopes: ['meeting:write:meeting'], clientIdEnv: 'ZOOM_CLIENT_ID', clientSecretEnv: 'ZOOM_CLIENT_SECRET',
  },
  mailchimp: {
    name: 'Mailchimp', authorizeUrl: 'https://login.mailchimp.com/oauth2/authorize', tokenUrl: 'https://login.mailchimp.com/oauth2/token',
    scopes: [], clientIdEnv: 'MAILCHIMP_CLIENT_ID', clientSecretEnv: 'MAILCHIMP_CLIENT_SECRET',
  },
};

export const isOAuthProvider = (p: string): p is OAuthProvider => p in OAUTH_PROVIDERS;
const STATE_TTL_MS = 10 * 60_000;

export function clientCredentials(p: OAuthProvider, env = process.env): { id: string; secret: string } | null {
  const id = env[OAUTH_PROVIDERS[p].clientIdEnv]?.trim();
  const secret = env[OAUTH_PROVIDERS[p].clientSecretEnv]?.trim();
  return id && secret ? { id, secret } : null;
}

export function redirectUri(p: OAuthProvider, env = process.env): string {
  return `${(env.PUBLIC_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/api/integrations/${p}/callback`;
}

/** HTTP client for token calls; tests replace it so nothing reaches a provider. */
export type TokenHttp = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json: () => Promise<unknown> }>;
let http: TokenHttp = (url, init) => fetch(url, init);
export function setOAuthHttpClient(client: TokenHttp | null): void { http = client ?? ((url, init) => fetch(url, init)); }

/** The provider's sign-in address to send the business owner to, or null when the provider is not configured. */
export function authorizeUrl(p: OAuthProvider, orgId: string, userId: string, now = Date.now()): string | null {
  const creds = clientCredentials(p);
  if (!creds) return null;
  const spec = OAUTH_PROVIDERS[p];
  const verifier = randomBytes(32).toString('base64url');
  const state = seal(`oauth-state:${p}`, JSON.stringify({ orgId, userId, verifier, exp: now + STATE_TTL_MS, nonce: randomBytes(8).toString('hex') }));
  const params = new URLSearchParams({
    response_type: 'code', client_id: creds.id, redirect_uri: redirectUri(p), state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(spec.scopes.length ? { scope: spec.scopes.join(' ') } : {}), ...(spec.extra ?? {}),
  });
  return `${spec.authorizeUrl}?${params.toString()}`;
}

/** The business, user and PKCE verifier a state was issued for, or null (altered, expired, other provider). */
export function readState(p: OAuthProvider, state: string, now = Date.now()): { orgId: string; userId: string; verifier: string } | null {
  const plain = typeof state === 'string' && state.length < 2000 ? open(`oauth-state:${p}`, state) : null;
  if (!plain) return null;
  try {
    const s = JSON.parse(plain) as { orgId: string; userId: string; verifier: string; exp: number };
    return s.exp > now ? { orgId: s.orgId, userId: s.userId, verifier: s.verifier } : null;
  } catch { return null; }
}

/** Exchanges the code for tokens and stores them encrypted for the business. */
export async function completeConnection(p: OAuthProvider, orgId: string, userId: string, code: string, verifier: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const creds = clientCredentials(p);
  if (!creds) return { ok: false, error: 'This integration is not configured on the server' };
  const res = await http(OAUTH_PROVIDERS[p].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: redirectUri(p), client_id: creds.id, client_secret: creds.secret, code_verifier: verifier,
    }).toString(),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (res.status !== 200 || !body.access_token) return { ok: false, error: 'The provider did not accept the connection. Try again.' };
  const bind = `${orgId}:${p}`;
  db.prepare(
    `INSERT INTO integration_connections (organization_id, provider, access_token_enc, refresh_token_enc, expires_at, scopes, connected_by, connected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id, provider) DO UPDATE SET access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
       expires_at = excluded.expires_at, scopes = excluded.scopes, connected_by = excluded.connected_by, connected_at = excluded.connected_at`
  ).run(orgId, p, seal(bind, body.access_token), body.refresh_token ? seal(bind, body.refresh_token) : null,
    body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
    body.scope ?? OAUTH_PROVIDERS[p].scopes.join(' '), userId);
  return { ok: true };
}

export function connectionStatus(orgId: string, p: OAuthProvider): { connected: boolean; connectedAt?: string; scopes?: string } {
  const row = db.prepare('SELECT connected_at, scopes FROM integration_connections WHERE organization_id = ? AND provider = ?').get(orgId, p) as
    { connected_at: string; scopes: string } | undefined;
  return row ? { connected: true, connectedAt: row.connected_at, scopes: row.scopes } : { connected: false };
}

/** Disconnects: revokes at the provider when possible (best effort) and always deletes the stored tokens. */
export async function disconnect(orgId: string, p: OAuthProvider): Promise<boolean> {
  const row = db.prepare('SELECT access_token_enc, refresh_token_enc FROM integration_connections WHERE organization_id = ? AND provider = ?').get(orgId, p) as
    { access_token_enc: string; refresh_token_enc: string | null } | undefined;
  if (!row) return false;
  const spec = OAUTH_PROVIDERS[p];
  const token = open(`${orgId}:${p}`, row.refresh_token_enc ?? row.access_token_enc);
  const creds = clientCredentials(p);
  if (spec.revokeUrl && token && creds) {
    await http(spec.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${creds.id}:${creds.secret}`).toString('base64')}` },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => undefined);
  }
  db.prepare('DELETE FROM integration_connections WHERE organization_id = ? AND provider = ?').run(orgId, p);
  return true;
}

/**
 * A usable access token for the business's connection: refreshed with the stored refresh token when it has expired.
 * Null when not connected or the refresh is refused (then the calendar must be connected again).
 */
export async function accessTokenFor(orgId: string, p: OAuthProvider, now = Date.now()): Promise<string | null> {
  const row = db.prepare('SELECT access_token_enc, refresh_token_enc, expires_at, scopes FROM integration_connections WHERE organization_id = ? AND provider = ?')
    .get(orgId, p) as { access_token_enc: string; refresh_token_enc: string | null; expires_at: string | null; scopes: string } | undefined;
  if (!row) return null;
  const bind = `${orgId}:${p}`;
  const access = open(bind, row.access_token_enc);
  if (access && (!row.expires_at || Date.parse(row.expires_at) - 60_000 > now)) return access;
  const refresh = row.refresh_token_enc ? open(bind, row.refresh_token_enc) : null;
  const creds = clientCredentials(p);
  if (!refresh || !creds) return null;
  const res = await http(OAUTH_PROVIDERS[p].tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: creds.id, client_secret: creds.secret }).toString(),
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (res.status !== 200 || !body.access_token) return null;
  db.prepare('UPDATE integration_connections SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc), expires_at = ? WHERE organization_id = ? AND provider = ?')
    .run(seal(bind, body.access_token), body.refresh_token ? seal(bind, body.refresh_token) : null,
      body.expires_in ? new Date(now + body.expires_in * 1000).toISOString() : null, orgId, p);
  return body.access_token;
}

/** Development only (mock provider mode): a stand-in connection so calendar sync can be exercised against the mock. */
export function connectMockCalendar(orgId: string, p: 'google' | 'microsoft', userId: string): void {
  const bind = `${orgId}:${p}`;
  db.prepare(
    `INSERT INTO integration_connections (organization_id, provider, access_token_enc, refresh_token_enc, expires_at, scopes, connected_by, connected_at)
     VALUES (?, ?, ?, NULL, NULL, 'mock', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(organization_id, provider) DO UPDATE SET access_token_enc = excluded.access_token_enc, scopes = 'mock', connected_by = excluded.connected_by, connected_at = excluded.connected_at`
  ).run(orgId, p, seal(bind, 'mock-token'), userId);
}

/** True when the connection is the development stand-in, not a real account. */
export function isMockConnection(orgId: string, p: OAuthProvider): boolean {
  return (db.prepare('SELECT scopes FROM integration_connections WHERE organization_id = ? AND provider = ?').pluck().get(orgId, p) as string | undefined) === 'mock';
}
