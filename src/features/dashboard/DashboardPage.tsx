import React, { useState, useMemo, useEffect } from 'react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Link, useNavigate } from 'react-router-dom';
import {
  AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import {
  CalendarDays, Clock, TrendingUp, XCircle, UserPlus, CheckCircle,
  Settings, Users, BookOpen, ArrowRight,
} from 'lucide-react';

import {
  Card, CardHeader, StatCard, Avatar, StatusBadge, EmptyState,
} from '@/components/ui';
import { appointmentsApi, staffApi, customersApi, settingsApi } from '@/api/client';
import { formatTime, todayInTimeZone } from '@/lib/utils';
import { DISPLAY_LOCALE } from '@/lib/regional';
import { addDaysISO, dayLabel, windowBounds } from '@/lib/reportWindow';
import { todaysAppointments, upcomingAppointments as upcomingAfterToday } from './dashboardLists';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiAppointment {
  id: string;
  bookingRef: string;
  customerId: string;
  staffId: string;
  status: string;
  date: string;
  startTime: string;
  customerName: string;
  serviceName: string;
  staffName: string;
  staffColor: string;
}

interface ApiStaff {
  id: string;
  name: string;
  title?: string;
  color: string;
  isActive: boolean;
}

// ─── Date range ───────────────────────────────────────────────────────────────

type DateRange = 'today' | 'week' | 'month' | 'custom';

const DATE_RANGE_OPTIONS: { id: DateRange; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'week',  label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'custom', label: 'Last 14 Days' },
];

/** Days in each range: the same windows as the Reports page and the server (N calendar days, today included). */
const RANGE_DAYS: Record<DateRange, number> = { today: 1, week: 7, month: 30, custom: 14 };

function getDateBounds(range: DateRange, today: string): { start: string; end: string } {
  const { from, to } = windowBounds(today, RANGE_DAYS[range]);
  return { start: from, end: to };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function buildStats(range: DateRange, allApts: ApiAppointment[], activeCustomers: number | null, today: string) {
  const { start, end } = getDateBounds(range, today);
  const rangeApts = allApts.filter(a => a.date >= start && a.date <= end);
  const total = rangeApts.length;
  const cancelled = rangeApts.filter(a => a.status === 'cancelled').length;
  const completed = rangeApts.filter(a => a.status === 'completed').length;
  const cancRate  = total > 0 ? `${((cancelled / total) * 100).toFixed(1)}%` : '—';
  const compRate  = total > 0 ? `${((completed / total) * 100).toFixed(0)}%` : '—';
  const upcoming  = allApts.filter(
    a => a.date > today && (a.status === 'scheduled' || a.status === 'confirmed')
  ).length;

  return [
    {
      label: range === 'today' ? "Today's Appointments" : 'Appointments',
      value: total,
      icon: <CalendarDays className="w-5 h-5 text-primary" />,
      iconBg: 'bg-primary-light',
    },
    {
      label: 'Upcoming',
      value: upcoming,
      icon: <Clock className="w-5 h-5 text-blue-600" />,
      iconBg: 'bg-blue-50',
    },
    {
      label: 'Total Bookings',
      value: allApts.length,
      icon: <TrendingUp className="w-5 h-5 text-emerald-600" />,
      iconBg: 'bg-emerald-50',
    },
    {
      label: 'Cancellation Rate',
      value: cancRate,
      icon: <XCircle className="w-5 h-5 text-red-500" />,
      iconBg: 'bg-red-50',
    },
    {
      // The same definition as the Customers page: customers with at least one appointment that was not cancelled.
      label: 'Active Customers',
      value: activeCustomers ?? '—',
      icon: <UserPlus className="w-5 h-5 text-purple-600" />,
      iconBg: 'bg-purple-50',
    },
    {
      label: 'Completion Rate',
      value: compRate,
      icon: <CheckCircle className="w-5 h-5 text-amber-500" />,
      iconBg: 'bg-amber-50',
    },
  ];
}

// ─── Status breakdown ─────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  scheduled: '#3B82F6',
  confirmed: '#6366F1',
  completed: '#10B981',
  cancelled: '#EF4444',
  no_show:   '#8B5CF6',
};

