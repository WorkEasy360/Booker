import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  Clock, Calendar, MapPin, Copy, ExternalLink,
  Users, Banknote, CheckCircle, RefreshCw,
  X as XIcon, Link as LinkIcon,
} from 'lucide-react';
import { format, startOfWeek, addDays, differenceInMinutes, parse } from 'date-fns';
import {
  Card, CardHeader, StatCard, StatusBadge, Badge,
  ConfirmModal, Avatar, Button, useToast,
} from '@/components/ui';
import { appointmentsApi, staffApi, bookingPagesApi } from '@/api/client';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { formatDate, formatTime, formatCurrency, copyToClipboard, cn, localDateISO } from '@/lib/utils';

import type { AppointmentStatus } from '@/types';
import { DEFAULT_CURRENCY } from '@/lib/regional';

interface ApiAppointment {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  staffId: string;
  customerId: string;
  serviceId: string;
  serviceName?: string;
  customerName?: string;
  staffName?: string;
  location?: string;
  price?: number;
  currency?: string;
}

interface WorkingHoursDay { enabled: boolean; start: string; end: string }

interface ApiStaff {
  id: string;
  name: string;
  email?: string;
  color: string;
  role: string;
  title?: string;
  workingHours?: Record<string, WorkingHoursDay>;
}

const TODAY = localDateISO();
const weekMonday = startOfWeek(new Date(), { weekStartsOn: 1 });
const weekDays = Array.from({ length: 5 }, (_, i) => {
  const d = addDays(weekMonday, i);
  return { date: format(d, 'yyyy-MM-dd'), label: format(d, 'EEE'), num: format(d, 'd') };
});
const WEEK_START = format(weekMonday, 'yyyy-MM-dd');
const WEEK_END   = format(addDays(weekMonday, 6), 'yyyy-MM-dd');

const STATUS_BORDER: Record<AppointmentStatus, string> = {
  scheduled:  'border-blue-400',
  confirmed:  'border-primary',
  completed:  'border-emerald-400',
  cancelled:  'border-red-400',
  no_show:    'border-purple-400',
};
const STATUS_SURFACE: Record<AppointmentStatus, string> = {
  scheduled:  'bg-blue-50',
  confirmed:  'bg-primary-light',
  completed:  'bg-emerald-50',
  cancelled:  'bg-red-50',
  no_show:    'bg-purple-50',
};

const DAY_ORDER = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
] as const;
const DAY_LABEL: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

function aptMinutes(apt: ApiAppointment): number {
  try {
    const base = new Date(`${apt.date}T00:00:00`);
    const s = parse(apt.startTime, 'HH:mm', base);
    const e = parse(apt.endTime,   'HH:mm', base);
    const diff = differenceInMinutes(e, s);
    return diff > 0 ? diff : 0;
  } catch { return 0; }
}

