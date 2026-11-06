import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, Search, Users, Mail, Phone, AlertTriangle, Info, KeyRound } from 'lucide-react';
import {
  Button, Input, Select, Badge, Avatar, ConfirmModal, PageHeader, useToast,
} from '@/components/ui';
import { staffApi, servicesApi, workspacesApi, appointmentsApi, type StaffAccount } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { bookabilityProblems, type StaffRole } from './staffRules';
import { cn, localDateISO } from '@/lib/utils';


interface ApiStaff {
  id: string;
  name: string;
  email: string;
  phone?: string;
  title?: string;
  color: string;
  role: StaffRole;
  isActive: boolean;
  serviceIds: string[];
  workspaceIds: string[];
  workingHours?: Record<string, { enabled?: boolean }>;
  /** Present for people who manage staff. */
  account?: StaffAccount;
}

const ACCOUNT_LABEL: Record<StaffAccount['status'], string> = {
  none: 'No sign-in',
  invited: 'Invitation sent',
  active: 'Can sign in',
  disabled: 'Sign-in turned off',
};

interface ApiService {
  id: string;
  name: string;
}

interface ApiWorkspace {
  id: string;
  name: string;
  color: string;
}

const ROLE_OPTIONS = [
  { value: '', label: 'All Roles' },
  { value: 'admin', label: 'Admin' },
  { value: 'manager', label: 'Manager' },
  { value: 'staff', label: 'Staff' },
];

