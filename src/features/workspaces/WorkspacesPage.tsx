import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, MapPin, Users, Briefcase, ExternalLink, Edit2, Building2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Empty';
import { workspacesApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';

interface ApiWorkspace {
  id: string;
  name: string;
  description?: string;
  address?: string;
  color: string;
  isActive: boolean;
  serviceIds: string[];
  staffIds: string[];
  bookingPageId?: string;
}

function WorkspaceCard({ workspace }: { workspace: ApiWorkspace }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const serviceCount = workspace.serviceIds?.length ?? 0;
  const staffCount = workspace.staffIds?.length ?? 0;

  return (
    <div className="card p-0 overflow-hidden flex flex-col">
      <div className="h-1.5 w-full" style={{ backgroundColor: workspace.color }} />

      <div className="p-5 flex flex-col flex-1">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 text-white"
              style={{ backgroundColor: workspace.color }}
            >
              <Building2 className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-text-primary truncate">{workspace.name}</h3>
              {workspace.description && (
                <p className="text-xs text-text-secondary mt-0.5 line-clamp-1">{workspace.description}</p>
              )}
            </div>
          </div>
          <Badge variant={workspace.isActive ? 'success' : 'default'} dot>
            {workspace.isActive ? 'Active' : 'Inactive'}
          </Badge>
        </div>

        <div className="space-y-2 mb-4 flex-1">
          {workspace.address && (
            <div className="flex items-center gap-2 text-xs text-text-secondary">
              <MapPin className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <span className="truncate">{workspace.address}</span>
            </div>
          )}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Briefcase className="w-3.5 h-3.5 text-text-muted" />
              <span>{serviceCount} service{serviceCount !== 1 ? 's' : ''}</span>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-text-secondary">
              <Users className="w-3.5 h-3.5 text-text-muted" />
              <span>{staffCount} staff member{staffCount !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-3 border-t border-border">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigate(`/workspaces/${workspace.id}`)}
            className="flex-1"
          >
            View Details
          </Button>
          {can('workspaces:write') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Edit2 className="w-3.5 h-3.5" />}
              onClick={() => navigate(`/workspaces/${workspace.id}/edit`)}
            >
              Edit
            </Button>
          )}
          {workspace.bookingPageId && can('booking_pages:write') && (
            <Button
              size="sm"
              variant="ghost"
              icon={<ExternalLink className="w-3.5 h-3.5" />}
              onClick={() => navigate(`/booking-pages/${workspace.bookingPageId}`)}
            >
              Booking
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function WorkspacesPage() {
  usePageTitle('Workspaces');
  const navigate = useNavigate();
  const { can } = useAuth();
  const canWrite = can('workspaces:write');
  const [workspaces, setWorkspaces] = useState<ApiWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    (workspacesApi.list() as Promise<ApiWorkspace[]>)
      .then(setWorkspaces)
      .catch((e: Error) => setLoadError(e.message || 'Failed to load workspaces'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page-container">
      <PageHeader
        title="Workspaces"
        description="Manage your locations and virtual spaces where services are delivered."
        breadcrumbs={[{ label: 'Workspaces' }]}
        actions={canWrite ? (
          <Button
            icon={<Plus className="w-4 h-4" />}
            onClick={() => navigate('/workspaces/new')}
          >
            Add Workspace
          </Button>
        ) : undefined}
      />

      <div className="mt-6">
        {loadError ? (
          <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">Could not load workspaces: {loadError}</div>
        ) : loading ? (
          <div className="text-center text-sm text-text-muted">Loading workspaces…</div>
        ) : workspaces.length === 0 ? (
          <EmptyState
            icon={<Building2 className="w-6 h-6" />}
            title="No workspaces yet"
            description={canWrite ? 'Create your first workspace to start managing locations and services.' : 'An administrator has not added any workspaces yet.'}
            action={canWrite ? {
              label: 'Add Workspace',
              onClick: () => navigate('/workspaces/new'),
              icon: <Plus className="w-4 h-4" />,
            } : undefined}
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {workspaces.map(ws => (
              <WorkspaceCard key={ws.id} workspace={ws} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
