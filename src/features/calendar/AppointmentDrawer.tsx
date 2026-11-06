import React, { useState } from 'react';
import { CalendarDays, Clock, MapPin } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button, Drawer, StatusBadge, Avatar, ConfirmModal, useToast } from '@/components/ui';
import { appointmentsApi } from '@/api/client';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { formatTime, formatDate, formatCurrency, formatDuration } from '@/lib/utils';

interface DrawerAppointment {
  id: string;
  bookingRef: string;
  status: string;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  price: number;
  currency: string;
  location: string;
  notes?: string;
}

interface DrawerService {
  name: string;
  color: string;
  duration: number;
  price: number;
  currency: string;
}

interface DrawerStaff {
  name: string;
  color: string;
  title?: string;
}

interface DrawerCustomer {
  name: string;
  email: string;
}

interface AppointmentDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  appointment: DrawerAppointment | null;
  staff: DrawerStaff | null;
  service: DrawerService | null;
  customer: DrawerCustomer | null;
  /** Whether the signed-in user may cancel or reschedule. */
  canChange: boolean;
  /** Called after the appointment was cancelled on the server, so the calendar can reload. */
  onChanged: () => void;
}

export function AppointmentDrawer({
  isOpen, onClose, appointment: apt, staff: aptStaff, service: aptSvc, customer: aptCust, canChange, onChanged,
}: AppointmentDrawerProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const closed = apt?.status === 'cancelled' || apt?.status === 'completed';

  async function cancelAppointment() {
    if (!apt) return;
    setCancelling(true);
    try {
      const updated = await appointmentsApi.update(apt.id, { status: 'cancelled' }) as { email?: EmailOutcome };
      toastWithEmailOutcome(toast, 'Appointment cancelled', `${aptSvc?.name ?? 'Appointment'} on ${formatDate(apt.date)}.`, 'cancellation', updated.email);
      setConfirmCancel(false);
      onChanged();
      onClose();
    } catch (e) {
      toast.error('Could not cancel the appointment', (e as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title="Appointment Details"
      subtitle={apt ? `Ref: ${apt.bookingRef}` : undefined}
      size="sm"
      footer={
        apt ? (
          <>
            {canChange && (
              <>
                <Button variant="danger" size="sm" disabled={closed} onClick={() => setConfirmCancel(true)}>
                  Cancel
                </Button>
                <Button variant="secondary" size="sm" disabled={closed}
                  onClick={() => { onClose(); navigate(`/appointments/${apt.id}/reschedule`); }}>
                  Reschedule
                </Button>
              </>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => { onClose(); navigate(`/appointments/${apt.id}`); }}
            >
              View Full Detail
            </Button>
          </>
        ) : null
      }
    >
      {apt && aptSvc && aptCust ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <StatusBadge status={apt.status} />
            <span className="text-xs text-text-muted font-mono">{apt.bookingRef}</span>
          </div>

          <div className="flex items-start gap-3 p-3 rounded-lg bg-muted">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: `${aptSvc.color}20` }}
            >
              <CalendarDays className="w-4 h-4" style={{ color: aptSvc.color }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text-primary truncate">{aptSvc.name}</p>
              <p className="text-xs text-text-secondary">
                {formatDuration(apt.duration)} · {formatCurrency(apt.price, apt.currency)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Clock className="w-4 h-4 text-text-muted shrink-0" />
            <div>
              <p className="text-sm font-medium text-text-primary">{formatDate(apt.date)}</p>
              <p className="text-xs text-text-secondary">
                {formatTime(apt.startTime)} – {formatTime(apt.endTime)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Avatar name={aptCust.name} size="sm" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">{aptCust.name}</p>
              <p className="text-xs text-text-secondary truncate">{aptCust.email}</p>
            </div>
          </div>

          {aptStaff && (
            <div className="flex items-center gap-3">
              <Avatar name={aptStaff.name} size="sm" color={aptStaff.color} />
              <div>
                <p className="text-sm font-medium text-text-primary">{aptStaff.name}</p>
                {aptStaff.title && <p className="text-xs text-text-secondary">{aptStaff.title}</p>}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3">
            <MapPin className="w-4 h-4 text-text-muted shrink-0" />
            <p className="text-sm text-text-secondary">{apt.location || '—'}</p>
          </div>

          {apt.notes && (
            <div className="p-3 rounded-lg bg-muted">
              <p className="text-xs font-semibold text-text-secondary mb-1 uppercase tracking-wide">Notes</p>
              <p className="text-sm text-text-primary">{apt.notes}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-text-muted">No appointment selected.</p>
      )}

      <ConfirmModal
        isOpen={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={cancelAppointment}
        title="Cancel appointment"
        message={apt ? `Cancel ${aptSvc?.name ?? 'this appointment'} with ${aptCust?.name ?? 'the customer'} on ${formatDate(apt.date)} at ${formatTime(apt.startTime)}? The customer is emailed if email is set up.` : ''}
        confirmLabel="Cancel appointment"
        cancelLabel="Keep it"
        variant="danger"
        loading={cancelling}
      />
    </Drawer>
  );
}
