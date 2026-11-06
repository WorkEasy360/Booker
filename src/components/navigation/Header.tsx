import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Search, Bell, HelpCircle, ChevronDown, Settings, LogOut,
  User, Plus, CalendarPlus, UserPlus, Globe, X, Menu,
  CalendarDays, Users, Briefcase, BookOpen,
} from 'lucide-react';
import { cn, formatCurrency } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { customersApi, appointmentsApi, staffApi, servicesApi } from '@/api/client';
import { canOpen } from '@/lib/permissions';
import { PRODUCT_ATTRIBUTION, PRODUCT_DESCRIPTION, PRODUCT_NAME } from '@/lib/brand';
import { ProductMark } from '@/components/brand';
import { useLanguage } from '@/i18n/LanguageContext';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const ROUTE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard', '/my-space': 'My Space', '/appointments': 'Appointments',
  '/appointments/new': 'New Appointment', '/calendar': 'Calendar', '/workspaces': 'Workspaces',
  '/services': 'Services', '/staff': 'Staff', '/resources': 'Resources',
  '/customers': 'Customers', '/booking-pages': 'Booking Pages', '/notifications': 'Notifications',
  '/integrations': 'Integrations', '/reports': 'Reports', '/settings': 'Settings',
};

interface SearchResult {
  id: string;
  category: string;
  title: string;
  subtitle: string;
  href: string;
  icon: React.ReactNode;
}

interface ApiCustomer    { id: string; name: string; email: string }
interface ApiAppointment { id: string; date: string; startTime: string; bookingRef?: string; customerName?: string }
interface ApiStaff       { id: string; name: string; email?: string; title?: string }
interface ApiService     { id: string; name: string; duration: number; price: number; currency: string }

interface HeaderProps {
  sidebarCollapsed: boolean;
  onMobileMenuToggle: () => void;
  mobileMenuOpen: boolean;
}

