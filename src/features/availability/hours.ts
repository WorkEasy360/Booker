// Weekly hours as the Availability editor shows them: each day is open or closed with one or more time ranges.
// The API stores one window per day (first start .. last end) plus weekly breaks for the gaps between ranges.

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = typeof WEEKDAYS[number];

export const WEEKDAY_LABEL: Record<Weekday, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday', thursday: 'Thursday',
  friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

export interface Range { start: string; end: string }
export interface DayEdit { open: boolean; ranges: Range[] }
export type WeekEdit = Record<Weekday, DayEdit>;

/** Stored form: { monday: { enabled, start, end }, ... } */
export type StoredHours = Partial<Record<string, { enabled?: boolean; start?: string; end?: string } | undefined>>;
export interface StoredBreak { id: string; weekday: string; startTime: string; endTime: string }

export const toMinutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

const DEFAULT_RANGE: Range = { start: '09:00', end: '17:00' };

/** The editor's week from the stored window per day and the weekly breaks inside it. */
export function weekFromStored(hours: StoredHours | null | undefined, breaks: StoredBreak[], defaultOpen = false): WeekEdit {
  const out = {} as WeekEdit;
  const hasAny = !!hours && Object.keys(hours).length > 0;
  for (const day of WEEKDAYS) {
    const d = hours?.[day];
    if (!hasAny) {
      const open = defaultOpen && !['saturday', 'sunday'].includes(day);
      out[day] = { open, ranges: [{ ...DEFAULT_RANGE }] };
      continue;
    }
    if (!d?.enabled || !d.start || !d.end) {
      out[day] = { open: false, ranges: [{ start: d?.start || DEFAULT_RANGE.start, end: d?.end || DEFAULT_RANGE.end }] };
      continue;
    }
    const ws = toMinutes(d.start), we = toMinutes(d.end);
    const inside = breaks
      .filter(b => b.weekday === day && toMinutes(b.startTime) > ws && toMinutes(b.endTime) < we && b.endTime > b.startTime)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const ranges: Range[] = [];
    let cursor = d.start;
    for (const b of inside) {
      if (b.startTime <= cursor) { if (b.endTime > cursor) cursor = b.endTime; continue; }
      ranges.push({ start: cursor, end: b.startTime });
      cursor = b.endTime;
    }
    if (cursor < d.end) ranges.push({ start: cursor, end: d.end });
    out[day] = { open: true, ranges: ranges.length ? ranges : [{ start: d.start, end: d.end }] };
  }
  return out;
}

/** Stored window per day and the breaks (gaps between ranges) to save. */
export function storedFromWeek(week: WeekEdit): { hours: Record<Weekday, { enabled: boolean; start: string; end: string }>; breaks: Array<{ weekday: Weekday; startTime: string; endTime: string }> } {
  const hours = {} as Record<Weekday, { enabled: boolean; start: string; end: string }>;
  const breaks: Array<{ weekday: Weekday; startTime: string; endTime: string }> = [];
  for (const day of WEEKDAYS) {
    const d = week[day];
    const ranges = [...d.ranges].sort((a, b) => a.start.localeCompare(b.start));
    const first = ranges[0] ?? DEFAULT_RANGE;
    const last = ranges[ranges.length - 1] ?? DEFAULT_RANGE;
    hours[day] = { enabled: d.open && ranges.length > 0, start: first.start, end: last.end };
    if (d.open) {
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i].start > ranges[i - 1].end) breaks.push({ weekday: day, startTime: ranges[i - 1].end, endTime: ranges[i].start });
      }
    }
  }
  return { hours, breaks };
}

/** Problems per day: end before start, overlapping ranges, or (for a provider) times outside business hours. */
export function weekProblems(week: WeekEdit, business: WeekEdit | null): Partial<Record<Weekday, string>> {
  const out: Partial<Record<Weekday, string>> = {};
  for (const day of WEEKDAYS) {
    const d = week[day];
    if (!d.open) continue;
    if (!d.ranges.length) { out[day] = 'Add a time range or mark the day closed.'; continue; }
    const sorted = [...d.ranges].sort((a, b) => a.start.localeCompare(b.start));
    if (sorted.some(r => r.end <= r.start)) { out[day] = 'Each end time must be after its start time.'; continue; }
    if (sorted.some((r, i) => i > 0 && r.start < sorted[i - 1].end)) { out[day] = 'Time ranges must not overlap.'; continue; }
    if (business) {
      const b = business[day];
      if (!b.open) { out[day] = `The business is closed on ${WEEKDAY_LABEL[day]}s. Open the business first or mark this day closed.`; continue; }
      const bs = [...b.ranges].sort((x, y) => x.start.localeCompare(y.start));
      const inside = sorted.every(r => bs.some(x => r.start >= x.start && r.end <= x.end));
      if (!inside) {
        out[day] = `Must be within business hours (${bs.map(x => `${fmt(x.start)}–${fmt(x.end)}`).join(', ')}).`;
      }
    }
  }
  return out;
}

/** 15-minute steps for time selects, as HH:MM. */
export const TIME_STEPS: string[] = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`).concat('23:59');

export function fmt(t: string): string {
  const [h, m] = t.split(':').map(Number);
  if (Number.isNaN(h)) return t;
  const period = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${period}`;
}
