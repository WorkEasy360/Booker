import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, Search, CalendarDays, Eye } from 'lucide-react';
import {
  PageHeader, Button, Input, Select, Table, Pagination, StatusBadge, Avatar,
} from '@/components/ui';
import { appointmentsApi, staffApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate, formatTime, formatDuration, localDateISO } from '@/lib/utils';
import type { AppointmentStatus } from '@/types';

type TabId = 'all' | 'upcoming' | 'past' | 'cancelled' | 'confirmed';

const PAGE_SIZE = 8;
const TODAY = localDateISO();

interface ApiAppointment {
  id: string;
  bookingRef: string;
  customerId: string;
  serviceId: string;
  staffId: string;
  status: AppointmentStatus;
  date: string;
  startTime: string;
  endTime: string;
  duration: number;
  location: string;
  notes: string;
  createdAt: string;
  customerName: string;
  customerEmail: string;
  serviceName: string;
  staffName: string;
  staffColor: string;
}

interface ApiStaff {
  id: string;
  name: string;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show',   label: 'No-show' },
];

export default function AppointmentsPage() {
  const { can } = useAuth();
  usePageTitle('Appointments');
  const navigate = useNavigate();
  const [activeTab, setActiveTab]   = useState<TabId>('all');
  const [search, setSearch]         = useState('');
  const [statusFilter, setStatus]   = useState('');
  const [staffFilter, setStaff]     = useState('');
  const [dateFrom, setDateFrom]     = useState('');
  const [dateTo, setDateTo]         = useState('');
  const [page, setPage]             = useState(1);

  const [allApts, setAllApts]   = useState<ApiAppointment[]>([]);
  const [staffList, setStaffList] = useState<ApiStaff[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      appointmentsApi.list() as Promise<ApiAppointment[]>,
      staffApi.list() as Promise<ApiStaff[]>,
    ])
      .then(([apts, staff]) => {
        setAllApts(apts);
        setStaffList(staff);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message ?? 'Failed to load appointments.');
        setLoading(false);
      });
  }, []);

  const counts = useMemo(() => ({
    all:       allApts.length,
    upcoming:  allApts.filter(a => a.date >= TODAY && (a.status === 'scheduled' || a.status === 'confirmed')).length,
    past:      allApts.filter(a => a.date < TODAY || a.status === 'completed' || a.status === 'no_show').length,
    cancelled: allApts.filter(a => a.status === 'cancelled').length,
    confirmed: allApts.filter(a => a.status === 'confirmed').length,
  }), [allApts]);

  const filtered = useMemo(() => {
    let list = [...allApts];

    if (activeTab === 'upcoming')       list = list.filter(a => a.date >= TODAY && (a.status === 'scheduled' || a.status === 'confirmed'));
    else if (activeTab === 'past')      list = list.filter(a => a.date < TODAY || a.status === 'completed' || a.status === 'no_show');
    else if (activeTab === 'cancelled') list = list.filter(a => a.status === 'cancelled');
    else if (activeTab === 'confirmed') list = list.filter(a => a.status === 'confirmed');

    if (statusFilter) list = list.filter(a => a.status === (statusFilter as AppointmentStatus));
    if (staffFilter)  list = list.filter(a => a.staffId === staffFilter);
    if (dateFrom)     list = list.filter(a => a.date >= dateFrom);
    if (dateTo)       list = list.filter(a => a.date <= dateTo);

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(a =>
        a.bookingRef.toLowerCase().includes(q) ||
        a.customerName.toLowerCase().includes(q) ||
        a.customerEmail.toLowerCase().includes(q) ||
        a.serviceName.toLowerCase().includes(q)
      );
    }

    return list;
  }, [allApts, activeTab, search, statusFilter, staffFilter, dateFrom, dateTo]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged      = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const resetPage  = () => setPage(1);

  const handleTabChange = (id: string) => {
    setActiveTab(id as TabId);
    setStatus('');
    setPage(1);
  };

  const staffOptions = [
    { value: '', label: 'All staff' },
    ...staffList.map(s => ({ value: s.id, label: s.name })),
  ];

  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="Appointments" description="Manage all bookings across your locations" />
        <div className="mt-8 text-center text-sm text-text-muted">Loading appointments…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader title="Appointments" description="Manage all bookings across your locations" />
        <div className="mt-8 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Failed to load appointments: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Appointments"
        description="Manage all bookings across your locations"
        actions={can('appointments:write') ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate('/appointments/new')}
          >
            Add Appointment
          </Button>
        ) : undefined}
        tabs={[
          { id: 'all',       label: 'All',       count: counts.all },
          { id: 'upcoming',  label: 'Upcoming',  count: counts.upcoming },
          { id: 'past',      label: 'Past',       count: counts.past },
          { id: 'cancelled', label: 'Cancelled',  count: counts.cancelled },
          { id: 'confirmed', label: 'Confirmed',  count: counts.confirmed },
        ]}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />

      {/* Toolbar */}
      <div className="mt-4 flex flex-wrap gap-3 items-end">
        <div className="flex-1 min-w-[200px] max-w-sm">
          <Input
            placeholder="Search by name, service, or ref…"
            aria-label="Search appointments"
            prefix={<Search className="w-4 h-4 text-text-muted" />}
            value={search}
            onChange={e => { setSearch(e.target.value); resetPage(); }}
          />
        </div>
        <div className="w-40">
          <Select
            aria-label="Filter by status"
            options={STATUS_OPTIONS}
            value={statusFilter}
            onChange={e => { setStatus(e.target.value); resetPage(); }}
          />
        </div>
        <div className="w-48">
          <Select
            aria-label="Filter by staff"
            options={staffOptions}
            value={staffFilter}
            onChange={e => { setStaff(e.target.value); resetPage(); }}
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="w-36">
            <Input
              type="date"
              aria-label="From date"
              value={dateFrom}
              onChange={e => { setDateFrom(e.target.value); resetPage(); }}
            />
          </div>
          <span className="text-text-muted text-xs shrink-0">to</span>
          <div className="w-36">
            <Input
              type="date"
              aria-label="To date"
              value={dateTo}
              onChange={e => { setDateTo(e.target.value); resetPage(); }}
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="mt-4 card overflow-hidden">
        <Table
          columns={[
            {
              key: 'ref',
              header: 'Booking Ref',
              // A reference is read and quoted as one piece: it never wraps at its hyphen.
              className: 'whitespace-nowrap',
              headerClassName: 'whitespace-nowrap',
              render: (row: ApiAppointment) => (
                <span className="font-mono text-xs text-text-secondary whitespace-nowrap" data-booking-ref>{row.bookingRef}</span>
              ),
            },
            {
              key: 'customer',
              header: 'Customer',
              className: 'min-w-[11rem] max-w-[16rem]',
              render: (row: ApiAppointment) => row.customerName ? (
                <div className="flex items-center gap-2.5 min-w-0">
                  <Avatar name={row.customerName} size="sm" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{row.customerName}</p>
                    <p className="text-xs text-text-muted truncate">{row.customerEmail}</p>
                  </div>
                </div>
              ) : <span className="text-text-muted text-sm">—</span>,
            },
            {
              key: 'service',
              header: 'Service',
              render: (row: ApiAppointment) => row.serviceName ? (
                <div>
                  <p className="text-sm font-medium text-text-primary">{row.serviceName}</p>
                  <p className="text-xs text-text-muted">{formatDuration(row.duration)}</p>
                </div>
              ) : <span className="text-text-muted text-sm">—</span>,
            },
            {
              key: 'staff',
              header: 'Staff',
              render: (row: ApiAppointment) => row.staffName ? (
                <div className="flex items-center gap-2">
                  <Avatar name={row.staffName} size="xs" color={row.staffColor} />
                  <span className="text-sm text-text-primary whitespace-nowrap">{row.staffName}</span>
                </div>
              ) : <span className="text-text-muted text-sm">—</span>,
            },
            {
              key: 'datetime',
              header: 'Date & Time',
              className: 'whitespace-nowrap',
              headerClassName: 'whitespace-nowrap',
              render: (row: ApiAppointment) => (
                <div>
                  <p className="text-sm text-text-primary whitespace-nowrap">{formatDate(row.date)}</p>
                  <p className="text-xs text-text-muted">{formatTime(row.startTime)}</p>
                </div>
              ),
            },
            {
              key: 'location',
              header: 'Location',
              // Secondary: shown from extra-wide screens up; always on the appointment's own page.
              className: 'hidden xl:table-cell',
              headerClassName: 'hidden xl:table-cell',
              render: (row: ApiAppointment) => <span className="text-sm text-text-secondary">{row.location}</span>,
            },
            {
              key: 'status',
              header: 'Status',
              className: 'whitespace-nowrap',
              render: (row: ApiAppointment) => <StatusBadge status={row.status} />,
            },
            {
              key: 'actions',
              header: '',
              className: 'whitespace-nowrap text-right',
              render: (row: ApiAppointment) => (
                <div onClick={e => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Eye className="w-3.5 h-3.5" />}
                    onClick={() => navigate(`/appointments/${row.id}`)}
                  >
                    View
                  </Button>
                </div>
              ),
            },
          ]}
          data={paged}
          keyExtractor={r => r.id}
          onRowClick={r => navigate(`/appointments/${r.id}`)}
          emptyTitle="No appointments found"
          emptyDescription="Try adjusting your search or filter criteria."
          emptyIcon={<CalendarDays className="w-8 h-8" />}
        />
        {filtered.length > 0 && (
          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}
