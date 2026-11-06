import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { CalendarPlus, Mail, Phone, Globe, Calendar, ChevronRight } from 'lucide-react';
import {
  Button, Avatar, Badge, StatusBadge, PageHeader, Tabs, Textarea, Input, Select, useToast,
} from '@/components/ui';
import { customersApi, appointmentsApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { CustomerConsentCard } from './CustomerConsentCard';
import { formatDate, formatTime, TIMEZONES } from '@/lib/utils';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';

function tagVariant(tag: string): 'default' | 'success' | 'warning' | 'info' | 'purple' | 'primary' {
  const map: Record<string, 'default' | 'success' | 'warning' | 'info' | 'purple' | 'primary'> = {
    vip: 'warning', regular: 'default', new: 'success',
    corporate: 'info', sports: 'purple', referral: 'primary',
  };
  return map[tag] ?? 'default';
}

const TZ_OPTIONS = [
  { value: '', label: 'Select timezone' },
  ...TIMEZONES.map(tz => ({ value: tz, label: tz })),
];

interface ApiCustomer {
  id: string;
  name: string;
  email: string;
  phone?: string;
  timezone?: string;
  notes?: string;
  tags: string[];
  totalBookings: number;
  lastBookingDate?: string;
  createdAt: string;
}

interface ApiAppointment {
  id: string;
  status: string;
  date: string;
  startTime: string;
  serviceName: string;
  staffName: string;
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const { can } = useAuth();
  usePageTitle('Customer');

  const [customer, setCustomer] = useState<ApiCustomer | null>(null);
  const [appointments, setAppointments] = useState<ApiAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [notes, setNotes] = useState('');
  const [detailName, setDetailName] = useState('');
  const [detailEmail, setDetailEmail] = useState('');
  const [detailPhone, setDetailPhone] = useState('');
  const [detailTz, setDetailTz] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      customersApi.get(id) as Promise<ApiCustomer>,
      appointmentsApi.list({ customerId: id }) as Promise<ApiAppointment[]>,
    ])
      .then(([cust, apts]) => {
        setCustomer(cust);
        setAppointments(apts);
        setNotes(cust.notes ?? '');
        setDetailName(cust.name);
        setDetailEmail(cust.email);
        setDetailPhone(cust.phone ?? '');
        setDetailTz(cust.timezone ?? '');
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load customer.'); setLoading(false); });
  }, [id]);

  if (loading) {
    return (
      <div className="page-container">
        <div className="mt-8 text-center text-sm text-text-muted">Loading customer…</div>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="page-container">
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-text-primary font-semibold mb-2">{error ? 'Failed to load customer' : 'Customer not found'}</p>
          <p className="text-text-secondary text-sm mb-4">{error ?? 'The requested customer does not exist.'}</p>
          <Button variant="secondary" onClick={() => navigate('/customers')}>Back to Customers</Button>
        </div>
      </div>
    );
  }

  const upcoming = appointments.filter(a => a.status === 'scheduled' || a.status === 'confirmed');

  async function handleSaveNotes() {
    if (!id) return;
    setSavingNotes(true);
    try {
      await customersApi.update(id, { notes });
      toast.success('Notes saved successfully');
    } catch (e: unknown) {
      toast.error('Failed to save notes', (e as Error).message);
    } finally {
      setSavingNotes(false);
    }
  }

  async function handleSaveDetails() {
    if (!id || !detailName.trim() || !detailEmail.trim() || emailError(detailEmail) || phoneError(detailPhone)) return;
    setSavingDetails(true);
    try {
      const updated = await customersApi.update(id, {
        name: detailName.trim(),
        email: detailEmail.trim(),
        phone: detailPhone.trim(),
        timezone: detailTz || undefined,
      }) as ApiCustomer;
      setCustomer(prev => prev ? { ...prev, ...updated } : null);
      toast.success('Details updated');
    } catch (e: unknown) {
      toast.error('Failed to update details', (e as Error).message);
    } finally {
      setSavingDetails(false);
    }
  }

  const bookingsTab = (
    <div className="space-y-2">
      {appointments.length === 0 ? (
        <div className="py-12 text-center">
          <Calendar className="w-10 h-10 text-text-muted mx-auto mb-3" />
          <p className="text-sm font-semibold text-text-primary">No bookings yet</p>
          <p className="text-xs text-text-secondary mt-1">This customer hasn't made any appointments.</p>
          <Button size="sm" className="mt-4" onClick={() => navigate('/appointments/new')}>
            Book Now
          </Button>
        </div>
      ) : appointments.map(apt => (
        <div
          key={apt.id}
          className="flex items-center justify-between p-3 rounded-lg border border-border bg-background hover:border-primary/30 cursor-pointer transition-colors"
          onClick={() => navigate(`/appointments/${apt.id}`)}
        >
          <div className="flex items-center gap-3">
            <div className="text-center w-14 shrink-0">
              <p className="text-xs font-bold text-text-primary">{formatDate(apt.date, 'MMM d')}</p>
              <p className="text-xs text-text-secondary">{formatTime(apt.startTime)}</p>
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">{apt.serviceName || '—'}</p>
              <p className="text-xs text-text-secondary">with {apt.staffName || '—'}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={apt.status} />
            <ChevronRight className="w-4 h-4 text-text-muted" />
          </div>
        </div>
      ))}
    </div>
  );

  const notesTab = (
    <div className="space-y-4 max-w-lg">
      <Textarea
        label="Customer Notes"
        hint="Notes are private and only visible to staff."
        rows={6}
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="Add notes about this customer..."
      />
      <Button onClick={handleSaveNotes} loading={savingNotes}>Save Notes</Button>
    </div>
  );

  const detailsTab = (
    <div className="space-y-4 max-w-md">
      <Input label="Full Name" required value={detailName} onChange={e => setDetailName(e.target.value)} />
      <Input label="Email Address" required type="email" value={detailEmail} onChange={e => setDetailEmail(e.target.value)} error={emailError(detailEmail)} />
      <Input label="Phone" type="tel" placeholder={PHONE_PLACEHOLDER} value={detailPhone} onChange={e => setDetailPhone(e.target.value)} error={phoneError(detailPhone)} />
      <Select label="Timezone" options={TZ_OPTIONS} value={detailTz} onChange={e => setDetailTz(e.target.value)} />
      <Button onClick={handleSaveDetails} loading={savingDetails} disabled={!detailName.trim() || !detailEmail.trim() || !!emailError(detailEmail) || !!phoneError(detailPhone)}>
        Save Details
      </Button>
    </div>
  );

  const tabs = [
    { id: 'bookings', label: 'Bookings', count: appointments.length, content: bookingsTab },
    { id: 'notes', label: 'Notes', content: notesTab },
    { id: 'details', label: 'Details', content: detailsTab },
  ];

  return (
    <div className="page-container">
      <PageHeader
        title={customer.name}
        breadcrumbs={[{ label: 'Customers', href: '/customers' }, { label: customer.name }]}
        actions={
          <Button icon={<CalendarPlus className="w-4 h-4" />} onClick={() => navigate('/appointments/new')}>
            Book Appointment
          </Button>
        }
      />

      <div className="card p-6 mb-6">
        <div className="flex flex-col sm:flex-row items-start gap-5">
          <Avatar name={customer.name} size="xl" />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h2 className="text-xl font-bold text-text-primary">{customer.name}</h2>
              {customer.tags.map(t => (
                <Badge key={t} variant={tagVariant(t)} size="sm">{t}</Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              <span className="flex items-center gap-1.5 text-sm text-text-secondary">
                <Mail className="w-3.5 h-3.5 shrink-0" />{customer.email}
              </span>
              {customer.phone && (
                <span className="flex items-center gap-1.5 text-sm text-text-secondary">
                  <Phone className="w-3.5 h-3.5 shrink-0" />{customer.phone}
                </span>
              )}
              {customer.timezone && (
                <span className="flex items-center gap-1.5 text-sm text-text-secondary">
                  <Globe className="w-3.5 h-3.5 shrink-0" />{customer.timezone}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted mt-2">Member since {formatDate(customer.createdAt)}</p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-border">
          <div className="text-center">
            <p className="text-2xl font-bold text-text-primary">{appointments.length}</p>
            <p className="text-xs text-text-secondary">Total Bookings</p>
          </div>
          <div className="text-center">
            <p className="text-sm font-semibold text-text-primary">
              {customer.lastBookingDate ? formatDate(customer.lastBookingDate) : '—'}
            </p>
            <p className="text-xs text-text-secondary">Last Booking</p>
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold text-primary">{upcoming.length}</p>
            <p className="text-xs text-text-secondary">Upcoming</p>
          </div>
        </div>
      </div>

      {can('customers:read') && <CustomerConsentCard customerId={customer.id} canEdit={can('customers:write')} />}

      <div className="card p-6">
        <Tabs tabs={tabs} defaultTab={searchParams.get('tab') ?? 'bookings'} variant="underline" />
      </div>
    </div>
  );
}
