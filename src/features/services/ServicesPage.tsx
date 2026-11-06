import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, Search, LayoutGrid, List, Clock, Banknote, Users, Briefcase } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';
import { EmptyState } from '@/components/ui/Empty';
import { Avatar } from '@/components/ui/Avatar';
import { servicesApi, staffApi } from '@/api/client';
import { formatCurrency, formatDuration } from '@/lib/utils';

type ServiceCategory = 'consultation' | 'class' | 'workshop' | 'session' | 'tour' | 'rental' | 'other';

interface ApiService {
  id: string;
  name: string;
  description: string;
  category: ServiceCategory;
  duration: number;
  price: number;
  currency: string;
  location: string;
  isActive: boolean;
  color: string;
  staffIds: string[];
}

interface ApiStaff {
  id: string;
  name: string;
  color: string;
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'All Categories' },
  { value: 'consultation', label: 'Consultation' },
  { value: 'class', label: 'Class' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'session', label: 'Session' },
  { value: 'tour', label: 'Tour' },
  { value: 'rental', label: 'Rental' },
  { value: 'other', label: 'Other' },
];

const CATEGORY_VARIANT: Record<ServiceCategory, 'info' | 'success' | 'warning' | 'purple' | 'default'> = {
  consultation: 'info',
  class: 'warning',
  workshop: 'success',
  session: 'info',
  tour: 'warning',
  rental: 'purple',
  other: 'default',
};

function ServiceCard({ service }: { service: ApiService }) {
  const navigate = useNavigate();
  const staffCount = service.staffIds.length;
  return (
    <Card hover onClick={() => navigate(`/services/${service.id}`)} className="cursor-pointer">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl shrink-0 flex items-center justify-center" style={{ backgroundColor: service.color + '20' }}>
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: service.color }} />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-text-primary truncate text-sm">{service.name}</h3>
            <Badge variant={CATEGORY_VARIANT[service.category] ?? 'default'} size="sm" className="mt-0.5 capitalize">
              {service.category}
            </Badge>
          </div>
        </div>
        <Badge variant={service.isActive ? 'success' : 'default'} dot size="sm">
          {service.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </div>
      {service.description && (
        <p className="text-xs text-text-secondary mb-3 line-clamp-2">{service.description}</p>
      )}
      <div className="grid grid-cols-3 gap-2 pt-3 border-t border-border">
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Clock className="w-3.5 h-3.5 text-text-muted" />
          {formatDuration(service.duration)}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Banknote className="w-3.5 h-3.5 text-text-muted" />
          {formatCurrency(service.price, service.currency)}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-text-secondary">
          <Users className="w-3.5 h-3.5 text-text-muted" />
          {staffCount} staff
        </div>
      </div>
    </Card>
  );
}

export default function ServicesPage() {
  usePageTitle('Services');
  const navigate = useNavigate();
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');

  const [services, setServices] = useState<ApiService[]>([]);
  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      servicesApi.list() as Promise<ApiService[]>,
      staffApi.list() as Promise<ApiStaff[]>,
    ])
      .then(([svcs, staff]) => { setServices(svcs); setAllStaff(staff); setLoading(false); })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load services.'); setLoading(false); });
  }, []);

  const staffById = useMemo(() => new Map(allStaff.map(s => [s.id, s])), [allStaff]);

  const filtered = useMemo(() => {
    return services.filter(s => {
      const matchSearch = !search ||
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        s.description.toLowerCase().includes(search.toLowerCase());
      const matchCategory = !category || s.category === category;
      return matchSearch && matchCategory;
    });
  }, [services, search, category]);

  const tableColumns = [
    {
      key: 'name',
      header: 'Service',
      render: (s: ApiService) => (
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: s.color + '20' }}>
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
          </div>
          <div>
            <p className="font-medium text-text-primary">{s.name}</p>
            <p className="text-xs text-text-muted">{s.location}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      render: (s: ApiService) => (
        <Badge variant={CATEGORY_VARIANT[s.category] ?? 'default'} size="sm" className="capitalize">{s.category}</Badge>
      ),
    },
    {
      key: 'duration',
      header: 'Duration',
      render: (s: ApiService) => (
        <span className="text-sm text-text-secondary">{formatDuration(s.duration)}</span>
      ),
    },
    {
      key: 'price',
      header: 'Price',
      render: (s: ApiService) => (
        <span className="text-sm font-medium text-text-primary">{formatCurrency(s.price, s.currency)}</span>
      ),
    },
    {
      key: 'staff',
      header: 'Staff',
      render: (s: ApiService) => {
        const members = s.staffIds.map(id => staffById.get(id)).filter(Boolean) as ApiStaff[];
        return (
          <div className="flex items-center gap-1.5">
            <div className="flex -space-x-1.5">
              {members.slice(0, 3).map(m => (
                <div key={m.id} className="ring-2 ring-white rounded-full">
                  <Avatar name={m.name} color={m.color} size="xs" />
                </div>
              ))}
            </div>
            {members.length > 3 && <span className="text-xs text-text-muted">+{members.length - 3}</span>}
            {members.length === 0 && <span className="text-xs text-text-muted">—</span>}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (s: ApiService) => (
        <Badge variant={s.isActive ? 'success' : 'default'} dot>{s.isActive ? 'Active' : 'Inactive'}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (s: ApiService) => (
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); navigate(`/services/${s.id}/edit`); }}>
          Edit
        </Button>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="Services" description="Configure the services your team offers to clients." breadcrumbs={[{ label: 'Services' }]} />
        <div className="mt-8 text-center text-sm text-text-muted">Loading services…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader title="Services" description="Configure the services your team offers to clients." breadcrumbs={[{ label: 'Services' }]} />
        <div className="mt-8 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Failed to load services: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Services"
        description="Configure the services your team offers to clients."
        breadcrumbs={[{ label: 'Services' }]}
        actions={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/services/new')}>
            Add Service
          </Button>
        }
      />

      <div className="mt-6 space-y-4">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px] max-w-xs">
            <Input
              placeholder="Search services..."
              aria-label="Search services"
              value={search}
              onChange={e => setSearch(e.target.value)}
              prefix={<Search className="w-4 h-4" />}
            />
          </div>
          <Select
            aria-label="Filter by category"
            options={CATEGORY_OPTIONS}
            value={category}
            onChange={e => setCategory(e.target.value)}
            className="w-44"
          />
          <div className="flex items-center gap-1 ml-auto border border-border rounded-lg p-1">
            <button
              onClick={() => setView('grid')}
              className={`p-1.5 rounded ${view === 'grid' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-primary'}`}
              title="Grid view"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setView('table')}
              className={`p-1.5 rounded ${view === 'table' ? 'bg-primary text-white' : 'text-text-muted hover:text-text-primary'}`}
              title="Table view"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        {filtered.length === 0 ? (
          <EmptyState
            icon={<Briefcase className="w-5 h-5" />}
            title={search || category ? 'No services match your filters' : 'No services yet'}
            description={search || category ? 'Try adjusting your search or filter.' : 'Create your first service to start accepting bookings.'}
            action={!search && !category ? { label: 'Add Service', onClick: () => navigate('/services/new'), icon: <Plus className="w-4 h-4" /> } : undefined}
          />
        ) : view === 'grid' ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(s => <ServiceCard key={s.id} service={s} />)}
          </div>
        ) : (
          <Card padding="none">
            <Table
              columns={tableColumns}
              data={filtered}
              keyExtractor={s => s.id}
              onRowClick={s => navigate(`/services/${s.id}`)}
              emptyTitle="No services found"
            />
          </Card>
        )}
      </div>
    </div>
  );
}
