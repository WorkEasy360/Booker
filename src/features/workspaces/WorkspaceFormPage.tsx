import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Input, Textarea } from '@/components/ui/Input';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { workspacesApi, settingsApi, servicesApi } from '@/api/client';
import { DAYS, timeZoneOptions } from '@/lib/utils';
import { phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';
import { DEFAULT_TIMEZONE } from '@/lib/regional';

const COLOR_SWATCHES = ['#00BF62', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#10B981'];

interface WorkingHoursDay { enabled: boolean; start: string; end: string; }
type WorkingHours = Record<string, WorkingHoursDay>;

const DEFAULT_HOURS: WorkingHours = {
  monday:    { enabled: true,  start: '09:00', end: '17:00' },
  tuesday:   { enabled: true,  start: '09:00', end: '17:00' },
  wednesday: { enabled: true,  start: '09:00', end: '17:00' },
  thursday:  { enabled: true,  start: '09:00', end: '17:00' },
  friday:    { enabled: true,  start: '09:00', end: '17:00' },
  saturday:  { enabled: false, start: '10:00', end: '14:00' },
  sunday:    { enabled: false, start: '10:00', end: '14:00' },
};

const DAY_FULL: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};


const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2).toString().padStart(2, '0');
  const m = i % 2 === 0 ? '00' : '30';
  return { value: `${h}:${m}`, label: `${h}:${m}` };
});

