import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, ChevronLeft } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  Button, Input, Textarea, Select, PageHeader, useToast,
} from '@/components/ui';
import { resourcesApi, workspacesApi, servicesApi } from '@/api/client';
import { DAYS, DAY_LABELS, cn } from '@/lib/utils';

type ResourceType = 'room' | 'equipment' | 'vehicle' | 'table' | 'other';

interface WorkingHoursDay { enabled: boolean; start: string; end: string }
type WorkingHours = Record<string, WorkingHoursDay>;

interface ApiWorkspace { id: string; name: string; color: string }
interface ApiService   { id: string; name: string; color: string }
interface ApiResource  {
  id: string;
  name: string;
  type: ResourceType;
  description?: string;
  capacity: number;
  isActive: boolean;
  workspaceIds: string[];
  serviceIds: string[];
  availabilityRules?: WorkingHours;
}

const TYPE_OPTIONS = [
  { value: 'room', label: 'Room' },
  { value: 'equipment', label: 'Equipment' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'table', label: 'Table' },
  { value: 'other', label: 'Other' },
];

const DEFAULT_HOURS: WorkingHours = {
  monday:    { enabled: true,  start: '09:00', end: '17:00' },
  tuesday:   { enabled: true,  start: '09:00', end: '17:00' },
  wednesday: { enabled: true,  start: '09:00', end: '17:00' },
  thursday:  { enabled: true,  start: '09:00', end: '17:00' },
  friday:    { enabled: true,  start: '09:00', end: '17:00' },
  saturday:  { enabled: false, start: '10:00', end: '14:00' },
  sunday:    { enabled: false, start: '10:00', end: '14:00' },
};

