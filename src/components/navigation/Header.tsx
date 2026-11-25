import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Bell, HelpCircle, ChevronDown, LogOut, Building2, Check, Menu, X,
  UserRound, CreditCard, Wallet, LifeBuoy, CalendarDays, User, Ticket, MessageSquarePlus, Bot,
} from 'lucide-react';
import { cn, formatTime, todayInTimeZone } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useAI } from '@/contexts/AIContext';
import { customersApi, appointmentsApi, ACCOUNT_PORTAL_URL } from '@/api/client';
import { canOpen, roleLabel } from '@/lib/permissions';
import { useBusiness, forgetBusiness } from '@/hooks/useBusiness';
import { useLanguage } from '@/i18n/LanguageContext';
import { SHELL_ZOOM_STYLE } from '@/hooks/useDesignScale';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? '?';
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

interface SearchResult { id: string; category: 'Appointments' | 'Customers' | 'Error'; title: string; subtitle: string; href: string }
interface ApiCustomer { id: string; name: string; email: string | null; phone: string | null }
interface ApiAppointment { id: string; date: string; startTime: string; status: string; customerName?: string; customerPhone?: string | null; serviceName?: string }

/** Shared WorkEasy360 account services, opened in the current organization with Booking as the product context. */
function portalLink(path: string, orgId?: string): string {
  const params = new URLSearchParams({ product: 'booking' });
  if (orgId) params.set('org', orgId);
  return `${ACCOUNT_PORTAL_URL}${path}?${params.toString()}`;
}

/** Closes a popover when clicking outside it. */
function useOutside(ref: React.RefObject<HTMLElement>, onOutside: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onOutside]);
}

const ICON_BUTTON = 'relative w-11 h-11 flex items-center justify-center rounded-xl text-[#1E293B] hover:bg-gray-100 transition-colors';
const MENU_ITEM = 'flex items-center gap-3 w-full px-4 py-2.5 text-[15px] text-text-primary hover:bg-gray-50 transition-colors text-left';

interface HeaderProps {
  onMobileMenuToggle: () => void;
  mobileMenuOpen: boolean;
}

