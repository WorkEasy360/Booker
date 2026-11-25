import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, CalendarDays, CalendarX, CalendarClock, PencilLine, CircleCheck, UserX, XCircle,
  Phone, Mail, Clock, MapPin, Globe2, Lock,
} from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { StatusBadge, ConfirmModal, useToast } from '@/components/ui';
import { appointmentsApi } from '@/api/client';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { useAuth } from '@/contexts/AuthContext';
import { EmailHistoryCard } from './EmailHistoryCard';
import { AppointmentHistoryCard } from './AppointmentHistoryCard';
import { NotificationHistoryCard } from './NotificationHistoryCard';
import { canRecordOutcome } from './appointmentStatus';
import { clock, longDay } from './listModel';

interface ApiAppointmentDetail {
  id: string;
  bookingRef: string;
  serviceId: string;
  staffId: string;
  customerId: string;
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  timezone: string;
  location: string;
  internalNotes: string;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  serviceName: string;
  staffName: string;
}

const ACTION = 'inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-[15px] font-semibold transition-colors disabled:opacity-45 disabled:cursor-not-allowed';

export default function AppointmentDetailPage() {
  const { can } = useAuth();
  const canChange = can('appointments:write');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('Appointment');

  const [appointment, setAppointment] = useState<ApiAppointmentDetail | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelModal, setCancelModal] = useState(false);
  const [busy, setBusy] = useState<null | 'completed' | 'no_show' | 'cancelled' | 'note'>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    if (!id) return;
    (appointmentsApi.get(id) as Promise<ApiAppointmentDetail>)
      .then(apt => { setAppointment(apt); setNote(apt.internalNotes ?? ''); setError(null); })
      .catch((e: Error) => setError(e.message || 'Failed to load appointment.'))
      .finally(() => setLoading(false));
  }, [id]);
  useEffect(load, [load]);

  if (loading) return <div className="page-container"><div className="panel p-10 text-center text-sm text-text-muted">Loading appointment…</div></div>;
  if (error || !appointment) {
    return (
      <div className="page-container">
        <div className="panel p-10 text-center">
          <CalendarX className="w-10 h-10 text-text-muted mx-auto" aria-hidden="true" />
          <p className="mt-3 text-lg font-semibold text-text-primary">{error ? 'Failed to load appointment' : 'Appointment not found'}</p>
          <p className="mt-1 text-sm text-text-secondary">{error ?? 'This appointment does not exist.'}</p>
          <Link to="/appointments" className="btn-secondary mt-5">Back to Appointments</Link>
        </div>
      </div>
    );
  }

  const status = appointment.status === 'confirmed' ? 'scheduled' : appointment.status;
  const isScheduled = status === 'scheduled';
  // Completed and No-show are outcomes: available once the appointment has started (the API checks it too).
  const outcomeAllowed = canRecordOutcome(appointment);

  async function setStatus(next: 'completed' | 'no_show' | 'cancelled') {
    setBusy(next);
    try {
      const updated = await appointmentsApi.update(appointment!.id, { status: next }) as ApiAppointmentDetail & { email?: EmailOutcome };
      setAppointment(prev => prev ? { ...prev, status: updated.status } : prev);
      if (next === 'cancelled') toastWithEmailOutcome(toast, 'Appointment cancelled', 'The time slot is free again and the reminder was stopped.', 'cancellation', appointment!.customerEmail ? updated.email : undefined);
      else toast.success(next === 'completed' ? 'Marked as completed' : 'Marked as no-show');
      setVersion(v => v + 1);
    } catch (e) {
      toast.error('Could not update the appointment', (e as Error).message);
    } finally {
      setBusy(null);
      setCancelModal(false);
    }
  }

  async function saveNote() {
    setBusy('note');
    try {
      await appointmentsApi.update(appointment!.id, { internalNotes: note });
      setAppointment(prev => prev ? { ...prev, internalNotes: note } : prev);
      toast.success('Internal note saved');
    } catch (e) {
      toast.error('Could not save the note', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const details: Array<{ icon: React.ElementType; label: string; value: string }> = [
    { icon: CalendarDays, label: 'Date', value: longDay(appointment.date) },
    { icon: Clock, label: 'Start – End', value: `${clock(appointment.startTime)} – ${clock(appointment.endTime)} (${appointment.duration} min)` },
    { icon: Globe2, label: 'Timezone', value: appointment.timezone },
    ...(appointment.location ? [{ icon: MapPin, label: 'Location', value: appointment.location }] : []),
  ];

  return (
    <div className="page-container max-w-[1200px]">
      <Link to="/appointments" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary mb-4">
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />Back to Appointments
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <CalendarDays className="w-10 h-10 sm:w-11 sm:h-11 text-primary shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-[30px] font-bold text-text-primary tracking-tight">{appointment.serviceName || 'Appointment'}</h1>
            <div className="flex flex-wrap items-center gap-2.5 mt-1">
              <StatusBadge status={appointment.status} />
              <span className="text-sm text-text-secondary">Ref <span className="font-mono">{appointment.bookingRef}</span></span>
            </div>
          </div>
        </div>
        {canChange && (
          <div className="flex flex-wrap gap-2">
            <button disabled={!isScheduled} onClick={() => navigate(`/appointments/${appointment.id}/edit`)} className={`${ACTION} border border-border bg-white text-text-primary hover:bg-gray-50`}>
              <PencilLine className="w-[18px] h-[18px]" aria-hidden="true" />Edit
            </button>
            <button disabled={!isScheduled} onClick={() => navigate(`/appointments/${appointment.id}/reschedule`)} className={`${ACTION} border border-border bg-white text-text-primary hover:bg-gray-50`}>
              <CalendarClock className="w-[18px] h-[18px]" aria-hidden="true" />Reschedule
            </button>
            <button disabled={!outcomeAllowed || !!busy} onClick={() => setStatus('completed')} className={`${ACTION} bg-brand-button text-white shadow-button hover:brightness-105`}
              aria-describedby={isScheduled && !outcomeAllowed ? 'outcome-hint' : undefined}>
              <CircleCheck className="w-[18px] h-[18px]" aria-hidden="true" />Complete
            </button>
            <button disabled={!outcomeAllowed || !!busy} onClick={() => setStatus('no_show')} className={`${ACTION} border border-border bg-white text-text-primary hover:bg-gray-50`}
              aria-describedby={isScheduled && !outcomeAllowed ? 'outcome-hint' : undefined}>
              <UserX className="w-[18px] h-[18px]" aria-hidden="true" />Mark No-show
            </button>
            <button disabled={!isScheduled || !!busy} onClick={() => setCancelModal(true)} className={`${ACTION} border border-red-200 bg-white text-red-600 hover:bg-red-50`}>
              <XCircle className="w-[18px] h-[18px]" aria-hidden="true" />Cancel
            </button>
          </div>
        )}
      </div>
      {canChange && isScheduled && !outcomeAllowed && (
        <p id="outcome-hint" className="mt-2 text-sm text-text-muted sm:text-right">Complete and Mark No-show become available after the start time.</p>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
        <div className="space-y-5 min-w-0">
          <section className="panel p-5 sm:p-6" aria-labelledby="apt-when">
            <h2 id="apt-when" className="text-[18px] font-bold text-text-primary mb-4">Appointment</h2>
            <dl className="grid gap-4 sm:grid-cols-2">
              {details.map(d => (
                <div key={d.label} className="flex items-start gap-3">
                  <span className="icon-tile w-10 h-10 bg-primary-light"><d.icon className="w-5 h-5 text-primary" aria-hidden="true" /></span>
                  <div>
                    <dt className="text-sm text-text-secondary">{d.label}</dt>
                    <dd className="text-[15px] font-semibold text-text-primary">{d.value}</dd>
                  </div>
                </div>
              ))}
            </dl>
            <div className="mt-5 pt-5 border-t border-border grid gap-5 sm:grid-cols-2">
              <div>
                <p className="text-sm text-text-secondary mb-1">Customer</p>
                <Link to={`/customers/${appointment.customerId}`} className="text-[16px] font-semibold text-text-primary hover:text-primary">{appointment.customerName}</Link>
                <div className="mt-1.5 space-y-1 text-sm text-text-secondary">
                  {appointment.customerPhone && <a href={`tel:${appointment.customerPhone}`} className="flex items-center gap-2 hover:text-primary"><Phone className="w-4 h-4" aria-hidden="true" />{appointment.customerPhone}</a>}
                  {appointment.customerEmail
                    ? <a href={`mailto:${appointment.customerEmail}`} className="flex items-center gap-2 hover:text-primary"><Mail className="w-4 h-4" aria-hidden="true" />{appointment.customerEmail}</a>
                    : <p className="text-[13px] text-text-muted">No email on file — email updates cannot be sent.</p>}
                </div>
              </div>
              <div>
                <p className="text-sm text-text-secondary mb-1">Staff</p>
                <p className="text-[16px] font-semibold text-text-primary">{appointment.staffName || '—'}</p>
              </div>
            </div>
          </section>

          <section className="panel p-5 sm:p-6" aria-labelledby="apt-note">
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 id="apt-note" className="text-[18px] font-bold text-text-primary flex items-center gap-2">Internal note <Lock className="w-4 h-4 text-text-muted" aria-label="Private" /></h2>
              {canChange && note !== (appointment.internalNotes ?? '') && (
                <button onClick={saveNote} disabled={busy === 'note'} className="btn-primary h-10">{busy === 'note' ? 'Saving…' : 'Save note'}</button>
              )}
            </div>
            <textarea
              rows={3}
              maxLength={5000}
              aria-label="Internal note"
              placeholder={canChange ? 'Optional private note, visible only to your team…' : 'No internal note.'}
              value={note}
              readOnly={!canChange}
              onChange={e => setNote(e.target.value)}
              className="w-full px-3.5 py-3 text-[15px] bg-white border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            />
            <p className="mt-1.5 text-xs text-text-muted">Never shown to the customer or included in notifications.</p>
          </section>
        </div>

        <div className="space-y-5">
          {(can('appointments:read') || can('appointments:read_own')) && (
            <NotificationHistoryCard appointmentId={appointment.id} canRetryJobs={can('emails:send')}
              version={[version, appointment.status, appointment.date, appointment.startTime, appointment.staffId].join('|')} />
          )}
          {can('appointments:read') && <EmailHistoryCard appointmentId={appointment.id} cancelled={status === 'cancelled'} version={version} />}
          <AppointmentHistoryCard appointmentId={appointment.id} timezone={appointment.timezone}
            version={`${appointment.status}|${appointment.date}|${appointment.startTime}|${appointment.staffId}`} />
        </div>
      </div>

      <ConfirmModal
        isOpen={cancelModal}
        onClose={() => setCancelModal(false)}
        onConfirm={() => setStatus('cancelled')}
        title="Cancel appointment?"
        message={`${appointment.customerName} · ${longDay(appointment.date)} at ${clock(appointment.startTime)}. The time slot becomes free and the reminder is stopped. The appointment stays in history as Cancelled.`}
        confirmLabel="Cancel Appointment"
        cancelLabel="Keep It"
        variant="danger"
        loading={busy === 'cancelled'}
      />
    </div>
  );
}
