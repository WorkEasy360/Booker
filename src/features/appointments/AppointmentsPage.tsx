import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  CalendarDays, CalendarCheck2, CircleCheck, CircleX, Users, List, Plus, Link2, Copy, Check,
  ExternalLink, Clock, Settings, ChevronRight, ArrowUp, ArrowDown,
} from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useToast } from '@/components/ui';
import { appointmentsApi, staffApi, customersApi, bookingLinkApi, type DefaultBookingPage } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { useBusiness } from '@/hooks/useBusiness';
import { cn, todayInTimeZone } from '@/lib/utils';
import { bookingUrl } from '@/lib/bookingUrl';
import { SHELL_ZOOM_STYLE } from '@/hooks/useDesignScale';
import { AppointmentList } from './AppointmentList';
import { AppointmentCalendar } from './AppointmentCalendar';
import {
  type ListAppointment, type ListStaff, type ListTab, type ListFilters, type ListStatus,
  forTab, matchesFilters, statusOf, addDays, weekStart,
} from './listModel';

/** True on screens narrower than the md breakpoint (phones): Calendar offers Day only there. */
function useIsPhone(): boolean {
  const query = '(max-width: 767px)';
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
}

interface StatProps { icon: React.ElementType; tile: string; iconColor: string; label: React.ReactNode; value: number | string; change?: number | null }

function StatCard({ icon: Icon, tile, iconColor, label, value, change }: StatProps) {
  return (
    <div className="panel xl:rounded-[16px] flex items-center gap-3 sm:gap-4 xl:gap-[17.5px] px-3.5 py-4 sm:px-4 sm:py-5 xl:pl-[15.5px] xl:pr-1 xl:py-0 xl:h-[121px] min-w-0 overflow-hidden">
      <span className={cn('icon-tile w-12 h-12 sm:w-16 sm:h-16 xl:w-[66px] xl:h-[67px] xl:rounded-[14px]', tile)}>
        <Icon className={cn('w-7 h-7 sm:w-9 sm:h-9 xl:w-[35px] xl:h-[35px]', iconColor)} strokeWidth={1.7} aria-hidden="true" />
      </span>
      <div className={cn('min-w-0', change !== undefined && change !== null ? 'xl:relative xl:top-[5.3px]' : 'xl:relative xl:-top-[2px]')}>
        <p className="text-[14px] sm:text-[15px] xl:text-[15px] text-text-primary xl:text-[#111827] xl:font-medium xl:tracking-[-0.01em] leading-snug xl:leading-[19px] break-words">{label}</p>
        <p className="text-[26px] sm:text-[30px] xl:text-[32px] font-bold text-text-primary leading-tight xl:leading-[38px] mt-0.5 xl:mt-[5px]">{value}</p>
        {change !== undefined && change !== null && (
          <p className={cn('text-[14px] sm:text-[15px] xl:text-[16px] font-semibold flex items-center gap-1 xl:gap-[6px] xl:mt-[2px]', change >= 0 ? 'text-primary' : 'text-red-600')}>
            {change >= 0 ? <ArrowUp className="w-4 h-4" strokeWidth={2.6} aria-hidden="true" /> : <ArrowDown className="w-4 h-4" strokeWidth={2.6} aria-hidden="true" />}
            {change >= 0 ? '+' : ''}{change}%
            <span className="sr-only"> compared with the same day last week</span>
          </p>
        )}
      </div>
    </div>
  );
}

