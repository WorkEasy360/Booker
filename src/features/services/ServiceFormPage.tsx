import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, Trash2 } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Avatar } from '@/components/ui/Avatar';
import { useToast } from '@/components/ui/Toast';
import { servicesApi, staffApi, settingsApi } from '@/api/client';
import { CURRENCY_OPTIONS, currencySymbol } from '@/lib/currency';
import { generateId } from '@/lib/utils';
import { DEFAULT_CURRENCY } from '@/lib/regional';

const COLOR_SWATCHES = ['#00BF62', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#10B981'];

const CATEGORY_OPTIONS = [
  { value: 'consultation', label: 'Consultation' },
  { value: 'class', label: 'Class' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'session', label: 'Session' },
  { value: 'tour', label: 'Tour' },
  { value: 'rental', label: 'Rental' },
  { value: 'other', label: 'Other' },
];

const BUFFER_OPTIONS = [
  { value: '0', label: 'None' },
  { value: '5', label: '5 min' },
  { value: '10', label: '10 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
];

const NOTICE_OPTIONS = [
  { value: '0', label: 'No minimum' },
  { value: '1', label: '1 hour' },
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
  { value: '12', label: '12 hours' },
  { value: '24', label: '24 hours' },
  { value: '48', label: '48 hours' },
];

const ADVANCE_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '14', label: '14 days' },
  { value: '30', label: '30 days' },
  { value: '60', label: '60 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
];

const FIELD_TYPE_OPTIONS = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'select', label: 'Dropdown' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'email', label: 'Email' },
  { value: 'phone', label: 'Phone' },
];

interface ApiStaff {
  id: string;
  name: string;
  color: string;
  isActive: boolean;
  role: string;
  title?: string;
}

interface LocalCustomField {
  id: string;
  label: string;
  type: string;
  required: boolean;
  placeholder?: string;
  options?: string[];
}

