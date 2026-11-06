import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Plus, Globe, Copy, Eye, Edit2, FileText, CheckCircle, Layout } from 'lucide-react';
import { Button, Badge, PageHeader, useToast } from '@/components/ui';
import { bookingPagesApi, servicesApi } from '@/api/client';
import { cn } from '@/lib/utils';

interface ApiBookingPage {
  id: string;
  title: string;
  description?: string;
  slug: string;
  type: 'business' | 'workspace' | 'service' | 'staff';
  isPublished: boolean;
  serviceIds: string[];
}

interface ApiService { id: string; name: string }

function typeBadgeVariant(type: ApiBookingPage['type']) {
  if (type === 'business')  return 'primary' as const;
  if (type === 'workspace') return 'info'    as const;
  if (type === 'service')   return 'warning' as const;
  return 'purple' as const;
}

function typeLabel(type: ApiBookingPage['type']) {
  if (type === 'business')  return 'Business';
  if (type === 'workspace') return 'Workspace';
  if (type === 'service')   return 'Service';
  return 'Staff';
}

export default function BookingPagesPage() {
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('Booking Pages');

  const [pages, setPages]           = useState<ApiBookingPage[]>([]);
  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [publishStates, setPublishStates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    Promise.all([
      bookingPagesApi.list() as Promise<ApiBookingPage[]>,
      servicesApi.list()     as Promise<ApiService[]>,
    ]).then(([bps, svcs]) => {
      setPages(bps);
      setAllServices(svcs);
      setPublishStates(Object.fromEntries(bps.map(p => [p.id, p.isPublished])));
    }).catch(() => {
      toast.error('Failed to load booking pages');
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages     = pages.length;
  const publishedCount = Object.values(publishStates).filter(Boolean).length;
  const totalServices  = new Set(pages.flatMap(p => p.serviceIds)).size;

  function handleCopyUrl(slug: string) {
    navigator.clipboard.writeText(`${window.location.origin}/book/${slug}`)
      .then(() => toast.success('URL copied to clipboard'))
      .catch(() => toast.error('Could not copy — please copy the URL manually'));
  }

  async function handleTogglePublish(id: string) {
    const current = publishStates[id];
    setPublishStates(prev => ({ ...prev, [id]: !current }));
    try {
      await bookingPagesApi.update(id, { isPublished: !current });
      toast.success(current ? 'Page unpublished' : 'Page published');
    } catch (e: unknown) {
      setPublishStates(prev => ({ ...prev, [id]: current }));
      toast.error('Failed to update page', (e as Error).message);
    }
  }

  function handlePreview(slug: string) {
    window.open(`/book/${slug}`, '_blank');
  }

  return (
    <div className="page-container">
      <PageHeader
        title="Booking Pages"
        description="Create and customize your public booking experience"
        breadcrumbs={[{ label: 'Booking Pages' }]}
        actions={
          <Button icon={<Plus className="w-4 h-4" />} onClick={() => navigate('/booking-pages/new')}>
            New Page
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-4 mt-4 mb-6">
        <div className="bg-surface rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary-light flex items-center justify-center shrink-0">
            <Layout className="w-5 h-5 text-primary" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary">{totalPages}</p>
            <p className="text-xs text-text-secondary">Total Pages</p>
          </div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
            <CheckCircle className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary">{publishedCount}</p>
            <p className="text-xs text-text-secondary">Published</p>
          </div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <p className="text-xl font-bold text-text-primary">{totalServices}</p>
            <p className="text-xs text-text-secondary">Services Listed</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
        {pages.map(page => {
          const isPublished = publishStates[page.id] ?? page.isPublished;
          const pageServices = allServices.filter(s => page.serviceIds.includes(s.id));

          return (
            <div key={page.id} className="bg-surface rounded-xl border border-border p-5 flex flex-col gap-4 hover:shadow-card transition-shadow">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary truncate">{page.title}</h3>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <Badge variant={typeBadgeVariant(page.type)} size="sm">{typeLabel(page.type)}</Badge>
                    <Badge variant={isPublished ? 'success' : 'default'} size="sm" dot>
                      {isPublished ? 'Published' : 'Draft'}
                    </Badge>
                  </div>
                </div>
              </div>

              {page.description && (
                <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">{page.description}</p>
              )}

              <div className="flex items-center gap-1.5 text-xs text-text-secondary">
                <FileText className="w-3.5 h-3.5 shrink-0" />
                <span>{pageServices.length} service{pageServices.length !== 1 ? 's' : ''}</span>
                {pageServices.length > 0 && (
                  <span className="text-text-muted">
                    ({pageServices.slice(0, 2).map(s => s.name).join(', ')}
                    {pageServices.length > 2 ? ` +${pageServices.length - 2} more` : ''})
                  </span>
                )}
              </div>

              <button
                onClick={() => handleCopyUrl(page.slug)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg bg-muted hover:bg-gray-100 transition-colors text-left group"
                title="Click to copy URL"
              >
                <Globe className="w-3.5 h-3.5 text-text-muted shrink-0" />
                <span className="text-xs text-text-secondary truncate flex-1">{window.location.host}/book/{page.slug}</span>
                <Copy className="w-3.5 h-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>

              <div className="flex items-center gap-2 pt-1 border-t border-border">
                <Button variant="secondary" size="sm" icon={<Edit2 className="w-3.5 h-3.5" />} onClick={() => navigate(`/booking-pages/${page.id}`)} className="flex-1">
                  Edit
                </Button>
                <Button variant="ghost" size="sm" icon={<Eye className="w-3.5 h-3.5" />} onClick={() => handlePreview(page.slug)} className="flex-1">
                  Preview
                </Button>
                <Button
                  variant={isPublished ? 'outline' : 'primary'}
                  size="sm"
                  onClick={() => handleTogglePublish(page.id)}
                  className={cn('flex-1', isPublished && 'text-text-secondary border-border')}
                >
                  {isPublished ? 'Unpublish' : 'Publish'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
