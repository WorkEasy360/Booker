import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ChevronLeft, Clock, RefreshCw, Building2, CalendarX, Mail, Phone } from 'lucide-react';
import {
  Button, Card, CardHeader, StatusBadge, Avatar,
  Textarea, ConfirmModal, EmptyState, useToast,
} from '@/components/ui';
import { appointmentsApi, resourcesApi } from '@/api/client';
import { formatDate, formatTime, formatDuration, formatRelative } from '@/lib/utils';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { EmailHistoryCard } from './EmailHistoryCard';
import { AppointmentHistoryCard } from './AppointmentHistoryCard';
import { NotificationHistoryCard } from './NotificationHistoryCard';
import { canRecordOutcome } from './appointmentStatus';
import { useAuth } from '@/contexts/AuthContext';

interface ApiAppointmentDetail {
  id: string;
  bookingRef: string;
  serviceId: string;
  staffId: string;
  customerId: string;
  resourceIds: string[];
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  timezone: string;
  price: number;
  currency: string;
  location: string;
  notes: string;
  internalNotes: string;
  customerAnswers: Array<{ question: string; answer: string }>;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  serviceName: string;
  serviceColor: string;
  staffName: string;
  staffColor: string;
  staffTitle: string;
}

interface ApiResource {
  id: string;
  name: string;
  type: string;
}

