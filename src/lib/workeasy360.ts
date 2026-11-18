// Sign-in with WorkEasy360 Accounts: what the sign-in page says when a WorkEasy360 sign-in did not complete.
// The server sends a fixed code (/login?sso_error=<code>&reason=<reason>); never a token or a provider's description.

const MESSAGES: Record<string, string> = {
  expired: 'That sign-in took too long or was already used. Please try again.',
  unavailable: 'WorkEasy360 could not be reached. Please try again in a moment.',
  rate_limited: 'Too many sign-ins were started just now. Please wait a minute and try again.',
  cancelled: 'Sign-in with WorkEasy360 was cancelled.',
  refused: 'WorkEasy360 did not complete the sign-in. Please try again.',
  invalid_token: 'The sign-in could not be verified. Please try again.',
  wrong_product: 'That WorkEasy360 sign-in was for another product.',
  no_organization: 'Choose an organization in WorkEasy360 to sign in.',
  email_unverified: 'Confirm your email address in WorkEasy360 first, then sign in again.',
  wrong_organization: 'The sign-in was for a different organization than the one you chose. Please try again.',
  not_entitled: 'Your organization does not have WorkeasyBooking.',
  membership_inactive: 'Your access to this organization has ended. Ask an administrator.',
  organization_inactive: 'This organization is not active in WorkEasy360.',
  integration_suspended: 'Sign-in with WorkEasy360 is suspended for WorkeasyBooking right now.',
  access_policy_denied: 'Your organization’s sign-in policy does not allow this sign-in.',
  access_unverified: 'WorkeasyBooking cannot confirm your access with WorkEasy360 right now. Try again in a few minutes.',
  account_conflict: 'An account with your email address already exists here. Ask the administrator to link it to WorkEasy360.',
  other_organization: 'Your WorkeasyBooking account belongs to another organization. Sign in with that organization.',
  identity_conflict: 'Your account is being moved to the new WorkEasy360 sign-in. Please try again later or contact support.',
  account_disabled: 'Your WorkeasyBooking account is turned off. Ask an administrator.',
  no_business: 'Your organization has not been set up in WorkeasyBooking yet. Contact support.',
  business_unavailable: 'Your organization’s business is not available. Contact support.',
  session_ended: 'You signed out of WorkEasy360 while signing in. Please sign in again.',
};

const REASONS: Record<string, string> = {
  not_entitled: 'Your organization does not have WorkeasyBooking.',
  expired: 'Your organization’s WorkeasyBooking subscription has ended.',
  suspended: 'Your organization’s access to WorkeasyBooking is suspended. Contact your administrator.',
  membership_inactive: 'Your access to this organization has ended. Ask an administrator.',
  no_seat: 'Ask an administrator for a WorkeasyBooking seat.',
};

/** The message for `?sso_error=<code>[&reason=<reason>]`, or null when there is none. */
export function workeasy360ErrorMessage(code: string | null, reason?: string | null): string | null {
  if (!code) return null;
  if (code === 'not_entitled' && reason && REASONS[reason]) return REASONS[reason];
  return MESSAGES[code] ?? MESSAGES.refused;
}

/** The address that starts a WorkEasy360 sign-in, returning to `returnTo` (a page of this app) afterwards. */
export function workeasy360StartUrl(startUrl: string, returnTo?: string | null): string {
  if (!returnTo || !/^\/(?!\/)(?!api(\/|$))[A-Za-z0-9/_.-]{0,300}$/.test(returnTo)) return startUrl;
  return `${startUrl}?returnTo=${encodeURIComponent(returnTo)}`;
}
