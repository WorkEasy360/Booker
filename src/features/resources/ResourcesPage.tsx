import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, Box, MoreVertical } from 'lucide-react';
import {
  Button, Badge, Select, PageHeader, Table, EmptyState, useToast,
} from '@/components/ui';
import { resourcesApi, servicesApi, workspacesApi } from '@/api/client';

type ResourceType = 'room' | 'equipment' | 'vehicle' | 'table' | 'other';

const TYPE_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'room', label: 'Room' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'table', label: 'Table' },
  { value: 'other', label: 'Other' },
];

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

interface ApiResource {
  id: string;
  name: string;
  description?: string;
  type: ResourceType;
  capacity: number;
  serviceIds: string[];
  workspaceIds: string[];
  isActive: boolean;
}

interface ApiService { id: string; name: string; }
interface ApiWorkspace { id: string; name: string; color: string; }

export default function ResourcesPage() {
  usePageTitle('Resources');
  const navigate = useNavigate();
  const toast = useToast();

  const [resources, setResources] = useState<ApiResource[]>([]);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<ApiWorkspace[]>([]);
  const [typeFilter, setTypeFilter] = useState('');

  useEffect(() => {
    Promise.all([
      resourcesApi.list() as Promise<ApiResource[]>,
      servicesApi.list() as Promise<ApiService[]>,
      workspacesApi.list() as Promise<ApiWorkspace[]>,
    ]).then(([res, svcs, wss]) => {
      setResources(res);
      setAllServices(svcs);
      setAllWorkspaces(wss);
    }).catch(() => {
      toast.error('Failed to load resources');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = resources.filter(r => !typeFilter || r.type === typeFilter);

  const columns = [
    {
      key: 'name',
      header: 'Name',
      render: (r: ApiResource) => (
        <div>
          <p className="font-medium text-text-primary">{r.name}</p>
          {r.description && (
            <p className="text-xs text-text-muted mt-0.5 max-w-xs truncate">{r.description}</p>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (r: ApiResource) => typeBadge(r.type),
    },
    {
      key: 'capacity',
      header: 'Capacity',
      render: (r: ApiResource) => (
        <span className="text-sm text-text-primary">{r.capacity} {r.capacity === 1 ? 'booking' : 'bookings'} at a time</span>
      ),
    },
    {
      key: 'services',
      header: 'Services',
      render: (r: ApiResource) => {
        const svcs = allServices.filter(s => r.serviceIds.includes(s.id));
        if (svcs.length === 0) return <span className="text-xs text-text-muted">None</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {svcs.slice(0, 2).map(s => (
              <span key={s.id} className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-muted text-text-secondary">
                {s.name}
              </span>
            ))}
            {svcs.length > 2 && (
              <span className="text-xs text-text-muted">+{svcs.length - 2}</span>
            )}
          </div>
        );
      },
    },
    {
      key: 'workspace',
      header: 'Workspace',
      render: (r: ApiResource) => {
        const ws = allWorkspaces.find(w => r.workspaceIds.includes(w.id));
        if (!ws) return <span className="text-xs text-text-muted">—</span>;
        return (
          <span
            className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium"
            style={{ backgroundColor: ws.color + '20', color: ws.color }}
          >
            {ws.name}
          </span>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (r: ApiResource) => (
        <Badge variant={r.isActive ? 'success' : 'default'} dot>
          {r.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r: ApiResource) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={e => { e.stopPropagation(); navigate(`/resources/${r.id}`); }}
          >
            View
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={e => { e.stopPropagation(); navigate(`/resources/${r.id}/edit`); }}
            aria-label={`Edit ${r.name}`}
          >
            <MoreVertical className="w-4 h-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="page-container">
      <PageHeader
        title="Resources"
        description="Manage rooms, equipment and other bookable assets"
        breadcrumbs={[{ label: 'Resources' }]}
        actions={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/resources/new')}>
            Add Resource
          </Button>
        }
      />

      <div className="flex items-center gap-3 mb-6 mt-4">
        <div className="w-40">
          <Select
            aria-label="Filter by type"
            options={TYPE_OPTIONS}
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
          />
        </div>
        <span className="text-sm text-text-muted">
          {filtered.length} resource{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="card overflow-hidden p-0">
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Box className="w-6 h-6" />}
            title="No resources found"
            description="Add rooms, equipment or other bookable assets to get started."
            action={{
              label: 'Add Resource',
              onClick: () => navigate('/resources/new'),
              icon: <Plus className="w-4 h-4" />,
            }}
          />
        ) : (
          <Table
            columns={columns}
            data={filtered}
            keyExtractor={(r: ApiResource) => r.id}
            onRowClick={(r: ApiResource) => navigate(`/resources/${r.id}`)}
            emptyTitle="No resources"
            emptyIcon={<Box className="w-6 h-6" />}
          />
        )}
      </div>
    </div>
  );
}
