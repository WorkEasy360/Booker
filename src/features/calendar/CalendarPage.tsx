import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Calendar, dateFnsLocalizer, Views } from 'react-big-calendar';
import type { View, SlotInfo } from 'react-big-calendar';
import { format, parse, startOfWeek, getDay } from 'date-fns';
import { enUS } from 'date-fns/locale';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import { useNavigate } from 'react-router-dom';
import { appointmentsApi, staffApi, servicesApi, customersApi } from '@/api/client';
import { Button, Modal, Select, useToast, PageHeader } from '@/components/ui';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { formatTime, formatDate } from '@/lib/utils';
import { CalendarToolbar } from './CalendarToolbar';
import { useAuth } from '@/contexts/AuthContext';
import { AppointmentDrawer } from './AppointmentDrawer';

const locales = { 'en-US': enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

interface ApiAppointment {
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
  price: number;
  currency: string;
  location: string;
  notes: string;
  customerName: string;
  customerEmail: string;
  serviceName: string;
  serviceColor: string;
  staffName: string;
  staffColor: string;
}

interface ApiStaff {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  serviceIds: string[];
}

interface ApiService {
  id: string;
  name: string;
  duration: number;
  staffIds: string[];
  isActive: boolean;
}

interface ApiCustomer {
  id: string;
  name: string;
}

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resource: ApiAppointment;
}