export default function ResourceFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle(id ? 'Edit Resource' : 'New Resource');

  const isEdit = !!id;

  const [allWorkspaces, setAllWorkspaces] = useState<ApiWorkspace[]>([]);
  const [allServices, setAllServices]     = useState<ApiService[]>([]);
  const [loading, setLoading]             = useState(true);
  const [loadError, setLoadError]         = useState<string | null>(null);

  const [name, setName]               = useState('');
  const [type, setType]               = useState<ResourceType>('room');
  const [description, setDescription] = useState('');
  const [capacity, setCapacity]       = useState('1');
  const [isActive, setIsActive]       = useState(true);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [serviceIds, setServiceIds]   = useState<string[]>([]);
  const [hours, setHours]             = useState<WorkingHours>(DEFAULT_HOURS);
  const [errors, setErrors]           = useState<Record<string, string>>({});
  const [saving, setSaving]           = useState(false);

  useEffect(() => {
    const tasks: Promise<unknown>[] = [
      workspacesApi.list() as Promise<ApiWorkspace[]>,
      servicesApi.list()   as Promise<ApiService[]>,
    ];
    if (isEdit && id) {
      tasks.push(resourcesApi.get(id) as Promise<ApiResource>);
    }
    Promise.all(tasks).then(results => {
      setAllWorkspaces(results[0] as ApiWorkspace[]);
      setAllServices(results[1] as ApiService[]);
      if (isEdit && results[2]) {
        const existing = results[2] as ApiResource;
        setName(existing.name);
        setType(existing.type);
        setDescription(existing.description ?? '');
        setCapacity(String(existing.capacity));
        setIsActive(existing.isActive);
        setWorkspaceIds(existing.workspaceIds);
        setServiceIds(existing.serviceIds);
        if (existing.availabilityRules) setHours(existing.availabilityRules);
      }
      setLoading(false);
    }).catch((e: Error) => {
      setLoadError(e.message || 'Request failed');
      setLoading(false);
    });
  }, [id, isEdit]);

  function toggleWorkspace(wsId: string) {
    setWorkspaceIds(prev => prev.includes(wsId) ? prev.filter(x => x !== wsId) : [...prev, wsId]);
  }

  function toggleService(svcId: string) {
    setServiceIds(prev => prev.includes(svcId) ? prev.filter(x => x !== svcId) : [...prev, svcId]);
  }

  function toggleDay(day: string) {
    setHours(prev => ({ ...prev, [day]: { ...prev[day], enabled: !prev[day].enabled } }));
  }

  function setDayTime(day: string, field: 'start' | 'end', value: string) {
    setHours(prev => ({ ...prev, [day]: { ...prev[day], [field]: value } }));
  }

  function validate() {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    const cap = Number(capacity);
    if (isNaN(cap) || cap < 1) errs.capacity = 'Capacity must be at least 1';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    const payload = { name, type, description, capacity: Number(capacity), isActive, workspaceIds, serviceIds, availabilityRules: hours };
    try {
      if (isEdit && id) {
        await resourcesApi.update(id, payload);
      } else {
        await resourcesApi.create(payload);
      }
      toast.success(isEdit ? 'Resource updated' : 'Resource created');
      navigate('/resources');
    } catch (e: unknown) {
      toast.error(isEdit ? 'Failed to update resource' : 'Failed to create resource', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading…</div></div>;
  }

  if (loadError) {
    return (
      <div className="page-container">
        <div className="mt-6 max-w-2xl p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load resource data: {loadError}. The form is disabled so existing data is not overwritten.
          <button className="ml-2 underline" onClick={() => navigate('/resources')}>Go back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title={isEdit ? 'Edit Resource' : 'Add Resource'}
        description={isEdit ? `Editing ${name}` : 'Add a new bookable resource'}
        breadcrumbs={[
          { label: 'Resources', href: '/resources' },
          { label: isEdit ? 'Edit' : 'New Resource' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/resources')}>
              <ChevronLeft className="w-4 h-4 mr-1" />Cancel
            </Button>
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Resource'}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Basic Information</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <Input
                  label="Resource Name"
                  required
                  placeholder="e.g. Consultation Room A"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  error={errors.name}
                />
              </div>
              <Select
                label="Type"
                options={TYPE_OPTIONS}
                value={type}
                onChange={e => setType(e.target.value as ResourceType)}
              />
              <Input
                label="Capacity (bookings at the same time)"
                type="number"
                min={1}
                placeholder="e.g. 1"
                hint="1 for a room or item one booking uses at a time; more if several bookings can share it."
                value={capacity}
                onChange={e => setCapacity(e.target.value)}
                error={errors.capacity}
              />
              <div className="sm:col-span-2">
                <Textarea
                  label="Description"
                  placeholder="Describe this resource..."
                  rows={3}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Availability Hours</h2>
            <div className="space-y-3">
              {DAYS.map(day => {
                const schedule = hours[day];
                return (
                  <div key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <button
                      onClick={() => toggleDay(day)}
                      className={cn('w-10 h-5 rounded-full transition-colors relative shrink-0', schedule?.enabled ? 'bg-primary' : 'bg-gray-200')}
                    >
                      <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform', schedule?.enabled ? 'translate-x-5' : 'translate-x-0.5')} />
                    </button>
                    <span className="w-10 text-sm font-medium text-text-primary shrink-0">{DAY_LABELS[day]}</span>
                    {schedule?.enabled ? (
                      <div className="flex items-center gap-2">
                        <input type="time" className="input-field py-1.5 text-sm w-24 sm:w-28" value={schedule.start} onChange={e => setDayTime(day, 'start', e.target.value)} />
                        <span className="text-text-muted text-sm">–</span>
                        <input type="time" className="input-field py-1.5 text-sm w-24 sm:w-28" value={schedule.end} onChange={e => setDayTime(day, 'end', e.target.value)} />
                      </div>
                    ) : (
                      <span className="text-sm text-text-muted">Closed</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Status</h2>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">
                {isActive ? 'Active — available for booking' : 'Inactive — not available'}
              </span>
              <button
                onClick={() => setIsActive(!isActive)}
                className={cn('w-10 h-5 rounded-full transition-colors relative shrink-0', isActive ? 'bg-primary' : 'bg-gray-200')}
              >
                <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform', isActive ? 'translate-x-5' : 'translate-x-0.5')} />
              </button>
            </div>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Workspaces</h2>
            <div className="space-y-2">
              {allWorkspaces.map(ws => (
                <label key={ws.id} className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-border text-primary focus:ring-primary" checked={workspaceIds.includes(ws.id)} onChange={() => toggleWorkspace(ws.id)} />
                  <span className="flex items-center gap-2 text-sm text-text-primary">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ws.color }} />{ws.name}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-1">Assigned Services</h2>
            <p className="text-xs text-text-muted mb-3">
              Each booking of a ticked service takes one free resource assigned to it. Times when none is free (or open) are not offered.
            </p>
            <div className="space-y-2">
              {allServices.map(svc => (
                <label key={svc.id} className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-border text-primary focus:ring-primary" checked={serviceIds.includes(svc.id)} onChange={() => toggleService(svc.id)} />
                  <span className="flex items-center gap-2 text-sm text-text-primary">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.color }} />{svc.name}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
