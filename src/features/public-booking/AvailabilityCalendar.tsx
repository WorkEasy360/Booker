import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { publicApi } from '@/api/client';
import { Spinner } from '@/components/ui';
import { cn, formatDate, todayInTimeZone } from '@/lib/utils';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_HEADERS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const pad = (n: number) => String(n).padStart(2, '0');

interface Props {
  serviceId: string;
  /** A staff id, or "any" to accept whichever assigned staff member is free. */
  staffId: string;
  /** Business time zone: decides what "today" is and is shown to the customer. */
  timeZone?: string;
  selected?: string;
  onSelect: (date: string) => void;
  /** When rescheduling: the booking's manage token, so its own slot does not count as taken. */
  manageToken?: string;
}

/** Month calendar that only enables days with at least one bookable slot, as reported by the server. */
export function AvailabilityCalendar({ serviceId, staffId, timeZone, selected, onSelect, manageToken }: Props) {
  const today = todayInTimeZone(timeZone);
  const [cal, setCal] = useState(() => ({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 }));
  const [open, setOpen] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const daysInMonth = new Date(cal.year, cal.month + 1, 0).getDate();
  const monthStart = `${cal.year}-${pad(cal.month + 1)}-01`;
  const monthEnd = `${cal.year}-${pad(cal.month + 1)}-${pad(daysInMonth)}`;
  const isCurrentMonth = monthStart.slice(0, 7) === today.slice(0, 7);

  useEffect(() => {
    let cancelled = false;
    setOpen(null);
    setError(null);
    if (monthEnd < today) { setOpen({}); return; }
    publicApi.availabilityDays({
      serviceId, staffId, from: monthStart < today ? today : monthStart, to: monthEnd,
    }, manageToken)
      .then(list => { if (!cancelled) setOpen(Object.fromEntries(list.map(d => [d.date, d.available]))); })
      .catch((e: Error) => { if (!cancelled) setError(e.message || 'Could not load available dates'); });
    return () => { cancelled = true; };
  }, [serviceId, staffId, monthStart, monthEnd, today, manageToken, attempt]);

  const firstDay = new Date(cal.year, cal.month, 1).getDay();
  const anyOpen = open ? Object.values(open).some(Boolean) : false;

  function prevMonth() { setCal(c => (c.month === 0 ? { year: c.year - 1, month: 11 } : { ...c, month: c.month - 1 })); }
  function nextMonth() { setCal(c => (c.month === 11 ? { year: c.year + 1, month: 0 } : { ...c, month: c.month + 1 })); }

  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-4">
        <button type="button" onClick={prevMonth} disabled={isCurrentMonth} aria-label="Previous month"
          className="p-1.5 rounded-lg hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
          <ChevronLeft className="w-4 h-4 text-text-secondary" />
        </button>
        <span className="font-semibold text-text-primary" aria-live="polite">{MONTHS[cal.month]} {cal.year}</span>
        <button type="button" onClick={nextMonth} aria-label="Next month" className="p-1.5 rounded-lg hover:bg-muted transition-colors">
          <ChevronRight className="w-4 h-4 text-text-secondary" />
        </button>
      </div>
      <div className="grid grid-cols-7 mb-2" aria-hidden="true">
        {DAY_HEADERS.map(d => <div key={d} className="text-center text-xs font-medium text-text-muted py-1">{d}</div>)}
      </div>
      <div className="relative">
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: firstDay }).map((_, i) => <div key={`b${i}`} />)}
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(d => {
            const dateStr = `${cal.year}-${pad(cal.month + 1)}-${pad(d)}`;
            const isPast = dateStr < today;
            const bookable = !isPast && open?.[dateStr] === true;
            const isSel = dateStr === selected;
            return (
              <button key={d} type="button" disabled={!bookable} onClick={() => onSelect(dateStr)}
                aria-label={`${formatDate(dateStr, 'EEEE, MMMM d, yyyy')}${bookable ? '' : ', unavailable'}`}
                aria-pressed={isSel} data-date={dateStr} data-available={bookable}
                className={cn(
                  'w-full aspect-square flex items-center justify-center rounded-lg text-sm font-medium transition-all',
                  !bookable && 'text-text-muted opacity-40 cursor-not-allowed line-through decoration-transparent',
                  bookable && !isSel && 'text-text-primary bg-primary-light/50 hover:bg-primary-light hover:text-primary',
                  dateStr === today && !isSel && 'ring-1 ring-primary',
                  isSel && 'bg-primary text-white font-bold shadow-sm',
                )}>
                {d}
              </button>
            );
          })}
        </div>
        {open === null && !error && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/60" role="status" aria-label="Loading available dates">
            <Spinner />
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600">
          {error}. <button type="button" className="underline" onClick={() => setAttempt(a => a + 1)}>Try again</button>
        </p>
      )}
      {open && !anyOpen && !error && (
        <p role="status" className="mt-3 text-sm text-text-secondary">No dates are available in {MONTHS[cal.month]}. Try the next month.</p>
      )}
      {timeZone && <p className="mt-3 text-xs text-text-muted">Dates and times are in the business time zone ({timeZone}).</p>}
    </div>
  );
}
