// Conversion between a business-local date and time (how appointments are stored) and an absolute instant.
// Uses only Intl, so every IANA zone and its daylight-saving rules are supported.

const PARTS = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    PARTS.set(timeZone, f);
  }
  return f;
}

/** The zone's offset from UTC at that instant, in milliseconds (local = UTC + offset). */
function offsetAt(instant: number, timeZone: string): number {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` shows `date` `time`.
 * A time skipped by a daylight-saving jump resolves to the moment after the jump; a repeated time resolves to its
 * first occurrence.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Every offset in force around that day; the instants that really show this wall time are the answers.
  const before = offsetAt(wall - 86_400_000, timeZone);
  const offsets = [...new Set([before, offsetAt(wall, timeZone), offsetAt(wall + 86_400_000, timeZone)])];
  const exact = offsets.map(o => wall - o).filter(ms => {
    const z = instantToZoned(ms, timeZone);
    return z.date === date && z.time === time;
  });
  if (exact.length) return Math.min(...exact); // a repeated hour: its first occurrence
  return wall - before; // skipped by a jump forward: the offset from before the jump lands just after it
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The business-local date and HH:MM time shown in `timeZone` at that instant. */
export function instantToZoned(instant: number, timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${pad(Number(p.hour))}:${p.minute}` };
}

/** Minutes after midnight, allowing values past 24:00 for appointments that end after midnight. */
export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
