import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Edit2, Trash2, Clock, Banknote, MapPin, Tag, Copy,
  Users, Briefcase, ExternalLink, Plus, X, CheckCircle,
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
import { servicesApi, staffApi, bookingPagesApi } from '@/api/client';
import { formatCurrency, formatDuration } from '@/lib/utils';

type CategoryVariantKey = 'consultation' | 'class' | 'workshop' | 'session' | 'tour' | 'rental' | 'other';
const CATEGORY_VARIANT: Record<CategoryVariantKey, 'info' | 'success' | 'warning' | 'purple' | 'default'> = {
  consultation: 'info',
  class: 'warning',
  workshop: 'success',
  session: 'info',
  tour: 'purple',
  rental: 'warning',
  other: 'default',
};

interface ApiService {
  id: string;
  name: string;
  description: string;
  category: string;
  duration: number;
  price: number;
  currency: string;
  location: string;
  color: string;
  isActive: boolean;
  staffIds: string[];
  bufferBefore: number;
  bufferAfter: number;
  minNotice: number;
  maxAdvance: number;
  cancellationPolicy: string;
  reschedulingPolicy: string;
  bookingPageUrl?: string;
  customFields?: Array<{
    id: string;
    label: string;
    type: string;
    required: boolean;
    placeholder?: string;
    options?: string[];
  }>;
  createdAt: string;
}

interface ApiStaff {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  role: string;
  title?: string;
}

