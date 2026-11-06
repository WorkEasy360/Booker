import React, { useMemo } from 'react';
import { Views } from 'react-big-calendar';
import type { View } from 'react-big-calendar';
import { format, startOfWeek, addDays } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

interface StaffItem {
  id: string;
  name: string;
  color: string;
}

export interface CalendarToolbarProps {
  date: Date;
  view: View;
  onNavigate: (action: 'PREV' | 'NEXT' | 'TODAY') => void;
  onView: (v: View) => void;
  selectedStaff: string[];
  onStaffToggle: (id: string) => void;
  /** Omitted when the user cannot create appointments. */
  onAdd?: () => void;
  staffList: StaffItem[];
}

const VIEW_DEFS: { id: View; label: string }[] = [
  { id: Views.DAY,    label: 'Day'    },
  { id: Views.WEEK,   label: 'Week'   },
  { id: Views.MONTH,  label: 'Month'  },
  { id: Views.AGENDA, label: 'Agenda' },
];

export function CalendarToolbar({
  date, view, onNavigate, onView, selectedStaff, onStaffToggle, onAdd, staffList,
}: CalendarToolbarProps) {
  const periodLabel = useMemo(() => {
    if (view === Views.DAY) return format(date, 'EEEE, MMMM d, yyyy');
    if (view === Views.WEEK) {
      const ws = startOfWeek(date, { locale: enUS });
      return `${format(ws, 'MMM d')} – ${format(addDays(ws, 6), 'MMM d, yyyy')}`;
    }
    return format(date, 'MMMM yyyy');
  }, [date, view]);

  return (
    <div className="flex flex-wrap items-center gap-3 mb-4">
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onNavigate('PREV')}
          className="p-1.5 rounded-lg border border-border hover:bg-muted text-text-secondary transition-colors"
          aria-label="Previous"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => onNavigate('TODAY')}
          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-border hover:bg-muted text-text-secondary transition-colors"
        >
          Today
        </button>
        <button
          onClick={() => onNavigate('NEXT')}
          className="p-1.5 rounded-lg border border-border hover:bg-muted text-text-secondary transition-colors"
          aria-label="Next"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <span className="text-sm font-semibold text-text-primary ml-1 hidden sm:block">{periodLabel}</span>
      </div>

      <div className="flex items-center bg-muted rounded-lg p-0.5 gap-0.5">
        {VIEW_DEFS.map(v => (
          <button
            key={v.id}
            onClick={() => onView(v.id)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
              view === v.id
                ? 'bg-surface text-text-primary shadow-sm'
                : 'text-text-secondary hover:text-text-primary',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1.5 flex-wrap flex-1">
        {staffList.map(staff => {
          const active = selectedStaff.includes(staff.id);
          return (
            <button
              key={staff.id}
              onClick={() => onStaffToggle(staff.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors',
                active
                  ? 'bg-surface border-border shadow-sm text-text-primary'
                  : 'border-transparent bg-muted text-text-muted',
              )}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: staff.color }} />
              {staff.name.split(' ').slice(-1)[0]}
            </button>
          );
        })}
      </div>

      {onAdd && (
        <Button variant="primary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={onAdd}>
          Add Appointment
        </Button>
      )}
    </div>
  );
}
