import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ChevronLeft, CalendarDays } from 'lucide-react';
import { Button, Input, PageHeader, useToast } from '@/components/ui';
import { appointmentsApi } from '@/api/client';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { formatDate, formatTime, todayInTimeZone } from '@/lib/utils';

/** A start time from the server's availability for the appointment's staff member and service. */
interface ApiSlot { start: string; available: boolean }

interface ApiAppointment {
  timezone?: string;
  id: string;
  serviceId: string;
  staffId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  duration: number;
  bookingRef?: string;
  serviceName?: string;
  staffName?: string;
}

function calcEndTime(start: string, durationMins: number): string {
  const [hh, mm] = start.split(':').map(Number);
  const total = hh * 60 + mm + durationMins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function ReschedulePage() {
  usePageTitle('Reschedule Appointment');
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [appointment, setAppointment] = useState<ApiAppointment | null>(null);
  const [loading, setLoading]         = useState(true);
  const [date, setDate]               = useState('');
  const [startTime, setStartTime]     = useState('09:00');
  const [saving, setSaving]           = useState(false);
  const [errors, setErrors]           = useState<{ date?: string; startTime?: string }>({});
  // Only times the server would accept are offered: the same availability as the New Appointment form, with this
  // appointment's own slot not counted as busy.
  const [times, setTimes]             = useState<string[]>([]);
  const [timesState, setTimesState]   = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    if (!id) return;
    (appointmentsApi.get(id) as Promise<ApiAppointment>)
      .then(apt => {
        setAppointment(apt);
        setDate(apt.date);
        setStartTime(apt.startTime);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [id]);

  useEffect(() => {
    if (!appointment || !date) { setTimes([]); setTimesState('idle'); return; }
    let cancelled = false;
    setTimesState('loading');
    (appointmentsApi.availability({ date, serviceId: appointment.serviceId, staffId: appointment.staffId, excludeAppointmentId: appointment.id }) as Promise<ApiSlot[]>)
      .then(list => {
        if (cancelled) return;
        const free = list.filter(s => s.available).map(s => s.start);
        setTimes(free);
        setTimesState('ready');
        setStartTime(prev => (free.includes(prev) ? prev : free[0] ?? ''));
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setTimes([]);
        setTimesState('error');
        toast.error('Could not load available times', e.message);
      });
    return () => { cancelled = true; };
  }, [appointment, date]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading…</div></div>;
  }

  if (!appointment) {
    return (
      <div className="page-container">
        <div className="text-center py-20 text-text-muted">Appointment not found.</div>
      </div>
    );
  }

  if (appointment.status === 'cancelled' || appointment.status === 'completed') {
    return (
      <div className="page-container">
        <button onClick={() => navigate(`/appointments/${id}`)} className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary mb-4">
          <ChevronLeft className="w-4 h-4" />Back
        </button>
        <div className="card p-8 text-center max-w-md mx-auto mt-8">
          <CalendarDays className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-sm font-semibold text-text-primary mb-1">Cannot reschedule</p>
          <p className="text-sm text-text-muted">This appointment is {appointment.status} and cannot be rescheduled.</p>
          <Button variant="secondary" className="mt-4" onClick={() => navigate(`/appointments/${id}`)}>Back to Appointment</Button>
        </div>
      </div>
    );
  }

  function validate(): boolean {
    const e: { date?: string; startTime?: string } = {};
    if (!date) {
      e.date = 'Please select a new date.';
    } else {
      if (date < todayInTimeZone(appointment?.timezone)) e.date = 'Cannot reschedule to a date in the past.';
    }
    if (!startTime) e.startTime = 'Please select a start time.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSave() {
    if (!appointment || !validate()) return;
    setSaving(true);
    const endTime = calcEndTime(startTime, appointment.duration);
    try {
      const updated = await appointmentsApi.update(appointment.id, { date, startTime, endTime }) as { email?: EmailOutcome };
      toastWithEmailOutcome(toast, 'Appointment rescheduled', `Moved to ${formatDate(date)} at ${formatTime(startTime)}.`, 'reschedule', updated.email);
      navigate(`/appointments/${appointment.id}`);
    } catch (e: unknown) {
      toast.error('Could not reschedule', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const endTime = calcEndTime(startTime, appointment.duration);

  return (
    <div className="page-container">
      <button
        onClick={() => navigate(`/appointments/${id}`)}
        className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mb-4"
      >
        <ChevronLeft className="w-4 h-4" />
        Back to Appointment
      </button>

      <PageHeader
        title="Reschedule Appointment"
        description={`${appointment.serviceName ?? 'Appointment'} · Ref: ${appointment.bookingRef ?? appointment.id}`}
        breadcrumbs={[
          { label: 'Appointments', href: '/appointments' },
          { label: appointment.bookingRef ?? appointment.id, href: `/appointments/${appointment.id}` },
          { label: 'Reschedule' },
        ]}
      />

      <div className="mt-6 max-w-lg">
        <div className="card p-4 mb-5 bg-amber-50 border-amber-200">
          <p className="text-xs font-semibold text-amber-800 uppercase tracking-wide mb-2">Current Booking</p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-xs text-amber-700">Date</p>
              <p className="font-medium text-amber-900">{formatDate(appointment.date)}</p>
            </div>
            <div>
              <p className="text-xs text-amber-700">Time</p>
              <p className="font-medium text-amber-900">{formatTime(appointment.startTime)} – {formatTime(appointment.endTime)}</p>
            </div>
            {appointment.serviceName && (
              <div>
                <p className="text-xs text-amber-700">Service</p>
                <p className="font-medium text-amber-900">{appointment.serviceName}</p>
              </div>
            )}
            {appointment.staffName && (
              <div>
                <p className="text-xs text-amber-700">Staff</p>
                <p className="font-medium text-amber-900">{appointment.staffName}</p>
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-primary">New Date & Time</h2>

          <Input
            label="New Date"
            type="date"
            required
            value={date}
            min={todayInTimeZone(appointment.timezone)}
            onChange={e => { setDate(e.target.value); setErrors(prev => ({ ...prev, date: undefined })); }}
            error={errors.date}
          />

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              Start Time <span className="text-red-500">*</span>
            </label>
            <select
              className="input-field w-full"
              value={startTime}
              disabled={!times.length}
              onChange={e => { setStartTime(e.target.value); setErrors(prev => ({ ...prev, startTime: undefined })); }}
            >
              {times.length ? times.map(t => (
                <option key={t} value={t}>{t}</option>
              )) : (
                <option value="">
                  {timesState === 'loading' ? 'Loading available times…'
                    : timesState === 'error' ? 'Could not load available times'
                    : 'No free times on this date'}
                </option>
              )}
            </select>
            {errors.startTime && <p className="mt-1 text-xs text-red-500">{errors.startTime}</p>}
          </div>

          <div className="pt-2 border-t border-border">
            <p className="text-xs text-text-muted">
              Duration: {appointment.duration} min — appointment will end at <span className="font-medium text-text-primary">{formatTime(endTime)}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <Button onClick={handleSave} loading={saving}>
            Confirm Reschedule
          </Button>
          <Button variant="secondary" onClick={() => navigate(`/appointments/${id}`)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