function BookingLinkCard() {
  const toast = useToast();
  const { can } = useAuth();
  const [page, setPage] = useState<DefaultBookingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    bookingLinkApi.get().then(setPage).catch((e: Error) => setError(e.message || 'Could not load the booking link'));
  }, []);

  const url = page ? bookingUrl(page.slug) : '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Booking link copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy', 'Select the link and copy it manually.');
    }
  }

  return (
    <section className="panel xl:rounded-[16px] p-5 sm:p-6 xl:pt-[28.5px] xl:pl-[16.5px] xl:pr-[17px] xl:pb-[25.5px]" aria-labelledby="booking-link-title">
      <div className="flex items-start gap-3.5 xl:gap-[12px]">
        <span className="icon-tile w-12 h-12 xl:w-[47px] xl:h-[46.5px] xl:rounded-[10px] bg-[#E3F6EA]">
          <Link2 className="w-6 h-6 xl:w-[27px] xl:h-[27px] text-[#16A34A]" strokeWidth={2.3} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h2 id="booking-link-title" className="text-[22px] sm:text-[24px] xl:text-[25px] font-bold text-text-primary xl:text-[#0F172A] leading-tight xl:leading-[25px] xl:tracking-[-0.02em] xl:-mt-[1px]">Booking Link</h2>
          <p className="text-[15px] xl:text-[16px] xl:leading-[20px] text-text-secondary xl:text-[#334155] mt-0.5 xl:mt-[2px] xl:tracking-[-0.01em]">Share your booking page with customers.</p>
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-red-600" role="alert">{error}</p>}
      {!error && (
        <>
          <div className="mt-5 xl:mt-[22.5px] flex items-stretch rounded-xl xl:rounded-[8px] border border-border xl:border-[#DDE3EA] overflow-hidden">
            <input
              readOnly
              value={url}
              aria-label="Booking link"
              onFocus={e => e.currentTarget.select()}
              className="flex-1 min-w-0 px-3.5 h-12 xl:h-[43px] text-[15px] xl:text-[16px] text-text-primary xl:text-[#0F172A] bg-white focus:outline-none"
            />
            <button onClick={copy} disabled={!page} aria-label="Copy booking link"
              className="w-12 xl:w-[46.5px] border-l border-border xl:border-[#DDE3EA] flex items-center justify-center text-text-primary xl:text-[#1E293B] hover:bg-gray-50 disabled:opacity-40">
              {copied ? <Check className="w-5 h-5 text-primary" aria-hidden="true" /> : <Copy className="w-5 h-5 xl:w-[21px] xl:h-[21px]" strokeWidth={2} aria-hidden="true" />}
            </button>
          </div>
          {page && !page.isPublished && (
            <p className="mt-3 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
              Online booking is off.{' '}
              {can('settings:write') && <Link to="/settings/public-booking" className="font-semibold underline">Turn it on</Link>}
            </p>
          )}
          <a
            href={url || undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!page}
            className="mt-4 xl:mt-[15.5px] xl:pl-[4px] flex items-center justify-center gap-2.5 xl:gap-[13px] h-12 xl:h-[45px] rounded-xl xl:rounded-[8px] bg-[#D9F5E3] xl:bg-[#D2F4DC] text-[#15803D] text-[16px] xl:text-[16.5px] font-semibold xl:font-bold xl:tracking-[-0.01em] hover:bg-[#C7F0D3] transition-colors"
          >
            <ExternalLink className="w-5 h-5 xl:w-[21px] xl:h-[21px]" strokeWidth={2.2} aria-hidden="true" />Preview Booking Page
          </a>
        </>
      )}
    </section>
  );
}

