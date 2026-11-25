import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type ListAppointment, type ListStaff, addDays, weekStart, longDay, clock, statusOf } from './listModel';

const HOUR_PX = 64;

const STATUS_BLOCK: Record<string, string> = {
  scheduled: 'bg-[#E3EEFF] border-[#2563EB] text-[#1E3A8A]',
  completed: 'bg-[#DDF6E5] border-[#16A34A] text-[#14532D]',
  cancelled: 'bg-[#F3F4F6] border-[#9CA3AF] text-[#6B7280] line-through',
  no_show: 'bg-[#F1E8FE] border-[#7C3AED] text-[#4C1D95]',
};

const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

interface Props {
  /** Already filtered by the shared search and status filters. */
  appointments: ListAppointment[];
  staffById: Map<string, ListStaff>;
  mode: 'day' | 'week';
  onMode: (m: 'day' | 'week') => void;
  /** Week view is offered on larger screens only; phones get List / Day. */
  allowWeek: boolean;
  day: string;
  onDay: (d: string) => void;
  today: string;
  canWrite: boolean;
  timezone?: string;
}

export function AppointmentCalendar({ appointments, staffById, mode, onMode, allowWeek, day, onDay, today, canWrite, timezone }: Props) {
  const navigate = useNavigate();
  const effective = allowWeek ? mode : 'day';
  const days = useMemo(() => {
    if (effective === 'day') return [day];
    const start = weekStart(day);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [effective, day]);

  const visible = appointments.filter(a => days.includes(a.date));
  // Hours shown: 8:00–18:00 by default, widened to fit the visible appointments.
  const startHour = Math.min(8, ...visible.map(a => Math.floor(toMin(a.startTime) / 60)));
  const endHour = Math.max(18, ...visible.map(a => Math.ceil(toMin(a.endTime) / 60)));
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const step = effective === 'day' ? 1 : 7;

  const title = effective === 'day'
    ? longDay(day)
    : `${longDay(days[0]).replace(/^\w+, /, '')} – ${longDay(days[6]).replace(/^\w+, /, '')}`;

  function slotClick(date: string, hour: number) {
    if (!canWrite) return;
    navigate(`/appointments/new?date=${date}&time=${String(hour).padStart(2, '0')}:00`);
  }

  return (
    <section className="panel p-4 sm:p-5 lg:p-6" aria-label="Appointment calendar">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex p-1 rounded-xl bg-[#F1F4F7] border border-[#E6EAF0]" role="tablist" aria-label="Calendar range">
          {(allowWeek ? (['day', 'week'] as const) : (['day'] as const)).map(m => (
            <button key={m} role="tab" aria-selected={effective === m} onClick={() => onMode(m)}
              className={cn('px-5 sm:px-6 h-10 sm:h-11 rounded-lg text-[15px] sm:text-[16px] font-medium capitalize',
                effective === m ? 'bg-brand-active text-white shadow-sm' : 'text-text-primary hover:bg-white')}>
              {m}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {day !== today && <button onClick={() => onDay(today)} className="btn-secondary h-11">Today</button>}
          <div className="flex items-stretch h-11 sm:h-12 rounded-xl border border-border bg-white overflow-hidden">
            <button onClick={() => onDay(addDays(day, -step))} aria-label={effective === 'day' ? 'Previous day' : 'Previous week'} className="w-11 flex items-center justify-center hover:bg-gray-50 border-r border-border">
              <ChevronLeft className="w-5 h-5" aria-hidden="true" />
            </button>
            <label className="relative flex items-center gap-2.5 px-3 sm:px-5 cursor-pointer hover:bg-gray-50">
              <CalendarDays className="w-5 h-5 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span className="text-[15px] sm:text-[17px] font-semibold whitespace-nowrap">{title}</span>
              <input type="date" value={day} onChange={e => e.target.value && onDay(e.target.value)} aria-label="Choose a date" className="absolute inset-0 opacity-0 cursor-pointer" />
            </label>
            <button onClick={() => onDay(addDays(day, step))} aria-label={effective === 'day' ? 'Next day' : 'Next week'} className="w-11 flex items-center justify-center hover:bg-gray-50 border-l border-border">
              <ChevronRight className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto">
        <div className={cn(effective === 'week' && 'min-w-[680px]')}>
          {/* Day headers */}
          <div className="grid border-b border-border" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}>
            <span />
            {days.map(d => (
              <button key={d} onClick={() => { onDay(d); onMode('day'); }}
                className={cn('py-2.5 text-center text-[14px] font-semibold', d === today ? 'text-primary' : 'text-text-primary')}>
                {effective === 'week' ? longDay(d).replace(/ \d{4}$/, '') : longDay(d)}
              </button>
            ))}
          </div>
          {/* Time grid */}
          <div className="relative grid" style={{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0,1fr))` }}>
            <div>
              {hours.map(h => (
                <div key={h} className="text-[12px] text-text-muted text-right pr-2 -mt-2" style={{ height: HOUR_PX }}>
                  {clock(`${String(h).padStart(2, '0')}:00`).replace(':00', '')}
                </div>
              ))}
            </div>
            {days.map(d => (
              <div key={d} className={cn('relative border-l border-border', d === today && 'bg-[#F7FCF9]')}>
                {hours.map(h => (
                  <div key={h} onClick={() => slotClick(d, h)}
                    className={cn('border-b border-[#EEF1F4]', canWrite && 'hover:bg-primary-light/40 cursor-pointer')} style={{ height: HOUR_PX }} />
                ))}
                {visible.filter(a => a.date === d).map(a => {
                  const top = ((toMin(a.startTime) - startHour * 60) / 60) * HOUR_PX;
                  const height = Math.max(26, ((toMin(a.endTime) - toMin(a.startTime)) / 60) * HOUR_PX - 3);
                  const st = staffById.get(a.staffId);
                  return (
                    <button key={a.id} onClick={() => navigate(`/appointments/${a.id}`)}
                      className={cn('absolute left-1 right-1 rounded-lg border-l-4 px-2 py-1 text-left overflow-hidden shadow-sm hover:shadow', STATUS_BLOCK[statusOf(a)] ?? STATUS_BLOCK.scheduled)}
                      style={{ top, height }}
                      title={`${clock(a.startTime)} – ${clock(a.endTime)} · ${a.customerName} · ${a.serviceName} · ${a.staffName}`}>
                      <p className="text-[12px] font-semibold leading-tight truncate">{clock(a.startTime)} {a.customerName}</p>
                      {height > 40 && <p className="text-[12px] leading-tight truncate opacity-80">{a.serviceName}{st ? ` · ${st.name}` : ''}</p>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {timezone && <p className="mt-3 text-xs text-text-muted">Times in {timezone}</p>}
    </section>
  );
}
