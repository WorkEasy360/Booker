import { Router, Response, Request } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import db from '../db/init';
import { requireAuth, readSessionToken, type AuthRequest } from '../middleware/auth';
import { createSession, csrfTokenFor, resolveSession, revokeSession, revokeUserSessions, listUserSessions, deriveKey } from '../auth/session';
import { permissionsFor, PERMISSIONS } from '../auth/permissions';
import { inspectInvitation, acceptInvitation } from '../services/staff-invitations';
import { securityConfig } from '../config/security';
import { BCRYPT_COST, PasswordRule } from '../auth/password-rules';
import { RULES, clearLimit, clientKey, rateLimit } from '../middleware/rate-limit';
import { newBusinessLocale } from '../services/business-locale';
import { accountEmailAvailable } from '../services/email/notify';
import {
  beginSetup, confirmSetup, disableTwoFactor, issueChallenge, regenerateRecoveryCodes, twoFactorEnabled, twoFactorStatus,
  verifyChallenge, verifySecondFactor,
} from '../services/two-factor';
import {
  requestSignup, resendVerification, inspectVerification, verifySignup,
  requestPasswordReset, inspectPasswordReset, completePasswordReset, supersedePasswordResets,
} from '../services/account-tokens';

const router = Router();

// Hash of a random throwaway value, compared when no account matches so both cases take the same time.
const DUMMY_HASH = '$2b$12$NDgdRTbaFmDg37W3LD0quOS0fyo3bpjQ/9uQJIhmpntyLDjGkHXmq';

function cookieOptions() {
  const cfg = securityConfig();
  return { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' as const, path: '/' };
}

function setSessionCookie(res: Response, token: string): void {
  res.cookie(securityConfig().cookieName, token, { ...cookieOptions(), maxAge: securityConfig().sessionTtlMs });
}

// ─── Known devices ───────────────────────────────────────────────────────────
// After a successful sign-in the browser gets a signed "device" cookie naming the account. The account-wide limit on
// failed sign-ins applies only to devices without one, so someone guessing passwords from elsewhere can slow down
// new-device sign-ins but cannot lock the owner out of the browsers they already use. (OWASP "device cookies".)

const DEVICE_MAX_AGE_MS = 180 * 86_400_000;
const deviceCookieName = () => (securityConfig().production ? '__Host-we360_device' : 'we360_device');

function signDevice(userId: string, deviceId: string): string {
  return createHmac('sha256', deriveKey('device-v1')).update(`${userId}.${deviceId}`).digest('base64url');
}

function setDeviceCookie(res: Response, userId: string): void {
  const deviceId = randomBytes(16).toString('base64url');
  res.cookie(deviceCookieName(), `${userId}.${deviceId}.${signDevice(userId, deviceId)}`, { ...cookieOptions(), maxAge: DEVICE_MAX_AGE_MS });
}

/** The account a valid device cookie belongs to, or null. */
function deviceAccount(req: Request): string | null {
  const raw = (req as AuthRequest).cookies?.[deviceCookieName()];
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [userId, deviceId, mac] = parts;
  const expected = Buffer.from(signDevice(userId, deviceId));
  const presented = Buffer.from(mac);
  return presented.length === expected.length && timingSafeEqual(presented, expected) ? userId : null;
}

/** True when this browser has signed in to the account for this email before. */
function knownDeviceFor(req: Request, email: string): boolean {
  const userId = deviceAccount(req);
  if (!userId) return false;
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string } | undefined;
  return user?.id === userId;
}

function publicUser(u: { id: string; email: string; name: string; role: string; organization_id?: string; staff_id?: string | null }) {
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, organization_id: u.organization_id,
    staffId: u.staff_id ?? null, permissions: permissionsFor(u.role),
  };
}

interface SignInUser {
  id: string; organization_id: string; email: string; password_hash: string; name: string; role: string;
  staff_id: string | null; staff_active: number | null;
}

