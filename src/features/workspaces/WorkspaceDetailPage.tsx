import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Edit2, Trash2, MapPin, Phone, Mail, Clock, Globe, Calendar,
  Users, Briefcase, Building2, CheckCircle, XCircle,
} from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmModal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/Empty';
import { useToast } from '@/components/ui/Toast';
import { workspacesApi, servicesApi, staffApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate, DAYS, DAY_LABELS } from '@/lib/utils';

interface ApiWorkspace {
  id: string;
  name: string;
  description?: string;
  address?: string;
  phone?: string;
  email?: string;
  timezone: string;
  color: string;
  isActive: boolean;
  serviceIds: string[];
  staffIds: string[];
  workingHours: Record<string, { enabled: boolean; start: string; end: string }>;
  createdAt: string;
}

interface ApiService {
  id: string;
  name: string;
  duration: number;
  price: number;
  color: string;
  isActive: boolean;
}

interface ApiStaff {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  role: string;
  title?: string;
}

export default function WorkspaceDetailPage() {
  const { can } = useAuth();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('Workspace');

  const [workspace, setWorkspace] = useState<ApiWorkspace | null>(null);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState('overview');
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      workspacesApi.get(id) as Promise<ApiWorkspace>,
      servicesApi.list() as Promise<ApiService[]>,
      staffApi.list() as Promise<ApiStaff[]>,
    ])
      .then(([ws, svcs, staff]) => {
        setWorkspace(ws);
        setAllServices(svcs);
        setAllStaff(staff);
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load workspace.'); setLoading(false); });
  }, [id]);

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading workspace…</div></div>;
  }

  if (error || !workspace) {
    return (
      <div className="page-container">
        <EmptyState
          icon={<Building2 className="w-6 h-6" />}
          title={error ? 'Failed to load workspace' : 'Workspace not found'}
          description={error ?? 'This workspace does not exist or has been removed.'}
          action={{ label: 'Back to Workspaces', onClick: () => navigate('/workspaces') }}
        />
      </div>
    );
  }

  const services = allServices.filter(s => workspace.serviceIds.includes(s.id));
  const staff = allStaff.filter(s => workspace.staffIds.includes(s.id));

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await workspacesApi.delete(workspace.id);
      toast.success('Workspace deleted', `${workspace.name} has been removed.`);
      navigate('/workspaces');
    } catch (e: unknown) {
      toast.error('Failed to delete workspace', (e as Error).message);
      setDeleting(false);
      setShowDelete(false);
    }
  };

  const tabsWithCounts = [
    { id: 'overview', label: 'Overview' },
    { id: 'hours', label: 'Working Hours' },
    { id: 'services', label: 'Services', count: services.length },
    { id: 'staff', label: 'Staff', count: staff.length },
  ];

  return (
    <div className="page-container">
      <PageHeader
        title={workspace.name}
        description={workspace.description}
        breadcrumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: workspace.name },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={workspace.isActive ? 'success' : 'default'} dot>
              {workspace.isActive ? 'Active' : 'Inactive'}
            </Badge>
            {can('workspaces:write') && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Edit2 className="w-3.5 h-3.5" />}
                  onClick={() => navigate(`/workspaces/${workspace.id}/edit`)}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 className="w-3.5 h-3.5" />}
                  onClick={() => setShowDelete(true)}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        }
        tabs={tabsWithCounts}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="mt-6">
        {activeTab === 'overview' && (
          <Card>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              {[
                { icon: <MapPin className="w-4 h-4" />, label: 'Address', value: workspace.address || '—' },
                { icon: <Phone className="w-4 h-4" />, label: 'Phone', value: workspace.phone || '—' },
                { icon: <Mail className="w-4 h-4" />, label: 'Email', value: workspace.email || '—' },
                { icon: <Globe className="w-4 h-4" />, label: 'Timezone', value: workspace.timezone },
                { icon: <Calendar className="w-4 h-4" />, label: 'Created', value: formatDate(workspace.createdAt) },
                {
                  icon: <div className="w-4 h-4 rounded-full border-2 border-white ring-2 ring-gray-200" style={{ backgroundColor: workspace.color }} />,
                  label: 'Brand Color',
                  value: workspace.color,
                },
              ].map(({ icon, label, value }) => (
                <div key={label} className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-text-muted shrink-0 mt-0.5">
                    {icon}
                  </div>
                  <div>
                    <p className="text-xs text-text-muted uppercase tracking-wide font-medium">{label}</p>
                    <p className="text-sm text-text-primary mt-0.5">{value}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {activeTab === 'hours' && (
          <Card>
            <div className="divide-y divide-border">
              {DAYS.map(day => {
                const schedule = workspace.workingHours?.[day];
                return (
                  <div key={day} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-3 w-28">
                      {schedule?.enabled
                        ? <CheckCircle className="w-4 h-4 text-primary shrink-0" />
                        : <XCircle className="w-4 h-4 text-text-muted shrink-0" />}
                      <span className="text-sm font-medium text-text-primary capitalize">
                        {DAY_LABELS[day] ?? day}
                      </span>
                    </div>
                    {schedule?.enabled ? (
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">
                          <Clock className="w-3 h-3" />
                          {schedule.start} – {schedule.end}
                        </Badge>
                      </div>
                    ) : (
                      <span className="text-sm text-text-muted">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {activeTab === 'services' && (
          services.length === 0 ? (
            <EmptyState
              icon={<Briefcase className="w-5 h-5" />}
              title="No services assigned"
              description="Choose the services offered here when you edit this workspace."
              action={can('workspaces:write') ? { label: 'Choose services', onClick: () => navigate(`/workspaces/${workspace.id}/edit`) } : undefined}
            />
          ) : (
            <div className="space-y-3">
              {services.map(svc => (
                <Card key={svc.id} padding="sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: svc.color }} />
                      <div>
                        <p className="text-sm font-medium text-text-primary">{svc.name}</p>
                        <p className="text-xs text-text-secondary">{svc.duration} min · ${svc.price}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={svc.isActive ? 'success' : 'default'}>{svc.isActive ? 'Active' : 'Inactive'}</Badge>
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/services/${svc.id}`)}>
                        View
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        )}

        {activeTab === 'staff' && (
          staff.length === 0 ? (
            <EmptyState
              icon={<Users className="w-5 h-5" />}
              title="No staff assigned"
              description="Assign staff members to this workspace."
            />
          ) : (
            <div className="space-y-3">
              {staff.map(member => (
                <Card key={member.id} padding="sm">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Avatar name={member.name} color={member.color} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-text-primary">{member.name}</p>
                        <p className="text-xs text-text-secondary">{member.title || member.role}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={member.isActive ? 'success' : 'default'}>{member.isActive ? 'Active' : 'Inactive'}</Badge>
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/staff/${member.id}`)}>
                        View
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        )}
      </div>

      <ConfirmModal
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete Workspace"
        message={`Are you sure you want to delete "${workspace.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
