import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { UserPlus } from 'lucide-react';
import {
  PageHeader, Button, Input, Textarea, Select, Card, CardHeader, useToast,
} from '@/components/ui';
import { appointmentsApi, customersApi, servicesApi, staffApi, settingsApi } from '@/api/client';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { formatDuration, formatCurrency, formatTime, todayInTimeZone } from '@/lib/utils';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';

/** A start time from the server's availability for one staff member and date. */
interface ApiSlot { start: string; end: string; available: boolean }

function addMins(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

interface ApiService {
  id: string;
  name: string;
  duration: number;
  price: number;
  currency: string;
  location: string;
  isActive: boolean;
  staffIds: string[];
  resourceIds?: string[];
}

interface ApiStaff {
  id: string;
  name: string;
  title?: string;
  isActive: boolean;
  serviceIds: string[];
}

interface ApiCustomer {
  id: string;
  name: string;
  email: string;
}

export default function NewAppointmentPage() {
  usePageTitle('New Appointment');
  const navigate = useNavigate();
  const toast = useToast();
  const [businessTz, setBusinessTz] = useState<string | undefined>();
  // "Today" is the business's date, which can differ from the browser's near midnight.
  const today = todayInTimeZone(businessTz);

  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [allCustomers, setAllCustomers] = useState<ApiCustomer[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [isNewCustomer, setIsNewCustomer] = useState(false);
  const [newCustName, setNewCustName] = useState('');
  const [newCustEmail, setNewCustEmail] = useState('');
  const [newCustPhone, setNewCustPhone] = useState('');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Start times come from the server: within the staff member's working hours and not overlapping their bookings.
  const [slots, setSlots] = useState<ApiSlot[]>([]);
  const [slotsState, setSlotsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    Promise.all([
      servicesApi.list() as Promise<ApiService[]>,
      staffApi.list() as Promise<ApiStaff[]>,
      customersApi.list() as Promise<ApiCustomer[]>,
      settingsApi.get() as Promise<{ timezone?: string }>,
    ])
      .then(([svcs, staff, customers, org]) => {
        setBusinessTz(org.timezone);
        setAllServices(svcs);
        setAllStaff(staff);
        setAllCustomers(customers);
        setDataLoading(false);
      })
      .catch((e: Error) => { toast.error('Could not load services, staff or customers', e.message); setDataLoading(false); });
    // Load once. The toast object is recreated whenever a toast shows, so depending on it would reload in a loop.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setStartTime('');
    if (!serviceId || !staffId || !date) { setSlots([]); setSlotsState('idle'); return; }
    let cancelled = false;
    setSlotsState('loading');
    (appointmentsApi.availability({ date, serviceId, staffId }) as Promise<ApiSlot[]>)
      .then(list => { if (!cancelled) { setSlots(list); setSlotsState('ready'); } })
      .catch((e: Error) => {
        if (cancelled) return;
        setSlots([]);
        setSlotsState('error');
        toast.error('Could not load available times', e.message);
      });
    return () => { cancelled = true; };
  }, [serviceId, staffId, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const freeSlots = slots.filter(s => s.available).map(s => ({ value: s.start, label: formatTime(s.start) }));
  const timePlaceholder = slotsState === 'loading' ? 'Loading available times…'
    : slotsState === 'error' ? 'Could not load available times'
    : slotsState === 'ready' && !freeSlots.length ? 'No free times on this date'
    : 'Choose a time…';

  const selectedService = allServices.find(s => s.id === serviceId);
  const availableStaff = selectedService
    ? allStaff.filter(s => s.isActive && selectedService.staffIds.includes(s.id))
    : allStaff.filter(s => s.isActive);

  const handleServiceChange = (newId: string) => {
    setServiceId(newId);
    setStaffId('');
    const svc = allServices.find(s => s.id === newId);
    setLocation(svc?.location ?? '');
  };

  const handleCustomerChange = (val: string) => {
    setCustomerId(val);
    const isNew = val === '__new__';
    setIsNewCustomer(isNew);
    if (!isNew) {
      setNewCustName('');
      setNewCustEmail('');
      setNewCustPhone('');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!serviceId || !staffId || !date || !startTime) {
      toast.error('Missing required fields', 'Please fill in service, staff, date, and time.');
      return;
    }
    if (date < today) {
      toast.error('Invalid date', 'Appointments cannot be created in the past.');
      return;
    }
    if (!customerId) {
      toast.error('Customer required', 'Please select or add a customer.');
      return;
    }
    if (isNewCustomer && (!newCustName.trim() || !newCustEmail.trim())) {
      toast.error('Customer details required', 'Please provide at least a name and email for the new customer.');
      return;
    }
    if (isNewCustomer && (emailError(newCustEmail) || phoneError(newCustPhone))) {
      toast.error('Check the new customer\'s details', emailError(newCustEmail) || phoneError(newCustPhone));
      return;
    }

    setSubmitting(true);
    try {
      let finalCustomerId = customerId;

      if (isNewCustomer) {
        const nc = await customersApi.create({
          name: newCustName.trim(),
          email: newCustEmail.trim(),
          phone: newCustPhone.trim() || undefined,
          tags: [],
        }) as { id: string };
        finalCustomerId = nc.id;
      }

      const svc = selectedService!;
      const apt = await appointmentsApi.create({
        serviceId: svc.id,
        staffId,
        customerId: finalCustomerId,
        status: 'scheduled',
        date,
        startTime,
        notes: notes.trim(),
        internalNotes: internalNotes.trim(),
        customerAnswers: [],
      }) as { bookingRef: string; email?: EmailOutcome };

      toastWithEmailOutcome(toast, 'Appointment created', `Booking ref: ${apt.bookingRef}.`, 'confirmation', apt.email);
      navigate('/appointments');
    } catch (err: unknown) {
      toast.error('Failed to create appointment', (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-container">
      <PageHeader
        title="New Appointment"
        breadcrumbs={[
          { label: 'Appointments', href: '/appointments' },
          { label: 'New Appointment' },
        ]}
      />

      <form onSubmit={handleSubmit} className="mt-6">
        <div className="max-w-2xl space-y-5">

          <Card>
            <CardHeader title="Service & Staff" />
            <div className="space-y-4">
              <Select
                label="Service"
                required
                placeholder={dataLoading ? 'Loading services…' : 'Choose a service…'}
                options={allServices.filter(s => s.isActive).map(s => ({
                  value: s.id,
                  label: `${s.name} — ${formatDuration(s.duration)} · ${formatCurrency(s.price, s.currency)}`,
                }))}
                value={serviceId}
                onChange={e => handleServiceChange(e.target.value)}
                disabled={dataLoading}
              />
              <Select
                label="Staff Member"
                required
                placeholder={serviceId ? 'Choose a staff member…' : 'Select a service first'}
                options={availableStaff.map(s => ({
                  value: s.id,
                  label: s.title ? `${s.name} — ${s.title}` : s.name,
                }))}
                value={staffId}
                disabled={!serviceId || dataLoading}
                onChange={e => setStaffId(e.target.value)}
              />
            </div>
          </Card>

          <Card>
            <CardHeader title="Date & Time" />
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Date"
                type="date"
                required
                value={date}
                min={today}
                onChange={e => setDate(e.target.value)}
              />
              <Select
                label="Time Slot"
                required
                placeholder={timePlaceholder}
                options={freeSlots}
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
              />
            </div>
            {selectedService && startTime && (
              <p className="text-xs text-text-muted mt-3">
                Duration: {formatDuration(selectedService.duration)} · Ends at{' '}
                {formatTime(addMins(startTime, selectedService.duration))}
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Customer" />
            <Select
              label="Customer"
              required
              placeholder={dataLoading ? 'Loading customers…' : 'Select or add a customer…'}
              options={[
                { value: '__new__', label: '+ Add new customer' },
                ...allCustomers.map(c => ({
                  value: c.id,
                  label: `${c.name} — ${c.email}`,
                })),
              ]}
              value={customerId}
              disabled={dataLoading}
              onChange={e => handleCustomerChange(e.target.value)}
            />
            {isNewCustomer && (
              <div className="mt-4 p-4 rounded-lg bg-primary-light border border-primary/20">
                <div className="flex items-center gap-2 mb-3">
                  <UserPlus className="w-4 h-4 text-primary" />
                  <p className="text-sm font-medium text-primary">New Customer Details</p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Input
                    label="Full Name"
                    required
                    placeholder="Jane Smith"
                    value={newCustName}
                    onChange={e => setNewCustName(e.target.value)}
                  />
                  <Input
                    label="Email"
                    type="email"
                    required
                    placeholder="jane@example.com"
                    value={newCustEmail}
                    onChange={e => setNewCustEmail(e.target.value)}
                    error={emailError(newCustEmail)}
                  />
                  <Input
                    label="Phone"
                    type="tel"
                    placeholder={PHONE_PLACEHOLDER}
                    value={newCustPhone}
                    onChange={e => setNewCustPhone(e.target.value)}
                    error={phoneError(newCustPhone)}
                  />
                </div>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Details" />
            <div className="space-y-4">
              <Input
                label="Location"
                value={location}
                placeholder="e.g. In-person, Video Call…"
                hint={selectedService ? `Auto-filled from service: ${selectedService.location}` : undefined}
                onChange={e => setLocation(e.target.value)}
              />
              <Textarea
                label="Customer-facing notes"
                rows={3}
                placeholder="Notes visible to the customer in their confirmation…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
              <Textarea
                label="Internal notes"
                rows={3}
                placeholder="Private notes for staff only, not shown to the customer…"
                value={internalNotes}
                onChange={e => setInternalNotes(e.target.value)}
              />
            </div>
          </Card>

          <div className="flex items-center justify-end gap-3 pb-8">
            <Button
              type="button"
              variant="secondary"
              onClick={() => navigate('/appointments')}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={submitting}>
              Create Appointment
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
