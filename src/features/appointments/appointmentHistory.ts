// How an appointment history entry reads on the appointment page. Pure functions, unit-tested in
// tests/unit/appointment-history.test.ts; the entries come from GET /api/appointments/:id/history.

export interface HistoryEntryView {
  action: 'created' | 'status_changed' | 'rescheduled' | 'reassigned' | 'deleted';
  fromStatus: string | null; toStatus: string | null;
  fromDate: string | null; fromStartTime: string | null; toDate: string | null; toStartTime: string | null;
  fromStaff: { id: string; name: string | null } | null;
  toStaff: { id: string; name: string | null } | null;
  actor: { type: 'user' | 'customer' | 'system'; name: string | null; source: string };
}

export interface HistoryFormat { date: (d: string) => string; time: (t: string) => string }

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show',
};
export const statusLabel = (s: string | null) => (s ? STATUS_LABEL[s] ?? s : '');

const staffName = (s: HistoryEntryView['fromStaff']) => (s ? s.name ?? 'a removed staff member' : 'unknown');

function statusTitle(from: string | null, to: string | null): string {
  if (to === 'completed') return 'Marked completed';
  if (to === 'no_show') return 'Marked as a no-show';
  if (to === 'cancelled') return 'Cancelled';
  if (from === 'cancelled') return 'Restored';
  if (to === 'confirmed') return 'Confirmed';
  return `Status set to ${statusLabel(to)}`;
}

/** What happened, in one short line, and the before → after detail. */
export function describeEntry(e: HistoryEntryView, f: HistoryFormat): { title: string; detail: string } {
  const at = (d: string | null, t: string | null) => (d && t ? `${f.date(d)}, ${f.time(t)}` : '');
  switch (e.action) {
    case 'created':
      return { title: 'Booked', detail: `${at(e.toDate, e.toStartTime)} with ${staffName(e.toStaff)} · ${statusLabel(e.toStatus)}` };
    case 'status_changed':
      return { title: statusTitle(e.fromStatus, e.toStatus), detail: `${statusLabel(e.fromStatus)} → ${statusLabel(e.toStatus)}` };
    case 'rescheduled':
      return { title: 'Rescheduled', detail: `${at(e.fromDate, e.fromStartTime)} → ${at(e.toDate, e.toStartTime)}` };
    case 'reassigned':
      return { title: 'Staff changed', detail: `${staffName(e.fromStaff)} → ${staffName(e.toStaff)}` };
    case 'deleted':
      return { title: 'Deleted', detail: `Was ${statusLabel(e.fromStatus)}, ${at(e.fromDate, e.fromStartTime)}` };
  }
}

/** Who made the change and from where. */
export function describeActor(a: HistoryEntryView['actor']): string {
  if (a.type === 'customer') return a.source === 'booking_page' ? 'The customer, on the booking page' : 'The customer, with their booking link';
  if (a.type === 'user') return `${a.name ?? 'A removed user'}${a.source === 'assistant' ? ', through the assistant' : ''}`;
  return 'System';
}
