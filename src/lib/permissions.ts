// What the signed-in user may open or change, as reported by the server (/auth/me → permissions).
// This only decides what to show; every request is still checked by the server, which is the authority.

export type Permission =
  | 'catalog:read' | 'customers:read' | 'customers:write'
  | 'appointments:read' | 'appointments:read_own' | 'appointments:write'
  | 'emails:send' | 'reports:read' | 'services:write' | 'resources:write' | 'booking_pages:write'
  | 'workspaces:write' | 'staff:manage' | 'settings:write' | 'ai:use' | 'ai:admin';

const VIEW_APPOINTMENTS: Permission[] = ['appointments:read', 'appointments:read_own'];

/** Most specific first; the first matching pattern decides. Any one listed permission opens the page. */
const ROUTES: Array<{ pattern: RegExp; any: Permission[] | 'everyone' }> = [
  { pattern: /^\/appointments\/new/, any: ['appointments:write'] },
  { pattern: /^\/appointments\/[^/]+\/(reschedule|edit)/, any: ['appointments:write'] },
  { pattern: /^\/appointments/, any: VIEW_APPOINTMENTS },
  // Staff see and manage their own availability; owners manage everyone's.
  { pattern: /^\/availability/, any: ['staff:manage', 'settings:write', 'appointments:write', 'appointments:read_own'] },
  { pattern: /^\/customers\/(new|[^/]+\/edit)/, any: ['customers:write'] },
  { pattern: /^\/customers/, any: ['customers:read'] },
  // Everyone can open Settings: people without settings:write see only the sections their role can use.
  { pattern: /^\/settings/, any: 'everyone' },
  { pattern: /^\/account/, any: 'everyone' },
];

export function hasPermission(perms: readonly string[] | undefined, p: Permission): boolean {
  return !!perms?.includes(p);
}

export function canOpen(perms: readonly string[] | undefined, pathname: string): boolean {
  const rule = ROUTES.find(r => r.pattern.test(pathname));
  if (!rule) return true;
  if (rule.any === 'everyone') return true;
  return rule.any.some(p => hasPermission(perms, p));
}

/** Where to land after signing in: Appointments is the home screen. */
export function homePath(perms: readonly string[] | undefined): string {
  if (VIEW_APPOINTMENTS.some(p => hasPermission(perms, p))) return '/appointments';
  return '/settings';
}

/** Display name of a sign-in role ("admin" is the business owner). */
export function roleLabel(role: string | undefined | null): string {
  switch (role) {
    case 'admin': case 'owner': return 'Owner';
    case 'manager': return 'Manager';
    case 'staff': return 'Staff';
    default: return role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  }
}
