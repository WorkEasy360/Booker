import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Monitor, Smartphone, Plus, Trash2, Upload, ToggleLeft, ToggleRight, ChevronLeft
} from 'lucide-react';
import {
  Button, Input, Textarea, Select, Modal, PageHeader, useToast, Tabs,
} from '@/components/ui';
import { bookingPagesApi, servicesApi, staffApi } from '@/api/client';
import { cn, generateId } from '@/lib/utils';

interface ApiBookingPage {
  id: string;
  title: string;
  description?: string;
  slug: string;
  type?: 'business' | 'service' | 'staff';
  staffId?: string | null;
  isPublished: boolean;
  serviceIds: string[];
  formFields?: CustomField[];
  theme?: {
    primaryColor: string;
    backgroundColor: string;
    fontFamily: string;
    buttonText: string;
    headerText?: string;
    footerText?: string;
    showLogo: boolean;
    showStaffPhoto: boolean;
    layout: 'classic' | 'modern' | 'minimal';
  };
}

interface CustomField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'phone' | 'email';
  required: boolean;
}

const COLOR_SWATCHES = [
  { hex: '#00BF62', label: 'Emerald' },
  { hex: '#3B82F6', label: 'Blue' },
  { hex: '#8B5CF6', label: 'Purple' },
  { hex: '#EF4444', label: 'Red' },
  { hex: '#F59E0B', label: 'Amber' },
  { hex: '#13222E', label: 'Navy' },
];

const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Roboto', label: 'Roboto' },
  { value: 'Open Sans', label: 'Open Sans' },
  { value: 'Lato', label: 'Lato' },
];

const FIELD_TYPE_OPTIONS = [
  { value: 'text', label: 'Short Text' },
  { value: 'textarea', label: 'Long Text' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
];

const MOCK_SLOTS = ['9:00 AM', '10:30 AM', '2:00 PM'];

interface PreviewConfig {
  title: string;
  description: string;
  primaryColor: string;
  backgroundColor: string;
  fontFamily: string;
  buttonText: string;
  headerText: string;
  footerText: string;
  showLogo: boolean;
  showStaffPhoto: boolean;
  logoName: string;
  layout: 'classic' | 'modern' | 'minimal';
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ColorSwatch({
  colors,
  value,
  onChange,
}: {
  colors: typeof COLOR_SWATCHES;
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {colors.map(c => (
        <button
          key={c.hex}
          title={c.label}
          onClick={() => onChange(c.hex)}
          className={cn(
            'w-7 h-7 rounded-full border-2 transition-all',
            value === c.hex ? 'border-text-primary scale-110' : 'border-transparent hover:scale-105',
          )}
          style={{ backgroundColor: c.hex }}
        />
      ))}
    </div>
  );
}

function LayoutCard({
  id,
  label,
  selected,
  onSelect,
}: {
  id: 'classic' | 'modern' | 'minimal';
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const icons: Record<string, React.ReactNode> = {
    classic: (
      <div className="space-y-1 w-full">
        <div className="h-2 bg-gray-300 rounded w-full" />
        <div className="h-1.5 bg-gray-200 rounded w-3/4" />
        <div className="h-1.5 bg-gray-200 rounded w-1/2" />
        <div className="h-3 bg-blue-300 rounded w-1/3 mt-1" />
      </div>
    ),
    modern: (
      <div className="space-y-1 w-full">
        <div className="flex gap-1">
          <div className="w-3 h-3 bg-gray-300 rounded-full" />
          <div className="h-3 bg-gray-300 rounded flex-1" />
        </div>
        <div className="h-1.5 bg-gray-200 rounded w-2/3" />
        <div className="h-3 bg-blue-300 rounded w-1/2 mt-1" />
      </div>
    ),
    minimal: (
      <div className="flex flex-col items-center gap-1 w-full">
        <div className="h-2 bg-gray-300 rounded w-1/2" />
        <div className="h-1.5 bg-gray-200 rounded w-2/3" />
        <div className="h-3 bg-blue-300 rounded w-1/3 mt-1" />
      </div>
    ),
  };

  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex-1 p-3 rounded-lg border-2 transition-all text-center',
        selected
          ? 'border-primary bg-primary-light'
          : 'border-border hover:border-gray-300 bg-surface',
      )}
    >
      <div className="flex items-center justify-center mb-2 h-12">
        {icons[id]}
      </div>
      <p className={cn('text-xs font-medium', selected ? 'text-primary' : 'text-text-secondary')}>{label}</p>
    </button>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="text-text-muted hover:text-primary transition-colors"
      type="button"
    >
      {value
        ? <ToggleRight className="w-6 h-6 text-primary" />
        : <ToggleLeft className="w-6 h-6" />
      }
    </button>
  );
}