function QuickActions() {
  const { user, can } = useAuth();
  const actions = [
    { icon: CalendarDays, label: 'Create New Appointment', to: '/appointments/new', show: can('appointments:write') },
    { icon: Clock, label: 'Manage Availability', to: '/availability', show: true },
    { icon: Users, label: 'View Customers', to: '/customers', show: can('customers:read') },
    { icon: Settings, label: 'Booking Settings', to: '/settings/public-booking', show: can('settings:write') },
  ].filter(a => a.show && !!user);
  if (!actions.length) return null;
  return (
    <section className="panel xl:rounded-[16px] p-5 sm:p-6 xl:pt-[15px] xl:pl-[17.5px] xl:pr-[17px] xl:pb-[28px]" aria-labelledby="quick-actions-title">
      <h2 id="quick-actions-title" className="text-[22px] sm:text-[24px] xl:text-[25px] font-bold text-text-primary xl:text-[#0F172A] leading-tight xl:leading-[30px] xl:tracking-[-0.015em] xl:pl-[5px] pb-3 xl:pb-[17px] border-b border-border xl:border-[#E8ECF1]">Quick Actions</h2>
      <ul>
        {actions.map(a => (
          <li key={a.to} className="border-b border-border xl:border-[#E8ECF1] last:border-0 xl:first:pt-[2px]">
            <Link to={a.to} className="flex items-center gap-4 xl:gap-[21.5px] py-3.5 xl:py-0 xl:h-[53px] xl:pl-[11px] xl:pr-[3.5px] text-[16px] sm:text-[17px] xl:text-[18px] text-text-primary xl:text-[#111827] xl:font-medium xl:tracking-[-0.01em] hover:text-primary group">
              <span className="icon-tile w-9 h-9 xl:w-[41px] xl:h-[38.5px] rounded-lg xl:rounded-[8px] bg-[#EBF8EF]">
                <a.icon className="w-6 h-6 text-[#16A34A] shrink-0" strokeWidth={1.9} aria-hidden="true" />
              </span>
              <span className="flex-1">{a.label}</span>
              <ChevronRight className="w-5 h-5 xl:w-[22px] xl:h-[22px] text-text-primary xl:text-[#0F172A] group-hover:text-primary" strokeWidth={2.2} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function AppointmentsPage() {
  usePageTitle('Appointments');
  const navigate = useNavigate();
  const { can } = useAuth();
  const { business } = useBusiness();
  const isPhone = useIsPhone();
  const [params, setParams] = useSearchParams();
  const canWrite = can('appointments:write');

  const timezone = business?.timezone;
  const today = todayInTimeZone(timezone);

  // View state lives in the address, so links, refresh and back/forward keep it.
  const view = params.get('view') === 'calendar' ? 'calendar' : 'list';
  const calMode = params.get('range') === 'week' ? 'week' : 'day';
  const tab = (['today', 'upcoming', 'past'].includes(params.get('tab') ?? '') ? params.get('tab') : 'today') as ListTab;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '') ? params.get('date')! : today;
  const filters: ListFilters = { q: params.get('q') ?? '', status: (params.get('status') ?? '') as '' | ListStatus };

  // Each change builds on the previous one, even when one click makes several (the date arrows set the day and switch
  // to the day tab; a week heading sets the day and the Day range). The router's own update reads the address as it
  // was when the page last drew, so a second change in the same click used to undo the first.
  const latestParams = useRef(params);
  latestParams.current = params;
  const update = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(latestParams.current);
    for (const [k, v] of Object.entries(changes)) { if (v) next.set(k, v); else next.delete(k); }
    latestParams.current = next;
    setParams(next, { replace: true });
  }, [setParams]);

  const [all, setAll] = useState<ListAppointment[]>([]);
  const [staff, setStaff] = useState<ListStaff[]>([]);
  const [customerTotal, setCustomerTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    return (appointmentsApi.list() as Promise<ListAppointment[]>)
      .then(list => { setAll(list); setError(null); })
      .catch((e: Error) => setError(e.message || 'Failed to load appointments'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    (staffApi.list() as Promise<ListStaff[]>).then(setStaff).catch(() => setStaff([]));
    if (can('customers:read')) customersApi.summary().then(s => setCustomerTotal(s.total)).catch(() => setCustomerTotal(null));
  }, [load]); // eslint-disable-line react-hooks/exhaustive-deps

  const staffById = useMemo(() => new Map(staff.map(s => [s.id, s])), [staff]);

  const stats = useMemo(() => {
    const ws = weekStart(today), we = addDays(ws, 6);
    const inWeek = (a: ListAppointment) => a.date >= ws && a.date <= we;
    const todayCount = all.filter(a => a.date === today).length;
    const lastWeekSameDay = all.filter(a => a.date === addDays(today, -7)).length;
    return {
      today: todayCount,
      todayChange: lastWeekSameDay > 0 ? Math.round(((todayCount - lastWeekSameDay) / lastWeekSameDay) * 100) : null,
      upcoming: all.filter(a => a.date > today && statusOf(a) === 'scheduled').length,
      completedWeek: all.filter(a => inWeek(a) && statusOf(a) === 'completed').length,
      cancelledWeek: all.filter(a => inWeek(a) && statusOf(a) === 'cancelled').length,
      customers: customerTotal ?? new Set(all.map(a => a.customerId)).size,
    };
  }, [all, today, customerTotal]);

  const filtered = useMemo(() => all.filter(a => matchesFilters(a, filters)), [all, filters.q, filters.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = useMemo(() => forTab(filtered, tab, today, day), [filtered, tab, today, day]);
  const counts = useMemo(() => ({
    today: forTab(filtered, 'today', today, day).length,
    upcoming: forTab(filtered, 'upcoming', today, day).length,
  }), [filtered, today, day]);

  const viewToggle = (
    <div className="inline-flex p-1 xl:p-[6px] xl:pl-[7px] xl:gap-[0px] rounded-xl xl:rounded-[12px] bg-white border border-border xl:border-[#DDE3EA] shadow-card" role="tablist" aria-label="View">
      {([['list', 'List', List], ['calendar', isPhone ? 'Day' : 'Calendar', CalendarDays]] as const).map(([id, label, Icon]) => (
        <button key={id} role="tab" aria-selected={view === id} onClick={() => update({ view: id === 'list' ? null : 'calendar' })}
          className={cn('flex items-center gap-2.5 xl:gap-[11px] px-4 sm:px-6 h-11 sm:h-12 xl:h-[39.5px] rounded-lg xl:rounded-[8px] text-[16px] sm:text-[17px] xl:text-[16px] font-medium xl:font-semibold xl:tracking-[-0.02em] transition-colors',
            id === 'list' ? 'xl:w-[114px] xl:px-0 xl:justify-center' : 'xl:pl-[31.5px] xl:pr-[15.5px]',
            view === id ? 'bg-brand-active text-white shadow-sm' : 'text-text-primary xl:text-[#1E293B] hover:bg-gray-50')}>
          <Icon className="w-5 h-5 xl:w-[23px] xl:h-[23px]" strokeWidth={1.9} aria-hidden="true" />{label}
        </button>
      ))}
    </div>
  );

  return (
    <div style={SHELL_ZOOM_STYLE} className="page-container xl:max-w-none xl:pl-[25.5px] xl:pr-[19px] xl:pt-[27px]">
      <div className="flex flex-wrap items-center xl:items-start justify-between gap-x-6 gap-y-4">
        <div className="flex items-center xl:items-start gap-3.5 sm:gap-4 xl:gap-[19px] min-w-0 xl:pl-[10px]">
          <CalendarDays className="w-9 h-9 sm:w-11 sm:h-11 xl:w-[45px] xl:h-[45px] xl:mt-[6px] text-primary xl:text-[#16A34A] shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-[32px] sm:leading-[38px] xl:text-[34px] xl:leading-[40px] font-bold text-text-primary xl:text-[#0F172A] tracking-tight">Appointments</h1>
            <p className="text-sm sm:text-base xl:text-[17.5px] xl:leading-[24px] text-text-secondary xl:text-[#334155] mt-0.5 xl:mt-[1px] xl:tracking-[-0.02em]">Manage bookings, reschedule, cancel and track your schedule.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 xl:gap-[38.5px] xl:mt-[16px] xl:mr-[2px]">
          {viewToggle}
          {canWrite && (
            <button onClick={() => navigate('/appointments/new')} className="btn-primary h-12 sm:h-[54px] px-5 sm:px-6 xl:pl-[21.5px] xl:pr-[20.5px] xl:gap-[15px] text-[17px] sm:text-[19px] xl:text-[18.8px] xl:tracking-[-0.02em] rounded-xl xl:rounded-[10px]">
              <Plus className="w-6 h-6 xl:w-[23px] xl:h-[23px]" strokeWidth={2.4} aria-hidden="true" />New Appointment
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="mt-6 sm:mt-7 xl:mt-[32.5px] grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-[264fr_214fr_242fr_235fr_223fr] gap-3 sm:gap-4 xl:gap-[15px]">
        <StatCard icon={CalendarDays} tile="bg-[#E5F7EC]" iconColor="text-primary" label="Today's Appointments" value={stats.today} change={stats.todayChange} />
        <StatCard icon={CalendarCheck2} tile="bg-[#E4EEFF]" iconColor="text-[#2563EB]" label="Upcoming" value={stats.upcoming} />
        <StatCard icon={CircleCheck} tile="bg-[#EFE9FF]" iconColor="text-[#7C3AED]" label={<>Completed <span className="text-[12px] xl:text-[12.5px] text-text-secondary xl:text-[#334155] whitespace-nowrap">(This Week)</span></>} value={stats.completedWeek} />
        <StatCard icon={CircleX} tile="bg-[#FDE7E7]" iconColor="text-[#DC2626]" label={<>Cancelled <span className="text-[12px] xl:text-[12.5px] text-text-secondary xl:text-[#334155] whitespace-nowrap">(This Week)</span></>} value={stats.cancelledWeek} />
        <StatCard icon={Users} tile="bg-[#EEF1F5]" iconColor="text-[#475569]" label="Total Customers" value={stats.customers} />
      </div>

      <div className="mt-6 sm:mt-7 xl:mt-[30px] grid gap-5 xl:gap-[16.5px] xl:grid-cols-[minmax(0,1fr)_425.5px] items-start">
        <div className="min-w-0">
          {error ? (
            <div className="panel p-6 text-sm text-red-700" role="alert">
              Failed to load appointments: {error}
              <button onClick={() => { setLoading(true); load(); }} className="btn-secondary ml-3">Retry</button>
            </div>
          ) : loading ? (
            <div className="panel p-10 text-center text-sm text-text-muted">Loading appointments…</div>
          ) : view === 'list' ? (
            <AppointmentList
              rows={rows}
              totalInAccount={all.length}
              counts={counts}
              staffById={staffById}
              tab={tab}
              onTab={t => update({ tab: t === 'today' ? null : t })}
              day={day}
              today={today}
              onDay={d => update({ date: d === today ? null : d })}
              filters={filters}
              onFilters={f => update({ q: f.q || null, status: f.status || null })}
              canWrite={canWrite}
              timezone={timezone}
              onChanged={load}
            />
          ) : (
            <AppointmentCalendar
              appointments={filtered}
              staffById={staffById}
              mode={calMode}
              onMode={m => update({ range: m === 'week' ? 'week' : null })}
              allowWeek={!isPhone}
              day={day}
              onDay={d => update({ date: d === today ? null : d })}
              today={today}
              canWrite={canWrite}
              timezone={timezone}
            />
          )}
        </div>

        <aside className="space-y-5 sm:space-y-6 xl:space-y-[17px]" aria-label="Booking link and quick actions">
          <BookingLinkCard />
          <QuickActions />
        </aside>
      </div>
    </div>
  );
}
