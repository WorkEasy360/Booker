import React, { useEffect, useState } from 'react';
import { Card, CardHeader } from '@/components/ui';
import { appointmentsApi, type AppointmentHistoryEntry } from '@/api/client';
import { formatDate, formatTime } from '@/lib/utils';
import { DISPLAY_LOCALE } from '@/lib/regional';
import { describeActor, describeEntry } from './appointmentHistory';

// Read-only: entries cannot be edited or removed (the API has no such route and the database refuses).

function when(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(DISPLAY_LOCALE, {
      day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** `version` changes whenever the appointment does, so new entries appear without a reload. */
export function AppointmentHistoryCard({ appointmentId, timezone, version }: { appointmentId: string; timezone: string; version: string }) {
  const [entries, setEntries] = useState<AppointmentHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    appointmentsApi.history(appointmentId)
      .then(list => { if (!cancelled) setEntries(list); })
      .catch((e: Error) => { if (!cancelled) setError(e.message || 'Could not load the history'); });
    return () => { cancelled = true; };
  }, [appointmentId, version]);

  return (
    <Card>
      <CardHeader title="History" />
      {error ? (
        <p className="text-sm text-red-600" role="alert">{error}</p>
      ) : entries === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          {entries.length > 0 && (
            <ol className="space-y-3" aria-label="Appointment history, oldest first">
              {entries.map(e => {
                const { title, detail } = describeEntry(e, { date: d => formatDate(d), time: t => formatTime(t) });
                return (
                  <li key={e.id} className="text-sm border-l-2 border-border pl-3">
                    <p className="font-medium text-text-primary">{title}</p>
                    <p className="text-xs text-text-secondary">{detail}</p>
                    <p className="text-xs text-text-muted">
                      {describeActor(e.actor)} · <time dateTime={e.createdAt}>{when(e.createdAt, timezone)}</time>
                    </p>
                  </li>
                );
              })}
            </ol>
          )}
          {entries[0]?.action !== 'created' && (
            <p className={entries.length ? 'text-xs text-text-muted mt-3' : 'text-sm text-text-muted'}>
              Changes made before history recording began are not shown.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