export default function ServiceFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const isEdit = Boolean(id && id !== 'new');
  usePageTitle(isEdit ? 'Edit Service' : 'New Service');

  const [allStaff, setAllStaff] = useState<ApiStaff[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>('consultation');
  const [duration, setDuration] = useState(60);
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [location, setLocation] = useState('');
  const [color, setColor] = useState(COLOR_SWATCHES[0]);
  const [selectedStaff, setSelectedStaff] = useState<string[]>([]);
  const [bufferBefore, setBufferBefore] = useState('0');
  const [bufferAfter, setBufferAfter] = useState('0');
  const [minNotice, setMinNotice] = useState('0');
  const [maxAdvance, setMaxAdvance] = useState('30');
  const [cancellationPolicy, setCancellationPolicy] = useState('');
  const [customFields, setCustomFields] = useState<LocalCustomField[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const tasks: [Promise<ApiStaff[]>, Promise<unknown>?] = [
      staffApi.list() as Promise<ApiStaff[]>,
    ];

    if (isEdit && id) {
      Promise.all([
        staffApi.list() as Promise<ApiStaff[]>,
        servicesApi.get(id) as Promise<Record<string, unknown>>,
      ]).then(([staff, svc]) => {
        setAllStaff(staff);
        setEditName((svc.name as string) ?? '');
        setName((svc.name as string) ?? '');
        setDescription((svc.description as string) ?? '');
        setCategory((svc.category as string) ?? 'consultation');
        setDuration((svc.duration as number) ?? 60);
        setPrice(String(svc.price ?? ''));
        setCurrency((svc.currency as string) ?? DEFAULT_CURRENCY);
        setLocation((svc.location as string) ?? '');
        setColor((svc.color as string) ?? COLOR_SWATCHES[0]);
        setSelectedStaff((svc.staffIds as string[]) ?? []);
        setBufferBefore(String(svc.bufferBefore ?? 0));
        setBufferAfter(String(svc.bufferAfter ?? 0));
        setMinNotice(String(svc.minNotice ?? 0));
        setMaxAdvance(String(svc.maxAdvance ?? 30));
        setCancellationPolicy((svc.cancellationPolicy as string) ?? '');
        setCustomFields((svc.customFields as LocalCustomField[]) ?? []);
        setDataLoading(false);
      }).catch((e: Error) => { setLoadError(e.message || 'Request failed'); setDataLoading(false); });
    } else {
      Promise.all([tasks[0], settingsApi.get() as Promise<{ currency?: string; bookingRules?: Record<string, unknown> }>]).then(([staff, org]) => {
        if (org.currency) setCurrency(org.currency);
        setAllStaff(staff);
        // New services start from the organization defaults (Settings → Booking Rules).
        const br = org.bookingRules ?? {};
        if (typeof br.defaultDurationMinutes === 'number') setDuration(br.defaultDurationMinutes);
        if (typeof br.defaultBufferMinutes === 'number') setBufferAfter(String(br.defaultBufferMinutes));
        setDataLoading(false);
      }).catch((e: Error) => { setLoadError(e.message || 'Request failed'); setDataLoading(false); });
    }
  }, [id, isEdit]);

  const toggleStaff = (staffId: string) => {
    setSelectedStaff(prev =>
      prev.includes(staffId) ? prev.filter(sid => sid !== staffId) : [...prev, staffId]
    );
  };

  const addField = () => {
    setCustomFields(prev => [...prev, {
      id: `cf-${generateId()}`,
      label: '',
      type: 'text',
      required: false,
    }]);
  };

  const updateField = (idx: number, updates: Partial<LocalCustomField>) => {
    setCustomFields(prev => prev.map((f, i) => i === idx ? { ...f, ...updates } : f));
  };

  const removeField = (idx: number) => {
    setCustomFields(prev => prev.filter((_, i) => i !== idx));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Service name is required';
    if (!price || isNaN(Number(price)) || Number(price) < 0) e.price = 'Enter a valid price';
    return e;
  };

  const handleSave = async () => {
    const e = validate();
    if (Object.keys(e).length > 0) { setErrors(e); return; }
    setSaving(true);

    const payload = {
      name,
      description,
      category,
      duration,
      price: Number(price),
      currency,
      location,
      staffIds: selectedStaff,
      isActive: true,
      bufferBefore: Number(bufferBefore),
      bufferAfter: Number(bufferAfter),
      minNotice: Number(minNotice),
      maxAdvance: Number(maxAdvance),
      cancellationPolicy,
      color,
      customFields,
    };

    try {
      if (isEdit && id) {
        await servicesApi.update(id, payload);
      } else {
        await servicesApi.create(payload);
      }
      toast.success(isEdit ? 'Service updated' : 'Service created', name);
      navigate('/services');
    } catch (err: unknown) {
      toast.error('Failed to save service', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="page-container">
        <div className="mt-6 max-w-2xl p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load service data: {loadError}. The form is disabled so existing data is not overwritten.
          <button className="ml-2 underline" onClick={() => navigate('/services')}>Go back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <PageHeader
        title={isEdit ? `Edit ${editName || 'Service'}` : 'New Service'}
        description={isEdit ? 'Update this service configuration.' : 'Create a new service for clients to book.'}
        breadcrumbs={[
          { label: 'Services', href: '/services' },
          { label: isEdit ? 'Edit' : 'New Service' },
        ]}
      />

      <div className="mt-6 max-w-2xl space-y-6">
        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Basic Information</h2>
          <div className="space-y-4">
            <Input
              label="Service Name"
              required
              placeholder="e.g. Initial Consultation"
              value={name}
              onChange={e => { setName(e.target.value); setErrors(p => ({ ...p, name: '' })); }}
              error={errors.name}
            />
            <Textarea
              label="Description"
              rows={3}
              placeholder="Describe what this service includes..."
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Select
                label="Category"
                options={CATEGORY_OPTIONS}
                value={category}
                onChange={e => setCategory(e.target.value)}
              />
              <Input
                label="Location"
                placeholder="e.g. In-person, Video Call"
                value={location}
                onChange={e => setLocation(e.target.value)}
              />
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Duration &amp; Pricing</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-primary mb-2">
                Duration: <span className="text-primary">{duration} min</span>
              </label>
              <input
                type="range"
                min={15}
                max={480}
                step={15}
                value={duration}
                onChange={e => setDuration(Number(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="flex justify-between text-xs text-text-muted mt-1">
                <span>15 min</span>
                <span>4 h</span>
                <span>8 h</span>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input
                label="Price"
                required
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={price}
                onChange={e => { setPrice(e.target.value); setErrors(p => ({ ...p, price: '' })); }}
                error={errors.price}
                prefix={currencySymbol(currency)}
              />
              <Select
                label="Currency"
                options={CURRENCY_OPTIONS}
                value={currency}
                onChange={e => setCurrency(e.target.value)}
              />
            </div>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-3">Service Color</h2>
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
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Staff Assignment</h2>
          {dataLoading ? (
            <p className="text-sm text-text-muted">Loading staff…</p>
          ) : allStaff.length === 0 ? (
            <p className="text-sm text-text-muted">No staff members found. Add staff first.</p>
          ) : (
            <div className="space-y-2">
              {allStaff.map(member => (
                <label key={member.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={selectedStaff.includes(member.id)}
                    onChange={() => toggleStaff(member.id)}
                    className="w-4 h-4 accent-primary rounded shrink-0"
                  />
                  <Avatar name={member.name} color={member.color} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary">{member.name}</p>
                    <p className="text-xs text-text-muted">{member.title ?? member.role}</p>
                  </div>
                  {!member.isActive && <Badge variant="default" size="sm">Inactive</Badge>}
                </label>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Scheduling Rules</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Select label="Buffer Before" options={BUFFER_OPTIONS} value={bufferBefore} onChange={e => setBufferBefore(e.target.value)} />
            <Select label="Buffer After" options={BUFFER_OPTIONS} value={bufferAfter} onChange={e => setBufferAfter(e.target.value)} />
            <Select label="Minimum Notice" options={NOTICE_OPTIONS} value={minNotice} onChange={e => setMinNotice(e.target.value)} />
            <Select label="Advance Booking Window" options={ADVANCE_OPTIONS} value={maxAdvance} onChange={e => setMaxAdvance(e.target.value)} />
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-text-primary mb-4">Cancellation Policy</h2>
          <Textarea
            rows={3}
            placeholder="Describe your cancellation and refund policy..."
            value={cancellationPolicy}
            onChange={e => setCancellationPolicy(e.target.value)}
          />
        </Card>

        <Card>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-sm font-semibold text-text-primary">Custom Questions</h2>
              <p className="text-xs text-text-muted mt-0.5">Collect additional information at booking time.</p>
            </div>
            <Button size="sm" variant="secondary" icon={<Plus className="w-3.5 h-3.5" />} onClick={addField}>
              Add Field
            </Button>
          </div>
          {customFields.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-4">No custom questions added yet.</p>
          ) : (
            <div className="space-y-4">
              {customFields.map((field, idx) => (
                <div key={field.id} className="p-3 bg-muted rounded-lg space-y-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Input
                        label="Question Label"
                        placeholder="e.g. Primary concern"
                        value={field.label}
                        onChange={e => updateField(idx, { label: e.target.value })}
                      />
                      <Select
                        label="Field Type"
                        options={FIELD_TYPE_OPTIONS}
                        value={field.type}
                        onChange={e => updateField(idx, { type: e.target.value })}
                      />
                    </div>
                    <button
                      onClick={() => removeField(idx)}
                      className="mt-7 p-1.5 rounded hover:bg-red-50 text-text-muted hover:text-red-600 transition-colors shrink-0"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={e => updateField(idx, { required: e.target.checked })}
                      className="w-4 h-4 accent-primary rounded"
                    />
                    <span className="text-sm text-text-secondary">Required field</span>
                  </label>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="flex items-center gap-3 pb-6">
          <Button onClick={handleSave} loading={saving}>
            {isEdit ? 'Save Changes' : 'Create Service'}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/services')}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