export default function MySpacePage() {
  const navigate = useNavigate();
  const { user, can } = useAuth();
  const canChange = can('appointments:write');
  const toast = useToast();
  usePageTitle('My Space');

  const [myStaff, setMyStaff]           = useState<ApiStaff | null>(null);
  const [appointments, setAppointments] = useState<ApiAppointment[]>([]);
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState<string | null>(null);
  const [profileIssue, setProfileIssue] = useState<'none' | 'ambiguous' | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ApiAppointment | null>(null);
  const [cancelling, setCancelling]     = useState(false);
  const [myPage, setMyPage]             = useState<{ slug: string; isPublished: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      staffApi.list() as Promise<ApiStaff[]>,
      appointmentsApi.list() as Promise<ApiAppointment[]>,
      bookingPagesApi.list() as Promise<Array<{ slug: string; isPublished: boolean; staffId: string | null }>>,
    ]).then(([staff, apts, pages]) => {
      if (cancelled) return;
      // A staff sign-in is linked to exactly one staff record; other accounts are matched by email.
      const email = user?.email?.trim().toLowerCase();
      const matches = user?.staffId
        ? staff.filter(s => s.id === user.staffId)
        : email ? staff.filter(s => s.email?.trim().toLowerCase() === email) : [];
      if (matches.length === 1) {
        setMyStaff(matches[0]);
        setProfileIssue(null);
        const own = pages.filter(p => p.staffId === matches[0].id);
        setMyPage(own.find(p => p.isPublished) ?? own[0] ?? null);
      } else {
        setMyStaff(null);
        setProfileIssue(matches.length === 0 ? 'none' : 'ambiguous');
      }
      setAppointments(apts);
      setLoading(false);
    }).catch((e: Error) => {
      if (cancelled) return;
      setLoadError(e.message || 'Failed to load your schedule');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [user?.email, user?.staffId]);

  const myApts = useMemo(
    () => myStaff ? appointments.filter(a => a.staffId === myStaff.id) : [],
    [appointments, myStaff],
  );

  const todayApts = useMemo(
    () => myApts.filter(a => a.date === TODAY).sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [myApts],
  );
  const upcomingApts = useMemo(
    () => myApts
      .filter(a => a.date >= TODAY && a.status !== 'cancelled' && a.status !== 'no_show')
      .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
      .slice(0, 5),
    [myApts],
  );
  const nextApt = todayApts.find(a => a.status === 'scheduled' || a.status === 'confirmed');

  const myWeekApts = useMemo(
    () => myApts.filter(a => a.date >= WEEK_START && a.date <= WEEK_END),
    [myApts],
  );

  const completedThisWeek = myWeekApts.filter(a => a.status === 'completed').length;
  const hoursThisWeek = (myWeekApts.filter(a => a.status !== 'cancelled').reduce((sum, a) => sum + aptMinutes(a), 0) / 60).toFixed(1);
  const uniqueCustomers = new Set(myWeekApts.map(a => a.customerId)).size;
  // Totals are kept per currency so amounts in different currencies are never added together.
  const revenueByCurrency = myWeekApts
    .filter(a => a.status === 'completed')
    .reduce<Record<string, number>>((acc, a) => {
      const c = a.currency ?? DEFAULT_CURRENCY;
      acc[c] = (acc[c] ?? 0) + (a.price ?? 0);
      return acc;
    }, {});
  const revenueLabel = Object.keys(revenueByCurrency).length
    ? Object.entries(revenueByCurrency).map(([c, v]) => formatCurrency(v, c)).join(' + ')
    : '—';

  async function handleCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      const updated = await appointmentsApi.update(cancelTarget.id, { status: 'cancelled' }) as { email?: EmailOutcome };
      setAppointments(prev =>
        prev.map(a => a.id === cancelTarget.id ? { ...a, status: 'cancelled' as AppointmentStatus } : a),
      );
      toastWithEmailOutcome(toast, 'Appointment cancelled', '', 'cancellation', updated.email);
      setCancelTarget(null);
    } catch (e: unknown) {
      toast.error('Could not cancel appointment', (e as Error).message);
    } finally {
      setCancelling(false);
    }
  }

  const bookingUrl = myPage ? `${window.location.origin}/book/${myPage.slug}` : null;

  function handleCopyLink() {
    if (!bookingUrl) return;
    copyToClipboard(bookingUrl)
      .then(() => toast.success('Booking link copied to clipboard'))
      .catch(() => toast.error('Could not copy — please copy the URL manually'));
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const staffColor = myStaff?.color ?? '#00BF62';

  return (
    <div className="page-container space-y-6">

      {/* Welcome Banner */}
      <div className="bg-primary rounded-xl px-6 py-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white/70 mb-1">{formatDate(TODAY, 'EEEE, MMMM d, yyyy')}</p>
            <h1 className="text-xl font-bold text-white">{greeting}, {user?.name ?? 'there'}</h1>
            <p className="text-sm text-white/70 mt-0.5 capitalize">{user?.role ?? ''}</p>
          </div>
          <div className="flex gap-3 shrink-0">
            <div className="bg-white/15 rounded-lg px-4 py-2.5 text-center min-w-[72px]">
              <p className="text-2xl font-bold text-white tabular-nums">{loading ? '…' : todayApts.length}</p>
              <p className="text-xs text-white/70 mt-0.5">Today</p>
            </div>
            {!loading && (nextApt ? (
              <div className="bg-white/15 rounded-lg px-4 py-2.5 text-center min-w-[80px]">
                <p className="text-lg font-bold text-white tabular-nums">{formatTime(nextApt.startTime)}</p>
                <p className="text-xs text-white/70 mt-0.5">Next up</p>
              </div>
            ) : (
              <div className="bg-white/15 rounded-lg px-4 py-2.5 text-center min-w-[80px]">
                <p className="text-sm font-semibold text-white/80">All done</p>
                <p className="text-xs text-white/70 mt-0.5">for today</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {loadError && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load your schedule: {loadError}
        </div>
      )}
      {!loading && !loadError && profileIssue && (
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          {profileIssue === 'none'
            ? `No staff profile uses your sign-in email (${user?.email ?? 'unknown'}). Ask an admin to create a staff member with this email to see your personal schedule here.`
            : `More than one staff profile uses your sign-in email (${user?.email ?? 'unknown'}). Ask an admin to make staff emails unique so your schedule can be shown.`}
        </div>
      )}

      {/* Quick Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Completed"     value={completedThisWeek}  icon={<CheckCircle className="w-5 h-5 text-primary"    />} iconBg="bg-primary-light" description="This week" />
        <StatCard label="Hours Worked"  value={`${hoursThisWeek}h`} icon={<Clock       className="w-5 h-5 text-blue-600"   />} iconBg="bg-blue-50"      description="This week" />
        <StatCard label="Clients"       value={uniqueCustomers}    icon={<Users        className="w-5 h-5 text-purple-600" />} iconBg="bg-purple-50"    description="This week" />
        <StatCard label="Revenue"       value={revenueLabel} icon={<Banknote className="w-5 h-5 text-amber-600" />} iconBg="bg-amber-50" description="This week (completed)" />
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">

          {/* Today's Schedule */}
          <Card padding="none">
            <div className="p-5 pb-0">
              <CardHeader
                title="Today's Schedule"
                subtitle={`${formatDate(TODAY, 'EEEE, MMMM d')} · ${todayApts.length} appointment${todayApts.length !== 1 ? 's' : ''}`}
              />
            </div>
            {loading ? (
              <p className="text-sm text-text-muted text-center py-10 px-5">Loading…</p>
            ) : todayApts.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-10 px-5">No appointments scheduled for today.</p>
            ) : (
              <div className="px-5 pb-5 space-y-3">
                {todayApts.map(apt => (
                  <div
                    key={apt.id}
                    className={cn(
                      'flex gap-3 pl-4 border-l-[3px] rounded-r-xl py-3 pr-4',
                      STATUS_BORDER[apt.status],
                      STATUS_SURFACE[apt.status],
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-text-primary tabular-nums">
                          {formatTime(apt.startTime)} – {formatTime(apt.endTime)}
                        </span>
                        <StatusBadge status={apt.status} />
                      </div>
                      <p className="text-sm font-medium text-text-primary mt-1">{apt.serviceName}</p>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        <span className="flex items-center gap-1 text-xs text-text-secondary">
                          <Users className="w-3 h-3" />{apt.customerName}
                        </span>
                        {apt.location && (
                          <span className="flex items-center gap-1 text-xs text-text-secondary">
                            <MapPin className="w-3 h-3" />{apt.location}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Upcoming Appointments */}
          <Card padding="none">
            <div className="p-5 pb-3">
              <CardHeader title="Upcoming Appointments" subtitle="Next scheduled sessions" />
            </div>
            {loading ? (
              <p className="text-sm text-text-muted text-center py-8 px-5">Loading…</p>
            ) : upcomingApts.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-8 px-5">No upcoming appointments.</p>
            ) : (
              <div className="divide-y divide-border px-5 pb-2">
                {upcomingApts.map(apt => (
                  <div key={apt.id} className="py-3 flex items-center gap-3 flex-wrap">
                    <Avatar name={apt.customerName ?? '?'} size="sm" color={staffColor} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary truncate">{apt.customerName}</p>
                      <p className="text-xs text-text-secondary">
                        {apt.serviceName} · {formatDate(apt.date, 'EEE, MMM d')} at {formatTime(apt.startTime)}
                      </p>
                    </div>
                    <StatusBadge status={apt.status} />
                    {canChange && <div className="flex gap-1.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<RefreshCw className="w-3 h-3" />}
                        onClick={() => navigate(`/appointments/${apt.id}/reschedule`)}
                        disabled={apt.status === 'cancelled' || apt.status === 'completed'}
                      >
                        Reschedule
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<XIcon className="w-3 h-3" />}
                        onClick={() => setCancelTarget(apt)}
                        disabled={apt.status === 'cancelled'}
                      >
                        Cancel
                      </Button>
                    </div>}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-6">

          {/* This Week mini-grid */}
          <Card>
            <CardHeader
              title="This Week"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Calendar className="w-3.5 h-3.5" />}
                  onClick={() => navigate('/calendar')}
                >
                  View
                </Button>
              }
            />
            <div className="grid grid-cols-5 gap-1.5">
              {weekDays.map(({ date, label, num }) => {
                const count = myApts.filter(a => a.date === date).length;
                const isAnchor = date === TODAY;
                return (
                  <button
                    key={date}
                    onClick={() => navigate('/calendar')}
                    className={cn(
                      'flex flex-col items-center rounded-lg py-2.5 px-1 gap-0.5 transition-colors',
                      isAnchor
                        ? 'bg-primary'
                        : count > 0
                        ? 'bg-primary-light hover:bg-primary/20'
                        : 'bg-muted hover:bg-border',
                    )}
                  >
                    <span className={cn('text-[10px] font-semibold uppercase tracking-wide', isAnchor ? 'text-white/70' : 'text-text-muted')}>
                      {label}
                    </span>
                    <span className={cn('text-sm font-bold', isAnchor ? 'text-white' : 'text-text-primary')}>
                      {num}
                    </span>
                    <span className={cn('text-xs font-semibold tabular-nums', isAnchor ? 'text-white' : count > 0 ? 'text-primary' : 'text-text-muted')}>
                      {count > 0 ? count : '–'}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Availability */}
          <Card>
            <CardHeader
              title="My Availability"
              subtitle="Working hours from your staff profile"
              action={myStaff && can('staff:manage') ? (
                <Button variant="ghost" size="sm" onClick={() => navigate(`/staff/${myStaff.id}/edit`)}>Edit</Button>
              ) : undefined}
            />
            <div className="space-y-1">
              {DAY_ORDER.map(day => {
                const sched = myStaff?.workingHours?.[day];
                const open = !!sched?.enabled;
                return (
                  <div
                    key={day}
                    className={cn(
                      'w-full flex items-center justify-between text-xs px-3 py-2 rounded-lg',
                      open ? 'bg-primary-light' : 'bg-muted opacity-60',
                    )}
                  >
                    <span className={cn('font-semibold w-[72px] text-left', open ? 'text-text-primary' : 'text-text-muted')}>
                      {DAY_LABEL[day]}
                    </span>
                    <span className="text-text-secondary flex-1 text-center">
                      {open && sched ? `${formatTime(sched.start)} – ${formatTime(sched.end)}` : ''}
                    </span>
                    <Badge variant={open ? 'primary' : 'default'} size="sm">
                      {open ? 'Open' : 'Off'}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader title="My Booking Page" />
            {myPage && bookingUrl ? (
              <div className="space-y-3">
                <div className="bg-muted rounded-lg p-3">
                  <p className="text-xs text-text-muted mb-1.5 flex items-center gap-1">
                    <LinkIcon className="w-3 h-3" />
                    Your booking link {!myPage.isPublished && <Badge size="sm" variant="warning">Draft — not public</Badge>}
                  </p>
                  <p className="text-xs font-medium text-text-primary break-all leading-relaxed">{bookingUrl}</p>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" icon={<Copy className="w-3.5 h-3.5" />} onClick={handleCopyLink} className="flex-1">
                    Copy Link
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<ExternalLink className="w-3.5 h-3.5" />}
                    onClick={() => window.open(`/book/${myPage.slug}`, '_blank')}
                    className="flex-1"
                    disabled={!myPage.isPublished}
                  >
                    Preview
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-text-muted">
                No booking page is assigned to you yet. An admin can create a staff booking page under Booking Pages.
              </p>
            )}
          </Card>
        </div>
      </div>

      <ConfirmModal
        isOpen={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={handleCancel}
        title="Cancel Appointment"
        message={
          cancelTarget
            ? `Cancel ${cancelTarget.serviceName ?? 'this appointment'} with ${cancelTarget.customerName ?? 'this customer'} on ${formatDate(cancelTarget.date, 'MMM d')} at ${formatTime(cancelTarget.startTime)}? This action cannot be undone.`
            : ''
        }
        confirmLabel="Yes, Cancel"
        variant="danger"
        loading={cancelling}
      />
    </div>
  );
}