export default function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('Service');

  const [service, setService] = useState<ApiService | null>(null);
  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [pages, setPages] = useState<Array<{ id: string; title: string; slug: string; isPublished: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState('overview');
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([
      servicesApi.get(id) as Promise<ApiService>,
      staffApi.list() as Promise<ApiStaff[]>,
      bookingPagesApi.list() as Promise<Array<{ id: string; title: string; slug: string; isPublished: boolean; serviceIds: string[] }>>,
    ])
      .then(([svc, staff, bps]) => {
        setService(svc);
        setAllStaff(staff);
        setPages(bps.filter(p => p.serviceIds.includes(id)));
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message ?? 'Failed to load service.'); setLoading(false); });
  }, [id]);

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading service…</div></div>;
  }

  if (error || !service) {
    return (
      <div className="page-container">
        <EmptyState
          icon={<Briefcase className="w-6 h-6" />}
          title={error ? 'Failed to load service' : 'Service not found'}
          description={error ?? 'This service does not exist or has been removed.'}
          action={{ label: 'Back to Services', onClick: () => navigate('/services') }}
        />
      </div>
    );
  }

  const assignedStaff = allStaff.filter(s => service.staffIds.includes(s.id));
  const customFields = service.customFields ?? [];

  const handleRemoveStaff = async (staffId: string) => {
    try {
      const updated = await servicesApi.update(service.id, {
        staffIds: service.staffIds.filter(sid => sid !== staffId),
      }) as ApiService;
      setService(prev => prev ? { ...prev, staffIds: updated.staffIds } : null);
      toast.info('Staff removed', 'Staff member removed from this service.');
    } catch (e: unknown) {
      toast.error('Failed to remove staff', (e as Error).message);
    }
  };

  const handleRemoveField = async (fieldId: string) => {
    const newFields = customFields.filter(f => f.id !== fieldId);
    try {
      await servicesApi.update(service.id, { customFields: newFields });
      setService(prev => prev ? { ...prev, customFields: newFields } : null);
      toast.info('Field removed', 'Custom question removed.');
    } catch (e: unknown) {
      toast.error('Failed to remove field', (e as Error).message);
    }
  };

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url).then(() => {
      toast.success('Copied!', 'Booking URL copied to clipboard.');
    }).catch(() => {
      toast.error('Copy failed', 'Please copy the URL manually.');
    });
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await servicesApi.delete(service.id);
      toast.success('Service deleted');
      navigate('/services');
    } catch (e: unknown) {
      toast.error('Failed to delete service', (e as Error).message);
      setDeleting(false);
      setShowDelete(false);
    }
  };

  const catVariant = CATEGORY_VARIANT[service.category as CategoryVariantKey] ?? 'default';

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'staff', label: 'Staff', count: assignedStaff.length },
    { id: 'policy', label: 'Booking Policy' },
    { id: 'fields', label: 'Custom Questions', count: customFields.length },
    { id: 'url', label: 'Public URL' },
  ];

  return (
    <div className="page-container">
      <PageHeader
        title={service.name}
        description={service.description}
        breadcrumbs={[
          { label: 'Services', href: '/services' },
          { label: service.name },
        ]}
        actions={
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={catVariant} className="capitalize">{service.category}</Badge>
            <Badge variant={service.isActive ? 'success' : 'default'} dot>
              {service.isActive ? 'Active' : 'Inactive'}
            </Badge>
            <Button
              variant="secondary"
              size="sm"
              icon={<Edit2 className="w-3.5 h-3.5" />}
              onClick={() => navigate(`/services/${service.id}/edit`)}
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
          </div>
        }
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="mt-6">
        {activeTab === 'overview' && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { icon: <Clock className="w-4 h-4" />, label: 'Duration', value: formatDuration(service.duration), bg: 'bg-blue-50', col: 'text-blue-600' },
                { icon: <Banknote className="w-4 h-4" />, label: 'Price', value: formatCurrency(service.price, service.currency), bg: 'bg-emerald-50', col: 'text-emerald-600' },
                { icon: <MapPin className="w-4 h-4" />, label: 'Location', value: service.location, bg: 'bg-amber-50', col: 'text-amber-600' },
                { icon: <Users className="w-4 h-4" />, label: 'Staff', value: `${assignedStaff.length} assigned`, bg: 'bg-purple-50', col: 'text-purple-600' },
              ].map(({ icon, label, value, bg, col }) => (
                <Card key={label} padding="sm">
                  <div className={`w-8 h-8 rounded-lg ${bg} ${col} flex items-center justify-center mb-2`}>{icon}</div>
                  <p className="text-xs text-text-muted">{label}</p>
                  <p className="text-sm font-semibold text-text-primary mt-0.5">{value}</p>
                </Card>
              ))}
            </div>

            <Card>
              <h3 className="text-sm font-semibold text-text-primary mb-4">Service Details</h3>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { label: 'Buffer Before', value: `${service.bufferBefore} min` },
                  { label: 'Buffer After', value: `${service.bufferAfter} min` },
                  { label: 'Min Notice', value: `${service.minNotice} hour${service.minNotice !== 1 ? 's' : ''}` },
                  { label: 'Max Advance', value: `${service.maxAdvance} days` },
                  { label: 'Currency', value: service.currency },
                  { label: 'Created', value: new Date(service.createdAt).toLocaleDateString() },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <dt className="text-xs text-text-muted font-medium uppercase tracking-wide">{label}</dt>
                    <dd className="text-sm text-text-primary mt-0.5">{value}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
        )}

        {activeTab === 'staff' && (
          assignedStaff.length === 0 ? (
            <EmptyState
              icon={<Users className="w-5 h-5" />}
              title="No staff assigned"
              description="Assign staff members to this service so clients can book with them."
            />
          ) : (
            <div className="space-y-3">
              {assignedStaff.map(member => (
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
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<X className="w-3.5 h-3.5" />}
                        onClick={() => handleRemoveStaff(member.id)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )
        )}

        {activeTab === 'policy' && (
          <div className="space-y-4">
            <Card>
              <h3 className="text-sm font-semibold text-text-primary mb-2">Cancellation Policy</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                {service.cancellationPolicy || 'No cancellation policy set.'}
              </p>
            </Card>
            <Card>
              <h3 className="text-sm font-semibold text-text-primary mb-2">Rescheduling Policy</h3>
              <p className="text-sm text-text-secondary leading-relaxed">
                {service.reschedulingPolicy || 'No rescheduling policy set.'}
              </p>
            </Card>
          </div>
        )}

        {activeTab === 'fields' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">{customFields.length} custom question{customFields.length !== 1 ? 's' : ''}</p>
              <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => toast.info('Coming soon', 'Add custom fields from the edit form.')}>
                Add Question
              </Button>
            </div>
            {customFields.length === 0 ? (
              <EmptyState
                icon={<Tag className="w-5 h-5" />}
                title="No custom questions"
                description="Add custom questions to collect more information when clients book."
              />
            ) : (
              customFields.map(field => (
                <Card key={field.id} padding="sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-text-primary">{field.label}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" size="sm">{field.type}</Badge>
                        {field.required && <Badge variant="warning" size="sm">Required</Badge>}
                      </div>
                      {field.placeholder && (
                        <p className="text-xs text-text-muted mt-1">Placeholder: &ldquo;{field.placeholder}&rdquo;</p>
                      )}
                      {field.options && field.options.length > 0 && (
                        <p className="text-xs text-text-muted mt-1">Options: {field.options.join(', ')}</p>
                      )}
                    </div>
                    <Button size="sm" variant="ghost" icon={<X className="w-3.5 h-3.5" />}
                      onClick={() => handleRemoveField(field.id)}
                      className="text-red-600 hover:text-red-700 hover:bg-red-50 shrink-0">
                      Remove
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}

        {activeTab === 'url' && (
          <Card>
            <div className="flex items-center gap-2 mb-2">
              <ExternalLink className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-text-primary">Public Booking URL</h3>
            </div>
            <p className="text-xs text-text-secondary mb-4">Booking pages that offer this service. Customers can only book it through a published page.</p>
            {pages.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-text-muted">No booking page offers this service yet.</p>
                <Button size="sm" variant="secondary" onClick={() => navigate('/booking-pages/new')}>Create booking page</Button>
              </div>
            ) : (
              <div className="space-y-2">
                {pages.map(p => {
                  const url = `${window.location.origin}/book/${p.slug}`;
                  return (
                    <div key={p.id} className="flex items-center gap-2 p-3 bg-muted rounded-lg border border-border">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary truncate">{p.title}</p>
                        <p className="text-xs font-mono text-text-secondary truncate">{url}</p>
                      </div>
                      <Badge variant={p.isPublished ? 'success' : 'default'}>{p.isPublished ? 'Published' : 'Draft'}</Badge>
                      <Button size="sm" variant="secondary" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => handleCopyUrl(url)} disabled={!p.isPublished}>
                        Copy
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {!service.isActive && (
              <div className="mt-4 flex items-center gap-2 text-xs text-amber-700">
                <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                This service is inactive, so it is hidden on every booking page.
              </div>
            )}
          </Card>
        )}
      </div>

      <ConfirmModal
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete Service"
        message={`Are you sure you want to delete "${service.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
