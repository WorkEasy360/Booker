import React, { useState, useEffect, useMemo } from 'react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Download, TrendingUp, Calendar, XCircle, AlertCircle, CheckCircle } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { Button, PageHeader, useToast } from '@/components/ui';
import { appointmentsApi, reportsApi } from '@/api/client';
import { formatDate, formatCurrency } from '@/lib/utils';
import { addDaysISO, dayLabel } from '@/lib/reportWindow';
import { DISPLAY_LOCALE } from '@/lib/regional';

const DATE_RANGES = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '3m', label: 'Last 3 months' },
  { value: '1y', label: 'Last year' },
];

const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '3m': 91, '1y': 365 };

const STATUS_COLORS: Record<string, string> = {
  scheduled: '#3B82F6',
  confirmed: '#6366F1',
  completed: '#10B981',
  cancelled: '#EF4444',
  no_show:   '#8B5CF6',
};

interface SummaryData {
  /** The report window in the business's dates (the server's), both ends included. */
  from: string;
  to: string;
  totalAppointments: number;
  currency: string;
  revenue: number;
  otherCurrencyRevenue?: Array<{ currency: string; revenue: number }>;
  avgPerDay: number;
  cancellationRate: number;
  noShowRate: number;
  completionRate: number;
}

interface ServiceRow { name: string; bookings: number; revenue: number }
interface StaffRow   { name: string; bookings: number }
interface CustomerRow { id: string; name: string; email: string; totalBookings: number; lastBookingDate?: string }

interface ApiAppointment {
  id: string;
  date: string;
  status: string;
  price?: number;
  startTime: string;
  serviceName?: string;
  staffName?: string;
}

/** Up to 30 buckets that split the report window (the server's from..to, the business's dates) with no gap or overlap. */
function buildTrend(appointments: ApiAppointment[], range: string, window: { from: string; to: string }) {
  const days = RANGE_DAYS[range] ?? 365;
  const buckets = Math.min(days, 30);
  return Array.from({ length: buckets }, (_, i) => {
    const startStr = addDaysISO(window.from, Math.floor((i * days) / buckets));
    const endStr = addDaysISO(window.from, Math.floor(((i + 1) * days) / buckets) - 1);
    const inBucket = appointments.filter(a => a.date >= startStr && a.date <= endStr);
    const label = dayLabel(endStr, DISPLAY_LOCALE, { month: 'short', day: 'numeric' });
    return {
      label,
      value: inBucket.filter(a => a.status !== 'cancelled').length,
      secondaryValue: inBucket.filter(a => a.status === 'cancelled').length,
    };
  });
}

function buildStatusBreakdown(appointments: ApiAppointment[]) {
  const counts: Record<string, number> = {};
  for (const a of appointments) counts[a.status] = (counts[a.status] ?? 0) + 1;
  return Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([status, value]) => ({
      label: status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' '),
      value,
      color: STATUS_COLORS[status] ?? '#94A3B0',
    }));
}

