import React, { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { CalendarDays, Clock, Users, Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { canOpen } from '@/lib/permissions';
import { PRODUCT_NAME } from '@/lib/brand';
import { useLanguage } from '@/i18n/LanguageContext';
import type { MessageKey } from '@/i18n/messages';
import logoWhite from '@/assets/brand/workeasy360-logo-white.png';
import { SHELL_ZOOM_STYLE } from '@/hooks/useDesignScale';

interface NavItem {
  path: string;
  labelKey: MessageKey;
  icon: React.ElementType;
}

/** V4: exactly four main menus. Appointments is the home screen. */
const NAV_ITEMS: NavItem[] = [
  { path: '/appointments', labelKey: 'menu.appointments', icon: CalendarDays },
  { path: '/availability', labelKey: 'menu.availability', icon: Clock },
  { path: '/customers',    labelKey: 'menu.customers',    icon: Users },
  { path: '/settings',     labelKey: 'menu.settings',     icon: Settings },
];

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

/** The WorkEasy360 logo with the green "Booking" product badge under it. */
export function SidebarBrand({ onDark = true }: { onDark?: boolean }) {
  return (
    <div className="flex flex-col items-center" role="img" aria-label={PRODUCT_NAME}>
      <img src={logoWhite} alt="" aria-hidden="true" draggable={false}
        className={cn('w-[206px] h-auto select-none ml-[4px]', !onDark && 'invert')} />
      <span aria-hidden="true" className="mt-[9px] ml-[8px] inline-flex items-center justify-center w-[116px] h-[38.5px] rounded-[12px] bg-brand-active text-white text-[23px] font-semibold tracking-[-0.02em] shadow-[0_2px_8px_rgba(22,163,74,0.35)]">
        Booking
      </span>
    </div>
  );
}

export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const { user } = useAuth();
  const { t } = useLanguage();
  // Only the menus this role can use are listed; the server enforces the same rules.
  const navItems = NAV_ITEMS.filter(item => canOpen(user?.permissions, item.path));
  const firstNavRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (mobileOpen) setTimeout(() => firstNavRef.current?.focus(), 50);
  }, [mobileOpen]);

  return (
    <aside
      id="main-sidebar"
      style={SHELL_ZOOM_STYLE}
      aria-label="Main navigation"
      className={cn(
        'fixed inset-y-0 left-0 w-[260px] lg:w-[252px] bg-brand-sidebar flex flex-col z-30 overflow-hidden',
        'transition-transform duration-200 md:translate-x-0',
        mobileOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full',
      )}
    >
      {/* Soft light sweep across the lower part, as in the product artwork. */}
      <div aria-hidden="true" className="pointer-events-none absolute -left-24 bottom-[-120px] w-[420px] h-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(52,211,153,0.16),transparent)]" />
      <div aria-hidden="true" className="pointer-events-none absolute -right-40 top-1/3 w-[360px] h-[520px] rotate-12 bg-[linear-gradient(120deg,transparent_30%,rgba(255,255,255,0.04)_50%,transparent_70%)]" />

      <div className="relative flex flex-col items-center pt-[22px] px-5">
        <SidebarBrand />
        <span aria-hidden="true" className="mt-[17px] w-[92px] h-px bg-white/15" />
        <button
          onClick={onMobileClose}
          aria-label="Close navigation menu"
          className="md:hidden absolute right-0 top-4 w-11 h-11 flex items-center justify-center rounded-lg text-white/80 hover:bg-white/10"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Site navigation" className="relative flex-1 overflow-y-auto pl-[12.5px] pr-[11px] pt-[19px] pb-5 space-y-[5.5px]">
        {navItems.map((item, idx) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.path}
              to={item.path}
              ref={idx === 0 ? firstNavRef : undefined}
              onClick={() => { if (mobileOpen) onMobileClose(); }}
              className={({ isActive }) => cn(
                'flex items-center gap-[23px] pl-[20px] pr-3 h-[56px] rounded-[12px] text-[19.5px] tracking-[-0.02em] transition-colors',
                isActive
                  ? 'bg-brand-active text-white font-semibold shadow-[0_4px_14px_rgba(22,163,74,0.35)]'
                  : 'text-white/95 font-medium hover:bg-white/10',
              )}
            >
              <Icon className="w-[29px] h-[29px] shrink-0" strokeWidth={1.7} aria-hidden="true" />
              <span className="truncate">{t(item.labelKey)}</span>
            </NavLink>
          );
        })}
      </nav>

    </aside>
  );
}
