import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Search, X, ChevronDown, Plus, Check } from 'lucide-react';
import { StatusBadge, useToast } from '@/components/ui';
import { appointmentsApi } from '@/api/client';
import { cn, getInitials } from '@/lib/utils';
import {
  type ListAppointment, type ListFilters, type ListStaff, type ListTab, type ListStatus,
  clock, contactOf, addDays, longDay, shortDay, statusOf, hasStartedAt, nowIn,
} from './listModel';

const PAGE_SIZE = 5;

const STATUS_OPTIONS: Array<{ value: '' | ListStatus; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-show' },
];

export function StaffAvatar({ staff, name, size = 38 }: { staff?: ListStaff; name: string; size?: number }) {
  if (staff?.photoUrl) {
    return <img src={staff.photoUrl} alt="" className="rounded-full object-cover shrink-0 ring-1 ring-black/5" style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden="true"
      className="rounded-full shrink-0 flex items-center justify-center text-[13px] font-semibold text-white"
      style={{ width: size, height: size, background: staff?.color || '#64748B' }}
    >
      {getInitials(name || '?')}
    </span>
  );
}

interface Props {
  rows: ListAppointment[];
  /** Appointments before any filter, to tell an empty account from "no matches". */
  totalInAccount: number;
  counts: { today: number; upcoming: number };
  staffById: Map<string, ListStaff>;
  tab: ListTab;
  onTab: (t: ListTab) => void;
  day: string;
  today: string;
  onDay: (d: string) => void;
  filters: ListFilters;
  onFilters: (f: ListFilters) => void;
  canWrite: boolean;
  timezone?: string;
  onChanged: () => void;
}

