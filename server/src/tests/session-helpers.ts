// The session token is only sent as an HttpOnly cookie. Tests read it from Set-Cookie and, where convenient,
// send it back as a Bearer token (Bearer requests need no CSRF token because browsers never add them on their own).

type WithHeaders = { headers: Record<string, unknown> };

function setCookies(res: WithHeaders): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw as string[] : raw ? [raw as string] : [];
}

/** The we360_session cookie value from a login or signup response. */
export function sessionToken(res: WithHeaders): string {
  const cookie = setCookies(res).find(c => c.startsWith('we360_session='));
  if (!cookie) throw new Error('Response did not set a we360_session cookie');
  return cookie.split(';')[0].slice('we360_session='.length);
}

/** "we360_session=<token>" for a Cookie header. */
export function sessionCookie(res: WithHeaders): string {
  return `we360_session=${sessionToken(res)}`;
}

/** The confirmation link token from the newest verification email to `email` (in-memory test transport). */
export async function verificationTokenFor(email: string): Promise<string> {
  const { testOutbox, accountEmailsSettled } = await import('../services/email/notify');
  await accountEmailsSettled();
  const mail = [...testOutbox.messages].reverse().find(m => m.to === email.toLowerCase() && /\/verify-email#token=/.test(m.text));
  if (!mail) throw new Error(`No confirmation email for ${email}`);
  return decodeURIComponent(/\/verify-email#token=([A-Za-z0-9_%-]+)/.exec(mail.text)![1]);
}

/**
 * Creates a business the way a person does: sign up, confirm the emailed link, sign in. Returns the sign-in response
 * (session cookie, `data.user` with `organization_id`, `data.csrfToken`), status 200.
 */
export async function signUpAndSignIn(
  app: import('express').Express,
  body: { name: string; email: string; company: string; password: string; confirmPassword?: string; timezone?: string; country?: string },
) {
  const { default: request } = await import('supertest');
  const signup = await request(app).post('/api/auth/signup').send({ confirmPassword: body.password, ...body });
  if (signup.status !== 202) throw new Error(`Sign-up answered ${signup.status}: ${JSON.stringify(signup.body)}`);
  const verified = await request(app).post('/api/auth/verify-email').send({ token: await verificationTokenFor(body.email) });
  if (verified.status !== 201) throw new Error(`Confirming the email answered ${verified.status}: ${JSON.stringify(verified.body)}`);
  return request(app).post('/api/auth/login').send({ email: body.email, password: body.password });
}