export function Header({ sidebarCollapsed, onMobileMenuToggle, mobileMenuOpen }: HeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, can } = useAuth();
  const { t } = useLanguage();
  // Search and shortcuts only cover what this role can open.
  const searchCustomers = can('customers:read');
  const searchAppointments = canOpen(user?.permissions, '/appointments');
  const searchCatalog = canOpen(user?.permissions, '/staff');
  const quickCreate = [
    { icon: CalendarPlus, label: 'Appointment', path: '/appointments/new' },
    { icon: UserPlus,     label: 'Customer',    path: '/customers/new' },
    { icon: Globe,        label: 'Booking Page', path: '/booking-pages/new' },
  ].filter(item => canOpen(user?.permissions, item.path));

  const [profileOpen, setProfileOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);

  const [allStaff, setAllStaff]     = useState<ApiStaff[]>([]);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!searchCatalog) return;
    Promise.all([staffApi.list(), servicesApi.list()])
      .then(([staff, svcs]) => {
        setAllStaff(staff as ApiStaff[]);
        setAllServices(svcs as ApiService[]);
      })
      .catch((e: Error) => setPreloadError(e.message || 'Could not load staff and services'));
  }, [searchCatalog]);

  const profileRef = useRef<HTMLDivElement>(null);
  const quickRef   = useRef<HTMLDivElement>(null);
  const bellRef    = useRef<HTMLDivElement>(null);
  const helpRef    = useRef<HTMLDivElement>(null);
  const searchRef  = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const title = Object.entries(ROUTE_TITLES).find(([path]) =>
    location.pathname === path || (path !== '/' && location.pathname.startsWith(path))
  )?.[1] || PRODUCT_NAME;

  // Close all dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false);
      if (quickRef.current   && !quickRef.current.contains(e.target as Node))   setQuickOpen(false);
      if (bellRef.current    && !bellRef.current.contains(e.target as Node))     setBellOpen(false);
      if (helpRef.current    && !helpRef.current.contains(e.target as Node))     setHelpOpen(false);
      if (searchRef.current  && !searchRef.current.contains(e.target as Node))  { setSearchOpen(false); setSearchQuery(''); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Escape key closes search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSelectedIdx(-1); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q);
    setSelectedIdx(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) { setSearchResults([]); setSearchOpen(false); return; }

    debounceRef.current = setTimeout(async () => {
      const lower = q.toLowerCase();
      const results: SearchResult[] = [];
      try {
        const [customers, appointments] = await Promise.all([
          searchCustomers ? customersApi.list(q) as Promise<ApiCustomer[]> : Promise.resolve([] as ApiCustomer[]),
          searchAppointments ? appointmentsApi.list({ q }) as Promise<ApiAppointment[]> : Promise.resolve([] as ApiAppointment[]),
        ]);
        for (const c of customers) {
          results.push({ id: c.id, category: 'Customers', title: c.name, subtitle: c.email, href: `/customers/${c.id}`, icon: <User className="w-4 h-4 text-purple-600" /> });
        }
        for (const a of appointments.slice(0, 8)) {
          results.push({ id: a.id, category: 'Appointments', title: a.customerName ?? 'Unknown', subtitle: `${a.date} · ${a.startTime}${a.bookingRef ? ` · Ref: ${a.bookingRef}` : ''}`, href: `/appointments/${a.id}`, icon: <CalendarDays className="w-4 h-4 text-blue-600" /> });
        }
      } catch (e) {
        results.push({ id: 'search-error', category: 'Error', title: 'Search failed', subtitle: (e as Error).message, href: location.pathname, icon: <X className="w-4 h-4 text-red-600" /> });
      }
      for (const s of allStaff) {
        if (s.name.toLowerCase().includes(lower) || s.email?.toLowerCase().includes(lower)) {
          results.push({ id: s.id, category: 'Staff', title: s.name, subtitle: s.title ?? s.email ?? '', href: `/staff/${s.id}`, icon: <Users className="w-4 h-4 text-green-600" /> });
        }
      }
      for (const svc of allServices) {
        if (svc.name.toLowerCase().includes(lower)) {
          results.push({ id: svc.id, category: 'Services', title: svc.name, subtitle: `${svc.duration} min · ${formatCurrency(svc.price, svc.currency)}`, href: `/services/${svc.id}`, icon: <Briefcase className="w-4 h-4 text-amber-600" /> });
        }
      }
      if (preloadError) {
        results.push({ id: 'preload-error', category: 'Error', title: 'Staff and services not searched', subtitle: preloadError, href: location.pathname, icon: <X className="w-4 h-4 text-red-600" /> });
      }
      setSearchResults(results.slice(0, 12));
      setSearchOpen(true);
    }, 250);
  }, [allStaff, allServices, preloadError]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, searchResults.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, -1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const target = selectedIdx >= 0 ? searchResults[selectedIdx] : searchResults[0];
      if (target) { navigate(target.href); setSearchOpen(false); setSearchQuery(''); setSelectedIdx(-1); }
    }
  }

  function openResult(href: string) {
    navigate(href);
    setSearchOpen(false);
    setSearchQuery('');
    setSelectedIdx(-1);
  }

  const showSearchDropdown = searchOpen && searchQuery.trim().length > 0;

  return (
    <header className={cn(
      'fixed top-0 right-0 left-0 h-14 bg-surface border-b border-border z-20 flex items-center justify-between gap-2 px-2 sm:px-4 transition-all duration-200',
      sidebarCollapsed ? 'md:left-16' : 'md:left-60',
    )}>
      {/* Left: Hamburger (mobile) + Page title */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          className="md:hidden p-2 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-primary transition-colors w-11 h-11 flex items-center justify-center"
          onClick={onMobileMenuToggle}
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="main-sidebar"
        >
          <Menu className="w-5 h-5" aria-hidden="true" />
        </button>
        <h2 className="hidden sm:block text-sm font-semibold text-text-primary truncate">{title}</h2>
      </div>

      {/* Center: Search */}
      <div ref={searchRef} className="relative min-w-0 flex-1 sm:flex-none">
        <div className={cn(
          'flex items-center gap-2 bg-background border rounded-lg px-3 py-1.5 transition-all duration-150',
          searchQuery ? 'border-primary w-full sm:w-80' : 'border-border w-full sm:w-56 focus-within:border-primary sm:focus-within:w-72',
        )}>
          <Search className="w-3.5 h-3.5 text-text-muted shrink-0" />
          <input
            ref={searchInputRef}
            type="search"
            aria-label={searchCustomers ? 'Search appointments, customers, staff and services' : 'Search my appointments'}
            placeholder={searchCustomers ? 'Search appointments, customers…' : 'Search my appointments…'}
            className="bg-transparent text-sm text-text-primary placeholder-text-muted focus:outline-none flex-1 min-w-0"
            value={searchQuery}
            onChange={e => handleSearchChange(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            onFocus={() => { if (searchQuery.trim()) setSearchOpen(true); }}
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); setSearchResults([]); setSearchOpen(false); searchInputRef.current?.focus(); }}
              aria-label="Clear search"
              className="text-text-muted hover:text-text-primary shrink-0 w-6 h-6 flex items-center justify-center"
            >
              <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          )}
        </div>

        {showSearchDropdown && (
          <div className="absolute left-0 top-full mt-1 bg-surface rounded-xl border border-border shadow-dropdown w-[min(24rem,calc(100vw-1rem))] py-2 z-50 max-h-80 overflow-y-auto">
            {searchResults.length === 0 ? (
              <p className="px-4 py-6 text-sm text-center text-text-muted">No results for "{searchQuery}"</p>
            ) : (
              (() => {
                const categories = [...new Set(searchResults.map(r => r.category))];
                return categories.map(cat => (
                  <div key={cat}>
                    <p className="px-3 py-1.5 text-xs font-semibold text-text-muted uppercase tracking-wide">{cat}</p>
                    {searchResults.filter(r => r.category === cat).map((result) => {
                      const globalIdx = searchResults.indexOf(result);
                      return (
                        <button
                          key={result.id}
                          onClick={() => openResult(result.href)}
                          className={cn(
                            'flex items-center gap-3 w-full px-3 py-2 text-left hover:bg-muted transition-colors',
                            globalIdx === selectedIdx && 'bg-muted'
                          )}
                        >
                          <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">{result.icon}</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">{result.title}</p>
                            <p className="text-xs text-text-muted truncate">{result.subtitle}</p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ));
              })()
            )}
          </div>
        )}
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 shrink-0">
        {/* Quick create */}
        {quickCreate.length > 0 && <div ref={quickRef} className="relative">
          <button
            onClick={() => setQuickOpen(!quickOpen)}
            aria-label="Create new"
            aria-expanded={quickOpen}
            aria-haspopup="true"
            className="flex items-center gap-1.5 px-3 min-h-[44px] bg-primary text-white text-xs font-medium rounded-lg hover:bg-primary-dark transition-colors"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /><span className="hidden sm:inline">New</span><ChevronDown className="hidden sm:block w-3 h-3" aria-hidden="true" />
          </button>
          {quickOpen && (
            <div className="absolute right-0 top-full mt-1 bg-surface rounded-xl border border-border shadow-dropdown w-48 py-1.5 z-50">
              {quickCreate.map(item => (
                <button key={item.label} onClick={() => { setQuickOpen(false); navigate(item.path); }}
                  className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-text-secondary hover:bg-gray-50 hover:text-text-primary transition-colors">
                  <item.icon className="w-4 h-4 text-text-muted" />{item.label}
                </button>
              ))}
            </div>
          )}
        </div>}

        {/* Bell */}
        <div ref={bellRef} className="relative">
          <button
            onClick={() => { setBellOpen(!bellOpen); setHelpOpen(false); }}
            aria-label="Notifications"
            aria-expanded={bellOpen}
            aria-haspopup="true"
            className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-primary transition-colors"
          >
            <Bell className="w-4 h-4" aria-hidden="true" />
          </button>
          {bellOpen && (
            <div className="absolute right-0 top-full mt-1 bg-surface rounded-xl border border-border shadow-dropdown w-72 z-50">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-sm font-semibold text-text-primary">Notifications</p>
              </div>
              <div className="py-8 text-center px-4">
                <Bell className="w-8 h-8 text-text-muted mx-auto mb-2" />
                <p className="text-sm font-medium text-text-primary">You're all caught up</p>
                <p className="text-xs text-text-muted mt-1">No new notifications right now.</p>
              </div>
            </div>
          )}
        </div>

        {/* Help */}
        <div ref={helpRef} className="relative hidden sm:block">
          <button
            onClick={() => { setHelpOpen(!helpOpen); setBellOpen(false); }}
            aria-label="Help and support"
            aria-expanded={helpOpen}
            aria-haspopup="true"
            className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-primary transition-colors"
          >
            <HelpCircle className="w-4 h-4" aria-hidden="true" />
          </button>
          {helpOpen && (
            <div className="absolute right-0 top-full mt-1 bg-surface rounded-xl border border-border shadow-dropdown w-64 py-2 z-50">
              <div className="px-3 py-2 border-b border-border mb-1">
                <p className="text-sm font-semibold text-text-primary">Help & Support</p>
              </div>
              {[
                { icon: BookOpen, label: 'Documentation', desc: `Learn how to use ${PRODUCT_NAME}`, action: () => {} },
                { icon: CalendarDays, label: 'Getting Started', desc: 'Quickstart guide', action: () => navigate('/settings') },
                { icon: Settings, label: 'Settings', desc: 'Configure your account', action: () => { setHelpOpen(false); navigate('/settings'); } },
              ].map(item => (
                <button key={item.label} onClick={() => { setHelpOpen(false); item.action(); }}
                  className="flex items-start gap-3 w-full px-3.5 py-2 hover:bg-gray-50 transition-colors text-left">
                  <item.icon className="w-4 h-4 text-text-muted mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{item.label}</p>
                    <p className="text-xs text-text-muted">{item.desc}</p>
                  </div>
                </button>
              ))}
              {/* About the product */}
              <div data-brand="about" className="mt-1 pt-3 pb-1 px-3.5 border-t border-border flex items-start gap-2.5">
                <ProductMark size={28} />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text-primary">{PRODUCT_NAME}</p>
                  <p className="text-xs text-text-secondary">{PRODUCT_DESCRIPTION}</p>
                  <p className="text-xs text-text-secondary mt-0.5">{PRODUCT_ATTRIBUTION}</p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Profile */}
        <div ref={profileRef} className="relative ml-1">
          <button
            onClick={() => setProfileOpen(!profileOpen)}
            aria-label={`Account menu for ${user?.name ?? 'User'}`}
            aria-expanded={profileOpen}
            aria-haspopup="true"
            className="flex items-center gap-2 pl-2 pr-1.5 py-1.5 rounded-lg hover:bg-gray-100 transition-colors min-h-[44px]"
          >
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-primary text-xs font-bold">
              {user ? getInitials(user.name) : '?'}
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-xs font-medium text-text-primary leading-tight">{user?.name ?? ''}</p>
              <p className="text-[11px] text-text-muted leading-tight capitalize">{user?.role ?? ''}</p>
            </div>
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          </button>
          {profileOpen && (
            <div className="absolute right-0 top-full mt-1 bg-surface rounded-xl border border-border shadow-dropdown w-48 py-1.5 z-50">
              {[
                { icon: User, label: 'My Profile', path: '/my-space' },
                { icon: Settings, label: 'Settings', path: '/settings' },
              ].map(item => (
                <button key={item.label} onClick={() => { setProfileOpen(false); navigate(item.path); }}
                  className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-text-secondary hover:bg-gray-50 hover:text-text-primary transition-colors">
                  <item.icon className="w-4 h-4 text-text-muted" />{item.label}
                </button>
              ))}
              <div className="border-t border-border mt-1 pt-1">
                <button onClick={() => { setProfileOpen(false); logout(); navigate('/login'); }}
                  className="flex items-center gap-2.5 w-full px-3.5 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors">
                  <LogOut className="w-4 h-4" />{t('menu.signOut')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
