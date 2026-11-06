import React, { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { Badge, Button, Card, CardHeader, useToast } from '@/components/ui';
import { appointmentsApi, settingsApi, type EmailDelivery } from '@/api/client';
import { adminEmailNote } from '@/lib/emailStatus';
import { formatRelative } from '@/lib/utils';

const KIND_LABEL: Record<EmailDelivery['kind'], string> = {
  confirmation: 'Confirmation',
  reschedule: 'Reschedule',
  cancellation: 'Cancellation',
  reminder: 'Reminder',
  staff_new: 'Staff alert: new booking',
  staff_cancelled: 'Staff alert: cancelled',
  staff_rescheduled: 'Staff alert: moved',
};

const STATUS: Record<EmailDelivery['status'], { variant: 'success' | 'danger' | 'default' | 'warning'; label: string }> = {
  sent: { variant: 'success', label: 'Sent' },
  failed: { variant: 'danger', label: 'Failed' },
  not_configured: { variant: 'default', label: 'Not sent — email off' },
  retrying: { variant: 'warning', label: 'Retrying' },
  unknown: { variant: 'danger', label: 'Outcome unknown' },
};

export function EmailHistoryCard({ appointmentId, cancelled, version }: { appointmentId: string; cancelled: boolean; version: number }) {
  const toast = useToast();
  const [deliveries, setDeliveries] = useState<EmailDelivery[] | null>(null);
  const [sending, setSending] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    Promise.all([appointmentsApi.emails(appointmentId), settingsApi.emailStatus()])
      .then(([list, status]) => { setDeliveries(list); setSending(status.sending); })
      .catch((e: Error) => setError(e.message || 'Could not load email history'));
  }, [appointmentId, version, reload]);

  async function resend() {
    const kind = cancelled ? 'cancellation' : 'confirmation';
    setResending(true);
    try {
      const outcome = await appointmentsApi.resendEmail(appointmentId, kind);
      const note = adminEmailNote(kind, outcome);
      if (note?.ok) toast.success('Email sent', note.text);
      else if (note) toast.warning(outcome.status === 'retrying' ? 'Email not sent yet' : 'Email not sent', note.text);
      setReload(r => r + 1);
    } catch (e) {
      toast.error('Could not resend', (e as Error).message);
    } finally {
      setResending(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Customer Emails"
        action={
          <Button size="sm" variant="secondary" icon={<Mail className="w-3.5 h-3.5" />} onClick={resend} loading={resending} disabled={sending === false}>
            Resend {cancelled ? 'cancellation' : 'confirmation'}
          </Button>
        }
      />
      {sending === false && (
        <p className="mb-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
          Email delivery is not configured on the server, so customers are not emailed. See the setup guide in Notifications.
        </p>
      )}
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : deliveries === null ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-text-muted">No emails have been attempted for this appointment.</p>
      ) : (
        <ul className="space-y-2">
          {deliveries.map(d => (
            <li key={d.id} className="flex items-start justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="text-text-primary">{KIND_LABEL[d.kind]}</p>
                <p className="text-xs text-text-muted">
                  {formatRelative(d.createdAt)}{d.error ? ` · ${d.error}` : ''}
                  {d.nextAttemptAt ? ` · next try ${formatRelative(d.nextAttemptAt)}` : ''}
                </p>
              </div>
              <Badge variant={STATUS[d.status].variant} size="sm">{STATUS[d.status].label}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