/** An active sign-in by email or id, with the active state of its staff record. */
function signInUser(by: 'email' | 'id', value: string): SignInUser | undefined {
  return db.prepare(
    `SELECT u.id, u.organization_id, u.email, u.password_hash, u.name, u.role, u.staff_id, st.is_active AS staff_active
     FROM users u LEFT JOIN staff st ON st.id = u.staff_id AND st.organization_id = u.organization_id
     WHERE u.${by === 'email' ? 'email' : 'id'} = ? AND u.is_active = 1`
  ).get(value) as SignInUser | undefined;
}

/** Creates the session once every required step has passed. */
function completeSignIn(req: AuthRequest, res: Response, user: SignInUser): void {
  clearLimit(RULES.loginAccountIp, `${user.email}|${clientKey(req)}`);
  clearLimit(RULES.loginAccount, user.email);
  const session = createSession(user.id, user.organization_id);
  setSessionCookie(res, session.token);
  setDeviceCookie(res, user.id);
  res.json({ data: { user: publicUser(user), csrfToken: session.csrfToken } });
}

function validationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'Validation error',
    details: error.errors.map(e => ({ path: e.path.join('.'), message: e.message })),
  });
}

const LoginSchema = z.object({
  email: z.string().trim().max(254).email(),
  password: z.string().min(1).max(200),
});


const SignupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or fewer'),
  email: z.string().trim().max(254).email('Valid work email required'),
  company: z.string().trim().min(1, 'Company / workspace name is required').max(100, 'Company name must be 100 characters or fewer'),
  password: PasswordRule,
  confirmPassword: z.string().min(1, 'Please confirm your password'),
  // Optional: the web app sends the browser's time zone; an invalid value is ignored rather than refused.
  timezone: z.string().max(64).optional(),
  country: z.string().trim().max(56).optional(),
}).refine(d => d.password === d.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

function loginEmail(req: AuthRequest): string | null {
  const e = (req.body as { email?: unknown } | undefined)?.email;
  return typeof e === 'string' && e.trim() ? e.trim().toLowerCase().slice(0, 254) : null;
}

// Only failed sign-ins count (status 401), so a shared network is never blocked by its own successful logins.
// The account-wide limit skips devices that have signed in to the account before (see "Known devices").
const loginLimit = rateLimit(req => {
  const email = loginEmail(req as AuthRequest);
  const ip = clientKey(req);
  return [
    { rule: RULES.loginAccountIp, key: email && `${email}|${ip}` },
    { rule: RULES.loginIp, key: ip },
    { rule: RULES.loginAccount, key: email && !knownDeviceFor(req, email) ? email : null },
  ];
}, { countIf: status => status === 401 });

router.post('/login', loginLimit, async (req: AuthRequest, res, next) => {
  try {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    const email = parsed.data.email.toLowerCase();

    const user = signInUser('email', email);

    const valid = await bcrypt.compare(parsed.data.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !valid || (user.staff_id && !user.staff_active)) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // With two-factor sign-in on, the correct password earns a short-lived challenge, not a session.
    if (twoFactorEnabled(user.id)) {
      res.json({ data: { twoFactorRequired: true, ...issueChallenge(user.id) } });
      return;
    }
    completeSignIn(req, res, user);
  } catch (err) {
    next(err);
  }
});

// ─── Two-factor sign-in (second step) ────────────────────────────────────────

const SecondFactorFields = {
  code: z.string().trim().max(12).optional(),
  recoveryCode: z.string().trim().max(40).optional(),
};
const oneSecondFactor = (d: { code?: string; recoveryCode?: string }) => (d.code === undefined) !== (d.recoveryCode === undefined);
const SECOND_FACTOR_MESSAGE = 'Enter the 6-digit code from your authenticator app, or one of your recovery codes';

const TwoFactorLoginSchema = z.object({ challenge: z.string().min(1).max(400), ...SecondFactorFields })
  .refine(oneSecondFactor, { message: SECOND_FACTOR_MESSAGE });

// Only wrong codes and dead challenges count (401), per network and per account.
const twoFactorLimit = rateLimit(req => [
  { rule: RULES.twoFactorIp, key: clientKey(req) },
  { rule: RULES.twoFactorUser, key: verifyChallenge((req.body as { challenge?: unknown } | undefined)?.challenge) },
], { countIf: status => status === 401 });

const CHALLENGE_INVALID = { error: 'This sign-in has expired. Enter your email and password again.', code: 'TWO_FACTOR_CHALLENGE_INVALID' };

router.post('/login/2fa', twoFactorLimit, (req: AuthRequest, res, next) => {
  try {
    const parsed = TwoFactorLoginSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message ?? SECOND_FACTOR_MESSAGE }); return; }
    const userId = verifyChallenge(parsed.data.challenge);
    const user = userId ? signInUser('id', userId) : undefined;
    if (!user || (user.staff_id && !user.staff_active)) { res.status(401).json(CHALLENGE_INVALID); return; }
    if (!verifySecondFactor(user.id, parsed.data)) {
      res.status(401).json({ error: 'That code is not correct, or it has already been used.', code: 'TWO_FACTOR_INVALID' });
      return;
    }
    completeSignIn(req, res, user);
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req: AuthRequest, res) => {
  // Ends this session on the server, so a copied cookie stops working too. Always succeeds.
  const presented = readSessionToken(req);
  const user = presented ? resolveSession(presented.token) : null;
  if (user?.sid) revokeSession(user.sid);
  res.clearCookie(securityConfig().cookieName, cookieOptions());
  res.json({ data: { message: 'Logged out' } });
});

