import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, User, Calendar, CalendarDays, Building2, Briefcase,
  Users, Box, UserRound, Globe, Bell, Plug, BarChart3, Settings,
  ChevronLeft, ChevronRight, ChevronDown, Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { workspacesApi, settingsApi } from '@/api/client';
import { canOpen } from '@/lib/permissions';
import { PRODUCT_NAME } from '@/lib/brand';
import { ProductLogo, ProductMark } from '@/components/brand';
import { setDateDisplayFormat } from '@/lib/regional';
import { useLanguage } from '@/i18n/LanguageContext';
import type { MessageKey } from '@/i18n/messages';

interface ApiWorkspace { id: string; name: string; color: string; }

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface NavItem {
  path: string;
  label: string;
  icon: React.ElementType;
  badge?: number;
  children?: { path: string; label: string }[];
}

const NAV_ITEMS: NavItem[] = [
  { path: '/dashboard',     label: 'Dashboard',    icon: LayoutDashboard },
  { path: '/my-space',      label: 'My Space',     icon: User },
  { path: '/appointments',  label: 'Appointments', icon: CalendarDays },
  { path: '/calendar',      label: 'Calendar',     icon: Calendar },
  { path: '/workspaces',    label: 'Workspaces',   icon: Building2 },
  { path: '/services',      label: 'Services',     icon: Briefcase },
  { path: '/staff',         label: 'Staff',        icon: Users },
  { path: '/resources',     label: 'Resources',    icon: Box },
  { path: '/customers',     label: 'Customers',    icon: UserRound },
  { path: '/booking-pages', label: 'Booking Pages', icon: Globe },
  { path: '/notifications', label: 'Notifications', icon: Bell },
  { path: '/integrations',  label: 'Integrations', icon: Plug },
  { path: '/reports',       label: 'Reports',      icon: BarChart3 },
  { path: '/settings',      label: 'Settings',     icon: Settings },
];

