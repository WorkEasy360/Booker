import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Edit, Trash2, Users, Box } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  Button, Badge, PageHeader, ConfirmModal, EmptyState, useToast,
} from '@/components/ui';
import { resourcesApi, workspacesApi, servicesApi } from '@/api/client';
import { formatDate, formatTime, DAYS } from '@/lib/utils';

type ResourceType = 'room' | 'equipment' | 'vehicle' | 'table' | 'other';

interface WorkingHoursDay { enabled: boolean; start: string; end: string }

interface ApiResource {
  id: string;
  name: string;
  description?: string;
  type: ResourceType;
  capacity: number;
  isActive: boolean;
  serviceIds: string[];
  workspaceIds: string[];
  availabilityRules?: Record<string, WorkingHoursDay>;
  createdAt: string;
}

interface ApiWorkspace { id: string; name: string; color: string }
interface ApiService   { id: string; name: string; color: string }

function typeBadge(type: ResourceType) {
  const map: Record<ResourceType, { variant: 'info' | 'warning' | 'success' | 'default'; label: string }> = {
    room:      { variant: 'info',    label: 'Room' },
    equipment: { variant: 'warning', label: 'Equipment' },
    vehicle:   { variant: 'success', label: 'Vehicle' },
    table:     { variant: 'info',    label: 'Table' },
    other:     { variant: 'default', label: 'Other' },
  };
  const { variant, label } = map[type] ?? { variant: 'default' as const, label: type };
  return <Badge variant={variant}>{label}</Badge>;
}

export default function ResourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('Resource');

  const [resource, setResource]         = useState<ApiResource | null>(null);
  const [allWorkspaces, setAllWorkspaces] = useState<ApiWorkspace[]>([]);
  const [allServices, setAllServices]   = useState<ApiService[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen]     = useState(false);
  const [deleting, setDeleting]         = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      resourcesApi.get(id) as Promise<ApiResource>,
      workspacesApi.list() as Promise<ApiWorkspace[]>,
      servicesApi.list() as Promise<ApiService[]>,
    ]).then(([res, wss, svcs]) => {
      setResource(res);
      setAllWorkspaces(wss);
      setAllServices(svcs);
      setLoading(false);
    }).catch((e: Error) => {
      setError(e.message ?? 'Failed to load resource.');
      setLoading(false);
    });
  }, [id]);

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading…</div></div>;
  }

  if (error || !resource) {
    return (
      <div className="page-container">
        <EmptyState
          icon={<Box className="w-6 h-6" />}
          title={error ? 'Failed to load resource' : 'Resource not found'}
          description={error ?? 'The resource you\'re looking for doesn\'t exist.'}
          action={{ label: 'Back to Resources', onClick: () => navigate('/resources') }}
        />
      </div>
    );
  }

  const assignedWorkspaces = allWorkspaces.filter(w => resource.workspaceIds.includes(w.id));
  const assignedServices   = allServices.filter(s => resource.serviceIds.includes(s.id));

  const current = resource;

  async function handleDelete() {
    setDeleting(true);
    try {
      await resourcesApi.delete(current.id);
      toast.success('Resource deleted', `${current.name} has been removed.`);
      navigate('/resources');
    } catch (e: unknown) {
      toast.error('Failed to delete resource', (e as Error).message);
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  return (
    <div className="page-container">
      <PageHeader
        breadcrumbs={[{ label: 'Resources', href: '/resources' }, { label: resource.name }]}
        title={resource.name}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<Edit className="w-4 h-4" />}
              onClick={() => navigate(`/resources/${resource.id}/edit`)}
            >
              Edit
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="w-4 h-4" />}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </div>
        }
      />

      <div className="flex items-center gap-2 mb-6 -mt-2">
        {typeBadge(resource.type)}
        <Badge variant={resource.isActive ? 'success' : 'default'} dot>
          {resource.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Overview</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
              <div>
                <dt className="text-text-muted mb-0.5">Type</dt>
                <dd>{typeBadge(resource.type)}</dd>
              </div>
              <div>
                <dt className="text-text-muted mb-0.5">Capacity</dt>
                <dd className="flex items-center gap-1.5 font-medium text-text-primary">
                  <Users className="w-4 h-4 text-text-muted" />
                  {resource.capacity} {resource.capacity === 1 ? 'booking' : 'bookings'} at a time
                </dd>
              </div>
              <div>
                <dt className="text-text-muted mb-0.5">Status</dt>
                <dd>
                  <Badge variant={resource.isActive ? 'success' : 'default'} dot>
                    {resource.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-text-muted mb-0.5">Created</dt>
                <dd className="font-medium text-text-primary">{formatDate(resource.createdAt)}</dd>
              </div>
              {resource.description && (
                <div className="col-span-2">
                  <dt className="text-text-muted mb-0.5">Description</dt>
                  <dd className="text-text-primary leading-relaxed">{resource.description}</dd>
                </div>
              )}
            </dl>
          </div>

          {resource.availabilityRules && (
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-text-primary mb-4">Availability</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2 pr-4 text-xs text-text-muted font-medium uppercase tracking-wide w-20">Day</th>
                      <th className="text-left py-2 pr-4 text-xs text-text-muted font-medium uppercase tracking-wide w-16">Status</th>
                      <th className="text-left py-2 text-xs text-text-muted font-medium uppercase tracking-wide">Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DAYS.map(day => {
                      const schedule = resource.availabilityRules![day];
                      return (
                        <tr key={day} className="border-b border-border last:border-0">
                          <td className="py-2 pr-4 font-medium text-text-primary capitalize">{day}</td>
                          <td className="py-2 pr-4">
                            {schedule?.enabled ? (
                              <span className="flex items-center gap-1.5 text-emerald-600">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />Open
                              </span>
                            ) : (
                              <span className="flex items-center gap-1.5 text-text-muted">
                                <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />Closed
                              </span>
                            )}
                          </td>
                          <td className="py-2 text-text-secondary">
                            {schedule?.enabled
                              ? `${formatTime(schedule.start)} – ${formatTime(schedule.end)}`
                              : '—'
                            }
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Workspaces</h2>
            {assignedWorkspaces.length === 0 ? (
              <p className="text-sm text-text-muted">No workspaces assigned.</p>
            ) : (
              <div className="space-y-2">
                {assignedWorkspaces.map(ws => (
                  <div key={ws.id} className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ws.color }} />
                    <span className="text-sm text-text-primary">{ws.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Assigned Services</h2>
            {assignedServices.length === 0 ? (
              <p className="text-sm text-text-muted">No services assigned.</p>
            ) : (
              <div className="space-y-2">
                {assignedServices.map(svc => (
                  <div key={svc.id} className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.color }} />
                    <span className="text-sm text-text-primary">{svc.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Delete Resource"
        message={`Are you sure you want to delete "${resource.name}"? This action cannot be undone.`}
        confirmLabel="Delete Resource"
        loading={deleting}
        variant="danger"
      />
    </div>
  );
}