function buildStatusBreakdown(allApts: ApiAppointment[]) {
  const counts: Record<string, number> = {};
  for (const a of allApts) counts[a.status] = (counts[a.status] ?? 0) + 1;
  return Object.entries(counts).map(([status, value]) => ({
    label: status.charAt(0).toUpperCase() + status.slice(1).replace('_', ' '),
    value,
    color: STATUS_COLORS[status] ?? '#94A3B8',
  }));
}

// ─── Booking trend ────────────────────────────────────────────────────────────

function buildTrend(allApts: ApiAppointment[], today: string) {
  return Array.from({ length: 14 }, (_, i) => {
    const dateStr = addDaysISO(today, -(13 - i));
    const label = dayLabel(dateStr, DISPLAY_LOCALE, { month: 'short', day: 'numeric' });
    const value = allApts.filter(a => a.date === dateStr && a.status !== 'cancelled').length;
    const secondaryValue = allApts.filter(a => a.date === dateStr && a.status === 'cancelled').length;
    return { label, value, secondaryValue };
  });
}

// ─── Appointment row ──────────────────────────────────────────────────────────

function AppointmentRow({ apt }: { apt: ApiAppointment }) {
  return (
    <Link
      to={`/appointments/${apt.id}`}
      className="flex items-center gap-3 px-4 py-3 hover:bg-background rounded-lg transition-colors group"
    >
      <Avatar name={apt.customerName || 'Unknown'} size="sm" color={apt.staffColor} decorative />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">
          {apt.customerName || 'Unknown Customer'}
        </p>
        <p className="text-xs text-text-muted truncate">
          {apt.serviceName || 'Service'} · {apt.staffName || 'Staff'}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <span className="text-xs font-medium text-text-secondary">
          {formatTime(apt.startTime)}
        </span>
        <StatusBadge status={apt.status} />
      </div>
      <ArrowRight className="w-3.5 h-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
    </Link>
  );
}

// ─── Staff availability grid ──────────────────────────────────────────────────

