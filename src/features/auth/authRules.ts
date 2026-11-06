// Checks shared by the account-email pages (forgot password, reset password, confirm email).

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The server's password rule, checked before sending so the person sees the problem at once. */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 128) return 'Password must be 128 characters or fewer.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null;
}

/** The token from an emailed link (#token=…). Browsers never send the part after # to servers. */
export function tokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') ?? '';
}
