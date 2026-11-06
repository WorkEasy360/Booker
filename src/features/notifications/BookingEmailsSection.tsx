import React, { useEffect, useState } from 'react';
import { Mail, CheckCircle, AlertTriangle } from 'lucide-react';
import { settingsApi } from '@/api/client';

const BUILT_IN = [
  { name: 'Booking confirmation', when: 'After a booking is made online or by staff' },
  { name: 'Reschedule notice', when: 'After the date or time changes (online or by staff)' },
  { name: 'Cancellation notice', when: 'After a booking is cancelled (online or by staff)' },
  { name: 'Reminder (if turned on below)', when: 'The chosen number of hours before the booking' },
  { name: 'Staff alert (if turned on below)', when: 'To the staff member, when a booking is made, moved or cancelled' },
];

export function BookingEmailsSection() {
  const [status, setStatus] = useState<{ transport: string; sending: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    settingsApi.emailStatus().then(setStatus).catch((e: Error) => setError(e.message || 'Could not load email status'));
  }, []);

  return (
    <section aria-labelledby="booking-emails-heading" className="mt-4 bg-surface rounded-xl border border-border p-5">
      <div className="flex items-center gap-2 mb-1">
        <Mail className="w-4 h-4 text-primary" aria-hidden="true" />
        <h2 id="booking-emails-heading" className="text-sm font-semibold text-text-primary">Booking emails to customers</h2>
      </div>
      <p className="text-xs text-text-secondary mb-4">
        These are sent automatically using built-in templates that include the booking reference, service, date, time,
        time zone and a link to manage the booking. Every attempt is recorded on the appointment page.
      </p>

      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : !status ? (
        <p className="text-sm text-text-muted">Checking email setup…</p>
      ) : status.sending ? (
        <p role="status" className="flex items-start gap-2 text-sm p-3 rounded-lg bg-emerald-50 text-emerald-800 mb-4">
          <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          Email delivery is configured (SMTP). Customers receive the emails below.
        </p>
      ) : (
        <div role="status" className="text-sm p-3 rounded-lg bg-amber-50 text-amber-900 mb-4 space-y-2">
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
            {status.transport === 'memory'
              ? 'The server is in test mode: emails are captured in memory and not delivered.'
              : 'Email delivery is not configured, so customers are not emailed.'}
          </p>
          <p className="text-xs">
            A server administrator can enable it by setting these variables in <code>server/.env</code> and restarting the API:
            {' '}<code>EMAIL_TRANSPORT=smtp</code>, <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_SECURE</code>,
            {' '}<code>SMTP_USER</code>, <code>SMTP_PASS</code>, <code>EMAIL_FROM</code> and <code>PUBLIC_APP_URL</code>.
          </p>
        </div>
      )}

      <ul className="divide-y divide-border">
        {BUILT_IN.map(e => (
          <li key={e.name} className="py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
            <span className="text-sm text-text-primary">{e.name}</span>
            <span className="text-xs text-text-muted">{e.when}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