// ─── Sign-up with email verification, and password reset ─────────────────────
// Every request that names an email address gets the same answer, whether or not an account exists; what happens
// next only reaches the mailbox owner (services/account-tokens.ts). Nothing here signs anyone in.

export const GENERIC_EMAIL_REPLY = 'We’ll send an email with the next steps if the address can be used for this request.';
const EMAIL_NOT_CONFIGURED = {
  error: 'Email is not set up on this server, so this cannot be completed yet. Ask the server administrator to configure email.',
  code: 'EMAIL_NOT_CONFIGURED',
};

const EmailOnlySchema = z.object({ email: z.string().trim().max(254).email('Enter a valid email address') });

// Every attempt counts, per network address and per address asked about.
const signupLimit = rateLimit(req => [{ rule: RULES.signupIp, key: clientKey(req) }, { rule: RULES.signupEmail, key: loginEmail(req as AuthRequest) }]);
const resendLimit = rateLimit(req => [{ rule: RULES.verifyResendIp, key: clientKey(req) }, { rule: RULES.verifyResendEmail, key: loginEmail(req as AuthRequest) }]);
const forgotLimit = rateLimit(req => [{ rule: RULES.forgotIp, key: clientKey(req) }, { rule: RULES.forgotEmail, key: loginEmail(req as AuthRequest) }]);
// Failed link checks count (unknown, expired or used links), like invitation links.
const accountTokenLimit = rateLimit(req => [{ rule: RULES.accountTokenIp, key: clientKey(req) }], { countIf: status => status === 404 || status === 410 });

/** With SIGNUP_MODE=closed nobody can create a business from the web; the operator creates accounts. */
const SIGNUP_CLOSED = { error: 'New sign-ups are closed on this server. Ask your administrator for an account.', code: 'SIGNUP_CLOSED' };

