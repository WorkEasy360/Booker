import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Mail, Phone, Calendar, Copy, ExternalLink,
  Edit, CalendarOff,
} from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  Button, Badge, Avatar, PageHeader, StatusBadge, EmptyState, useToast,
} from '@/components/ui';
import { staffApi, servicesApi, appointmentsApi, workspacesApi, bookingPagesApi, type StaffAccount } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { StaffAccessCard } from './StaffAccessCard';
import { StaffNotificationsCard } from './StaffNotificationsCard';
import { ImageUpload } from '@/components/ImageUpload';
import { mediaApi } from '@/api/client';
import { formatDate, formatTime, formatDuration, formatCurrency, cn, DAYS, DAY_LABELS } from '@/lib/utils';

function roleBadgeVariant(role: string) {
  if (role === 'owner') return 'primary' as const;
  if (role === 'admin') return 'warning' as const;
  if (role === 'staff') return 'info' as const;
  return 'default' as const;
}

interface ApiStaff {
  id: string;
  name: string;
  email: string;
  phone?: string;
  title?: string;
  bio?: string;
  role: string;
  color: string;
  isActive: boolean;
  serviceIds: string[];
  workspaceIds: string[];
  workingHours: Record<string, { enabled: boolean; start: string; end: string }>;
  bookingPageUrl?: string;
  createdAt: string;
  account?: StaffAccount;
  photoUrl?: string | null;
}

interface ApiService {
  id: string;
  name: string;
  category: string;
  price: number;
  currency: string;
  duration: number;
  color: string;
}

interface ApiWorkspace {
  id: string;
  name: string;
  color: string;
  address?: string;
}

interface ApiAppointment {
  id: string;
  status: string;
  date: string;
  startTime: string;
  serviceName: string;
  customerName: string;
}

