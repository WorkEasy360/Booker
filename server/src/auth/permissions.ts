import type { StaffRole } from '../types';

// One place that says what each role may do. Routes ask for a permission, never for a role,
// and an unknown role gets nothing.

export const PERMISSIONS = [
  'catalog:read',          // services, staff list, workspaces, resources, booking pages, business settings
  'customers:read',
  'customers:write',
  'appointments:read',     // every appointment in the organization
  'appointments:read_own', // only appointments assigned to the signed-in staff member
  'appointments:write',
  'emails:send',           // resend booking emails
  'reports:read',
  'services:write',
  'resources:write',
  'booking_pages:write',
  'workspaces:write',
  'staff:manage',          // create, edit, deactivate staff and their sign-in access
  'settings:write',
  'ai:use',
  'ai:admin',              // knowledge index maintenance
] as const;

export type Permission = typeof PERMISSIONS[number];

const MANAGER: Permission[] = [
  'catalog:read', 'customers:read', 'customers:write', 'appointments:read', 'appointments:write',
  'emails:send', 'reports:read', 'services:write', 'resources:write', 'booking_pages:write', 'ai:use',
];

const ROLE_PERMISSIONS: Record<StaffRole, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  manager: new Set(MANAGER),
  staff: new Set<Permission>(['catalog:read', 'appointments:read_own']),
};

export function permissionsFor(role: string | undefined): Permission[] {
  const set = role && Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)
    ? ROLE_PERMISSIONS[role as StaffRole]
    : undefined;
  return set ? PERMISSIONS.filter(p => set.has(p)) : [];
}

export function can(role: string | undefined, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Permission needed to carry out an assistant proposal of this kind. */
export const PROPOSAL_PERMISSIONS: Record<string, Permission> = {
  propose_create_service: 'services:write',
  propose_create_appointment: 'appointments:write',
  propose_create_customer: 'customers:write',
};