export default function CalendarPage() {
  usePageTitle('Calendar');
  const navigate = useNavigate();
  const { can } = useAuth();
  const canCreate = can('appointments:write');
  const toast = useToast();

  const [allAppointments, setAllAppointments] = useState<ApiAppointment[]>([]);
  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allCustomers, setAllCustomers] = useState<ApiCustomer[]>([]);

  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentView, setCurrentView] = useState<View>(Views.WEEK);
  const [selectedStaff, setSelectedStaff] = useState<string[]>([]);

  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [slotModal, setSlotModal] = useState(false);
  const [slotDate, setSlotDate] = useState('');
  const [slotTime, setSlotTime] = useState('');
  const [newServiceId, setNewServiceId] = useState('');
  const [newStaffId, setNewStaffId] = useState('');
  const [newCustomerId, setNewCustomerId] = useState('');
  const [quickCreating, setQuickCreating] = useState(false);

  const reloadAppointments = useCallback(() => {
    (appointmentsApi.list() as Promise<ApiAppointment[]>)
      .then(setAllAppointments)
      .catch((e: Error) => toast.error('Could not reload appointments', e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    Promise.all([
      appointmentsApi.list() as Promise<ApiAppointment[]>,
      staffApi.list() as Promise<ApiStaff[]>,
      servicesApi.list() as Promise<ApiService[]>,
      // Customers are only needed to create appointments from the calendar.
      canCreate && can('customers:read') ? customersApi.list() as Promise<ApiCustomer[]> : Promise.resolve([] as ApiCustomer[]),
    ]).then(([apts, staff, svcs, customers]) => {
      setAllAppointments(apts);
      setAllStaff(staff);
      setAllServices(svcs);
      setAllCustomers(customers);
      setSelectedStaff(staff.filter(s => s.isActive).map(s => s.id));
    }).catch((e: Error) => toast.error('Could not load calendar data', e.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeStaff = useMemo(() => allStaff.filter(s => s.isActive), [allStaff]);

  const events: CalendarEvent[] = useMemo(
    () => allAppointments
      .filter(apt => selectedStaff.includes(apt.staffId))
      .map(apt => ({
        id: apt.id,
        title: `${apt.serviceName || 'Service'} — ${apt.customerName || 'Customer'}`,
        start: new Date(`${apt.date}T${apt.startTime}`),
        end: new Date(`${apt.date}T${apt.endTime}`),
        resource: apt,
      })),
    [allAppointments, selectedStaff],
  );

  const handleNavigate = useCallback((action: 'PREV' | 'NEXT' | 'TODAY') => {
    if (action === 'TODAY') { setCurrentDate(new Date()); return; }
    const d = new Date(currentDate);
    const dir = action === 'NEXT' ? 1 : -1;
    if (currentView === Views.DAY)       d.setDate(d.getDate() + dir);
    else if (currentView === Views.WEEK) d.setDate(d.getDate() + 7 * dir);
    else                                 d.setMonth(d.getMonth() + dir);
    setCurrentDate(d);
  }, [currentDate, currentView]);

  const handleStaffToggle = useCallback((id: string) => {
    setSelectedStaff(prev => prev.includes(id) ? prev.filter(s => s !== id) : [...prev, id]);
  }, []);

  const eventPropGetter = useCallback((event: CalendarEvent) => {
    const color = event.resource.staffColor || '#00BF62';
    return {
      style: {
        backgroundColor: `${color}18`,
        borderLeft: `3px solid ${color}`,
        border: 'none',
        borderLeftWidth: '3px',
        borderLeftStyle: 'solid' as const,
        borderLeftColor: color,
        color: '#17232D',
        borderRadius: '5px',
        fontSize: '12px',
        padding: '2px 6px',
        fontWeight: 500,
      },
    };
  }, []);

  const handleSelectEvent = useCallback((event: CalendarEvent) => {
    setSelectedEvent(event);
    setDrawerOpen(true);
  }, []);

  const handleSelectSlot = useCallback(({ start }: SlotInfo) => {
    setSlotDate(format(start, 'yyyy-MM-dd'));
    setSlotTime(format(start, 'HH:mm'));
    setNewServiceId('');
    setNewStaffId('');
    setNewCustomerId('');
    setSlotModal(true);
  }, []);

  const availableStaffForService = useMemo(() => {
    if (!newServiceId) return activeStaff;
    const svc = allServices.find(s => s.id === newServiceId);
    return svc ? activeStaff.filter(s => svc.staffIds.includes(s.id)) : activeStaff;
  }, [newServiceId, activeStaff, allServices]);

  const handleQuickSave = async () => {
    if (!newServiceId || !newStaffId || !newCustomerId) return;
    setQuickCreating(true);
    try {
      const created = await appointmentsApi.create({
        serviceId: newServiceId,
        staffId: newStaffId,
        customerId: newCustomerId,
        resourceIds: [],
        status: 'scheduled',
        date: slotDate,
        startTime: slotTime,
        customerAnswers: [],
      }) as { email?: EmailOutcome };
      const updated = await appointmentsApi.list() as ApiAppointment[];
      setAllAppointments(updated);
      toastWithEmailOutcome(toast, 'Appointment created', '', 'confirmation', created.email);
      setSlotModal(false);
    } catch (e: unknown) {
      toast.error('Failed to create appointment', (e as Error).message);
    } finally {
      setQuickCreating(false);
    }
  };

  const apt = selectedEvent?.resource ?? null;
  const aptSvcAdapter = apt ? {
    name: apt.serviceName,
    color: apt.serviceColor || '#00BF62',
    duration: apt.duration,
    price: apt.price,
    currency: apt.currency,
  } : null;
  const aptCustAdapter = apt ? { name: apt.customerName, email: apt.customerEmail } : null;
  const aptStaffAdapter = apt ? { name: apt.staffName, color: apt.staffColor || '#94A3B8' } : null;

  return (
    <div className="page-container">
      <PageHeader
        title="Calendar"
        description="View and manage all appointments across your team"
        breadcrumbs={[{ label: 'Calendar' }]}
        className="mb-4"
      />

      <CalendarToolbar
        date={currentDate}
        view={currentView}
        onNavigate={handleNavigate}
        onView={setCurrentView}
        selectedStaff={selectedStaff}
        onStaffToggle={handleStaffToggle}
        onAdd={canCreate ? () => navigate('/appointments/new') : undefined}
        staffList={activeStaff}
      />

      <div
        className="rounded-xl border border-border bg-surface overflow-hidden"
        style={{ height: 'calc(100vh - 220px)' }}
      >
        <Calendar
          localizer={localizer}
          events={events}
          startAccessor="start"
          endAccessor="end"
          view={currentView}
          date={currentDate}
          onNavigate={setCurrentDate}
          onView={setCurrentView}
          onSelectEvent={handleSelectEvent as (event: object) => void}
          onSelectSlot={canCreate ? handleSelectSlot : undefined}
          eventPropGetter={eventPropGetter as (event: object, start: Date, end: Date, isSelected: boolean) => object}
          selectable={canCreate}
          toolbar={false}
          popup
          style={{ height: '100%' }}
        />
      </div>

      <AppointmentDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        appointment={apt}
        staff={aptStaffAdapter}
        service={aptSvcAdapter}
        customer={aptCustAdapter}
        canChange={canCreate}
        onChanged={reloadAppointments}
      />

      <Modal
        isOpen={slotModal}
        onClose={() => setSlotModal(false)}
        title="New Appointment"
        description={slotDate ? `${formatDate(slotDate)} at ${formatTime(slotTime)}` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setSlotModal(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={handleQuickSave}
              disabled={!newServiceId || !newStaffId || !newCustomerId}
              loading={quickCreating}
            >
              Save Appointment
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Select
            label="Service"
            options={allServices.filter(s => s.isActive).map(s => ({ value: s.id, label: s.name }))}
            placeholder="Select a service"
            required
            value={newServiceId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => { setNewServiceId(e.target.value); setNewStaffId(''); }}
          />
          <Select
            label="Staff Member"
            options={availableStaffForService.map(s => ({ value: s.id, label: s.name }))}
            placeholder={newServiceId ? 'Select a staff member' : 'Select a service first'}
            required
            value={newStaffId}
            disabled={!newServiceId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNewStaffId(e.target.value)}
          />
          <Select
            label="Customer"
            options={allCustomers.map(c => ({ value: c.id, label: c.name }))}
            placeholder="Select a customer"
            required
            value={newCustomerId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setNewCustomerId(e.target.value)}
          />
          <p className="text-xs text-text-muted">
            Date and time are pre-filled from your selected slot. For full options, use the Add Appointment form.
          </p>
        </div>
      </Modal>
    </div>
  );
}