// ── Pane tabs content ──────────────────────────────────────────────────────────

function BrandingTab({
  config,
  onChange,
}: {
  config: PreviewConfig;
  onChange: (patch: Partial<PreviewConfig>) => void;
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-medium text-text-primary mb-1.5">Logo</p>
        <div className="border-2 border-dashed border-border rounded-lg p-4 flex flex-col items-center justify-center gap-1 text-center">
          <Upload className="w-5 h-5 text-text-muted" />
          <p className="text-xs text-text-secondary">Logo upload is not available yet.</p>
        </div>
      </div>

      <Input
        label="Page Title"
        value={config.title}
        onChange={e => onChange({ title: e.target.value })}
        placeholder="e.g. Book at Downtown Clinic"
      />

      <Textarea
        label="Description"
        value={config.description}
        onChange={e => onChange({ description: e.target.value })}
        rows={3}
        placeholder="Short description shown on the booking page"
      />

      {/* Primary color */}
      <div>
        <p className="text-xs font-medium text-text-primary mb-1.5">Primary Color</p>
        <ColorSwatch
          colors={COLOR_SWATCHES}
          value={config.primaryColor}
          onChange={v => onChange({ primaryColor: v })}
        />
      </div>

      <Select
        label="Font Family"
        options={FONT_OPTIONS}
        value={config.fontFamily}
        onChange={e => onChange({ fontFamily: e.target.value })}
      />

      <Input
        label="Button Text"
        value={config.buttonText}
        onChange={e => onChange({ buttonText: e.target.value })}
        placeholder="e.g. Book Now"
      />

      <Input
        label="Header Text"
        value={config.headerText}
        onChange={e => onChange({ headerText: e.target.value })}
        placeholder="e.g. Book an Appointment"
      />

      <Input
        label="Footer Text"
        value={config.footerText}
        onChange={e => onChange({ footerText: e.target.value })}
        placeholder="e.g. We look forward to seeing you!"
      />
    </div>
  );
}

function LayoutTab({
  config,
  onChange,
}: {
  config: PreviewConfig;
  onChange: (patch: Partial<PreviewConfig>) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Layout style */}
      <div>
        <p className="text-xs font-medium text-text-primary mb-2">Layout Style</p>
        <div className="flex gap-3">
          {(['classic', 'modern', 'minimal'] as const).map(id => (
            <LayoutCard
              key={id}
              id={id}
              label={id.charAt(0).toUpperCase() + id.slice(1)}
              selected={config.layout === id}
              onSelect={() => onChange({ layout: id })}
            />
          ))}
        </div>
      </div>

      {/* Background color */}
      <div>
        <p className="text-xs font-medium text-text-primary mb-1.5">Background Color</p>
        <ColorSwatch
          colors={COLOR_SWATCHES}
          value={config.backgroundColor}
          onChange={v => onChange({ backgroundColor: v })}
        />
      </div>

      {/* Toggles */}
      <div className="space-y-3">
        <div className="flex items-center justify-between py-2 border-b border-border">
          <div>
            <p className="text-sm font-medium text-text-primary">Show Logo</p>
            <p className="text-xs text-text-muted">Display your organization logo at the top</p>
          </div>
          <Toggle value={config.showLogo} onChange={v => onChange({ showLogo: v })} />
        </div>
        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm font-medium text-text-primary">Show Staff Photo</p>
            <p className="text-xs text-text-muted">Display the assigned staff member's photo</p>
          </div>
          <Toggle value={config.showStaffPhoto} onChange={v => onChange({ showStaffPhoto: v })} />
        </div>
      </div>
    </div>
  );
}