export default function AppointmentDetailPage() {
  const { can } = useAuth();
  const canChange = can('appointments:write');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('Appointment');

  const [appointment, setAppointment] = useState<ApiAppointmentDetail | null>(null);
  const [resources, setResources] = useState<ApiResource[]>([]);
  const [internalNotes, setInternalNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelModal, setCancelModal] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);
  const [emailsVersion, setEmailsVersion] = useState(0);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      appointmentsApi.get(id) as Promise<ApiAppointmentDetail>,
      resourcesApi.list() as Promise<ApiResource[]>,
    ])
      .then(([apt, allResources]) => {
        setAppointment(apt);
        setInternalNotes(apt.internalNotes ?? '');
        setResources(allResources.filter(r => apt.resourceIds?.includes(r.id)));
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load appointment.'); setLoading(false); });
  }, [id]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="mt-8 text-center text-sm text-text-muted">Loading appointment…</div>
      </div>
    );
  }

  if (error || !appointment) {
    return (
      <div className="page-container">
        <EmptyState
          icon={<CalendarX className="w-8 h-8 text-text-muted" />}
          title={error ? 'Failed to load appointment' : 'Appointment not found'}
          description={error ?? 'This appointment does not exist or has been removed.'}
          action={{ label: 'Back to Appointments', onClick: () => navigate('/appointments') }}
        />
      </div>
    );
  }

  const isDone = appointment.status === 'completed' || appointment.status === 'cancelled';
  const isActive = appointment.status === 'scheduled' || appointment.status === 'confirmed';
  // Completed and no-show are outcomes: the API accepts them only once the appointment has started.
  const outcomeAllowed = canRecordOutcome(appointment);

  const recordOutcome = async (status: 'completed' | 'no_show') => {
    setCompleting(true);
    try {
      const updated = await appointmentsApi.update(appointment.id, { status }) as ApiAppointmentDetail;
      setAppointment(prev => prev ? { ...prev, status: updated.status } : null);
      toast.success(status === 'completed' ? 'Marked complete' : 'Marked as a no-show', 'The appointment status has been updated.');
    } catch (e: unknown) {
      toast.error('Failed to update', (e as Error).message);
    } finally {
      setCompleting(false);
    }
  };
  const handleComplete = () => recordOutcome('completed');

  const handleCancel = async () => {
    setCancelling(true);
    try {
      const updated = await appointmentsApi.update(appointment.id, { status: 'cancelled' }) as ApiAppointmentDetail & { email?: EmailOutcome };
      setAppointment(prev => prev ? { ...prev, status: updated.status } : null);
      toastWithEmailOutcome(toast, 'Appointment cancelled', '', 'cancellation', updated.email);
      setEmailsVersion(v => v + 1);
    } catch (e: unknown) {
      toast.error('Failed to cancel', (e as Error).message);
    } finally {
      setCancelling(false);
      setCancelModal(false);
    }
  };

  const handleSaveNotes = async () => {
    setSavingNotes(true);
    try {
      await appointmentsApi.update(appointment.id, { internalNotes });
      toast.success('Notes saved');
    } catch (e: unknown) {
      toast.error('Failed to save notes', (e as Error).message);
    } finally {
      setSavingNotes(false);
    }
  };

  const infoRows = [
    { label: 'Service',     value: appointment.serviceName || '—' },
    { label: 'Date',        value: formatDate(appointment.date) },
    { label: 'Time',        value: `${formatTime(appointment.startTime)} – ${formatTime(appointment.endTime)}` },
    { label: 'Duration',    value: formatDuration(appointment.duration) },
    { label: 'Location',    value: appointment.location || '—' },
    { label: 'Booking Ref', value: appointment.bookingRef },
    { label: 'Timezone',    value: appointment.timezone },
    { label: 'Created',     value: formatRelative(appointment.createdAt) },
  ];

  return (
    <div className="page-container">
      <button
        onClick={() => navigate('/appointments')}
        className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mb-4"
      >
        <ChevronLeft className="w-4 h-4" />
        Back to Appointments
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">
            {appointment.serviceName || 'Appointment'}
          </h1>
          <div className="flex items-center gap-2 mt-1.5">
            <StatusBadge status={appointment.status} />
            <span className="text-sm text-text-muted font-mono">{appointment.bookingRef}</span>
          </div>
        </div>
        {canChange && <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => navigate(`/appointments/${appointment.id}/reschedule`)} disabled={isDone}>
            Reschedule
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={completing}
            disabled={!outcomeAllowed || completing}
            onClick={handleComplete}
            aria-describedby={isActive && !outcomeAllowed ? 'appt-outcome-hint' : undefined}
          >
            Mark Complete
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!outcomeAllowed || completing}
            onClick={() => recordOutcome('no_show')}
            aria-describedby={isActive && !outcomeAllowed ? 'appt-outcome-hint' : undefined}
          >
            No-show
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={appointment.status === 'cancelled' || appointment.status === 'completed'}
            onClick={() => setCancelModal(true)}
          >
            Cancel
          </Button>
          {isActive && !outcomeAllowed && (
            <p id="appt-outcome-hint" className="w-full text-xs text-text-muted">
              Mark Complete and No-show become available once the appointment has started.
            </p>
          )}
        </div>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <Card>
            <CardHeader title="Appointment Details" />
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-4">
              {infoRows.map(({ label, value }) => (
                <div key={label}>
                  <p className="text-xs text-text-muted mb-0.5">{label}</p>
                  <p className="text-sm font-medium text-text-primary">{value}</p>
                </div>
              ))}
            </div>

            {appointment.staffName && (
              <div className="pt-4 mt-4 border-t border-border">
                <p className="text-xs text-text-muted mb-2">Staff Member</p>
                <div className="flex items-center gap-3">
                  <Avatar name={appointment.staffName} size="sm" color={appointment.staffColor} />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{appointment.staffName}</p>
                    {appointment.staffTitle && (
                      <p className="text-xs text-text-muted">{appointment.staffTitle}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {appointment.customerName && (
              <div className="pt-4 mt-4 border-t border-border">
                <p className="text-xs text-text-muted mb-2">Customer</p>
                <div className="flex items-start gap-3">
                  <Avatar name={appointment.customerName} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{appointment.customerName}</p>
                    <div className="mt-1 flex flex-col gap-1">
                      <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                        <Mail className="w-3 h-3 shrink-0" />{appointment.customerEmail}
                      </span>
                      {appointment.customerPhone && (
                        <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                          <Phone className="w-3 h-3 shrink-0" />{appointment.customerPhone}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Card>

          {appointment.customerAnswers?.length > 0 && (
            <Card>
              <CardHeader title="Customer Questions" />
              <div className="space-y-4">
                {appointment.customerAnswers.map((qa, i) => (
                  <div key={i}>
                    <p className="text-xs font-medium text-text-secondary uppercase tracking-wide mb-0.5">
                      {qa.question}
                    </p>
                    <p className="text-sm text-text-primary">{qa.answer}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Internal Notes"
              action={canChange ? (
                <Button variant="secondary" size="sm" onClick={handleSaveNotes} loading={savingNotes}>Save</Button>
              ) : undefined}
            />
            <Textarea
              rows={4}
              aria-label="Internal notes"
              placeholder={canChange ? 'Add private notes visible only to staff…' : 'No internal notes.'}
              value={internalNotes}
              readOnly={!canChange}
              onChange={e => setInternalNotes(e.target.value)}
            />
          </Card>
        </div>

        <div className="space-y-5">
          {can('appointments:read') && <EmailHistoryCard appointmentId={appointment.id} cancelled={appointment.status === 'cancelled'} version={emailsVersion} />}
          {(can('appointments:read') || can('appointments:read_own')) && (
            <NotificationHistoryCard appointmentId={appointment.id} canRetryJobs={can('emails:send')}
              version={[emailsVersion, appointment.status, appointment.date, appointment.startTime, appointment.staffId].join('|')} />
          )}
          <AppointmentHistoryCard
            appointmentId={appointment.id}
            timezone={appointment.timezone}
            version={`${appointment.status}|${appointment.date}|${appointment.startTime}|${appointment.staffId}`}
          />
          {resources.length > 0 && (
            <Card>
              <CardHeader title="Resources Booked" />
              <div className="space-y-3">
                {resources.map(r => (
                  <div key={r.id} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                      <Building2 className="w-4 h-4 text-text-muted" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">{r.name}</p>
                      <p className="text-xs text-text-muted capitalize">{r.type}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Activity" />
            <div className="space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-primary-light flex items-center justify-center shrink-0 mt-0.5">
                  <Clock className="w-3 h-3 text-primary" />
                </div>
                <div>
                  <p className="text-xs font-medium text-text-primary">Booking created</p>
                  <p className="text-xs text-text-muted mt-0.5">{formatRelative(appointment.createdAt)}</p>
                </div>
              </div>
              {appointment.updatedAt !== appointment.createdAt && (
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-primary-light flex items-center justify-center shrink-0 mt-0.5">
                    <RefreshCw className="w-3 h-3 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-text-primary">Last updated</p>
                    <p className="text-xs text-text-muted mt-0.5">{formatRelative(appointment.updatedAt)}</p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      <ConfirmModal
        isOpen={cancelModal}
        onClose={() => setCancelModal(false)}
        onConfirm={handleCancel}
        title="Cancel Appointment"
        message="Are you sure you want to cancel this appointment? This action cannot be undone."
        confirmLabel="Cancel Appointment"
        cancelLabel="Keep It"
        variant="danger"
        loading={cancelling}
      />
    </div>
  );
}
