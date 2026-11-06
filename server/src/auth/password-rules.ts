import { z } from 'zod';

// The password policy and hashing cost for new accounts, shared by sign-up, password change and reset in
// routes/auth.ts and by the operator's account-creation script (scripts/create-organization.ts).

export const BCRYPT_COST = 12;

export const PasswordRule = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be 128 characters or fewer')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');
