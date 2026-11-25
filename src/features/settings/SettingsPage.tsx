import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Settings, Building2, Briefcase, Bell, Globe, Users, Workflow, Plug, UserRound } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { PageTitle } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import type { Permission } from '@/lib/permissions';
import { BusinessSection } from './BusinessSection';
import { ServicesSection } from './ServicesSection';
import { NotificationsSection } from './NotificationsSection';
import { PublicBookingSection } from './PublicBookingSection';
import { TeamSection } from './TeamSection';
import { AutomationSection } from './AutomationSection';
import { IntegrationsSection } from './IntegrationsSection';

type TabId = 'business' | 'services' | 'notifications' | 'public-booking' | 'team' | 'automation' | 'integrations';

interface Tab {
  id: TabId;
  label: string;
  icon: React.ElementType;
  /** Any one of these opens the section; the server checks every change again. */
  needs: Permission[];
}

// V4 Settings: one place for each setting.
const TABS: Tab[] = [
  { id: 'business',       label: 'Business Details', icon: Building2, needs: ['settings:write'] },
  { id: 'services',       label: 'Services',         icon: Briefcase, needs: ['services:write', 'settings:write'] },
  { id: 'notifications',  label: 'Notifications',    icon: Bell,      needs: ['settings:write'] },
  { id: 'public-booking', label: 'Public Booking',   icon: Globe,     needs: ['booking_pages:write', 'settings:write'] },
  { id: 'team',           label: 'Team',             icon: Users,     needs: ['staff:manage'] },
  { id: 'automation',     label: 'Internal Automation', icon: Workflow, needs: ['settings:write'] },
  { id: 'integrations',   label: 'Integrations',     icon: Plug,      needs: ['settings:write'] },
];

export default function SettingsPage() {
  usePageTitle('Settings');
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const tabs = TABS.filter(t => t.needs.some(p => can(p)));
  // The section comes from the address every time, so a direct link, a refresh and back/forward all show the right one.
  const active = tabs.find(t => t.id === tab) ?? tabs[0];

  return (
    <div className="page-container">
      <PageTitle icon={Settings} title="Settings" description="Business details, services, notifications and team — all in one place." />

      {!active ? (
        <div className="panel p-6 mt-6 max-w-xl">
          <p className="text-base font-semibold text-text-primary">Business settings are managed by your owner</p>
          <p className="text-sm text-text-secondary mt-1">Your password, two-factor sign-in and language are in My Account.</p>
          <Link to="/account" className="btn-primary mt-4"><UserRound className="w-4 h-4" aria-hidden="true" />Open My Account</Link>
        </div>
      ) : (
        <div className="mt-6 flex flex-col lg:flex-row gap-6 items-stretch lg:items-start">
          <nav aria-label="Settings sections" className="lg:w-60 shrink-0 panel p-2 lg:sticky lg:top-24">
            <ul className="flex lg:flex-col gap-1 overflow-x-auto lg:overflow-visible -mx-0.5 px-0.5">
              {tabs.map(t => {
                const Icon = t.icon;
                const on = t.id === active.id;
                return (
                  <li key={t.id} className="shrink-0">
                    <button
                      type="button"
                      onClick={() => { if (!on) navigate(`/settings/${t.id}`); }}
                      aria-current={on ? 'page' : undefined}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left whitespace-nowrap min-h-[44px]',
                        on ? 'bg-primary-light text-primary font-semibold' : 'text-text-secondary hover:bg-muted hover:text-text-primary',
                      )}
                    >
                      <Icon className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
                      {t.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex-1 min-w-0">
            {active.id === 'business' && <BusinessSection />}
            {active.id === 'services' && <ServicesSection canEdit={can('services:write')} />}
            {active.id === 'notifications' && <NotificationsSection canEdit={can('settings:write')} />}
            {active.id === 'public-booking' && <PublicBookingSection canEdit={can('settings:write') || can('booking_pages:write')} canEditCutoff={can('settings:write')} />}
            {active.id === 'team' && <TeamSection />}
            {active.id === 'automation' && <AutomationSection />}
            {active.id === 'integrations' && <IntegrationsSection />}
          </div>
        </div>
      )}
    </div>
  );
}
