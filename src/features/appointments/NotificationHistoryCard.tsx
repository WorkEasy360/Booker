import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge, Button, Card, CardHeader, useToast } from '@/components/ui';
import { notificationPlatformApi, type NotificationJob } from '@/api/client';
import { formatDate, formatRelative } from '@/lib/utils';
import { CHANNEL_LABEL, EVENT_LABEL, canRetry, jobStatusLabel } from '../notifications/notificationLabels';

// Every message and calendar update planned for this booking, per recipient and channel, with each attempt. Statuses
// are the recorded ones: "Sent" is the provider accepting it; delivered and read come only from the provider's report.
// The customer's own booking emails are listed in "Customer Emails" above.

export function NotificationHistoryCard({ appointmentId, version, canRetryJobs }: { appointmentId: string; version: string; canRetryJobs: boolean }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<NotificationJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setError(null);
    notificationPlatformApi.appointmentJobs(appointmentId).then(setJobs).catch((e: Error) => setError(e.message || 'Could not load notifications'));
  }, [appointmentId, version, reload]);

  async function retry(job: NotificationJob) {
    setRetrying(job.id);
    try {
      await notificationPlatformApi.retryJob(job.id);
      toast.success('Queued again', `${CHANNEL_LABEL[job.channel]} to ${job.recipient} will be tried again shortly.`);
      setReload(r => r + 1);
    } catch (e) {
      toast.error('Could not retry', (e as Error).message);
    } finally {
      setRetrying(null);
    }
  }

  return (
    <Card>
      <CardHeader title="Notifications" />
      {error ? <p className="text-sm text-red-600">{error}</p>
        : jobs === null ? <p className="text-sm text-text-muted">Loading…</p>
        : jobs.length === 0 ? <p className="text-sm text-text-muted">No text messages, WhatsApp messages, staff or business alerts, reminders or calendar updates for this booking.</p>
        : (
          <ul className="space-y-2.5" aria-label="Notifications for this booking">
            {jobs.map(j => {
              const st = jobStatusLabel(j);
              const detail = j.reason ?? j.lastError;
              return (
                <li key={j.id} className="text-sm" data-job={`${j.event}:${j.role}:${j.channel}`} data-job-status={j.status}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-text-primary">{EVENT_LABEL[j.event]} · {CHANNEL_LABEL[j.channel]} · {j.recipient}</p>
                      <p className="text-xs text-text-muted">
                        {j.status === 'pending' && j.scheduledFor ? `Due ${formatDate(j.scheduledFor, 'MMM d, h:mm a')}` : formatRelative(j.createdAt)}
                        {j.attempts > 0 ? ` · ${j.attempts} attempt${j.attempts === 1 ? '' : 's'}` : ''}
                        {j.nextAttemptAt && j.attempts > 0 ? ` · next try ${formatRelative(j.nextAttemptAt)}` : ''}
                        {detail ? ` · ${detail}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge size="sm" variant={st.tone === 'info' ? 'info' : st.tone}>{st.label}</Badge>
                      {canRetryJobs && canRetry(j.status) && (
                        <Button size="sm" variant="ghost" icon={<RefreshCw className="w-3.5 h-3.5" />} loading={retrying === j.id}
                          aria-label={`Retry ${CHANNEL_LABEL[j.channel]} to ${j.recipient}`} onClick={() => retry(j)}>Retry</Button>
                      )}
                    </div>
                  </div>
                  {j.status === 'unknown' && (
                    <p className="text-xs text-amber-800 mt-1">The provider did not answer in time, so this may already have been sent. Retry only if you are sure it was not.</p>
                  )}
                  {j.history.length > 0 && (
                    <button type="button" className="text-xs text-primary hover:underline mt-0.5" aria-expanded={open === j.id} onClick={() => setOpen(o => (o === j.id ? null : j.id))}>
                      {open === j.id ? 'Hide attempts' : 'Show attempts'}
                    </button>
                  )}
                  {open === j.id && (
                    <ol className="mt-1 ml-3 text-xs text-text-secondary space-y-0.5">
                      {j.history.map(h => (
                        <li key={h.attempt}>#{h.attempt} · {h.outcome}{h.at ? ` · ${formatDate(h.at, 'MMM d, h:mm:ss a')}` : ''}{h.error ? ` · ${h.error}` : ''}</li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </Card>
  );
}
