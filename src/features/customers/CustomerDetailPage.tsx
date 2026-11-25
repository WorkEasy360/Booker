import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CalendarPlus, Pencil, Phone, Mail, CalendarDays, ChevronRight, ContactRound } from 'lucide-react';
import { Avatar, Spinner, StatusBadge } from '@/components/ui';
import { appointmentsApi, customersApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatDate, formatTime, localDateISO } from '@/lib/utils';
import { normalizeCustomer, type CustomerRecord } from './customerData';

interface HistoryRow {
  id: string; status: string; date: string; startTime: string; endTime?: string; duration?: number;
  serviceName?: string; staffName?: string;
}

/** Customer details: contact details, appointment history, Book Appointment / Edit Contact Details. */
export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [customer, setCustomer] = useState<CustomerRecord | null>(null);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  usePageTitle(customer?.name ?? 'Customer');

  useEffect(() => {
    if (!id) return;
    customersApi.get(id)
      .then(raw => setCustomer(normalizeCustomer(raw)))
      .catch((e: Error) => setError(e.message || 'Could not load this customer.'));
    appointmentsApi.list({ customerId: id })
      .then(rows => setHistory(rows as HistoryRow[]))
      .catch((e: Error) => { setHistory([]); setHistoryError(e.message || 'Could not load appointment history.'); });
  }, [id]);

  const today = localDateISO();
  const { upcoming, past } = useMemo(() => {
    const rows = [...(history ?? [])];
    const up = rows.filter(a => a.date >= today && (a.status === 'scheduled' || a.status === 'confirmed'))
      .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
    const upIds = new Set(up.map(a => a.id));
    const rest = rows.filter(a => !upIds.has(a.id)).sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`));
    return { upcoming: up, past: rest };
  }, [history, today]);

  if (error) {
    return (
      <div className="page-container space-y-4">
        <BackLink />
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      </div>
    );
  }
  if (!customer) return <div className="page-container"><BackLink /><div className="flex justify-center py-16"><Spinner /></div></div>;

  return (
    <div className="page-container space-y-6">
      <BackLink />

      {/* Header: name and actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4 min-w-0">
          <Avatar name={customer.name} size="xl" color="#16A34A" decorative />
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-[32px] sm:leading-[38px] font-bold text-text-primary tracking-tight truncate">{customer.name}</h1>
            <p className="text-sm sm:text-base text-text-secondary mt-0.5">
              {history ? `${history.length} appointment${history.length === 1 ? '' : 's'}` : 'Customer'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          {can('customers:write') && (
            <Link to={`/customers/${customer.id}/edit`} className="btn-secondary min-h-[48px] px-5">
              <Pencil className="w-4 h-4" aria-hidden="true" />Edit Contact Details
            </Link>
          )}
          {can('appointments:write') && (
            <Link to={`/appointments/new?customerId=${encodeURIComponent(customer.id)}`} className="btn-primary min-h-[48px] px-5 text-base">
              <CalendarPlus className="w-5 h-5" aria-hidden="true" />Book Appointment
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 items-start">
        {/* Contact details */}
        <section className="panel p-5 sm:p-6" aria-labelledby="contact-title">
          <div className="flex items-center gap-3 mb-4">
            <span className="icon-tile w-10 h-10 bg-primary-light text-primary"><ContactRound className="w-5 h-5" aria-hidden="true" /></span>
            <h2 id="contact-title" className="text-xl font-semibold text-text-primary">Contact Details</h2>
          </div>
          <dl className="divide-y divide-border">
            <Detail label="Name" value={customer.name} />
            <Detail label="Phone" icon={Phone} value={customer.phone} href={customer.phone ? `tel:${customer.phone.replace(/\s/g, '')}` : undefined} />
            <Detail label="Email" icon={Mail} value={customer.email} href={customer.email ? `mailto:${customer.email}` : undefined} />
          </dl>
          {!customer.email && (
            <p className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">No email address: booking confirmations and reminders cannot be emailed to this customer.</p>
          )}
        </section>

        {/* Appointment history */}
        <section className="panel" aria-labelledby="history-title">
          <div className="flex items-center gap-3 px-5 sm:px-6 pt-5 sm:pt-6 pb-4">
            <span className="icon-tile w-10 h-10 bg-primary-light text-primary"><CalendarDays className="w-5 h-5" aria-hidden="true" /></span>
            <h2 id="history-title" className="text-xl font-semibold text-text-primary">Appointment History</h2>
          </div>
          {historyError && <p role="alert" className="mx-5 sm:mx-6 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{historyError}</p>}
          {history === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : history.length === 0 && !historyError ? (
            <div className="border-t border-border px-6 py-12 text-center">
              <p className="text-[15px] font-medium text-text-primary">No appointments yet</p>
              {can('appointments:write') && (
                <button type="button" className="btn-primary mt-4 min-h-[44px]" onClick={() => navigate(`/appointments/new?customerId=${encodeURIComponent(customer.id)}`)}>
                  <CalendarPlus className="w-4 h-4" aria-hidden="true" />Book Appointment
                </button>
              )}
            </div>
          ) : (
            <div className="pb-3">
              {upcoming.length > 0 && <HistoryGroup title="Upcoming" rows={upcoming} />}
              {past.length > 0 && <HistoryGroup title="Past and cancelled" rows={past} />}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/customers" className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
      <ArrowLeft className="w-4 h-4" aria-hidden="true" />Back to customers
    </Link>
  );
}

function Detail({ label, value, icon: Icon, href }: { label: string; value: string | null; icon?: React.ElementType; href?: string }) {
  return (
    <div className="py-3 first:pt-0">
      <dt className="text-sm text-text-secondary">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-2 text-[15px] font-medium text-text-primary break-all">
        {Icon && value && <Icon className="w-4 h-4 text-text-muted shrink-0" aria-hidden="true" />}
        {value ? (href ? <a href={href} className="hover:text-primary">{value}</a> : value) : <span className="font-normal text-text-muted">Not provided</span>}
      </dd>
    </div>
  );
}

function HistoryGroup({ title, rows }: { title: string; rows: HistoryRow[] }) {
  const time = (a: HistoryRow) => `${formatTime(a.startTime)}${a.endTime ? ` – ${formatTime(a.endTime)}` : ''}`;
  return (
    <div className="px-4 sm:px-5 pb-2">
      <h3 className="px-1 pt-2 pb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">{title}</h3>
      {/* Desktop table */}
      <table className="hidden md:table w-full text-[15px]">
        <thead>
          <tr className="bg-[#F3F5F8] text-left text-text-primary">
            <th scope="col" className="rounded-l-lg px-4 py-3 font-semibold">Date</th>
            <th scope="col" className="px-4 py-3 font-semibold">Time</th>
            <th scope="col" className="px-4 py-3 font-semibold">Service</th>
            <th scope="col" className="px-4 py-3 font-semibold">Staff</th>
            <th scope="col" className="rounded-r-lg px-4 py-3 font-semibold">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(a => (
            <tr key={a.id} className="hover:bg-gray-50/80">
              <td className="px-4 py-3.5 whitespace-nowrap">
                <Link to={`/appointments/${a.id}`} className="font-medium text-text-primary hover:text-primary">{formatDate(a.date, 'EEE, d MMM yyyy')}</Link>
              </td>
              <td className="px-4 py-3.5 whitespace-nowrap text-text-secondary">{time(a)}</td>
              <td className="px-4 py-3.5 text-text-primary">{a.serviceName ?? '—'}</td>
              <td className="px-4 py-3.5 text-text-secondary">{a.staffName ?? '—'}</td>
              <td className="px-4 py-3.5"><StatusBadge status={a.status} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* Mobile cards */}
      <ul className="md:hidden space-y-2">
        {rows.map(a => (
          <li key={a.id}>
            <Link to={`/appointments/${a.id}`} className="flex items-center gap-3 rounded-xl border border-border px-4 py-3 min-h-[64px] active:bg-gray-50">
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold text-text-primary">{formatDate(a.date, 'EEE, d MMM yyyy')}</p>
                <p className="text-sm text-text-secondary">{time(a)}</p>
                <p className="text-sm text-text-secondary truncate">{a.serviceName ?? '—'}{a.staffName ? ` · ${a.staffName}` : ''}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge status={a.status} />
                <ChevronRight className="w-5 h-5 text-text-muted" aria-hidden="true" />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
