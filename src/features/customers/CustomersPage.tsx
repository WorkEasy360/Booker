import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, Search, Users, Eye, Edit2 } from 'lucide-react';
import {
  Button, Input, Badge, Avatar, PageHeader, Table, Pagination,
} from '@/components/ui';
import { customersApi } from '@/api/client';
import { formatDate } from '@/lib/utils';

const ALL_TAGS = ['regular', 'new', 'vip', 'corporate', 'sports', 'referral'];

function tagVariant(tag: string): 'default' | 'success' | 'warning' | 'info' | 'purple' | 'primary' {
  const map: Record<string, 'default' | 'success' | 'warning' | 'info' | 'purple' | 'primary'> = {
    vip: 'warning', regular: 'default', new: 'success',
    corporate: 'info', sports: 'purple', referral: 'primary',
  };
  return map[tag] ?? 'default';
}

interface ApiCustomer {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  tags: string[];
  totalBookings: number;
  lastBookingDate: string | null;
  createdAt: string;
}

const PAGE_SIZE = 10;

export default function CustomersPage() {
  usePageTitle('Customers');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const [allCustomers, setAllCustomers] = useState<ApiCustomer[]>([]);
  const [activeCount, setActiveCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    (customersApi.list() as Promise<ApiCustomer[]>)
      .then(data => { setAllCustomers(data); setLoading(false); })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load customers.'); setLoading(false); });
    customersApi.summary().then(s => setActiveCount(s.active)).catch(() => setActiveCount(null));
  }, []);

  const filtered = allCustomers.filter(c => {
    const q = search.toLowerCase();
    const matchSearch = !search ||
      c.name.toLowerCase().includes(q) ||
      c.email.toLowerCase().includes(q) ||
      (c.phone?.includes(search) ?? false);
    const matchTags = selectedTags.length === 0 || selectedTags.some(t => c.tags.includes(t));
    return matchSearch && matchTags;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleTag(tag: string) {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
    setPage(1);
  }

  const total = allCustomers.length;
  const newThisMonth = allCustomers.filter(c => {
    const d = new Date(c.createdAt);
    const now = new Date();
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  // Same definition as the Dashboard (GET /customers/summary); "—" until it has loaded.
  const active = activeCount ?? '—';
  const vip = allCustomers.filter(c => c.tags.includes('vip')).length;

  const columns = [
    {
      key: 'name',
      header: 'Customer',
      render: (c: ApiCustomer) => (
        <div className="flex items-center gap-3">
          <Avatar name={c.name} size="sm" />
          <span className="text-sm font-medium text-text-primary">{c.name}</span>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (c: ApiCustomer) => <span className="text-text-secondary text-sm">{c.email}</span>,
    },
    {
      key: 'phone',
      header: 'Phone',
      render: (c: ApiCustomer) => <span className="text-text-secondary text-sm">{c.phone ?? '—'}</span>,
    },
    {
      key: 'tags',
      header: 'Tags',
      render: (c: ApiCustomer) => (
        <div className="flex flex-wrap gap-1">
          {c.tags.length === 0
            ? <span className="text-text-muted text-xs">—</span>
            : c.tags.map(t => <Badge key={t} variant={tagVariant(t)} size="sm">{t}</Badge>)}
        </div>
      ),
    },
    {
      key: 'totalBookings',
      header: 'Bookings',
      render: (c: ApiCustomer) => (
        <span className="text-sm font-semibold text-text-primary">{c.totalBookings}</span>
      ),
    },
    {
      key: 'lastBooking',
      header: 'Last Booking',
      render: (c: ApiCustomer) => (
        <span className="text-xs text-text-secondary">
          {c.lastBookingDate ? formatDate(c.lastBookingDate) : '—'}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Member Since',
      render: (c: ApiCustomer) => (
        <span className="text-xs text-text-secondary">{formatDate(c.createdAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (c: ApiCustomer) => (
        <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
          <Button
            variant="ghost" size="sm"
            icon={<Eye className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/customers/${c.id}`)}
          >
            View
          </Button>
          <Button
            variant="ghost" size="sm"
            icon={<Edit2 className="w-3.5 h-3.5" />}
            onClick={() => navigate(`/customers/${c.id}?tab=details`)}
          >
            Edit
          </Button>
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="page-container">
        <PageHeader title="Customers" description="Manage your customer relationships" breadcrumbs={[{ label: 'Customers' }]} />
        <div className="mt-8 text-center text-sm text-text-muted">Loading customers…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-container">
        <PageHeader title="Customers" description="Manage your customer relationships" breadcrumbs={[{ label: 'Customers' }]} />
        <div className="mt-8 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Failed to load customers: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Customers"
        description="Manage your customer relationships"
        breadcrumbs={[{ label: 'Customers' }]}
        actions={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/customers/new')}>
            Add Customer
          </Button>
        }
      />

      {/* Stats bar */}
      <div className="flex flex-wrap items-center gap-6 mt-4 mb-6 p-4 bg-surface rounded-xl border border-border">
        <StatPill label="Total Customers" value={total} color="text-text-primary" />
        <div className="w-px h-10 bg-border hidden sm:block" />
        <StatPill label="New This Month" value={newThisMonth} color="text-primary" />
        <div className="w-px h-10 bg-border hidden sm:block" />
        <StatPill label="Active" value={active} color="text-emerald-600" />
        <div className="w-px h-10 bg-border hidden sm:block" />
        <StatPill label="VIP" value={vip} color="text-amber-600" />
      </div>

      {/* Search */}
      <div className="mb-4">
        <Input
          placeholder="Search by name, email, or phone..."
          aria-label="Search customers"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          prefix={<Search className="w-4 h-4" />}
        />
      </div>

      {/* Tag filter chips */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <span className="text-xs text-text-muted">Filter by tag:</span>
        {ALL_TAGS.map(tag => (
          <button
            key={tag}
            onClick={() => toggleTag(tag)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors border ${
              selectedTags.includes(tag)
                ? 'bg-primary text-white border-primary'
                : 'bg-surface text-text-secondary border-border hover:border-primary hover:text-primary'
            }`}
          >
            {tag}
          </button>
        ))}
        {selectedTags.length > 0 && (
          <button
            onClick={() => { setSelectedTags([]); setPage(1); }}
            className="px-3 py-1 rounded-full text-xs text-text-muted hover:text-text-primary underline"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <Table
          columns={columns}
          data={paginated}
          keyExtractor={c => c.id}
          onRowClick={c => navigate(`/customers/${c.id}`)}
          emptyTitle="No customers found"
          emptyDescription="Try adjusting your search or filters."
          emptyIcon={<Users className="w-6 h-6" />}
        />
        {filtered.length > PAGE_SIZE && (
          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  );
}

function StatPill({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="text-center">
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      <p className="text-xs text-text-secondary">{label}</p>
    </div>
  );
}