export function Header({ onMobileMenuToggle, mobileMenuOpen }: HeaderProps) {
  const navigate = useNavigate();
  const { user, logout, can } = useAuth();
  const ai = useAI();
  const { t } = useLanguage();
  const { business } = useBusiness();
  const canSearchCustomers = can('customers:read');
  const canSeeAppointments = canOpen(user?.permissions, '/appointments');

  const [open, setOpen] = useState<null | 'org' | 'search' | 'bell' | 'help' | 'profile'>(null);
  const close = useCallback(() => setOpen(null), []);
  const toggle = (menu: NonNullable<typeof open>) => setOpen(o => (o === menu ? null : menu));

  const orgRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  useOutside(orgRef, useCallback(() => setOpen(o => (o === 'org' ? null : o)), []));
  useOutside(searchRef, useCallback(() => setOpen(o => (o === 'search' ? null : o)), []));
  useOutside(bellRef, useCallback(() => setOpen(o => (o === 'bell' ? null : o)), []));
  useOutside(helpRef, useCallback(() => setOpen(o => (o === 'help' ? null : o)), []));
  useOutside(profileRef, useCallback(() => setOpen(o => (o === 'profile' ? null : o)), []));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // ── Search: customers by name, phone or email; appointments by customer name or phone ──
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { if (open === 'search') setTimeout(() => searchInput.current?.focus(), 30); }, [open]);

  function runSearch(q: string) {
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) { setResults([]); return; }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      const found: SearchResult[] = [];
      try {
        const [customers, appointments] = await Promise.all([
          canSearchCustomers ? customersApi.list(q) as Promise<ApiCustomer[]> : Promise.resolve([] as ApiCustomer[]),
          canSeeAppointments ? appointmentsApi.list({ q }) as Promise<ApiAppointment[]> : Promise.resolve([] as ApiAppointment[]),
        ]);
        for (const c of customers.slice(0, 5)) {
          found.push({ id: c.id, category: 'Customers', title: c.name, subtitle: [c.phone, c.email].filter(Boolean).join(' · '), href: `/customers/${c.id}` });
        }
        for (const a of appointments.slice(0, 6)) {
          found.push({ id: a.id, category: 'Appointments', title: a.customerName ?? 'Appointment', subtitle: `${a.date} · ${formatTime(a.startTime)}${a.serviceName ? ` · ${a.serviceName}` : ''}`, href: `/appointments/${a.id}` });
        }
      } catch (e) {
        found.push({ id: 'error', category: 'Error', title: 'Search failed', subtitle: (e as Error).message, href: '' });
      }
      setResults(found);
      setSearching(false);
    }, 250);
  }

  function openResult(r: SearchResult) {
    if (!r.href) return;
    navigate(r.href);
    setQuery(''); setResults([]); close();
  }

  // ── Notifications: today's appointments. The red dot shows until they have been looked at (per person, per day). ──
  const [todayList, setTodayList] = useState<ApiAppointment[]>([]);
  const businessToday = todayInTimeZone(business?.timezone);
  useEffect(() => {
    if (!canSeeAppointments || !business) return;
    (appointmentsApi.list({ date: businessToday }) as Promise<ApiAppointment[]>)
      .then(list => setTodayList(list.filter(a => a.date === businessToday && (a.status === 'scheduled' || a.status === 'confirmed'))
        .sort((a, b) => a.startTime.localeCompare(b.startTime))))
      .catch(() => setTodayList([]));
  }, [canSeeAppointments, business, businessToday]);
  const seenKey = `we360:notifications-seen:${user?.id ?? ''}`;
  const signature = `${businessToday}:${todayList.map(a => a.id).join(',')}`;
  const [seen, setSeen] = useState<string | null>(() => { try { return localStorage.getItem(seenKey); } catch { return null; } });
  const unread = todayList.length > 0 && seen !== signature;
  useEffect(() => {
    if (open !== 'bell' || !todayList.length) return;
    setSeen(signature);
    try { localStorage.setItem(seenKey, signature); } catch { /* storage unavailable: the dot just returns next time */ }
  }, [open, signature, seenKey, todayList.length]);
  const nowLocal = (() => {
    try { return new Date().toLocaleTimeString('sv-SE', { timeZone: business?.timezone, hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; }
  })();

  function signOut() {
    close();
    forgetBusiness();
    logout();
    navigate('/login');
  }

  const orgName = business?.name ?? '';
  const help = (path: string) => window.open(portalLink(path, business?.id), '_blank', 'noopener');

  return (
    <header style={SHELL_ZOOM_STYLE} className="fixed top-0 right-0 left-0 md:left-[252px] h-16 md:h-[78px] bg-surface border-b border-border z-20 flex items-center justify-between gap-2 px-2 sm:px-5 lg:pl-7 lg:pr-[25px]">
      {/* Left: menu button (phones) and the organization */}
      <div className="flex items-center gap-2 min-w-0">
        <button
          className="md:hidden w-11 h-11 flex items-center justify-center rounded-xl hover:bg-gray-100 text-text-primary"
          onClick={onMobileMenuToggle}
          aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileMenuOpen}
          aria-controls="main-sidebar"
        >
          <Menu className="w-6 h-6" aria-hidden="true" />
        </button>

        <div ref={orgRef} className="relative min-w-0">
          <button
            onClick={() => toggle('org')}
            aria-haspopup="true"
            aria-expanded={open === 'org'}
            aria-label={`Organization: ${orgName}`}
            className="flex items-center gap-3 md:gap-[12px] h-11 md:h-[45px] pl-3 pr-3 md:pl-[19px] md:pr-[13px] rounded-xl md:rounded-[10px] border border-[#DDE3EA] bg-white hover:border-gray-300 transition-colors w-full md:w-[339px] min-w-0 shadow-[0_1px_2px_rgba(16,24,40,0.04)]"
          >
            <Building2 className="w-6 h-6 md:w-[23px] md:h-[23px] text-[#334155] shrink-0" strokeWidth={1.7} aria-hidden="true" />
            <span className="flex-1 min-w-0 text-left text-[15px] md:text-[16.5px] font-semibold text-[#0F172A] tracking-[-0.015em] truncate">{orgName || ' '}</span>
            <ChevronDown className="w-5 h-5 text-[#0F172A] shrink-0" strokeWidth={2.2} aria-hidden="true" />
          </button>
          {open === 'org' && (
            <div className="absolute left-0 top-full mt-2 w-[min(340px,calc(100vw-1rem))] bg-surface rounded-xl border border-border shadow-dropdown py-2 z-50">
              <p className="px-4 pt-1 pb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">Organization</p>
              <div className="flex items-center gap-3 px-4 py-2.5 bg-primary-light/60">
                <Building2 className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0 text-[15px] font-semibold text-text-primary truncate">{orgName}</span>
                <Check className="w-4 h-4 text-primary" aria-label="Current organization" />
              </div>
              <p className="px-4 pt-2 text-xs text-text-muted">Records and balances stay separate for each organization. Other organizations you belong to are opened from your WorkEasy360 account.</p>
            </div>
          )}
        </div>
      </div>

      {/* Right: search, notifications, help, account */}
      <div className="flex items-center gap-0.5 sm:gap-1.5 lg:gap-[22px] shrink-0">
        {(canSearchCustomers || canSeeAppointments) && (
          <div ref={searchRef} className="relative">
            <button onClick={() => toggle('search')} aria-label="Search customers and appointments" aria-expanded={open === 'search'} className={ICON_BUTTON}>
              <Search className="w-6 h-6 lg:w-[27px] lg:h-[27px]" strokeWidth={1.9} aria-hidden="true" />
            </button>
            {open === 'search' && (
              <div className="fixed sm:absolute left-2 right-2 sm:left-auto sm:right-0 top-16 sm:top-full mt-2 sm:w-[420px] bg-surface rounded-xl border border-border shadow-dropdown z-50">
                <div className="flex items-center gap-2 px-3 border-b border-border">
                  <Search className="w-4 h-4 text-text-muted shrink-0" aria-hidden="true" />
                  <input
                    ref={searchInput}
                    type="search"
                    value={query}
                    onChange={e => runSearch(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && results[0]) openResult(results[0]); }}
                    placeholder="Search by customer name or phone…"
                    aria-label="Search by customer name or phone"
                    className="flex-1 min-w-0 h-12 bg-transparent text-[15px] focus:outline-none"
                  />
                  {query && (
                    <button onClick={() => runSearch('')} aria-label="Clear search" className="w-8 h-8 flex items-center justify-center text-text-muted hover:text-text-primary">
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="max-h-80 overflow-y-auto py-1.5">
                  {!query.trim() && <p className="px-4 py-5 text-sm text-text-muted text-center">Type a customer name or phone number.</p>}
                  {query.trim() && searching && <p className="px-4 py-5 text-sm text-text-muted text-center">Searching…</p>}
                  {query.trim() && !searching && results.length === 0 && <p className="px-4 py-5 text-sm text-text-muted text-center">No results for “{query}”.</p>}
                  {(['Customers', 'Appointments', 'Error'] as const).map(cat => {
                    const rows = results.filter(r => r.category === cat);
                    if (!rows.length) return null;
                    return (
                      <div key={cat}>
                        <p className="px-4 pt-2 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{cat}</p>
                        {rows.map(r => (
                          <button key={`${cat}-${r.id}`} onClick={() => openResult(r)} className="flex items-center gap-3 w-full px-4 py-2 hover:bg-gray-50 text-left">
                            <span className="w-8 h-8 rounded-lg bg-primary-light text-primary flex items-center justify-center shrink-0">
                              {cat === 'Customers' ? <User className="w-4 h-4" aria-hidden="true" /> : <CalendarDays className="w-4 h-4" aria-hidden="true" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-text-primary truncate">{r.title}</span>
                              <span className="block text-xs text-text-muted truncate">{r.subtitle}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <div ref={bellRef} className="relative">
          <button onClick={() => toggle('bell')} aria-label={unread ? `Notifications: ${todayList.length} appointments today, not yet seen` : 'Notifications'} aria-expanded={open === 'bell'} className={ICON_BUTTON}>
            <Bell className="w-6 h-6 lg:w-[27px] lg:h-[27px]" strokeWidth={1.9} aria-hidden="true" />
            {unread && <span className="absolute top-[7px] right-[9px] w-[10px] h-[10px] rounded-full bg-[#EF2D2D] ring-2 ring-white" aria-hidden="true" />}
          </button>
          {open === 'bell' && (
            <div className="absolute right-0 top-full mt-2 w-[min(340px,calc(100vw-1rem))] bg-surface rounded-xl border border-border shadow-dropdown z-50">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-[15px] font-semibold text-text-primary">Notifications</p>
              </div>
              {todayList.length === 0 ? (
                <div className="py-8 text-center px-4">
                  <Bell className="w-8 h-8 text-text-muted mx-auto mb-2" aria-hidden="true" />
                  <p className="text-sm font-medium text-text-primary">You're all caught up</p>
                  <p className="text-xs text-text-muted mt-1">No appointments today.</p>
                </div>
              ) : (
                <div className="py-1.5 max-h-80 overflow-y-auto">
                  <p className="px-4 pt-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">Today's appointments ({todayList.length})</p>
                  {todayList.map(a => (
                    <button key={a.id} onClick={() => { close(); navigate(`/appointments/${a.id}`); }} className={cn('flex items-center gap-3 w-full px-4 py-2 hover:bg-gray-50 text-left', nowLocal && a.startTime < nowLocal && 'opacity-60')}>
                      <span className="text-sm font-semibold text-primary w-[68px] shrink-0">{formatTime(a.startTime)}</span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text-primary truncate">{a.customerName}</span>
                        <span className="block text-xs text-text-muted truncate">{a.serviceName}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div ref={helpRef} className="relative hidden sm:block">
          <button onClick={() => toggle('help')} aria-label="Help" aria-expanded={open === 'help'} className={ICON_BUTTON}>
            <HelpCircle className="w-6 h-6 lg:w-[28px] lg:h-[28px]" strokeWidth={1.9} aria-hidden="true" />
          </button>
          {open === 'help' && (
            <div className="absolute right-0 top-full mt-2 w-72 bg-surface rounded-xl border border-border shadow-dropdown py-2 z-50">
              <p className="px-4 pt-1 pb-2 text-[15px] font-semibold text-text-primary">Help</p>
              <button className={MENU_ITEM} onClick={() => { close(); help('/support'); }}><LifeBuoy className="w-5 h-5 text-text-secondary" aria-hidden="true" />Unified Helpdesk</button>
              <button className={MENU_ITEM} onClick={() => { close(); help('/support/tickets/new'); }}><MessageSquarePlus className="w-5 h-5 text-text-secondary" aria-hidden="true" />Create Ticket</button>
              <button className={MENU_ITEM} onClick={() => { close(); help('/support/tickets'); }}><Ticket className="w-5 h-5 text-text-secondary" aria-hidden="true" />My Tickets</button>
              {can('ai:use') && (
                <button className={MENU_ITEM} onClick={() => { close(); ai.openPanel(); }}><Bot className="w-5 h-5 text-text-secondary" aria-hidden="true" />Ask the AI Assistant</button>
              )}
              <p className="px-4 pt-2 text-xs text-text-muted">Opens WorkEasy360 support with Booking and your organization filled in.</p>
            </div>
          )}
        </div>

        <span className="hidden sm:block w-px h-9 lg:h-[43px] bg-[#E2E8F0] mx-2 lg:-ml-[1px] lg:mr-[2px]" aria-hidden="true" />

        <div ref={profileRef} className="relative">
          <button
            onClick={() => toggle('profile')}
            aria-label={`Account menu for ${user?.name ?? 'User'}`}
            aria-expanded={open === 'profile'}
            aria-haspopup="true"
            className="flex items-center gap-3 lg:gap-[12.5px] pl-1 pr-1 sm:pr-2 lg:p-0 py-1 rounded-xl hover:bg-gray-50 transition-colors min-h-[44px]"
          >
            {user?.photoUrl ? (
              <img src={user.photoUrl} alt="" className="w-10 h-10 md:w-[50px] md:h-[50px] rounded-full object-cover shrink-0 ring-1 ring-black/5" />
            ) : (
              <span className="w-10 h-10 md:w-[50px] md:h-[50px] rounded-full bg-gradient-to-br from-[#1FAE50] to-[#0E6B3A] text-white flex items-center justify-center text-sm md:text-base font-bold shrink-0" aria-hidden="true">
                {user ? getInitials(user.name) : '?'}
              </span>
            )}
            <span className="hidden sm:block text-left">
              <span className="block text-[16px] lg:text-[17px] font-semibold text-[#0F172A] leading-tight tracking-[-0.01em]">{user?.name ?? ''}</span>
              <span className="block text-sm lg:text-[15.5px] text-[#475569] leading-tight mt-0.5 lg:mt-[3px]">{roleLabel(user?.role)}</span>
            </span>
            <ChevronDown className="hidden sm:block w-5 h-5 text-[#0F172A] ml-1 lg:ml-[-4px]" strokeWidth={2.2} aria-hidden="true" />
          </button>
          {open === 'profile' && (
            <div className="absolute right-0 top-full mt-2 w-60 bg-surface rounded-xl border border-border shadow-dropdown py-2 z-50">
              <div className="px-4 pt-1 pb-2.5 border-b border-border mb-1.5 sm:hidden">
                <p className="text-sm font-semibold text-text-primary truncate">{user?.name}</p>
                <p className="text-xs text-text-muted">{roleLabel(user?.role)}</p>
              </div>
              <button className={MENU_ITEM} onClick={() => { close(); navigate('/account'); }}><UserRound className="w-5 h-5 text-text-secondary" aria-hidden="true" />My Account</button>
              <button className={MENU_ITEM} onClick={() => { close(); window.open(portalLink('/billing', business?.id), '_blank', 'noopener'); }}><CreditCard className="w-5 h-5 text-text-secondary" aria-hidden="true" />Plan &amp; Billing</button>
              <button className={MENU_ITEM} onClick={() => { close(); window.open(portalLink('/wallets', business?.id), '_blank', 'noopener'); }}><Wallet className="w-5 h-5 text-text-secondary" aria-hidden="true" />Wallets &amp; Usage</button>
              <button className={MENU_ITEM} onClick={() => { close(); help('/support'); }}><LifeBuoy className="w-5 h-5 text-text-secondary" aria-hidden="true" />Help</button>
              <div className="border-t border-border mt-1.5 pt-1.5">
                <button className={cn(MENU_ITEM, 'text-red-600 hover:bg-red-50')} onClick={signOut}><LogOut className="w-5 h-5" aria-hidden="true" />{t('menu.signOut')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