function FormFieldsTab({ fields, onChange }: { fields: CustomField[]; onChange: (f: CustomField[]) => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newType, setNewType] = useState<CustomField['type']>('text');
  const [newRequired, setNewRequired] = useState(false);

  const DEFAULT_FIELDS = [
    { label: 'Full Name', type: 'text' },
    { label: 'Email', type: 'email' },
    { label: 'Phone', type: 'phone' },
  ];

  function handleAdd() {
    if (!newLabel.trim()) return;
    onChange([...fields, { id: generateId(), label: newLabel.trim(), type: newType, required: newRequired }]);
    setNewLabel('');
    setNewType('text');
    setNewRequired(false);
    setAddOpen(false);
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
        Custom questions appear on the public booking form after the contact details. Required questions must be answered before booking.
      </p>
      <div>
        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-3">Default Fields</p>
        <div className="space-y-2">
          {DEFAULT_FIELDS.map(f => (
            <div key={f.label} className="flex items-center justify-between p-3 rounded-lg bg-muted">
              <div>
                <p className="text-sm font-medium text-text-primary">{f.label}</p>
                <p className="text-xs text-text-muted capitalize">{f.type}</p>
              </div>
              <span className="text-xs text-text-secondary">Always required</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">Custom Questions</p>
          <Button variant="ghost" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setAddOpen(true)}>
            Add Question
          </Button>
        </div>
        {fields.length === 0 ? (
          <p className="text-sm text-text-muted text-center py-4">No custom questions added yet.</p>
        ) : (
          <div className="space-y-2">
            {fields.map(f => (
              <div key={f.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface">
                <div>
                  <p className="text-sm font-medium text-text-primary">{f.label}</p>
                  <p className="text-xs text-text-muted capitalize">{f.type} {f.required ? '· Required' : '· Optional'}</p>
                </div>
                <button
                  onClick={() => onChange(fields.filter(x => x.id !== f.id))}
                  aria-label={`Remove ${f.label}`}
                  className="p-1.5 rounded-lg hover:bg-red-50 text-text-muted hover:text-red-500 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Custom Question"
        description="The question is saved when you save the page."
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={!newLabel.trim()}>Add Field</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Input label="Field Label" required value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="e.g. Area of concern" />
          <Select label="Field Type" options={FIELD_TYPE_OPTIONS} value={newType} onChange={e => setNewType(e.target.value as CustomField['type'])} />
          <div className="flex items-center justify-between py-2">
            <p className="text-sm font-medium text-text-primary">Required</p>
            <Toggle value={newRequired} onChange={setNewRequired} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface PageSetup {
  slug: string;
  type: 'business' | 'service' | 'staff';
  staffId: string;
  serviceIds: string[];
}

interface OptionItem { id: string; name: string; color?: string; isActive?: boolean }

function SetupTab({
  setup, onChange, services, staff, slugError,
}: {
  setup: PageSetup;
  onChange: (patch: Partial<PageSetup>) => void;
  services: OptionItem[];
  staff: OptionItem[];
  slugError?: string;
}) {
  function toggleService(id: string) {
    onChange({ serviceIds: setup.serviceIds.includes(id) ? setup.serviceIds.filter(x => x !== id) : [...setup.serviceIds, id] });
  }

  return (
    <div className="space-y-5">
      <Input
        label="Page address"
        required
        value={setup.slug}
        onChange={e => onChange({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
        hint={`${window.location.origin}/book/${setup.slug || 'your-page'}`}
        error={slugError}
      />

      <Select
        label="Page type"
        value={setup.type}
        onChange={e => onChange({ type: e.target.value as PageSetup['type'] })}
        options={[
          { value: 'business', label: 'Business — several services' },
          { value: 'service', label: 'Single service' },
          { value: 'staff', label: 'Personal page for one staff member' },
        ]}
      />

      {setup.type === 'staff' && (
        <Select
          label="Staff member"
          value={setup.staffId}
          onChange={e => onChange({ staffId: e.target.value })}
          options={[{ value: '', label: 'Select a staff member…' }, ...staff.map(s => ({ value: s.id, label: s.name }))]}
        />
      )}

      <div>
        <p className="text-xs font-medium text-text-primary mb-2">Services offered on this page <span className="text-red-500">*</span></p>
        {services.length === 0 ? (
          <p className="text-sm text-text-muted">No services exist yet. Create a service first.</p>
        ) : (
          <div className="space-y-2">
            {services.map(s => (
              <label key={s.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  className="w-4 h-4 rounded border-border text-primary focus:ring-primary"
                  checked={setup.serviceIds.includes(s.id)}
                  onChange={() => toggleService(s.id)}
                />
                <span className="flex items-center gap-2 text-sm text-text-primary">
                  {s.color && <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />}
                  {s.name}
                  {s.isActive === false && <span className="text-xs text-text-muted">(inactive — hidden publicly)</span>}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-text-muted bg-muted rounded-lg p-3">
        Minimum notice, maximum advance booking and same-day rules are set for the whole business in
        Settings → Booking Rules and apply to every booking page.
      </p>
    </div>
  );
}

// ── Preview Pane ───────────────────────────────────────────────────────────────

function PreviewPane({ config, device, staffName }: { config: PreviewConfig; device: 'desktop' | 'mobile'; staffName?: string }) {
  const containerClass = device === 'mobile'
    ? 'w-[375px] mx-auto border-4 border-gray-800 rounded-3xl overflow-hidden shadow-xl'
    : 'w-full';

  return (
    <div className={containerClass} style={{ fontFamily: config.fontFamily }}>
      <div
        className="min-h-[500px] rounded-xl overflow-hidden border border-border"
        style={{ backgroundColor: config.backgroundColor === '#13222E' ? '#13222E' : config.backgroundColor }}
      >
        {/* Preview header */}
        <div
          className="px-6 py-5 text-white"
          style={{ backgroundColor: config.primaryColor }}
        >
          {config.showLogo && (
            <div className="mb-2">
              {config.logoName ? (
                <span className="text-xs opacity-80">{config.logoName}</span>
              ) : (
                <div className="w-24 h-6 bg-white/30 rounded" />
              )}
            </div>
          )}
          <h2 className="text-base font-bold">{config.headerText || config.title || 'Book an Appointment'}</h2>
          {config.description && (
            <p className="text-xs opacity-80 mt-1">{config.description}</p>
          )}
        </div>

        {/* Preview body */}
        <div className="p-5 space-y-4">
          {/* Staff photo placeholder */}
          {config.showStaffPhoto && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-white/60 border border-border">
              <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-400 text-sm font-bold shrink-0">
                {(staffName ?? 'S').charAt(0).toUpperCase()}
              </div>
              <div>
                <p className="text-xs font-semibold text-text-primary">{staffName ?? 'Staff member'}</p>
              </div>
            </div>
          )}

          {/* Time slots */}
          <div>
            <p className="text-xs font-medium text-text-secondary mb-2">Select a time</p>
            <div className="space-y-2">
              {MOCK_SLOTS.map((slot, i) => (
                <button
                  key={i}
                  className="w-full py-2 px-3 rounded-lg text-white text-sm font-medium transition-opacity hover:opacity-90"
                  style={{ backgroundColor: config.primaryColor }}
                >
                  {slot}
                </button>
              ))}
            </div>
          </div>

          {/* CTA button */}
          <button
            className="w-full py-2.5 rounded-lg text-white text-sm font-semibold"
            style={{ backgroundColor: config.primaryColor }}
          >
            {config.buttonText || 'Book Now'}
          </button>
        </div>

        {/* Footer */}
        {config.footerText && (
          <div className="px-5 py-3 border-t border-border">
            <p className="text-xs text-text-muted text-center">{config.footerText}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PreviewConfig = {
  title: 'Book an Appointment',
  description: '',
  primaryColor: '#00BF62',
  backgroundColor: '#FFFFFF',
  fontFamily: 'Inter',
  buttonText: 'Book Now',
  headerText: '',
  footerText: '',
  showLogo: true,
  showStaffPhoto: false,
  logoName: '',
  layout: 'classic',
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function BookingPageEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const isNew = !id || id === 'new';
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [config, setConfig] = useState<PreviewConfig>(DEFAULT_CONFIG);
  const [setup, setSetup] = useState<PageSetup>({ slug: '', type: 'business', staffId: '', serviceIds: [] });
  const [fields, setFields] = useState<CustomField[]>([]);
  const [isPublished, setIsPublished] = useState(false);
  const [services, setServices] = useState<OptionItem[]>([]);
  const [staff, setStaff] = useState<OptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [slugError, setSlugError] = useState<string | undefined>();
  const [slugTouched, setSlugTouched] = useState(false);

  useEffect(() => {
    const base = Promise.all([
      servicesApi.list() as Promise<OptionItem[]>,
      staffApi.list() as Promise<OptionItem[]>,
    ]);
    const page = isNew ? Promise.resolve(null) : (bookingPagesApi.get(id!) as Promise<ApiBookingPage>);
    Promise.all([base, page])
      .then(([[svcs, stf], p]) => {
        setServices(svcs);
        setStaff(stf);
        if (p) {
          const t: Partial<NonNullable<ApiBookingPage['theme']>> = p.theme ?? {};
          setConfig({
            ...DEFAULT_CONFIG,
            title: p.title,
            description: p.description ?? '',
            primaryColor: t.primaryColor ?? DEFAULT_CONFIG.primaryColor,
            backgroundColor: t.backgroundColor ?? DEFAULT_CONFIG.backgroundColor,
            fontFamily: t.fontFamily ?? DEFAULT_CONFIG.fontFamily,
            buttonText: t.buttonText ?? DEFAULT_CONFIG.buttonText,
            headerText: t.headerText ?? DEFAULT_CONFIG.headerText,
            footerText: t.footerText ?? '',
            showLogo: t.showLogo ?? DEFAULT_CONFIG.showLogo,
            showStaffPhoto: t.showStaffPhoto ?? DEFAULT_CONFIG.showStaffPhoto,
            layout: t.layout ?? DEFAULT_CONFIG.layout,
          });
          setSetup({ slug: p.slug, type: p.type ?? 'business', staffId: p.staffId ?? '', serviceIds: p.serviceIds ?? [] });
          setFields(p.formFields ?? []);
          setIsPublished(p.isPublished);
          setSlugTouched(true);
        }
      })
      .catch((e: Error) => setLoadError(e.message || 'Failed to load booking page'))
      .finally(() => setLoading(false));
  }, [id, isNew]);

  function handleChange(patch: Partial<PreviewConfig>) {
    setConfig(prev => ({ ...prev, ...patch }));
    if (patch.title !== undefined && isNew && !slugTouched) {
      setSetup(prev => ({ ...prev, slug: slugify(patch.title!) }));
    }
  }

  function handleSetup(patch: Partial<PageSetup>) {
    if (patch.slug !== undefined) { setSlugTouched(true); setSlugError(undefined); }
    setSetup(prev => ({ ...prev, ...patch }));
  }

  function validate(): string | null {
    if (!config.title.trim()) return 'Enter a page title (Branding tab).';
    const slug = setup.slug.replace(/^-+|-+$/g, '');
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) { setSlugError('Use lowercase letters, numbers and dashes.'); return 'Enter a valid page address (Page Setup tab).'; }
    if (setup.serviceIds.length === 0) return 'Select at least one service (Page Setup tab).';
    if (setup.type === 'staff' && !setup.staffId) return 'Choose the staff member for this personal page (Page Setup tab).';
    return null;
  }

  async function persist(publish: boolean | undefined) {
    const problem = validate();
    if (problem) { toast.error('Cannot save yet', problem); return; }
    const { logoName: _logo, title, description, ...theme } = config;
    const payload: Record<string, unknown> = {
      title: title.trim(),
      description,
      slug: setup.slug.replace(/^-+|-+$/g, ''),
      type: setup.type,
      serviceIds: setup.serviceIds,
      formFields: fields,
      theme,
      ...(setup.type === 'staff' ? { staffId: setup.staffId } : {}),
      ...(publish !== undefined ? { isPublished: publish } : {}),
    };
    setSaving(true);
    try {
      if (isNew) {
        const created = await bookingPagesApi.create(payload) as ApiBookingPage;
        toast.success(created.isPublished ? 'Page created and published' : 'Page saved as draft');
        navigate(`/booking-pages/${created.id}`, { replace: true });
      } else {
        const updated = await bookingPagesApi.update(id!, payload) as ApiBookingPage;
        setIsPublished(updated.isPublished);
        toast.success(publish === true ? 'Page published' : publish === false ? 'Page unpublished' : 'Changes saved');
      }
    } catch (e: unknown) {
      const msg = (e as Error).message;
      if (/slug/i.test(msg)) setSlugError('That address is already taken. Choose another.');
      toast.error('Could not save booking page', msg);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="page-container"><div className="mt-8 text-center text-sm text-text-muted">Loading booking page…</div></div>;
  }

  if (loadError) {
    return (
      <div className="page-container">
        <div className="mt-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          Could not load this booking page: {loadError}
          <button className="ml-2 underline" onClick={() => navigate('/booking-pages')}>Back to Booking Pages</button>
        </div>
      </div>
    );
  }

  const previewStaff = setup.type === 'staff' ? staff.find(s => s.id === setup.staffId)?.name : undefined;

  const editorTabs = [
    { id: 'setup', label: 'Page Setup', content: <SetupTab setup={setup} onChange={handleSetup} services={services} staff={staff} slugError={slugError} /> },
    { id: 'branding', label: 'Branding', content: <BrandingTab config={config} onChange={handleChange} /> },
    { id: 'layout', label: 'Layout', content: <LayoutTab config={config} onChange={handleChange} /> },
    { id: 'form-fields', label: 'Form Fields', content: <FormFieldsTab fields={fields} onChange={setFields} /> },
  ];

  return (
    <div className="page-container">
      <PageHeader
        title={isNew ? 'New Booking Page' : `Edit: ${config.title}`}
        description={isNew ? 'Configure your public booking page' : 'Edit your booking page settings'}
        breadcrumbs={[
          { label: 'Booking Pages', href: '/booking-pages' },
          { label: isNew ? 'New Page' : config.title },
        ]}
        actions={
          <Button variant="ghost" icon={<ChevronLeft className="w-4 h-4" />} onClick={() => navigate('/booking-pages')}>
            Back
          </Button>
        }
      />

      <div className="flex flex-col lg:flex-row gap-5 mt-4">
        <div className="flex flex-col lg:basis-[55%] min-w-0">
          <div className="bg-surface rounded-xl border border-border flex flex-col flex-1">
            <div className="p-5 border-b border-border">
              <Tabs tabs={editorTabs} defaultTab="setup" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 mt-4">
            {!isNew && (
              <span className="mr-auto text-xs text-text-muted">
                Status: <strong className={isPublished ? 'text-emerald-600' : 'text-text-secondary'}>{isPublished ? 'Published' : 'Draft'}</strong>
              </span>
            )}
            <Button variant="secondary" onClick={() => persist(isNew ? false : undefined)} disabled={saving}>
              {isNew ? 'Save as Draft' : 'Save Changes'}
            </Button>
            {isPublished && !isNew ? (
              <Button variant="outline" onClick={() => persist(false)} disabled={saving}>Unpublish</Button>
            ) : (
              <Button onClick={() => persist(true)} disabled={saving}>{isNew ? 'Create & Publish' : 'Save & Publish'}</Button>
            )}
          </div>
        </div>

        <div className="flex flex-col flex-1 min-w-0">
          <div className="bg-surface rounded-xl border border-border flex flex-col flex-1">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <p className="text-sm font-medium text-text-secondary">Branding Preview</p>
              <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
                <button
                  onClick={() => setDevice('desktop')}
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    device === 'desktop' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary')}
                >
                  <Monitor className="w-3.5 h-3.5" />Desktop
                </button>
                <button
                  onClick={() => setDevice('mobile')}
                  className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
                    device === 'mobile' ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary')}
                >
                  <Smartphone className="w-3.5 h-3.5" />Mobile
                </button>
              </div>
            </div>
            <p className="px-5 pt-3 text-xs text-amber-700">
              The public page uses these settings, including the layout, your logo (Settings › Branding) and staff photos (on each staff profile). Time slots below are examples.
            </p>
            <div className="flex-1 overflow-auto p-5 bg-gray-50 rounded-b-xl">
              <PreviewPane config={config} device={device} staffName={previewStaff} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