interface SidebarProps {
  collapsed: boolean;
  onCollapse: (v: boolean) => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

/** Navigation labels shown in the chosen language. */
const MENU_KEYS: Record<string, MessageKey> = {
  'Dashboard': 'menu.dashboard',
  'My Space': 'menu.mySpace',
  'Appointments': 'menu.appointments',
  'Calendar': 'menu.calendar',
  'Workspaces': 'menu.workspaces',
  'Services': 'menu.services',
  'Staff': 'menu.staff',
  'Resources': 'menu.resources',
  'Customers': 'menu.customers',
  'Booking Pages': 'menu.bookingPages',
  'Notifications': 'menu.notifications',
  'Integrations': 'menu.integrations',
  'Reports': 'menu.reports',
  'Settings': 'menu.settings'
};

export function Sidebar({ collapsed, onCollapse, mobileOpen, onMobileClose }: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const { t } = useLanguage();
  const menuLabel = (label: string) => (MENU_KEYS[label] ? t(MENU_KEYS[label]) : label);
  // Only the pages this role can use are listed; the server enforces the same rules.
  const navItems = NAV_ITEMS.filter(item => canOpen(user?.permissions, item.path));
  const showWorkspaces = canOpen(user?.permissions, '/workspaces');
  const [wsOpen, setWsOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<ApiWorkspace[]>([]);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);
  const firstNavRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    (workspacesApi.list() as Promise<ApiWorkspace[]>)
      .then(setWorkspaces)
      .catch((e: Error) => setWsError(e.message || 'Could not load workspaces'));
    (settingsApi.get() as Promise<{ name?: string; dateFormat?: string }>)
      .then(o => { setOrgName(o.name ?? null); setDateDisplayFormat(o.dateFormat); })
      .catch(() => setOrgName(null));
  }, []);

  // Focus first nav item when mobile drawer opens
  useEffect(() => {
    if (mobileOpen) {
      setTimeout(() => firstNavRef.current?.focus(), 50);
    }
  }, [mobileOpen]);

  // Close mobile drawer on navigation
  const handleNavClick = () => {
    if (mobileOpen) onMobileClose();
  };

  return (
    <aside
      id="main-sidebar"
      aria-label="Main navigation"
      className={cn(
        'fixed top-0 h-screen bg-navy flex flex-col z-30',
        // Desktop: always visible, width depends on collapsed state
        'md:left-0 md:translate-x-0 md:transition-[width] md:duration-200',
        collapsed ? 'md:w-16' : 'md:w-60',
        // Mobile: drawer that slides in from left
        'w-60 transition-transform duration-200',
        mobileOpen ? 'left-0 translate-x-0' : 'left-0 -translate-x-full md:translate-x-0',
      )}
    >
      {/* Product identity: WorkeasyBooking (the business's own name is shown just below) */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        {!collapsed && <ProductLogo tone="dark" layout="stacked" size="md" />}
        {collapsed && <ProductMark size={32} label={PRODUCT_NAME} className="mx-auto" />}
        {!collapsed && (
          <button
            onClick={() => onCollapse(true)}
            aria-label="Collapse sidebar"
            className="rounded hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0 w-11 h-11 flex items-center justify-center"
          >
            <ChevronLeft className="w-4 h-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Organization + workspace shortcuts (there is no per-workspace data scoping to switch) */}
      {!collapsed && (
        <div className="px-3 py-3 border-b border-white/10 shrink-0">
          <button
            onClick={() => setWsOpen(!wsOpen)}
            aria-expanded={wsOpen}
            aria-controls="sidebar-workspaces"
            aria-label={`Organization: ${orgName ?? 'unknown'}. Show workspaces.`}
            className="w-full flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/10 transition-colors"
          >
            <div className="w-6 h-6 rounded bg-primary flex items-center justify-center shrink-0" aria-hidden="true">
              <Building2 className="w-3 h-3 text-white" />
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs text-gray-400 leading-none">Organization</p>
              <p className="text-sm text-white font-medium truncate">{orgName ?? '—'}</p>
            </div>
            <ChevronDown className={cn('w-3.5 h-3.5 text-gray-400 transition-transform shrink-0', wsOpen && 'rotate-180')} aria-hidden="true" />
          </button>
          {wsOpen && showWorkspaces && (
            <div id="sidebar-workspaces" className="mt-1 ml-2 space-y-0.5">
              <p className="px-2 pt-1 text-[11px] uppercase tracking-wide text-gray-500">Workspaces</p>
              {wsError && <p className="px-2 py-1 text-xs text-red-300">{wsError}</p>}
              {!wsError && workspaces.length === 0 && <p className="px-2 py-1 text-xs text-gray-400">No workspaces yet</p>}
              {workspaces.map(ws => (
                <NavLink
                  key={ws.id}
                  to={`/workspaces/${ws.id}`}
                  onClick={() => { setWsOpen(false); handleNavClick(); }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/10 transition-colors"
                >
                  <span className="w-2 h-2 rounded-full shrink-0" aria-hidden="true" style={{ backgroundColor: ws.color }} />
                  <span className="text-xs text-gray-300 truncate">{ws.name}</span>
                </NavLink>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Quick create */}
      {!collapsed && can('appointments:write') && (
        <div className="px-3 pt-3 shrink-0">
          <NavLink
            to="/appointments/new"
            onClick={handleNavClick}
            className="flex items-center gap-2 w-full px-3 py-2 bg-primary/20 hover:bg-primary/30 text-primary rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            New Appointment
          </NavLink>
        </div>
      )}

      {/* Nav items */}
      <nav aria-label="Site navigation" className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
        {navItems.map((item, idx) => {
          const Icon = item.icon;

          return (
            <NavLink
              key={item.path}
              to={item.path}
              ref={idx === 0 ? firstNavRef : undefined}
              title={collapsed ? menuLabel(item.label) : undefined}
              aria-label={collapsed ? menuLabel(item.label) : undefined}
              onClick={handleNavClick}
              className={({ isActive: active }) => cn(
                'flex items-center gap-3 rounded-lg transition-colors relative',
                collapsed ? 'justify-center p-2.5' : 'px-3 py-2',
                active || (item.path !== '/dashboard' && location.pathname.startsWith(item.path))
                  ? 'bg-white/10 text-white'
                  : 'text-gray-400 hover:bg-white/8 hover:text-gray-200',
              )}
            >
              <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
              {!collapsed && <span className="text-sm font-medium flex-1">{menuLabel(item.label)}</span>}
              {!collapsed && item.badge ? (
                <span className="bg-primary text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center" aria-label={`${item.badge} pending`}>
                  {item.badge}
                </span>
              ) : null}
              {collapsed && item.badge ? (
                <span className="absolute top-0.5 right-0.5 w-2 h-2 bg-primary rounded-full" aria-label={`${item.badge} pending`} />
              ) : null}
            </NavLink>
          );
        })}
      </nav>

      {/* Collapse toggle (bottom) — desktop only */}
      {collapsed && (
        <div className="hidden md:block px-3 pb-4 shrink-0">
          <button
            onClick={() => onCollapse(false)}
            aria-label="Expand sidebar"
            className="w-full flex justify-center p-2 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors min-h-[44px] items-center"
          >
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* User profile at bottom */}
      {!collapsed && (
        <div className="px-3 py-4 border-t border-white/10 shrink-0">
          <button
            className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-white/10 transition-colors w-full text-left"
            onClick={() => { navigate('/my-space'); if (mobileOpen) onMobileClose(); }}
            aria-label={`Profile: ${user?.name ?? 'User'}, ${user?.role ?? ''}`}
          >
            <div className="w-7 h-7 rounded-full bg-primary/30 flex items-center justify-center text-primary text-xs font-bold shrink-0" aria-hidden="true">
              {user ? getInitials(user.name) : '?'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-white truncate">{user?.name ?? ''}</p>
              <p className="text-[11px] text-gray-400 truncate capitalize">{user?.role ?? ''}</p>
            </div>
          </button>
        </div>
      )}
    </aside>
  );
}
