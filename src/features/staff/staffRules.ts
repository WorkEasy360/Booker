// Mirrors the server rules in server/src/routes/staff.ts and server/src/services/bookability.ts.

export type StaffRole = 'admin' | 'manager' | 'staff';

export const STAFF_ROLE_OPTIONS: Array<{ value: StaffRole; label: string }> = [
  { value: 'staff', label: 'Staff' },
  { value: 'manager', label: 'Manager' },
  { value: 'admin', label: 'Admin' },
];

// Phone numbers: see src/lib/validation.ts (the same rule as the API).
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface BookableLike {
  isActive: boolean;
  serviceIds: string[];
  workingHours?: Record<string, { enabled?: boolean } | undefined>;
}

/** Reasons a staff member cannot currently receive online bookings; empty when bookable. */
export function bookabilityProblems(s: BookableLike): string[] {
  const problems: string[] = [];
  if (!s.isActive) problems.push('inactive');
  if (!s.serviceIds.length) problems.push('no services assigned');
  if (!Object.values(s.workingHours ?? {}).some(d => d?.enabled)) problems.push('no working hours');
  return problems;
}
