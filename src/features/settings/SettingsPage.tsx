import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  Building2, Palette, Clock, CalendarDays, Ban,
  Bell, Shield, Lock, Globe,
} from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';

import {
  BusinessProfileSection,
  BrandingSection,
  WorkingHoursSection,
  BookingRulesSection,
} from './SettingsSectionsA';

import {
  CancellationSection,
  NotificationsSection,
  RolesSection,
  SecuritySection,
  LanguageSection,
} from './SettingsSectionsB';

// ─── Nav config ──────────────────────────────────────────────────────────────

interface NavItem {
  id: string;
  label: string;
  icon: React.ElementType;
  /** Sections everyone can open; the rest change business settings and need settings:write. */
  personal?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'business',      label: 'Business Profile',    icon: Building2 },
  { id: 'branding',      label: 'Branding',            icon: Palette },
  { id: 'hours',         label: 'Working Hours',        icon: Clock },
  { id: 'booking',       label: 'Booking Rules',        icon: CalendarDays },
  { id: 'cancellation',  label: 'Cancellation Policy',  icon: Ban },
  { id: 'notifications', label: 'Notifications',        icon: Bell },
  { id: 'roles',         label: 'Roles & Permissions',  icon: Shield, personal: true },
  { id: 'security',      label: 'Security',             icon: Lock, personal: true },
  { id: 'language',      label: 'Language & Region',    icon: Globe },
];

const SECTION_MAP: Record<string, React.ComponentType> = {
  business:      BusinessProfileSection,
  branding:      BrandingSection,
  hours:         WorkingHoursSection,
  booking:       BookingRulesSection,
  cancellation:  CancellationSection,
  notifications: NotificationsSection,
  roles:         RolesSection,
  security:      SecuritySection,
  language:      LanguageSection,
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  usePageTitle('Settings');
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const navItems = can('settings:write') ? NAV_ITEMS : NAV_ITEMS.filter(i => i.personal);
  const allowed = new Set(navItems.map(i => i.id));
  // Business settings open on the business profile; everyone else starts on their own account security.
  // The section comes from the address every time, so a direct link, a refresh and back/forward all show the right one.
  const active = tab && SECTION_MAP[tab] && allowed.has(tab) ? tab : (can('settings:write') ? 'business' : 'security');

  function select(id: string) {
    // A normal history entry per section, so the browser's back and forward buttons move between them.
    if (id !== active) navigate(`/settings/${id}`);
  }

  const SectionComponent = SECTION_MAP[active] ?? SecuritySection;

  return (
    <div className="page-container">
      <PageHeader
        title="Settings"
        description={can('settings:write') ? 'Manage your organization preferences and configuration' : 'Your account security and what your role can do'}
        breadcrumbs={[{ label: 'Settings' }]}
      />

      <div className="mt-6 flex flex-col md:flex-row gap-6 items-stretch md:items-start">
        {/* Sidebar nav */}
        <nav aria-label="Settings sections" className="w-full md:w-56 shrink-0 bg-surface rounded-xl border border-border p-2">
          <ul className="space-y-0.5">
            {navItems.map(item => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    onClick={() => select(item.id)}
                    aria-current={active === item.id ? 'page' : undefined}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left',
                      active === item.id
                        ? 'bg-primary-light text-primary font-semibold'
                        : 'text-text-secondary hover:bg-muted hover:text-text-primary'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content area */}
        <div className="flex-1 min-w-0">
          <SectionComponent />
        </div>
      </div>
    </div>
  );
}