function StaffAvailabilityGrid({ allApts, allStaff, today }: { allApts: ApiAppointment[]; allStaff: ApiStaff[]; today: string }) {
  const todayApts = allApts.filter(a => a.date === today);
  const rows = allStaff.slice(0, 6).map(member => {
    const count = todayApts.filter(a => a.staffId === member.id).length;
    let dotClass = 'bg-emerald-500';
    let status   = 'Available';
    if (!member.isActive) { dotClass = 'bg-gray-300'; status = 'Offline'; }
    else if (count >= 2)  { dotClass = 'bg-amber-400'; status = 'Busy'; }
    return { member, count, dotClass, status };
  });

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {rows.map(({ member, count, dotClass, status }) => (
        <Link
          key={member.id}
          to={`/staff/${member.id}`}
          className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-background transition-colors"
        >
          <div className="relative shrink-0">
            <Avatar name={member.name} size="sm" color={member.color} />
            <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-white ${dotClass}`} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">{member.name}</p>
            <p className="text-xs text-text-muted">{member.title ?? 'Staff'}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs font-semibold text-text-primary">{count} appt{count !== 1 ? 's' : ''}</p>
            <p className={`text-xs ${status === 'Available' ? 'text-emerald-600' : status === 'Busy' ? 'text-amber-600' : 'text-text-muted'}`}>
              {status}
            </p>
          </div>
        </Link>
      ))}
    </div>
  );
}

// ─── Quick actions ────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { label: 'Create Appointment', description: 'Book a new appointment for a customer', icon: <CalendarDays className="w-6 h-6 text-primary" />, iconBg: 'bg-primary-light', href: '/appointments/new' },
  { label: 'Add Service', description: 'Define a new service offering', icon: <BookOpen className="w-6 h-6 text-blue-600" />, iconBg: 'bg-blue-50', href: '/services/new' },
  { label: 'Add Staff', description: 'Invite a new team member', icon: <Users className="w-6 h-6 text-purple-600" />, iconBg: 'bg-purple-50', href: '/staff' },
  { label: 'Customize Booking Page', description: 'Edit your public booking experience', icon: <Settings className="w-6 h-6 text-amber-600" />, iconBg: 'bg-amber-50', href: '/booking-pages' },
];

// ─── Tooltip ─────────────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border rounded-lg shadow-dropdown px-3 py-2 text-xs">
      <p className="font-semibold text-text-primary mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color }}>{p.name}: <span className="font-medium">{p.value}</span></p>
      ))}
    </div>
  );
}

function renderPieLabel({ cx, cy, midAngle, innerRadius, outerRadius, percent }: { cx: number; cy: number; midAngle: number; innerRadius: number; outerRadius: number; percent: number }) {
  if (percent < 0.06) return null;
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.55;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return <text x={x} y={y} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600}>{`${(percent * 100).toFixed(0)}%`}</text>;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  usePageTitle('Dashboard');
  const navigate = useNavigate();
  const [dateRange, setDateRange] = useState<DateRange>('today');

  const [allApts, setAllApts]     = useState<ApiAppointment[]>([]);
  const [allStaff, setAllStaff]   = useState<ApiStaff[]>([]);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      appointmentsApi.list() as Promise<ApiAppointment[]>,
      staffApi.list() as Promise<ApiStaff[]>,
    ])
      .then(([apts, staff]) => {
        setAllApts(apts);
        setAllStaff(staff);
      })
      .catch((e: Error) => setLoadError(e.message || 'Failed to load dashboard data'))
      .finally(() => setLoading(false));
  }, []);

  const [activeCustomers, setActiveCustomers] = useState<number | null>(null);
  useEffect(() => { customersApi.summary().then(s => setActiveCustomers(s.active)).catch(() => setActiveCustomers(null)); }, []);
  // "Today" is the business's date, as on the Reports page; until its time zone has loaded, the browser's date.
  const [businessTz, setBusinessTz] = useState<string | undefined>(undefined);
  useEffect(() => { (settingsApi.get() as Promise<{ timezone?: string }>).then(o => setBusinessTz(o.timezone)).catch(() => setBusinessTz(undefined)); }, []);
  const today = todayInTimeZone(businessTz);
  const stats           = useMemo(() => buildStats(dateRange, allApts, activeCustomers, today), [dateRange, allApts, activeCustomers, today]);
  const statusBreakdown = useMemo(() => buildStatusBreakdown(allApts),        [allApts]);
  const trendData       = useMemo(() => buildTrend(allApts, today),           [allApts, today]);

  const todayAppointments = useMemo(
    () => todaysAppointments(allApts, today).slice(0, 3),
    [allApts, today]
  );
  const upcomingAppointments = useMemo(
    // From tomorrow on: today's appointments are in the "Today" list beside it, so nobody is listed twice.
    () => upcomingAfterToday(allApts, today).slice(0, 5),
    [allApts, today]
  );

  const noBreakdownData = statusBreakdown.length === 0;

  if (loading) {
    return (
      <div className="page-container space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-text-primary">Dashboard</h1>
            <p className="text-sm text-text-secondary mt-0.5">Welcome back — loading your data…</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Dashboard</h1>
          <p className="text-sm text-text-secondary mt-0.5">Welcome back — here's what's happening today.</p>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-xl p-1 self-start sm:self-auto">
          {DATE_RANGE_OPTIONS.map(opt => (
            <button
              key={opt.id}
              onClick={() => setDateRange(opt.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all ${
                dateRange === opt.id ? 'bg-surface text-text-primary shadow-card' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loadError && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load dashboard data: {loadError}. Figures below may be empty.
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
        {stats.map((s, i) => (
          <StatCard key={i} label={s.label} value={s.value} icon={s.icon} iconBg={s.iconBg} />
        ))}
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card padding="none" className="lg:col-span-2 overflow-hidden">
          <div className="p-5 pb-2">
            <CardHeader title="Booking Trends" subtitle="Bookings vs cancellations — last 14 days" />
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={trendData} margin={{ top: 4, right: 20, left: -10, bottom: 4 }}>
              <defs>
                <linearGradient id="bookingsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#00BF62" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="#00BF62" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="cancelsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.14} />
                  <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E1E7EB" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94A3B0' }} axisLine={false} tickLine={false} interval={1} />
              <YAxis tick={{ fontSize: 11, fill: '#94A3B0' }} axisLine={false} tickLine={false} allowDecimals={false} />
              <Tooltip content={<ChartTooltip />} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, paddingTop: 8, paddingLeft: 20 }} />
              <Area type="monotone" dataKey="value" name="Bookings" stroke="#00BF62" strokeWidth={2} fill="url(#bookingsGrad)" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
              <Area type="monotone" dataKey="secondaryValue" name="Cancellations" stroke="#EF4444" strokeWidth={2} fill="url(#cancelsGrad)" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card padding="none" className="overflow-hidden">
          <div className="p-5 pb-0">
            <CardHeader title="Status Breakdown" subtitle="Appointment outcomes — all time" />
          </div>
          {noBreakdownData ? (
            <div className="flex items-center justify-center py-16 text-text-muted text-sm">No appointments yet</div>
          ) : (
            <div className="flex flex-col items-center">
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie data={statusBreakdown} cx="50%" cy="50%" innerRadius={46} outerRadius={78} paddingAngle={2} dataKey="value" labelLine={false} label={renderPieLabel}>
                    {statusBreakdown.map((entry, index) => <Cell key={index} fill={entry.color} />)}
                  </Pie>
                  <Tooltip formatter={(val: number, name: string) => [val, name]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E1E7EB', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="w-full px-5 pb-5 grid grid-cols-2 gap-x-3 gap-y-2">
                {statusBreakdown.map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                    <span className="text-xs text-text-secondary truncate">{item.label}</span>
                    <span className="text-xs font-semibold text-text-primary ml-auto">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Appointments + Staff row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card padding="none" className="lg:col-span-1">
          <div className="p-5 pb-2">
            <CardHeader
              title="Today's Appointments"
              subtitle={dayLabel(today, DISPLAY_LOCALE, { month: 'long', day: 'numeric', year: 'numeric' })}
              action={<Link to="/appointments" className="text-xs font-medium text-primary hover:underline">View all</Link>}
            />
          </div>
          <div className="pb-3">
            {todayAppointments.length > 0 ? (
              todayAppointments.map(apt => <AppointmentRow key={apt.id} apt={apt} />)
            ) : (
              <div className="px-5 py-6">
                <EmptyState icon={<CalendarDays className="w-8 h-8" />} title="No appointments today" description="All clear for today." />
              </div>
            )}
          </div>
        </Card>

        <Card padding="none" className="lg:col-span-1">
          <div className="p-5 pb-2">
            <CardHeader title="Upcoming Appointments" subtitle="Next 5 scheduled" action={<Link to="/appointments" className="text-xs font-medium text-primary hover:underline">View all</Link>} />
          </div>
          <div className="pb-3">
            {upcomingAppointments.length > 0 ? (
              upcomingAppointments.map(apt => <AppointmentRow key={apt.id} apt={apt} />)
            ) : (
              <div className="px-5 py-6">
                <EmptyState icon={<Clock className="w-8 h-8" />} title="No upcoming appointments" description="Nothing scheduled yet." />
              </div>
            )}
          </div>
        </Card>

        <Card padding="none" className="lg:col-span-1">
          <div className="p-5 pb-3">
            <CardHeader title="Staff Availability" subtitle="Today's status" action={<Link to="/staff" className="text-xs font-medium text-primary hover:underline">Manage</Link>} />
            <StaffAvailabilityGrid allApts={allApts} allStaff={allStaff} today={today} />
          </div>
        </Card>
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-sm font-semibold text-text-primary mb-3">Quick Actions</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {QUICK_ACTIONS.map((action, i) => (
            <Card key={i} padding="md" hover onClick={() => navigate(action.href)} className="group">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${action.iconBg}`}>
                {action.icon}
              </div>
              <p className="text-sm font-semibold text-text-primary mb-1 group-hover:text-primary transition-colors">{action.label}</p>
              <p className="text-xs text-text-muted leading-snug">{action.description}</p>
              <div className="flex items-center gap-1 mt-3 text-xs font-medium text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                <span>Go</span><ArrowRight className="w-3 h-3" />
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