export default function WorkspaceFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = Boolean(id && id !== 'new');
  usePageTitle(isEdit ? 'Edit Workspace' : 'New Workspace');

  const [editName, setEditName] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [color, setColor] = useState(COLOR_SWATCHES[0]);
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [isActive, setIsActive] = useState(true);
  const [hours, setHours] = useState<WorkingHours>(DEFAULT_HOURS);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [allServices, setAllServices] = useState<Array<{ id: string; name: string; color?: string; isActive?: boolean }> | null>(null);
  const [existingStaffIds, setExistingStaffIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!isEdit);

  useEffect(() => {
    (servicesApi.list() as Promise<Array<{ id: string; name: string; color?: string; isActive?: boolean }>>)
      .then(setAllServices)
      .catch(() => setAllServices([]));
  }, []);

  // A new workspace starts in its business's time zone rather than a fixed default.
  useEffect(() => {
    if (isEdit) return;
    (settingsApi.get() as Promise<{ timezone?: string }>)
      .then(org => { if (org.timezone) setTimezone(org.timezone); })
      .catch(() => { /* keep the default; the server applies the business zone when none is chosen */ });
  }, [isEdit]);

  useEffect(() => {
    if (!isEdit || !id) return;
    (workspacesApi.get(id) as Promise<Record<string, unknown>>)
      .then(ws => {
        setEditName((ws.name as string) ?? '');
        setName((ws.name as string) ?? '');
        setDescription((ws.description as string) ?? '');
        setEmail((ws.email as string) ?? '');
        setPhone((ws.phone as string) ?? '');
        setAddress((ws.address as string) ?? '');
        setColor((ws.color as string) ?? COLOR_SWATCHES[0]);
        setTimezone((ws.timezone as string) ?? DEFAULT_TIMEZONE);
        setIsActive((ws.isActive as boolean) ?? true);
        setHours((ws.workingHours as WorkingHours) ?? DEFAULT_HOURS);
        setServiceIds((ws.serviceIds as string[]) ?? []);
        setExistingStaffIds((ws.staffIds as string[]) ?? []);
        setLoaded(true);
      })
      .catch((e: Error) => setLoadError(e.message || 'Failed to load workspace'));
  }, [id, isEdit]);

  const toggleDay = (day: string) => {
    setHours(prev => ({
      ...prev,
      [day]: { ...prev[day], enabled: !prev[day].enabled },
    }));
  };

  const toggleService = (serviceId: string) =>
    setServiceIds(prev => (prev.includes(serviceId) ? prev.filter(x => x !== serviceId) : [...prev, serviceId]));

  const updateHour = (day: string, field: 'start' | 'end', value: string) => {
    setHours(prev => ({ ...prev, [day]: { ...prev[day], [field]: value } }));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Workspace name is required';
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) e.email = 'Enter a valid email address';
    const phoneMsg = phoneError(phone);
    if (phoneMsg) e.phone = phoneMsg;
    return e;
  };

  const handleSave = async () => {
    if (!loaded) return;
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }
    setSaving(true);

    const payload = {
      name, description, email: email || undefined, phone: phone || undefined,
      address: address || undefined, color, timezone, isActive, workingHours: hours,
      serviceIds, staffIds: existingStaffIds,
    };

    try {
      if (isEdit && id) {
        await workspacesApi.update(id, payload);
      } else {
        await workspacesApi.create(payload);
      }
      toast.success(isEdit ? 'Workspace updated' : 'Workspace created', name);
      navigate('/workspaces');
    } catch (err: unknown) {
      toast.error('Failed to save workspace', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-container">
      <PageHeader
        title={isEdit ? `Edit ${editName || 'Workspace'}` : 'New Workspace'}
        description={isEdit ? 'Update workspace details and working hours.' : 'Create a new location or virtual space for your services.'}
        breadcrumbs={[
          { label: 'Workspaces', href: '/workspaces' },
          { label: isEdit ? 'Edit' : 'New Workspace' },
        ]}
      />

      {loadError && (
        <div className="mt-6 max-w-2xl p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load this workspace: {loadError}. Saving is disabled so the existing record is not overwritten.
        </div>
      )}

      <div className="mt-6 max-w-2xl space-y-6">
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Basic Information</h2>
          <div className="space-y-4">
            <Input
              label="Workspace Name"
              required
              placeholder="e.g. Downtown Clinic"
              value={name}
              onChange={e => { setName(e.target.value); setErrors(prev => ({ ...prev, name: '' })); }}
              error={errors.name}
            />
            <Textarea
              label="Description"
              rows={3}
              placeholder="Brief description of this workspace..."
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Email"
                type="email"
                placeholder="location@example.com"
                value={email}
                onChange={e => { setEmail(e.target.value); setErrors(prev => ({ ...prev, email: '' })); }}
                error={errors.email}
              />
              <Input
                label="Phone"
                type="tel"
                placeholder={PHONE_PLACEHOLDER}
                value={phone}
                onChange={e => { setPhone(e.target.value); setErrors(prev => ({ ...prev, phone: '' })); }}
                error={errors.phone}
              />
            </div>
            <Input
              label="Address"
              placeholder="123 Main St, City, State 12345"
              value={address}
              onChange={e => setAddress(e.target.value)}
            />
            <Select
              label="Timezone"
              options={timeZoneOptions(timezone)}
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Brand Color</h2>
          <div className="flex items-center gap-3">
            {COLOR_SWATCHES.map(c => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={`w-8 h-8 rounded-full transition-transform ${color === c ? 'scale-125 ring-2 ring-offset-2 ring-gray-300' : 'hover:scale-110'}`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
            <input
              type="color"
              value={color}
              onChange={e => setColor(e.target.value)}
              className="w-8 h-8 rounded-full border border-border cursor-pointer p-0 overflow-hidden"
              title="Custom color"
            />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Working Hours</h2>
          <div className="space-y-3">
            {DAYS.map(day => {
              const sched = hours[day];
              return (
                <div key={day} className="flex items-center gap-3 flex-wrap">
                  <label className="flex items-center gap-2.5 w-32 cursor-pointer">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={sched?.enabled}
                      aria-label={`Open on ${DAY_FULL[day]}`}
                      onClick={() => toggleDay(day)}
                      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${sched?.enabled ? 'bg-primary' : 'bg-gray-200'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${sched?.enabled ? 'translate-x-4' : ''}`} />
                    </button>
                    <span className="text-sm text-text-primary">{DAY_FULL[day]}</span>
                  </label>
                  {sched?.enabled ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Select
                        aria-label={`${DAY_FULL[day]} opening time`}
                        options={TIME_OPTIONS}
                        value={sched.start}
                        onChange={e => updateHour(day, 'start', e.target.value)}
                        className="w-24 sm:w-28 text-sm"
                      />
                      <span className="text-text-muted text-sm">to</span>
                      <Select
                        aria-label={`${DAY_FULL[day]} closing time`}
                        options={TIME_OPTIONS}
                        value={sched.end}
                        onChange={e => updateHour(day, 'end', e.target.value)}
                        className="w-24 sm:w-28 text-sm"
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-text-muted">Closed</span>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-1">Services Offered Here</h2>
          <p className="text-xs text-text-muted mb-3">The services delivered at this workspace. They are listed on the workspace and counted on its card.</p>
          {allServices === null ? (
            <p className="text-sm text-text-muted">Loading services…</p>
          ) : allServices.length === 0 ? (
            <p className="text-sm text-text-muted">No services yet. Create a service first, then choose it here.</p>
          ) : (
            <div className="space-y-2" data-workspace-services>
              {allServices.map(svc => (
                <label key={svc.id} className="flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4 rounded border-border text-primary focus:ring-primary" checked={serviceIds.includes(svc.id)} onChange={() => toggleService(svc.id)} />
                  <span className="flex items-center gap-2 text-sm text-text-primary">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.color ?? '#00BF62' }} />{svc.name}
                    {svc.isActive === false && <span className="text-xs text-text-muted">(inactive)</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-text-primary">Active Status</p>
              <p className="text-xs text-text-secondary mt-0.5">Inactive workspaces are hidden from booking pages.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive(!isActive)}
              className={`relative w-11 h-6 rounded-full transition-colors ${isActive ? 'bg-primary' : 'bg-gray-200'}`}
            >
              <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${isActive ? 'translate-x-5' : ''}`} />
            </button>
          </div>
        </Card>

        <div className="flex items-center gap-3 pb-6">
          <Button onClick={handleSave} loading={saving} disabled={!loaded}>
            {isEdit ? 'Save Changes' : 'Create Workspace'}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/workspaces')}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