export function AppointmentList({
  rows, totalInAccount, counts, staffById, tab, onTab, day, today, onDay, filters, onFilters, canWrite, timezone, onChanged,
}: Props) {
  const navigate = useNavigate();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(!!filters.q);
  useEffect(() => { if (filters.q) setSearchOpen(true); }, [filters.q]);
  const [statusOpen, setStatusOpen] = useState(false);
  const dateInput = useRef<HTMLInputElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setPage(1); setSelected(new Set()); }, [tab, day, filters.q, filters.status]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const paged = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const filtering = !!(filters.q.trim() || filters.status);
  const nowLocal = nowIn(timezone);

  // Bulk actions: Complete / Mark No-show for Scheduled appointments that have started.
  const eligible = useMemo(() => rows.filter(a => selected.has(a.id) && statusOf(a) === 'scheduled' && hasStartedAt(a, nowLocal)), [rows, selected, nowLocal]);
  const allOnPage = paged.length > 0 && paged.every(a => selected.has(a.id));
  const toggleAll = () => setSelected(s => {
    const next = new Set(s);
    if (allOnPage) paged.forEach(a => next.delete(a.id)); else paged.forEach(a => next.add(a.id));
    return next;
  });
  const toggleOne = (id: string) => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function bulk(status: 'completed' | 'no_show') {
    setBusy(true);
    const results = await Promise.allSettled(eligible.map(a => appointmentsApi.update(a.id, { status })));
    const failed = results.filter(r => r.status === 'rejected').length;
    setBusy(false);
    setSelected(new Set());
    if (failed) toast.error(`${failed} of ${results.length} could not be updated`, (results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason?.message);
    else toast.success(`${results.length} appointment${results.length === 1 ? '' : 's'} marked ${status === 'completed' ? 'completed' : 'no-show'}`);
    onChanged();
  }

  const dayLabel = day === today ? 'Today' : shortDay(day);
  const tabs: Array<{ id: ListTab; label: string }> = [
    { id: 'today', label: `${dayLabel} (${counts.today})` },
    { id: 'upcoming', label: `Upcoming (${counts.upcoming})` },
    { id: 'past', label: 'Past' },
  ];

  // Rows grouped by date in Upcoming and Past.
  const grouped = tab !== 'today';

  return (
    <section className="panel xl:rounded-[16px] p-4 sm:p-5 xl:pt-[25.5px] xl:pl-[16.5px] xl:pr-[18px] xl:pb-[25.5px]" aria-label="Appointment list">
      {/* Toolbar: tabs · search · date */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Appointment period" className="inline-flex items-center p-1 xl:p-0 xl:ml-[1px] xl:h-[50px] rounded-xl xl:rounded-[10px] bg-[#F1F4F7] border border-[#E6EAF0]">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => onTab(t.id)}
              className={cn(
                'px-4 sm:px-[22px] xl:px-0 h-10 sm:h-11 xl:h-[43.5px] rounded-lg xl:rounded-[8px] text-[15px] sm:text-[16px] font-medium xl:font-semibold xl:tracking-[-0.01em] transition-colors whitespace-nowrap',
                t.id === 'today' ? 'xl:w-[118px]' : t.id === 'upcoming' ? 'xl:w-[160px]' : 'xl:w-[95px]',
                tab === t.id ? 'bg-brand-active text-white shadow-sm' : 'text-text-primary hover:bg-white',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5 ml-auto xl:mr-[5px]">
          {searchOpen ? (
            <div className="flex items-center gap-2 h-11 px-3 rounded-xl border border-border bg-white w-[220px] sm:w-[240px] focus-within:border-primary">
              <Search className="w-4 h-4 text-text-muted shrink-0" aria-hidden="true" />
              <input
                autoFocus
                type="search"
                value={filters.q}
                onChange={e => onFilters({ ...filters, q: e.target.value })}
                placeholder="Customer name or phone"
                aria-label="Search by customer name or phone"
                className="flex-1 min-w-0 bg-transparent text-[15px] focus:outline-none"
              />
              <button onClick={() => { onFilters({ ...filters, q: '' }); setSearchOpen(false); }} aria-label="Close search" className="text-text-muted hover:text-text-primary">
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {/* Date: the day shown in the first tab */}
          <div className="flex items-stretch h-11 sm:h-12 xl:h-[48px] rounded-xl xl:rounded-[10px] border border-border xl:border-[#DDE3EA] bg-white overflow-hidden" title={timezone ? `Times shown in ${timezone}` : undefined}>
            <button onClick={() => { onDay(addDays(day, -1)); onTab('today'); }} aria-label="Previous day" className="w-11 xl:w-[44px] flex items-center justify-center hover:bg-gray-50 border-r border-border xl:border-[#DDE3EA]">
              <ChevronLeft className="w-5 h-5 xl:w-[22px] xl:h-[22px]" strokeWidth={2.2} aria-hidden="true" />
            </button>
            <label className="relative flex items-center gap-2.5 xl:gap-[13px] px-3 sm:px-4 xl:pl-[19px] xl:pr-[18px] cursor-pointer hover:bg-gray-50">
              <CalendarDays className="w-5 h-5 xl:w-[24px] xl:h-[24px] text-text-primary xl:text-[#1E293B] shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span className="text-[15px] sm:text-[17px] xl:text-[16px] font-semibold text-text-primary xl:text-[#0F172A] xl:tracking-[-0.02em] whitespace-nowrap">{longDay(day)}</span>
              <input
                ref={dateInput}
                type="date"
                value={day}
                onChange={e => { if (e.target.value) { onDay(e.target.value); onTab('today'); } }}
                aria-label="Choose a date"
                className="absolute inset-0 opacity-0 cursor-pointer"
                onClick={() => { try { dateInput.current?.showPicker?.(); } catch { /* not supported */ } }}
              />
            </label>
            <button onClick={() => { onDay(addDays(day, 1)); onTab('today'); }} aria-label="Next day" className="w-11 xl:w-[43px] flex items-center justify-center hover:bg-gray-50 border-l border-border xl:border-[#DDE3EA]">
              <ChevronRight className="w-5 h-5 xl:w-[22px] xl:h-[22px]" strokeWidth={2.2} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      {(filtering || (tab === 'today' && day !== today)) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {filters.q.trim() && <FilterChip label={`Search: ${filters.q.trim()}`} onClear={() => onFilters({ ...filters, q: '' })} />}
          {filters.status && <FilterChip label={`Status: ${STATUS_OPTIONS.find(o => o.value === filters.status)?.label}`} onClear={() => onFilters({ ...filters, status: '' })} />}
          {tab === 'today' && day !== today && <FilterChip label={`Date: ${longDay(day)}`} onClear={() => onDay(today)} />}
        </div>
      )}

      {/* Desktop table */}
      <div className="hidden md:block mt-5 xl:mt-[25.5px]">
        <table className="w-full text-left xl:table-fixed">
          <colgroup className="hidden xl:table-column-group">
            <col className="xl:w-[6.8%]" /><col className="xl:w-[22.7%]" /><col className="xl:w-[21.3%]" /><col className="xl:w-[18.6%]" /><col className="xl:w-[17.6%]" /><col />
          </colgroup>
          <thead>
            <tr className="bg-[#F3F5F8] xl:bg-[#F1F4F7] text-[15px] xl:text-[16px] font-semibold xl:font-bold text-text-primary xl:text-[#111827] xl:h-[44px]">
              <th scope="col" className="w-12 pl-3 xl:pl-[10px] py-3.5 xl:py-0 rounded-l-xl xl:rounded-l-[10px]">
                <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select all on this page"
                  className="w-5 h-5 rounded-md border-2 border-[#C3CBD6] accent-[#16A34A] align-middle cursor-pointer" />
              </th>
              <th scope="col" className="py-3.5 xl:py-0 pl-3 xl:pl-0">Time</th>
              <th scope="col" className="py-3.5 xl:py-0">Customer</th>
              <th scope="col" className="py-3.5 xl:py-0">Service</th>
              <th scope="col" className="py-3.5 xl:py-0">Staff</th>
              <th scope="col" className="py-3.5 xl:py-0 pr-3 xl:pl-[12px] rounded-r-xl xl:rounded-r-[10px]">
                <div ref={statusRef} className="relative inline-block">
                  <button onClick={() => setStatusOpen(o => !o)} aria-haspopup="true" aria-expanded={statusOpen} aria-label="Filter by status"
                    title="Filter by status"
                    className={cn('inline-flex items-center gap-1 font-semibold xl:font-bold hover:text-primary', filters.status && 'text-primary')}>
                    Status{filters.status ? ':' : ''} {filters.status && STATUS_OPTIONS.find(o => o.value === filters.status)?.label}
                    {filters.status && <ChevronDown className="w-4 h-4 opacity-60" aria-hidden="true" />}
                  </button>
                  {statusOpen && (
                    <div className="absolute right-0 top-full mt-2 w-44 bg-white rounded-xl border border-border shadow-dropdown py-1.5 z-20 font-normal">
                      {STATUS_OPTIONS.map(o => (
                        <button key={o.value || 'all'} onClick={() => { onFilters({ ...filters, status: o.value }); setStatusOpen(false); }}
                          className="flex items-center justify-between w-full px-3.5 py-2 text-sm text-text-primary hover:bg-gray-50">
                          {o.label}{filters.status === o.value && <Check className="w-4 h-4 text-primary" aria-hidden="true" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.map((a, i) => {
              const showGroup = grouped && (i === 0 || paged[i - 1].date !== a.date);
              return (
                <React.Fragment key={a.id}>
                  {showGroup && (
                    <tr>
                      <td colSpan={6} className="pt-4 pb-1.5 pl-3 text-[13px] font-semibold uppercase tracking-wide text-text-muted">{longDay(a.date)}</td>
                    </tr>
                  )}
                  <tr
                    onClick={() => navigate(`/appointments/${a.id}`)}
                    className="border-b border-[#EEF1F4] hover:bg-[#FAFBFC] cursor-pointer text-[15px] xl:text-[16px] xl:h-[65px]"
                  >
                    <td className="pl-3 xl:pl-[10px] py-3 xl:py-0" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleOne(a.id)} aria-label={`Select ${a.customerName} at ${clock(a.startTime)}`}
                        className="w-5 h-5 rounded-md border-2 border-[#C3CBD6] accent-[#16A34A] align-middle cursor-pointer" />
                    </td>
                    <td className="py-3 xl:py-0 pl-3 xl:pl-0 pr-3 whitespace-nowrap overflow-hidden text-ellipsis text-text-primary xl:text-[#111827] xl:tracking-[-0.01em]">{clock(a.startTime)} – {clock(a.endTime)}</td>
                    <td className="py-3 xl:py-0 pr-3 xl:pl-[2px]">
                      <p className="font-semibold xl:font-bold text-text-primary xl:text-[#0F172A] xl:leading-[21px] xl:tracking-[-0.01em] truncate">{a.customerName}</p>
                      <p className="text-text-secondary xl:text-[#475A75] text-[14px] xl:text-[16px] mt-0.5 xl:mt-[2px] xl:leading-[21px] truncate">{contactOf(a)}</p>
                    </td>
                    <td className="py-3 xl:py-0 pr-3">
                      <p className="text-text-primary xl:text-[#1F2937] xl:leading-[21px] xl:tracking-[-0.01em] truncate">{a.serviceName}</p>
                      <p className="text-text-secondary xl:text-[#6B7280] text-[14px] xl:text-[16px] mt-0.5 xl:mt-[1px] xl:leading-[21px]">({a.duration} min)</p>
                    </td>
                    <td className="py-3 xl:py-0 pr-3">
                      {/* Not clipped: the avatar sits 4px left of the cell edge (as in the design); a long name shortens with "…". */}
                      <span className="flex items-center gap-2.5 xl:gap-[10px] xl:-ml-[4px] min-w-0">
                        <StaffAvatar staff={staffById.get(a.staffId)} name={a.staffName} />
                        <span className="text-text-primary xl:text-[#1F2937] whitespace-nowrap truncate min-w-0 xl:tracking-[-0.01em]">{a.staffName}</span>
                      </span>
                    </td>
                    <td className="py-3 xl:py-0 pr-3 xl:pr-0"><StatusBadge status={a.status} className="xl:h-[31px] xl:w-[91px] xl:px-0 xl:py-0 xl:text-[15px] xl:rounded-[8px] xl:tracking-[-0.03em]" /></td>
                  </tr>
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Phone: appointment cards */}
      <ul className="md:hidden mt-4 space-y-3">
        {paged.map((a, i) => (
          <React.Fragment key={a.id}>
            {grouped && (i === 0 || paged[i - 1].date !== a.date) && (
              <li className="pt-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{longDay(a.date)}</li>
            )}
            <li>
              <button onClick={() => navigate(`/appointments/${a.id}`)} className="w-full text-left rounded-xl border border-border bg-white p-4 active:bg-gray-50">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold text-primary">{clock(a.startTime)} – {clock(a.endTime)}</p>
                    <p className="mt-1 text-base font-semibold text-text-primary truncate">{a.customerName}</p>
                    <p className="text-sm text-text-secondary truncate">{contactOf(a)}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </div>
                <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                  <span className="text-text-primary truncate">{a.serviceName} <span className="text-text-secondary">({a.duration} min)</span></span>
                  <span className="flex items-center gap-2 shrink-0">
                    <StaffAvatar staff={staffById.get(a.staffId)} name={a.staffName} size={28} />
                    <span className="text-text-primary">{a.staffName}</span>
                  </span>
                </div>
              </button>
            </li>
          </React.Fragment>
        ))}
      </ul>

      {/* Empty states */}
      {rows.length === 0 && (
        <div className="py-14 text-center">
          <CalendarDays className="w-10 h-10 text-text-muted mx-auto" strokeWidth={1.5} aria-hidden="true" />
          {totalInAccount === 0 ? (
            <>
              <p className="mt-3 text-lg font-semibold text-text-primary">No appointments yet</p>
              <p className="mt-1 text-sm text-text-secondary">Book your first appointment or share your booking link with customers.</p>
              {canWrite && (
                <button onClick={() => navigate('/appointments/new')} className="btn-primary mt-5 h-11 px-5 text-[15px]">
                  <Plus className="w-5 h-5" aria-hidden="true" />Add First Appointment
                </button>
              )}
            </>
          ) : filtering ? (
            <>
              <p className="mt-3 text-lg font-semibold text-text-primary">No appointments match your filters</p>
              <button onClick={() => { onFilters({ q: '', status: '' }); setSearchOpen(false); }} className="btn-secondary mt-4 h-11 px-5">Clear Filters</button>
            </>
          ) : (
            <p className="mt-3 text-base font-medium text-text-secondary">
              {tab === 'today' ? `No appointments on ${longDay(day)}.` : tab === 'upcoming' ? 'No upcoming appointments.' : 'No past appointments.'}
            </p>
          )}
        </div>
      )}

      {/* Footer: bulk actions or count · pagination */}
      {rows.length > 0 && (
        <div className="mt-5 xl:mt-[22px] flex flex-wrap items-center justify-between gap-3 xl:pl-[8.5px] xl:pr-[9.5px]">
          {selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 text-[15px]">
              <span className="font-semibold text-text-primary">{selected.size} selected</span>
              {canWrite && (
                <>
                  <button disabled={busy || !eligible.length} onClick={() => bulk('completed')} className="btn-secondary h-10" title={eligible.length ? undefined : 'Only started Scheduled appointments can be completed'}>Complete{eligible.length ? ` (${eligible.length})` : ''}</button>
                  <button disabled={busy || !eligible.length} onClick={() => bulk('no_show')} className="btn-secondary h-10">Mark No-show</button>
                </>
              )}
              <button onClick={() => setSelected(new Set())} className="btn-ghost h-10">Clear</button>
            </div>
          ) : (
            <p className="text-[15px] xl:text-[16.5px] text-text-secondary xl:text-[#475569] xl:tracking-[-0.01em]">
              Showing {(current - 1) * PAGE_SIZE + 1} – {Math.min(current * PAGE_SIZE, rows.length)} of {rows.length} appointments
            </p>
          )}
          {totalPages > 1 && (
            <nav aria-label="Pages" className="flex items-center gap-2 xl:gap-[3.5px]">
              <PageButton label="Previous page" className="xl:mr-[7.5px]" disabled={current === 1} onClick={() => setPage(current - 1)}><ChevronLeft className="w-5 h-5" aria-hidden="true" /></PageButton>
              {pageNumbers(current, totalPages).map((n, i) => n === 0
                ? <span key={`gap-${i}`} className="px-1 text-text-muted">…</span>
                : (
                  <button key={n} onClick={() => setPage(n)} aria-current={n === current ? 'page' : undefined}
                    className={cn('w-10 h-10 xl:w-[36.5px] xl:h-[36.5px] rounded-lg xl:rounded-[6px] text-[15px] xl:text-[17px] font-semibold', n === current ? 'bg-brand-active text-white' : 'text-text-primary xl:text-[#0F172A] hover:bg-gray-100')}>
                    {n}
                  </button>
                ))}
              <PageButton label="Next page" className="xl:ml-[3.5px]" disabled={current === totalPages} onClick={() => setPage(current + 1)}><ChevronRight className="w-5 h-5" aria-hidden="true" /></PageButton>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}

function PageButton({ label, disabled, onClick, children, className }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button aria-label={label} disabled={disabled} onClick={onClick}
      className={cn(className, "w-10 h-10 xl:w-[37.5px] xl:h-[36.5px] rounded-lg xl:rounded-[8px] border border-border xl:border-[#DDE3EA] bg-white flex items-center justify-center text-text-primary xl:text-[#0F172A] hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed")}>
      {children}
    </button>
  );
}

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 pl-3 pr-1.5 py-1 rounded-full bg-primary-light text-primary font-medium">
      {label}
      <button onClick={onClear} aria-label={`Clear ${label}`} className="w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/60">
        <X className="w-3.5 h-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

/** Page numbers with gaps (0) for long lists: 1 … 4 5 6 … 12. */
function pageNumbers(current: number, total: number): number[] {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set([1, total, current - 1, current, current + 1].filter(n => n >= 1 && n <= total));
  const sorted = [...set].sort((a, b) => a - b);
  const out: number[] = [];
  sorted.forEach((n, i) => { if (i && n - sorted[i - 1] > 1) out.push(0); out.push(n); });
  return out;
}
