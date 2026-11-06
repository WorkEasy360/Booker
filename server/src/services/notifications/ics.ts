import db from '../../db/init';
import { zonedToInstant } from '../zoned-time';
import { DEFAULT_TIMEZONE } from '../business-locale';

// Calendar files (RFC 5545) for an appointment: the "Add to calendar" download and the attachment on booking emails.
// One UID per appointment, so a calendar app that already has the event updates it; SEQUENCE grows with every change
// (from the appointment's history), and a cancelled booking produces a CANCEL with the same UID. Times are written in
// UTC (the "Z" form), which every calendar app converts to the viewer's own zone; the business's zone is named in the
// description. A file is only a file: nothing is added to anyone's calendar until they open it.

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets are folded (CRLF + space), never inside a UTF-8 character. */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let size = 0;
  const limit = () => (parts.length ? 74 : 75);
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (size + n > limit()) { parts.push(current); current = ''; size = 0; }
    current += ch; size += n;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface IcsInput {
  uid: string; sequence: number; startMs: number; endMs: number; summary: string; description: string; location?: string;
  url?: string; cancelled: boolean; organizerName?: string; stampMs?: number;
}

export function buildIcs(i: IcsInput): string {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//WorkEasy360//Booking//EN', 'CALSCALE:GREGORIAN',
    `METHOD:${i.cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:${i.uid}`,
    `SEQUENCE:${i.sequence}`,
    `DTSTAMP:${utc(i.stampMs ?? Date.now())}`,
    `DTSTART:${utc(i.startMs)}`,
    `DTEND:${utc(i.endMs)}`,
    `SUMMARY:${escapeText(i.summary)}`,
    `DESCRIPTION:${escapeText(i.description)}`,
    ...(i.location ? [`LOCATION:${escapeText(i.location)}`] : []),
    ...(i.url ? [`URL:${i.url}`] : []),
    ...(i.organizerName ? [`ORGANIZER;CN=${escapeText(i.organizerName).replace(/"/g, '')}:mailto:noreply@workeasy360.invalid`] : []),
    `STATUS:${i.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** The calendar file for one appointment as it is now, for the customer (no staff contact details). */
export function appointmentIcs(appointmentId: string, opts: { manageUrl?: string } = {}): { filename: string; content: string } | null {
  const a = db.prepare(
    `SELECT a.id, a.booking_ref, a.status, a.date, a.start_time, a.end_time, a.timezone, a.location, a.updated_at,
            s.name AS service, st.name AS staff, o.name AS business
     FROM appointments a JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id JOIN organizations o ON o.id = a.organization_id
     WHERE a.id = ?`
  ).get(appointmentId) as Record<string, string> | undefined;
  if (!a) return null;
  const tz = a.timezone || DEFAULT_TIMEZONE;
  const sequence = (db.prepare('SELECT COUNT(*) c FROM appointment_history WHERE appointment_id = ?').get(appointmentId) as { c: number }).c;
  const content = buildIcs({
    uid: `${a.id}@workeasy360`,
    sequence,
    startMs: zonedToInstant(a.date, a.start_time, tz),
    endMs: zonedToInstant(a.date, a.end_time === '24:00' ? '23:59' : a.end_time, tz) + (a.end_time === '24:00' ? 60_000 : 0),
    summary: `${a.service} — ${a.business}`,
    description: [`Booking reference: ${a.booking_ref}`, `With: ${a.staff}`, `Time zone: ${tz}`, ...(opts.manageUrl ? [`Manage your booking: ${opts.manageUrl}`] : [])].join('\n'),
    location: a.location || undefined,
    url: opts.manageUrl,
    cancelled: a.status === 'cancelled',
    organizerName: a.business,
    stampMs: Date.parse(a.updated_at) || Date.now(),
  });
  return { filename: `booking-${a.booking_ref}.ics`, content };
}