router.post('/signup', signupLimit, async (req, res, next) => {
  try {
    if (!securityConfig().signupOpen) { res.status(403).json(SIGNUP_CLOSED); return; }
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    if (!accountEmailAvailable()) { res.status(503).json(EMAIL_NOT_CONFIGURED); return; }
    const { name, email, company, password } = parsed.data;
    const locale = newBusinessLocale({ timezone: parsed.data.timezone, country: parsed.data.country });
    // Hashed for every request, so a new and an already-registered address take the same time.
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    requestSignup({ email: email.toLowerCase(), name, company, passwordHash, timezone: locale.timezone, country: locale.country ?? null });
    res.status(202).json({ data: { message: GENERIC_EMAIL_REPLY } });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-email/inspect', accountTokenLimit, (req, res) => {
  const result = inspectVerification((req.body as { token?: unknown } | undefined)?.token);
  if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
  res.json({ data: result.data });
});

router.post('/verify-email', accountTokenLimit, (req, res, next) => {
  try {
    if (!securityConfig().signupOpen) { res.status(403).json(SIGNUP_CLOSED); return; }
    const result = verifySignup((req.body as { token?: unknown } | undefined)?.token);
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
    res.status(201).json({ data: { message: 'Your email is confirmed and your account is ready. Sign in to continue.' } });
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'An account with this email address already exists. Sign in instead.', code: 'VERIFY_ACCOUNT_EXISTS' });
      return;
    }
    next(err);
  }
});

router.post('/verify-email/resend', resendLimit, (req, res, next) => {
  try {
    if (!securityConfig().signupOpen) { res.status(403).json(SIGNUP_CLOSED); return; }
    const parsed = EmailOnlySchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    if (!accountEmailAvailable()) { res.status(503).json(EMAIL_NOT_CONFIGURED); return; }
    resendVerification(parsed.data.email.toLowerCase());
    res.status(202).json({ data: { message: GENERIC_EMAIL_REPLY } });
  } catch (err) {
    next(err);
  }
});

router.post('/password/forgot', forgotLimit, (req, res, next) => {
  try {
    const parsed = EmailOnlySchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    if (!accountEmailAvailable()) { res.status(503).json(EMAIL_NOT_CONFIGURED); return; }
    requestPasswordReset(parsed.data.email.toLowerCase());
    res.status(202).json({ data: { message: GENERIC_EMAIL_REPLY } });
  } catch (err) {
    next(err);
  }
});

router.post('/password/reset/inspect', accountTokenLimit, (req, res) => {
  const result = inspectPasswordReset((req.body as { token?: unknown } | undefined)?.token);
  if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
  res.json({ data: result.data });
});

const ResetSchema = z.object({
  token: z.string().min(20).max(200),
  password: PasswordRule,
  confirmPassword: z.string().min(1, 'Please confirm your password'),
}).refine(d => d.password === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

router.post('/password/reset', accountTokenLimit, async (req, res, next) => {
  try {
    const parsed = ResetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }
    // The link is checked before any work is done; it is checked again, and consumed, when the password is saved.
    const link = inspectPasswordReset(parsed.data.token);
    if (!link.ok) { res.status(link.status).json({ error: link.error, code: link.code }); return; }
    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
    const result = completePasswordReset(parsed.data.token, passwordHash);
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
    // The owner proved control of the mailbox: earlier failed sign-ins no longer hold the account back.
    clearLimit(RULES.loginAccount, result.email);
    res.json({ data: { message: 'Your password has been changed and every device was signed out. Sign in with your new password.' } });
  } catch (err) {
    next(err);
  }
});

const PasswordChangeSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(200),
  newPassword: PasswordRule,
});

const passwordLimit = rateLimit(
  req => [{ rule: RULES.passwordUser, key: (req as AuthRequest).user?.sub }],
  { countIf: status => status === 400 },
);