export default function StaffProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('staff:manage');
  usePageTitle('Staff Profile');

  const [staff, setStaff] = useState<ApiStaff | null>(null);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<ApiWorkspace[]>([]);
  const [appointments, setAppointments] = useState<ApiAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState('overview');
  const [bookingPage, setBookingPage] = useState<{ slug: string; isPublished: boolean } | null>(null);

  const reloadStaff = () => {
    if (id) (staffApi.get(id) as Promise<ApiStaff>).then(setStaff).catch(() => { /* keep the last loaded record */ });
  };

  useEffect(() => {
    if (!id) return;
    Promise.all([
      staffApi.get(id) as Promise<ApiStaff>,
      servicesApi.list() as Promise<ApiService[]>,
      workspacesApi.list() as Promise<ApiWorkspace[]>,
      appointmentsApi.list({ staffId: id }) as Promise<ApiAppointment[]>,
      bookingPagesApi.list() as Promise<Array<{ slug: string; isPublished: boolean; staffId: string | null }>>,
    ])
      .then(([s, svcs, wss, apts, pages]) => {
        const own = pages.filter(p => p.staffId === id);
        setBookingPage(own.find(p => p.isPublished) ?? own[0] ?? null);
        setStaff(s);
        setAllServices(svcs);
        setAllWorkspaces(wss);
        setAppointments(apts);
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load staff.'); setLoading(false); });
  }, [id]);

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading staff profile…</div></div>;
  }

  if (error || !staff) {
    return (
      <div className="page-container">
        <EmptyState
          title={error ? 'Failed to load staff' : 'Staff member not found'}
          description={error ?? "The staff member you're looking for doesn't exist."}
          action={{ label: 'Back to Staff', onClick: () => navigate('/staff') }}
        />
      </div>
    );
  }

  const assignedServices = allServices.filter(svc => staff.serviceIds.includes(svc.id));
  const assignedWorkspaces = allWorkspaces.filter(ws => staff.workspaceIds.includes(ws.id));
  const bookingUrl = bookingPage ? `${window.location.origin}/book/${bookingPage.slug}` : null;

  function handleCopyUrl() {
    if (!bookingUrl) return;
    navigator.clipboard.writeText(bookingUrl)
      .then(() => toast.success('Booking URL copied to clipboard'))
      .catch(() => toast.error('Could not copy — please copy the URL manually'));
  }

  const TABS = [
    { id: 'overview',    label: 'Overview' },
    { id: 'schedule',    label: 'Schedule' },
    { id: 'services',    label: 'Services', count: assignedServices.length },
    { id: 'bookings',    label: 'Bookings', count: appointments.length },
    { id: 'bookingpage', label: 'Booking Page' },
  ];

  return (
    <div className="page-container">
      <PageHeader
        breadcrumbs={[{ label: 'Staff', href: '/staff' }, { label: staff.name }]}
        title=""
        actions={canManage ? (
          <Button
            variant="secondary"
            icon={<Edit className="w-4 h-4" />}
            onClick={() => navigate(`/staff/${staff.id}/edit`)}
          >
            Edit Profile
          </Button>
        ) : undefined}
      />

      <div className="card p-6 mb-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-5">
          <Avatar name={staff.name} src={staff.photoUrl ?? undefined} color={staff.color} size="xl" />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h1 className="text-xl font-semibold text-text-primary">{staff.name}</h1>
              <Badge variant={roleBadgeVariant(staff.role)}>
                {staff.role.charAt(0).toUpperCase() + staff.role.slice(1)}
              </Badge>
              <Badge variant={staff.isActive ? 'success' : 'default'} dot>
                {staff.isActive ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            {staff.title && <p className="text-sm text-text-secondary mb-2">{staff.title}</p>}
            <div className="flex flex-wrap gap-4 text-sm text-text-secondary">
              <span className="flex items-center gap-1.5">
                <Mail className="w-4 h-4 shrink-0" />{staff.email}
              </span>
              {staff.phone && (
                <span className="flex items-center gap-1.5">
                  <Phone className="w-4 h-4 shrink-0" />{staff.phone}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border mb-6 -mt-2 overflow-x-auto">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              activeTab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300',
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={cn(
                'inline-flex items-center justify-center w-5 h-5 rounded-full text-xs',
                activeTab === t.id ? 'bg-primary-light text-primary' : 'bg-gray-100 text-text-muted',
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            {staff.bio && (
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-text-primary mb-2">Bio</h3>
                <p className="text-sm text-text-secondary leading-relaxed">{staff.bio}</p>
              </div>
            )}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-3">Workspaces</h3>
              {assignedWorkspaces.length === 0 ? (
                <p className="text-sm text-text-muted">No workspaces assigned.</p>
              ) : (
                <div className="space-y-2">
                  {assignedWorkspaces.map(ws => (
                    <div key={ws.id} className="flex items-center gap-3">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ws.color }} />
                      <div>
                        <p className="text-sm font-medium text-text-primary">{ws.name}</p>
                        {ws.address && <p className="text-xs text-text-muted">{ws.address}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="space-y-4">
            {canManage && <StaffAccessCard staff={staff} onChanged={reloadStaff} />}
            {canManage && <StaffNotificationsCard staffId={staff.id} hasPhone={!!staff.phone} canEdit={canManage} />}
            {canManage && (
              <div className="card p-5">
                <ImageUpload label="Photo" shape="round" value={staff.photoUrl ?? null}
                  onChange={url => setStaff(s => (s ? { ...s, photoUrl: url } : s))}
                  upload={file => mediaApi.uploadStaffPhoto(staff.id, file)} remove={() => mediaApi.removeStaffPhoto(staff.id)} />
                <p className="text-xs text-text-muted mt-2">Shown on booking pages that have “Show staff photo” turned on.</p>
              </div>
            )}
            <div className="card p-5">
              <h3 className="text-sm font-semibold text-text-primary mb-3">Details</h3>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-text-muted">Email</dt>
                  <dd className="text-text-primary font-medium">{staff.email}</dd>
                </div>
                {staff.phone && (
                  <div>
                    <dt className="text-text-muted">Phone</dt>
                    <dd className="text-text-primary font-medium">{staff.phone}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-text-muted">Role</dt>
                  <dd>
                    <Badge variant={roleBadgeVariant(staff.role)} size="sm">
                      {staff.role.charAt(0).toUpperCase() + staff.role.slice(1)}
                    </Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-text-muted">Member Since</dt>
                  <dd className="text-text-primary font-medium">{formatDate(staff.createdAt)}</dd>
                </div>
              </dl>
            </div>

            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-text-primary">Time Off</h3>
                <Badge size="sm">Not available yet</Badge>
              </div>
              <div className="flex flex-col items-center justify-center py-6 text-center">
                <CalendarOff className="w-8 h-8 text-text-muted mb-2" />
                <p className="text-xs text-text-muted">Time-off tracking is not implemented yet. To block days, disable them in this staff member's working hours.</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'schedule' && (
        <div className="card p-5 max-w-lg">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Weekly Working Hours</h3>
          <div className="space-y-2">
            {DAYS.map(day => {
              const schedule = staff.workingHours?.[day];
              return (
                <div
                  key={day}
                  className="flex items-center gap-3 py-2 border-b border-border last:border-0"
                >
                  <span className="w-8 text-xs font-medium text-text-muted uppercase">
                    {DAY_LABELS[day]}
                  </span>
                  {schedule?.enabled ? (
                    <>
                      <div className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <span className="text-sm text-text-primary">
                        {formatTime(schedule.start)} – {formatTime(schedule.end)}
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-gray-300 shrink-0" />
                      <span className="text-sm text-text-muted">Closed</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'services' && (
        <div className="card divide-y divide-border">
          {assignedServices.length === 0 ? (
            <EmptyState title="No services assigned" description="This staff member has no assigned services." />
          ) : (
            assignedServices.map(svc => (
              <div key={svc.id} className="flex items-center gap-4 p-4">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.color }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{svc.name}</p>
                  <p className="text-xs text-text-muted capitalize">{svc.category}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-text-primary">{formatCurrency(svc.price, svc.currency)}</p>
                  <p className="text-xs text-text-muted">{formatDuration(svc.duration)}</p>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'bookings' && (
        <div className="card divide-y divide-border">
          {appointments.length === 0 ? (
            <EmptyState
              icon={<Calendar className="w-6 h-6" />}
              title="No bookings"
              description="This staff member has no appointments yet."
            />
          ) : (
            appointments.map(apt => (
              <div
                key={apt.id}
                className="flex items-center gap-4 p-4 hover:bg-gray-50/60 cursor-pointer transition-colors"
                onClick={() => navigate(`/appointments/${apt.id}`)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="text-sm font-medium text-text-primary">
                      {apt.customerName || 'Unknown Customer'}
                    </span>
                    <StatusBadge status={apt.status} />
                  </div>
                  <p className="text-xs text-text-secondary">{apt.serviceName || '—'}</p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm text-text-primary">{formatDate(apt.date)}</p>
                  <p className="text-xs text-text-muted">{formatTime(apt.startTime)}</p>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'bookingpage' && (
        <div className="card p-6 max-w-lg">
          <h3 className="text-sm font-semibold text-text-primary mb-1">Personal Booking Page</h3>
          <p className="text-sm text-text-secondary mb-4">
            Share this URL so clients can book directly with {staff.name.split(' ')[0]}.
          </p>
          {bookingPage && bookingUrl ? (
            <>
              <div className="flex items-center gap-2 p-3 bg-muted rounded-lg border border-border mb-4">
                <span className="flex-1 text-sm text-text-primary font-mono break-all">{bookingUrl}</span>
                {!bookingPage.isPublished && <Badge size="sm" variant="warning">Draft</Badge>}
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" icon={<Copy className="w-4 h-4" />} onClick={handleCopyUrl}>
                  Copy URL
                </Button>
                <Button
                  variant="primary"
                  icon={<ExternalLink className="w-4 h-4" />}
                  disabled={!bookingPage.isPublished}
                  onClick={() => window.open(`/book/${bookingPage.slug}`, '_blank', 'noopener,noreferrer')}
                >
                  Open Page
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-text-muted">No booking page is assigned to this staff member.</p>
              {can('booking_pages:write') && <Button variant="secondary" onClick={() => navigate('/booking-pages/new')}>Create booking page</Button>}
            </div>
          )}
        </div>
      )}

    </div>
  );
}