export default function ReportsPage() {
  usePageTitle('Reports');
  const toast = useToast();
  const [dateRange, setDateRange] = useState('30d');

  const [summary, setSummary]         = useState<SummaryData | null>(null);
  const [serviceRows, setServiceRows] = useState<ServiceRow[]>([]);
  const [staffRows, setStaffRows]     = useState<StaffRow[]>([]);
  const [topCustomers, setTopCustomers] = useState<CustomerRow[]>([]);
  const [allAppointments, setAllAppointments] = useState<ApiAppointment[]>([]);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    setLoading(true);
    let cancelled = false;

    Promise.all([
      reportsApi.summary(dateRange),
      reportsApi.byService(dateRange),
      reportsApi.byStaff(dateRange),
      reportsApi.topCustomers(),
      appointmentsApi.list() as Promise<ApiAppointment[]>,
    ]).then(([summaryData, serviceData, staffData, custData, apts]) => {
      if (cancelled) return;
      setSummary(summaryData as SummaryData);
      setServiceRows(serviceData as ServiceRow[]);
      setStaffRows(staffData as StaffRow[]);
      setTopCustomers(custData as CustomerRow[]);
      setAllAppointments(apts);
      setLoading(false);
    }).catch((e: Error) => {
      if (cancelled) return;
      toast.error('Failed to load reports', e.message);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [dateRange]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chart and the breakdown count the summary's own window, so they add up to "Total Appointments".
  const inWindow        = useMemo(() => (summary ? allAppointments.filter(a => a.date >= summary.from && a.date <= summary.to) : []), [allAppointments, summary]);
  const trend           = useMemo(() => (summary ? buildTrend(inWindow, dateRange, summary) : []), [inWindow, dateRange, summary]);
  const statusBreakdown = useMemo(() => buildStatusBreakdown(inWindow), [inWindow]);

  const stats = summary
    ? [
        { label: 'Total Appointments', value: String(summary.totalAppointments), icon: Calendar,      iconBg: 'bg-blue-50',     iconColor: 'text-blue-600' },
        { label: 'Total Revenue',       value: formatCurrency(summary.revenue, summary.currency),    icon: TrendingUp,   iconBg: 'bg-primary-light', iconColor: 'text-primary' },
        { label: 'Avg per Day',         value: summary.avgPerDay.toFixed(1),       icon: TrendingUp,   iconBg: 'bg-purple-50',   iconColor: 'text-purple-600' },
        { label: 'Cancellation Rate',   value: `${summary.cancellationRate.toFixed(1)}%`, icon: XCircle,      iconBg: 'bg-red-50',      iconColor: 'text-red-500' },
        { label: 'No-show Rate',        value: `${summary.noShowRate.toFixed(1)}%`,       icon: AlertCircle,  iconBg: 'bg-amber-50',    iconColor: 'text-amber-600' },
        { label: 'Completion Rate',     value: `${summary.completionRate.toFixed(1)}%`,   icon: CheckCircle,  iconBg: 'bg-emerald-50',  iconColor: 'text-emerald-600' },
      ]
    : [];

  function handleExport() {
    toast.info('Export not yet configured', 'Connect an export integration in Settings to download reports.');
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Reports"
        description="Analytics and performance insights for your business"
        breadcrumbs={[{ label: 'Reports' }]}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div role="group" aria-label="Date range" className="flex flex-wrap items-center gap-1 bg-surface border border-border rounded-lg p-1">
              {DATE_RANGES.map(r => (
                <button
                  key={r.value}
                  onClick={() => setDateRange(r.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    dateRange === r.value
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={handleExport}>
              Export
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        {loading
          ? Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="card p-4 animate-pulse">
                <div className="w-8 h-8 rounded-lg bg-muted mb-2" />
                <div className="h-6 w-12 bg-muted rounded mb-1" />
                <div className="h-3 w-20 bg-muted rounded" />
              </div>
            ))
          : stats.map(stat => {
              const Icon = stat.icon;
              return (
                <div key={stat.label} className="card p-4 flex flex-col gap-2">
                  <div className={`w-8 h-8 rounded-lg ${stat.iconBg} flex items-center justify-center`}>
                    <Icon className={`w-4 h-4 ${stat.iconColor}`} />
                  </div>
                  <p className="text-xl font-bold text-text-primary">{stat.value}</p>
                  <p className="text-xs text-text-secondary">{stat.label}</p>
                </div>
              );
            })}
      </div>

      {summary?.otherCurrencyRevenue?.length ? (
        <p role="note" className="-mt-3 mb-6 text-xs text-text-secondary">
          Total revenue is in {summary.currency}. Also earned in other currencies (not included above):{' '}
          {summary.otherCurrencyRevenue.map(r => formatCurrency(r.revenue, r.currency)).join(', ')}.
        </p>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2 card p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Booking Volume</h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={trend} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#00BF62" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#00BF62" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="areaGrad2" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#EF4444" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
              <Tooltip contentStyle={{ fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="value" name="Bookings" stroke="#00BF62" strokeWidth={2} fill="url(#areaGrad)" />
              <Area type="monotone" dataKey="secondaryValue" name="Cancelled" stroke="#EF4444" strokeWidth={1.5} strokeDasharray="4 2" fill="url(#areaGrad2)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="card p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Status Breakdown</h3>
          {statusBreakdown.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={statusBreakdown} dataKey="value" cx="50%" cy="50%" outerRadius={70} innerRadius={40}>
                    {statusBreakdown.map((entry, i) => (
                      <Cell key={i} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(val, name) => [val, name]} contentStyle={{ fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1">
                {statusBreakdown.map(entry => (
                  <div key={entry.label} className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: entry.color }} />
                      <span className="text-text-secondary">{entry.label}</span>
                    </div>
                    <span className="font-medium text-text-primary">{entry.value}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-sm text-text-muted text-center py-8">No appointment data</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-text-primary">By Service</h3>
          <p className="text-xs text-text-muted mb-4">Bookings in this period and upcoming ones; cancellations not counted</p>
          {serviceRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={serviceRows.slice(0, 8)} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="bookings" fill="#00BF62" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-text-muted text-center py-8">No service data</p>
          )}
        </div>

        <div className="card p-5">
          <h3 className="text-sm font-semibold text-text-primary">By Staff</h3>
          <p className="text-xs text-text-muted mb-4">Bookings in this period and upcoming ones; cancellations not counted</p>
          {staffRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={staffRows.slice(0, 8)} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={90} />
                <Tooltip contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="bookings" fill="#3B82F6" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-sm text-text-muted text-center py-8">No staff data</p>
          )}
        </div>
      </div>

      {topCustomers.length > 0 && (
        <div className="card p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Top Customers</h3>
          <div className="divide-y divide-border">
            {topCustomers.map((c, i) => (
              <div key={c.id} className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
                <span className="text-sm font-bold text-text-muted w-5 shrink-0">#{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate">{c.name}</p>
                  <p className="text-xs text-text-secondary truncate">{c.email}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-text-primary">{c.totalBookings} booking{c.totalBookings !== 1 ? 's' : ''}</p>
                  {c.lastBookingDate && (
                    <p className="text-xs text-text-muted">Last: {formatDate(c.lastBookingDate)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