router.put('/password', requireAuth, passwordLimit, async (req: AuthRequest, res, next) => {
  try {
    const parsed = PasswordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? 'Validation error' });
      return;
    }
    const { currentPassword, newPassword } = parsed.data;

    const user = db
      .prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1')
      .get(req.user!.sub) as { password_hash: string } | undefined;
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      res.status(400).json({ error: 'Current password is incorrect' });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, req.user!.sub);
    // Reset links requested before the change no longer work.
    supersedePasswordResets(req.user!.sub);
    // Anyone holding an older session (another device, a stolen cookie) is signed out; this one stays.
    const ended = revokeUserSessions(req.user!.sub, req.user!.sid);

    res.json({ data: { message: 'Password updated successfully', otherSessionsEnded: ended } });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req: AuthRequest, res, next) => {
  try {
    const user = db
      .prepare('SELECT id, email, name, role, organization_id, staff_id FROM users WHERE id = ?')
      .get(req.user!.sub) as
      | { id: string; email: string; name: string; role: string; organization_id: string; staff_id: string | null }
      | undefined;
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }

    res.json({ data: { ...publicUser(user), csrfToken: req.user!.sid ? csrfTokenFor(req.user!.sid) : undefined } });
  } catch (err) {
    next(err);
  }
});

// ─── Roles (read-only description of the enforced model) ─────────────────────

const ROLE_LABELS: Record<string, string> = { admin: 'Administrator', manager: 'Manager', staff: 'Staff' };

router.get('/roles', requireAuth, (_req, res) => {
  res.json({
    data: {
      permissions: PERMISSIONS,
      roles: Object.keys(ROLE_LABELS).map(role => ({ role, label: ROLE_LABELS[role], permissions: permissionsFor(role) })),
    },
  });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

router.get('/sessions', requireAuth, (req: AuthRequest, res) => {
  // Session ids are not shown; a short fingerprint is enough to tell sessions apart.
  const sessions = listUserSessions(req.user!.sub).map(s => ({
    id: s.id.slice(0, 6), createdAt: s.createdAt, expiresAt: s.expiresAt, current: s.id === req.user!.sid,
  }));
  res.json({ data: sessions });
});

router.post('/sessions/revoke-others', requireAuth, (req: AuthRequest, res) => {
  res.json({ data: { ended: revokeUserSessions(req.user!.sub, req.user!.sid) } });
});

// ─── Two-factor sign-in settings (the signed-in user's own) ──────────────────
// Turning it on, off, or replacing recovery codes needs the current password; turning it off or replacing codes also
// needs a current code, so a session left open on a shared computer cannot remove the protection.

const twoFactorManageLimit = rateLimit(req => [{ rule: RULES.twoFactorManage, key: (req as AuthRequest).user?.sub }], { countIf: status => status === 400 });
const PasswordOnlySchema = z.object({ password: z.string().min(1, 'Enter your current password').max(200) });
const CodeOnlySchema = z.object({ code: z.string().trim().min(1, 'Enter the 6-digit code from your authenticator app').max(12) });
const ConfirmSchema = z.object({ password: z.string().min(1, 'Enter your current password').max(200), ...SecondFactorFields })
  .refine(oneSecondFactor, { message: SECOND_FACTOR_MESSAGE });

async function passwordMatches(userId: string, password: string): Promise<boolean> {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ? AND is_active = 1').get(userId) as { password_hash: string } | undefined;
  return !!row && bcrypt.compare(password, row.password_hash);
}

router.get('/2fa', requireAuth, (req: AuthRequest, res) => {
  res.json({ data: twoFactorStatus(req.user!.sub) });
});

router.post('/2fa/setup', requireAuth, twoFactorManageLimit, async (req: AuthRequest, res, next) => {
  try {
    const parsed = PasswordOnlySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message }); return; }
    if (!(await passwordMatches(req.user!.sub, parsed.data.password))) { res.status(400).json({ error: 'Current password is incorrect' }); return; }
    const result = beginSetup(req.user!.sub, req.user!.email);
    if ('error' in result) { res.status(409).json({ error: result.error }); return; }
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.post('/2fa/enable', requireAuth, twoFactorManageLimit, (req: AuthRequest, res, next) => {
  try {
    const parsed = CodeOnlySchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message }); return; }
    const result = confirmSetup(req.user!.sub, parsed.data.code);
    if ('error' in result) { res.status(400).json({ error: result.error }); return; }
    // Other sessions were opened with the password alone: they end; this one stays.
    const ended = revokeUserSessions(req.user!.sub, req.user!.sid);
    res.json({ data: { recoveryCodes: result.recoveryCodes, otherSessionsEnded: ended } });
  } catch (err) { next(err); }
});

