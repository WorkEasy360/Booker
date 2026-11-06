// What the signed-in user may open or change, as reported by the server (/auth/me → permissions).
// This only decides what to show; every request is still checked by the server, which is the authority.

export type Permission =
  | 'catalog:read' | 'customers:read' | 'customers:write'
  | 'appointments:read' | 'appointments:read_own' | 'appointments:write'
  | 'emails:send' | 'reports:read' | 'services:write' | 'resources:write' | 'booking_pages:write'
  | 'workspaces:write' | 'staff:manage' | 'settings:write' | 'ai:use' | 'ai:admin';

const VIEW_APPOINTMENTS: Permission[] = ['appointments:read', 'appointments:read_own'];
// Business set-up pages are for people who run the business, not for staff sign-ins.
const RUN_BUSINESS: Permission[] = ['appointments:read'];

/** Most specific first; the first matching pattern decides. Any one listed permission opens the page. */
const ROUTES: Array<{ pattern: RegExp; any: Permission[] | 'everyone' }> = [
  { pattern: /^\/dashboard/, any: ['reports:read'] },
  { pattern: /^\/my-space/, any: VIEW_APPOINTMENTS },
  { pattern: /^\/appointments\/new/, any: ['appointments:write'] },
  { pattern: /^\/appointments\/[^/]+\/reschedule/, any: ['appointments:write'] },
  { pattern: /^\/appointments/, any: VIEW_APPOINTMENTS },
  { pattern: /^\/calendar/, any: VIEW_APPOINTMENTS },
  { pattern: /^\/workspaces\/(new|[^/]+\/edit)/, any: ['workspaces:write'] },
  { pattern: /^\/workspaces/, any: RUN_BUSINESS },
  { pattern: /^\/services\/(new|[^/]+\/edit)/, any: ['services:write'] },
  { pattern: /^\/services/, any: RUN_BUSINESS },
  { pattern: /^\/staff\/(new|[^/]+\/edit)/, any: ['staff:manage'] },
  { pattern: /^\/staff/, any: RUN_BUSINESS },
  { pattern: /^\/resources\/(new|[^/]+\/edit)/, any: ['resources:write'] },
  { pattern: /^\/resources/, any: RUN_BUSINESS },
  { pattern: /^\/customers\/new/, any: ['customers:write'] },
  { pattern: /^\/customers/, any: ['customers:read'] },
  { pattern: /^\/booking-pages/, any: ['booking_pages:write'] },
  { pattern: /^\/notifications/, any: ['emails:send'] },
  { pattern: /^\/integrations/, any: ['settings:write'] },
  { pattern: /^\/reports/, any: ['reports:read'] },
  // Everyone can open Settings: people without settings:write only see their own account (password, sessions).
  { pattern: /^\/settings/, any: 'everyone' },
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

/** Where to land after signing in. */
export function homePath(perms: readonly string[] | undefined): string {
  if (hasPermission(perms, 'reports:read')) return '/dashboard';
  if (VIEW_APPOINTMENTS.some(p => hasPermission(perms, p))) return '/my-space';
  return '/settings';
}
