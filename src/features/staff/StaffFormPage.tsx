import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Save, ChevronLeft, CheckCircle, AlertTriangle } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import {
  Button, Input, Textarea, Select, PageHeader, Avatar, useToast,
} from '@/components/ui';
import { staffApi, servicesApi, workspacesApi, ApiError } from '@/api/client';
import { STAFF_ROLE_OPTIONS, EMAIL_PATTERN, bookabilityProblems } from './staffRules';
import { phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';
import { DAYS, DAY_LABELS, cn } from '@/lib/utils';

const AVATAR_COLORS = [
  '#00BF62', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899',
];

interface WorkingHoursDay {
  enabled: boolean;
  start: string;
  end: string;
}
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

interface ApiService { id: string; name: string; color: string; }
interface ApiWorkspace { id: string; name: string; color: string; }

export default function StaffFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = !!id;
  usePageTitle(isEdit ? 'Edit Staff' : 'New Staff');

  const [allServices, setAllServices] = useState<ApiService[]>([]);
  const [allWorkspaces, setAllWorkspaces] = useState<ApiWorkspace[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [bio, setBio] = useState('');
  const [role, setRole] = useState('staff');
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [isActive, setIsActive] = useState(true);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [hours, setHours] = useState<WorkingHours>(DEFAULT_HOURS);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const loadBase = Promise.all([
      servicesApi.list() as Promise<ApiService[]>,
      workspacesApi.list() as Promise<ApiWorkspace[]>,
    ]);

    if (isEdit && id) {
      Promise.all([
        loadBase,
        staffApi.get(id) as Promise<Record<string, unknown>>,
      ]).then(([[svcs, wss], existing]) => {
        setAllServices(svcs);
        setAllWorkspaces(wss);
        setName((existing.name as string) ?? '');
        setEmail((existing.email as string) ?? '');
        setPhone((existing.phone as string) ?? '');
        setTitle((existing.title as string) ?? '');
        setBio((existing.bio as string) ?? '');
        setRole((existing.role as string) ?? 'staff');
        setColor((existing.color as string) ?? AVATAR_COLORS[0]);
        setIsActive((existing.isActive as boolean) ?? true);
        setWorkspaceIds((existing.workspaceIds as string[]) ?? []);
        setServiceIds((existing.serviceIds as string[]) ?? []);
        setHours((existing.workingHours as WorkingHours) ?? DEFAULT_HOURS);
        setDataLoading(false);
      }).catch((e: Error) => { setLoadError(e.message || 'Request failed'); setDataLoading(false); });
    } else {
      loadBase.then(([svcs, wss]) => {
        setAllServices(svcs);
        setAllWorkspaces(wss);
        setDataLoading(false);
      }).catch((e: Error) => { setLoadError(e.message || 'Request failed'); setDataLoading(false); });
    }
  }, [id, isEdit]);

  function toggleWorkspace(wsId: string) {
    setWorkspaceIds(prev =>
      prev.includes(wsId) ? prev.filter(x => x !== wsId) : [...prev, wsId],
    );
  }

  function toggleService(svcId: string) {
    setServiceIds(prev =>
      prev.includes(svcId) ? prev.filter(x => x !== svcId) : [...prev, svcId],
    );
  }

  function toggleDay(day: string) {
    setHours(prev => ({
      ...prev,
      [day]: { ...prev[day], enabled: !prev[day].enabled },
    }));
  }

  function setDayTime(day: string, field: 'start' | 'end', value: string) {
    setHours(prev => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }));
  }

  function validate() {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Name is required';
    else if (name.trim().length > 100) errs.name = 'Name must be 100 characters or fewer';
    else if (/[<>]/.test(name)) errs.name = 'Name must not contain < or >';
    if (!email.trim()) errs.email = 'Email is required';
    else if (!EMAIL_PATTERN.test(email.trim())) errs.email = 'Enter a valid email address';
    const phoneMsg = phoneError(phone);
    if (phoneMsg) errs.phone = phoneMsg;
    if (title.trim().length > 100) errs.title = 'Job title must be 100 characters or fewer';
    for (const day of DAYS) {
      const d = hours[day];
      if (d?.enabled && !(d.end > d.start)) errs.hours = `${DAY_LABELS[day]}: end time must be after start time`;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);

    const payload = {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      title: title.trim(),
      bio,
      role,
      color,
      isActive,
      workspaceIds,
      serviceIds,
      workingHours: hours,
    };

    try {
      if (isEdit && id) {
        await staffApi.update(id, payload);
      } else {
        await staffApi.create(payload);
      }
      toast.success(isEdit ? 'Staff member updated' : 'Staff member created');
      navigate('/staff');
    } catch (err: unknown) {
      const message = (err as Error).message;
      if (err instanceof ApiError && err.status === 409) setErrors(e => ({ ...e, email: message }));
      toast.error('Failed to save staff member', message);
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="page-container">
        <div className="mt-6 max-w-2xl p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load staff data: {loadError}. The form is disabled so existing data is not overwritten.
          <button className="ml-2 underline" onClick={() => navigate('/staff')}>Go back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title={isEdit ? 'Edit Staff Member' : 'Add Staff Member'}
        description={isEdit ? `Editing profile for ${name || '…'}` : 'Create a new team member account'}
        breadcrumbs={[
          { label: 'Staff', href: '/staff' },
          { label: isEdit ? 'Edit' : 'New Staff' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => navigate('/staff')}>
              <ChevronLeft className="w-4 h-4 mr-1" />Cancel
            </Button>
            <Button icon={<Save className="w-4 h-4" />} onClick={handleSave} loading={saving}>
              {isEdit ? 'Save Changes' : 'Create Staff'}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Basic Information</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Full Name"
                required
                placeholder="e.g. Dr. Jane Smith"
                value={name}
                onChange={e => setName(e.target.value)}
                error={errors.name}
              />
              <Input
                label="Email Address"
                required
                type="email"
                placeholder="jane@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                error={errors.email}
              />
              <Input
                label="Phone Number"
                type="tel"
                placeholder={PHONE_PLACEHOLDER}
                value={phone}
                onChange={e => setPhone(e.target.value)}
                error={errors.phone}
              />
              <Input
                label="Job Title"
                placeholder="e.g. Senior Therapist"
                value={title}
                onChange={e => setTitle(e.target.value)}
                error={errors.title}
              />
              <div className="sm:col-span-2">
                <Select
                  label="Role"
                  options={STAFF_ROLE_OPTIONS}
                  value={role}
                  onChange={e => setRole(e.target.value)}
                  hint="Describes the person's job. Staff cannot sign in yet, so the role does not grant any access."
                />
              </div>
              <div className="sm:col-span-2">
                <Textarea
                  label="Bio"
                  placeholder="A short description about this staff member..."
                  rows={3}
                  value={bio}
                  onChange={e => setBio(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Avatar Color</h2>
            <div className="flex items-center gap-4">
              <Avatar name={name || 'Staff'} color={color} size="xl" />
              <div className="flex gap-2">
                {AVATAR_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Avatar colour ${c}`}
                    aria-pressed={color === c}
                    className={cn(
                      'w-8 h-8 rounded-full transition-transform',
                      color === c ? 'ring-2 ring-offset-2 ring-primary scale-110' : 'hover:scale-110',
                    )}
                    style={{ backgroundColor: c }}
                    onClick={() => setColor(c)}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-1">Working Hours</h2>
            <p className="text-xs text-text-muted mb-4">Online bookings are only offered inside these hours, in the business time zone.</p>
            {errors.hours && <p role="alert" className="mb-3 text-xs text-red-600">{errors.hours}</p>}
            <div className="space-y-3">
              {DAYS.map(day => {
                const schedule = hours[day];
                return (
                  <div key={day} className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!!schedule?.enabled}
                      aria-label={`Works on ${DAY_LABELS[day]}`}
                      onClick={() => toggleDay(day)}
                      className={cn(
                        'w-10 h-5 rounded-full transition-colors relative shrink-0',
                        schedule?.enabled ? 'bg-primary' : 'bg-gray-200',
                      )}
                    >
                      <span className={cn(
                        'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                        schedule?.enabled ? 'translate-x-5' : 'translate-x-0.5',
                      )} />
                    </button>
                    <span className="w-10 text-sm font-medium text-text-primary shrink-0">
                      {DAY_LABELS[day]}
                    </span>
                    {schedule?.enabled ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="time"
                          aria-label={`${DAY_LABELS[day]} start time`}
                          className="input-field py-1.5 text-sm w-24 sm:w-28"
                          value={schedule.start}
                          onChange={e => setDayTime(day, 'start', e.target.value)}
                        />
                        <span className="text-text-muted text-sm">–</span>
                        <input
                          type="time"
                          aria-label={`${DAY_LABELS[day]} end time`}
                          className="input-field py-1.5 text-sm w-24 sm:w-28"
                          value={schedule.end}
                          onChange={e => setDayTime(day, 'end', e.target.value)}
                        />
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
          {(() => {
            const problems = bookabilityProblems({ isActive, serviceIds, workingHours: hours });
            return problems.length === 0 ? (
              <div className="card p-4 flex items-start gap-2 border-emerald-200 bg-emerald-50 text-sm text-emerald-800" role="status">
                <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>Bookable online for {serviceIds.length} service{serviceIds.length === 1 ? '' : 's'}.</span>
              </div>
            ) : (
              <div className="card p-4 flex items-start gap-2 border-amber-200 bg-amber-50 text-sm text-amber-800" role="status">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>Not bookable yet: {problems.join('; ')}. You can still save.</span>
              </div>
            );
          })()}

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-4">Status</h2>
            <div className="flex items-center justify-between">
              <span className="text-sm text-text-secondary">
                {isActive ? 'Active — can receive bookings' : 'Inactive — hidden from booking pages'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={isActive}
                aria-label="Active"
                onClick={() => setIsActive(!isActive)}
                className={cn(
                  'w-10 h-5 rounded-full transition-colors relative shrink-0',
                  isActive ? 'bg-primary' : 'bg-gray-200',
                )}
              >
                <span className={cn(
                  'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
                  isActive ? 'translate-x-5' : 'translate-x-0.5',
                )} />
              </button>
            </div>
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Workspaces</h2>
            {dataLoading ? (
              <p className="text-sm text-text-muted">Loading…</p>
            ) : allWorkspaces.length === 0 ? (
              <p className="text-sm text-text-muted">No workspaces found.</p>
            ) : (
              <div className="space-y-2">
                {allWorkspaces.map(ws => (
                  <label key={ws.id} className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      checked={workspaceIds.includes(ws.id)}
                      onChange={() => toggleWorkspace(ws.id)}
                    />
                    <span className="flex items-center gap-2 text-sm text-text-primary">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: ws.color }} />
                      {ws.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="card p-5">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Services</h2>
            {dataLoading ? (
              <p className="text-sm text-text-muted">Loading…</p>
            ) : allServices.length === 0 ? (
              <p className="text-sm text-text-muted">No services found.</p>
            ) : (
              <div className="space-y-2">
                {allServices.map(svc => (
                  <label key={svc.id} className="flex items-center gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                      checked={serviceIds.includes(svc.id)}
                      onChange={() => toggleService(svc.id)}
                    />
                    <span className="flex items-center gap-2 text-sm text-text-primary">
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.color }} />
                      {svc.name}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