/** Checks the password, then the second factor (in that order, so a wrong password never uses up a recovery code). */
async function confirmIdentity(req: AuthRequest, res: Response): Promise<boolean> {
  const parsed = ConfirmSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.errors[0]?.message }); return false; }
  if (!twoFactorEnabled(req.user!.sub)) { res.status(409).json({ error: 'Two-factor sign-in is not on.' }); return false; }
  if (!(await passwordMatches(req.user!.sub, parsed.data.password))) { res.status(400).json({ error: 'Current password is incorrect' }); return false; }
  if (!verifySecondFactor(req.user!.sub, parsed.data)) { res.status(400).json({ error: 'That code is not correct, or it has already been used.' }); return false; }
  return true;
}

router.post('/2fa/disable', requireAuth, twoFactorManageLimit, async (req: AuthRequest, res, next) => {
  try {
    if (!(await confirmIdentity(req, res))) return;
    disableTwoFactor(req.user!.sub);
    const ended = revokeUserSessions(req.user!.sub, req.user!.sid);
    res.json({ data: { enabled: false, otherSessionsEnded: ended } });
  } catch (err) { next(err); }
});

router.post('/2fa/recovery-codes', requireAuth, twoFactorManageLimit, async (req: AuthRequest, res, next) => {
  try {
    if (!(await confirmIdentity(req, res))) return;
    res.json({ data: { recoveryCodes: regenerateRecoveryCodes(req.user!.sub) } });
  } catch (err) { next(err); }
});

// ─── Staff invitations (public: the token itself is the credential) ──────────

const inviteLimit = rateLimit(req => [{ rule: RULES.inviteTokenIp, key: clientKey(req) }], { countIf: status => status === 404 || status === 410 });
const TokenSchema = z.object({ token: z.string().min(20).max(200) });

router.post('/invitations/inspect', inviteLimit, (req, res) => {
  const parsed = TokenSchema.safeParse(req.body);
  if (!parsed.success) { res.status(404).json({ error: 'This invitation link is not valid.', code: 'INVITE_INVALID' }); return; }
  const result = inspectInvitation(parsed.data.token);
  if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
  res.json({ data: result.data });
});

const AcceptSchema = z.object({
  token: z.string().min(20).max(200),
  password: PasswordRule,
  confirmPassword: z.string().min(1, 'Please confirm your password'),
}).refine(d => d.password === d.confirmPassword, { message: 'Passwords do not match', path: ['confirmPassword'] });

router.post('/invitations/accept', inviteLimit, async (req, res, next) => {
  try {
    const parsed = AcceptSchema.safeParse(req.body);
    if (!parsed.success) { validationError(res, parsed.error); return; }
    // Cheap checks first, so a bad token costs no password hashing.
    const preview = inspectInvitation(parsed.data.token);
    if (!preview.ok) { res.status(preview.status).json({ error: preview.error, code: preview.code }); return; }
    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);
    const result = acceptInvitation(parsed.data.token, passwordHash);
    if (!result.ok) { res.status(result.status).json({ error: result.error, code: result.code }); return; }
    const session = createSession(result.user.id, result.user.organization_id);
    setSessionCookie(res, session.token);
    setDeviceCookie(res, result.user.id);
    res.status(201).json({ data: { user: publicUser(result.user), csrfToken: session.csrfToken } });
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'An account for this email address already exists. Sign in instead.', code: 'EMAIL_IN_USE' });
      return;
    }
    next(err);
  }
});

export default router;