const ACTIVE_OPTIONS = [
  { value: '', label: 'All Status' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

function roleBadgeVariant(role: StaffRole) {
  if (role === 'admin') return 'warning' as const;
  if (role === 'manager') return 'primary' as const;
  if (role === 'staff') return 'info' as const;
  return 'default' as const;
}

export default function StaffPage() {
  usePageTitle('Staff');
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const canManage = can('staff:manage');

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [wsFilter, setWsFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState('');
  const [statusTarget, setStatusTarget] = useState<{ staff: ApiStaff; upcoming: number } | null>(null);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);

  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<ApiWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      staffApi.list() as Promise<ApiStaff[]>,
      servicesApi.list() as Promise<ApiService[]>,
      workspacesApi.list() as Promise<ApiWorkspace[]>,
    ])
      .then(([staff, services, workspaces]) => {
        setAllStaff(staff);
        setAllServices(services);
        setAllWorkspaces(workspaces);
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load staff.'); setLoading(false); });
  }, []);

  const wsOptions = [
    { value: '', label: 'All Workspaces' },
    ...allWorkspaces.map(w => ({ value: w.id, label: w.name })),
  ];

  const filtered = allStaff.filter(s => {
    const q = search.toLowerCase();
    const matchSearch = !search ||
      s.name.toLowerCase().includes(q) ||
      s.email.toLowerCase().includes(q) ||
      (s.title?.toLowerCase().includes(q) ?? false);
    const matchRole = !roleFilter || s.role === roleFilter;
    const matchWs = !wsFilter || s.workspaceIds.includes(wsFilter);
    const matchActive =
      !activeFilter ||
      (activeFilter === 'active' ? s.isActive : !s.isActive);
    return matchSearch && matchRole && matchWs && matchActive;
  });

  const total = allStaff.length;
  const active = allStaff.filter(s => s.isActive).length;
  const inactive = allStaff.filter(s => !s.isActive).length;

  async function setActive(staff: ApiStaff, isActive: boolean) {
    setStatusBusy(staff.id);
    try {
      const updated = await staffApi.update(staff.id, { isActive }) as ApiStaff;
      setAllStaff(prev => prev.map(s => (s.id === staff.id ? { ...s, isActive: updated.isActive } : s)));
      toast.success(isActive ? `${staff.name} is active and bookable` : `${staff.name} deactivated`);
    } catch (e) {
      toast.error('Could not change status', (e as Error).message);
    } finally {
      setStatusBusy(null);
      setStatusTarget(null);
    }
  }

  async function requestToggle(staff: ApiStaff) {
    if (!staff.isActive) { await setActive(staff, true); return; }
    // Deactivation does not cancel existing bookings, so show how many remain before confirming.
    setStatusBusy(staff.id);
    try {
      const today = localDateISO();
      const appts = await appointmentsApi.list({ staffId: staff.id }) as Array<{ date: string; status: string }>;
      const upcoming = appts.filter(a => a.date >= today && a.status !== 'cancelled' && a.status !== 'no_show').length;
      setStatusTarget({ staff, upcoming });
    } catch (e) {
      toast.error('Could not check upcoming appointments', (e as Error).message);
    } finally {
      setStatusBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="Staff" description="Manage your team members and their access" breadcrumbs={[{ label: 'Staff' }]} />
        <div className="mt-8 text-center text-sm text-text-muted">Loading staff…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader title="Staff" description="Manage your team members and their access" breadcrumbs={[{ label: 'Staff' }]} />
        <div className="mt-8 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Failed to load staff: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Staff"
        description="Manage your team members and their access"
        breadcrumbs={[{ label: 'Staff' }]}
        actions={canManage ? (
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/staff/new')}>
            Add Staff Member
          </Button>
        ) : undefined}
      />

      <div className="mt-4 flex items-start gap-2 p-3 rounded-lg border border-border bg-muted text-xs text-text-secondary">
        <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        {canManage ? (
          <p>
            Staff members are bookable providers. Adding one here makes them available for bookings once they are active,
            assigned to at least one service and have working hours. Adding someone does not let them sign in: to do that,
            open their profile and send an invitation to their email address (email sending must be set up).
          </p>
        ) : (
          <p>You can view the team. Only administrators can add staff, change their details or manage their sign-in.</p>
        )}
      </div>

      {/* Stats bar */}
      <div className="flex items-center gap-6 mt-4 mb-6 p-4 bg-surface rounded-xl border border-border">
        <div className="text-center">
          <p className="text-2xl font-bold text-text-primary">{total}</p>
          <p className="text-xs text-text-secondary">Total Staff</p>
        </div>
        <div className="w-px h-10 bg-border" />
        <div className="text-center">
          <p className="text-2xl font-bold text-emerald-600">{active}</p>
          <p className="text-xs text-text-secondary">Active</p>
        </div>
        <div className="w-px h-10 bg-border" />
        <div className="text-center">
          <p className="text-2xl font-bold text-text-muted">{inactive}</p>
          <p className="text-xs text-text-secondary">Inactive</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-6">
        <div className="flex-1">
          <Input
            placeholder="Search staff..."
            aria-label="Search staff"
            value={search}
            onChange={e => setSearch(e.target.value)}
            prefix={<Search className="w-4 h-4" />}
          />
        </div>
        <div className="w-full sm:w-36">
          <Select aria-label="Filter by role" options={ROLE_OPTIONS} value={roleFilter} onChange={e => setRoleFilter(e.target.value)} />
        </div>
        <div className="w-full sm:w-44">
          <Select aria-label="Filter by workspace" options={wsOptions} value={wsFilter} onChange={e => setWsFilter(e.target.value)} />
        </div>
        <div className="w-full sm:w-36">
          <Select aria-label="Filter by status" options={ACTIVE_OPTIONS} value={activeFilter} onChange={e => setActiveFilter(e.target.value)} />
        </div>
      </div>

      {/* Staff grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center text-text-muted mb-4">
            <Users className="w-6 h-6" />
          </div>
          {total === 0 ? (
            <>
              <p className="text-sm font-semibold text-text-primary">No staff yet</p>
              <p className="text-sm text-text-secondary mb-4">{canManage ? 'Add your first staff member to start taking bookings.' : 'An administrator has not added any staff yet.'}</p>
              {canManage && <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/staff/new')}>Add Staff Member</Button>}
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-text-primary">No staff match these filters</p>
              <p className="text-sm text-text-secondary">Try adjusting your filters.</p>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map(staff => {
            const assignedServices = allServices.filter(svc => staff.serviceIds.includes(svc.id));
            const assignedWorkspaces = allWorkspaces.filter(ws => staff.workspaceIds.includes(ws.id));
            const problems = bookabilityProblems(staff);
            return (
              <div key={staff.id} className="card p-5 flex flex-col gap-4">
                {/* Header */}
                <div className="flex items-start gap-3">
                  <Avatar name={staff.name} color={staff.color} size="xl" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-semibold text-text-primary truncate">{staff.name}</h3>
                      <Badge variant={roleBadgeVariant(staff.role)} size="sm">
                        {staff.role.charAt(0).toUpperCase() + staff.role.slice(1)}
                      </Badge>
                    </div>
                    {staff.title && (
                      <p className="text-xs text-text-secondary mt-0.5 truncate">{staff.title}</p>
                    )}
                    <div className="flex items-center gap-1 mt-1">
                      <div className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        staff.isActive ? 'bg-emerald-500' : 'bg-gray-400',
                      )} />
                      <span className={cn(
                        'text-xs',
                        staff.isActive ? 'text-emerald-600' : 'text-text-muted',
                      )}>
                        {staff.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                  </div>
                  {canManage && <button
                    type="button"
                    role="switch"
                    aria-checked={staff.isActive}
                    aria-label={`${staff.isActive ? 'Deactivate' : 'Activate'} ${staff.name}`}
                    disabled={statusBusy === staff.id}
                    onClick={() => requestToggle(staff)}
                    className={cn(
                      'w-10 h-5 rounded-full transition-colors relative shrink-0 disabled:opacity-50',
                      staff.isActive ? 'bg-primary' : 'bg-gray-300',
                    )}
                  >
                    <span className={cn(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                      staff.isActive ? 'translate-x-5' : 'translate-x-0.5',
                    )} />
                  </button>}
                </div>

                {problems.length > 0 && (
                  <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
                    <span>Not bookable: {problems.join('; ')}</span>
                  </div>
                )}

                {/* Contact */}
                <div className="space-y-1">
                  <div className="flex items-center gap-2 text-xs text-text-secondary">
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{staff.email}</span>
                  </div>
                  {staff.phone && (
                    <div className="flex items-center gap-2 text-xs text-text-secondary">
                      <Phone className="w-3.5 h-3.5 shrink-0" />
                      <span>{staff.phone}</span>
                    </div>
                  )}
                  {staff.account && (
                    <div className="flex items-center gap-2 text-xs text-text-secondary" data-account-status={staff.account.status}>
                      <KeyRound className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>
                        {ACCOUNT_LABEL[staff.account.status]}
                        {staff.account.status === 'active' && staff.account.role ? ` (${staff.account.role})` : ''}
                      </span>
                    </div>
                  )}
                </div>

                {/* Services */}
                {assignedServices.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">Services</p>
                    <div className="flex flex-wrap gap-1">
                      {assignedServices.slice(0, 3).map(svc => (
                        <span
                          key={svc.id}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-text-secondary"
                        >
                          {svc.name}
                        </span>
                      ))}
                      {assignedServices.length > 3 && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-text-muted">
                          +{assignedServices.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Workspaces */}
                {assignedWorkspaces.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-1.5">Workspaces</p>
                    <div className="flex flex-wrap gap-1">
                      {assignedWorkspaces.map(ws => (
                        <span
                          key={ws.id}
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                          style={{ backgroundColor: ws.color + '20', color: ws.color }}
                        >
                          {ws.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-2 pt-1 border-t border-border">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1"
                    onClick={() => navigate(`/staff/${staff.id}`)}
                  >
                    View Profile
                  </Button>
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="flex-1"
                      onClick={() => navigate(`/staff/${staff.id}/edit`)}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        isOpen={!!statusTarget}
        onClose={() => setStatusTarget(null)}
        onConfirm={() => statusTarget && setActive(statusTarget.staff, false)}
        title={`Deactivate ${statusTarget?.staff.name ?? ''}`}
        message={statusTarget
          ? `${statusTarget.staff.name} will be hidden from booking pages and cannot be given new appointments.${statusTarget.upcoming
              ? ` Their ${statusTarget.upcoming} upcoming appointment${statusTarget.upcoming === 1 ? '' : 's'} will stay scheduled; reschedule or cancel them separately.`
              : ' They have no upcoming appointments.'}${statusTarget.staff.account?.status === 'active' ? ' They will also be signed out and cannot sign in while inactive.' : ''}`
          : ''}
        confirmLabel="Deactivate"
        variant="warning"
        loading={!!statusTarget && statusBusy === statusTarget.staff.id}
      />
    </div>
  );
}
