import React, { useState, useEffect } from 'react';
import { cn, DAYS } from '@/lib/utils';
import { Button, Input, Select, useToast } from '@/components/ui';
import { Link } from 'react-router-dom';
import { settingsApi, mediaApi } from '@/api/client';
import { ImageUpload } from '@/components/ImageUpload';
import { phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';

// ─── Types ───────────────────────────────────────────────────────────────────

interface OrgSettings {
  name?: string;
  /** The uploaded logo, if any. */
  logoUpload?: { id: string; url: string } | null;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  city?: string;
  country?: string;
  timezone?: string;
  currency?: string;
  dateFormat?: string;
  timeFormat?: string;
  workingHours?: Record<string, { enabled: boolean; start: string; end: string }>;
  bookingRules?: {
    duration?: string;
    buffer?: string;
    minNotice?: string;
    maxAdvance?: string;
    sameDay?: boolean;
    requirePhone?: boolean;
  };
  cancellationPolicy?: string;
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary',
        checked ? 'bg-primary' : 'bg-gray-200'
      )}
    >
      <span className={cn(
        'inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-6' : 'translate-x-1'
      )} />
    </button>
  );
}

export function Section({ title, description, children }: {
  title: string; description?: string; children: React.ReactNode;
}) {
  return (
    <div className="bg-surface rounded-xl border border-border p-6">
      <div className="mb-5">
        <h2 className="text-base font-semibold text-text-primary">{title}</h2>
        {description && <p className="text-sm text-text-secondary mt-1">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function isValidEmail(v: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

// ─── Business Profile ────────────────────────────────────────────────────────

export function BusinessProfileSection() {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', phone: '', website: '', address: '', city: '', country: '' });
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [loadState, setLoadState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    settingsApi.get().then(raw => {
      setLoadState('ready');
      const d = raw as OrgSettings;
      setForm({
        name:    d.name    ?? '',
        email:   d.email   ?? '',
        phone:   d.phone   ?? '',
        website: d.website ?? '',
        address: d.address ?? '',
        city:    d.city    ?? '',
        country: d.country ?? '',
      });
    }).catch((e: Error) => setLoadState({ error: e.message || 'Failed to load settings' }));
  }, []);

  function set(key: string, value: string) {
    setForm(f => ({ ...f, [key]: value }));
    setErrors(e => ({ ...e, [key]: '' }));
  }

  function validate() {
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Organization name is required.';
    if (form.email && !isValidEmail(form.email)) errs.email = 'Enter a valid email address.';
    const phoneMsg = phoneError(form.phone ?? '');
    if (phoneMsg) errs.phone = phoneMsg;
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    try {
      await settingsApi.update({ name: form.name, email: form.email, phone: form.phone, website: form.website, address: form.address, city: form.city, country: form.country });
      toast.success('Business profile saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save. Is the server running?');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Business Profile" description="Your organization's basic contact information">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Input label="Organization name" value={form.name} onChange={e => set('name', e.target.value)} required error={errors.name} />
        </div>
        <Input label="Email address" type="email" value={form.email} onChange={e => set('email', e.target.value)} required error={errors.email} />
        <Input label="Phone number" type="tel" placeholder={PHONE_PLACEHOLDER} value={form.phone} onChange={e => set('phone', e.target.value)} error={errors.phone} />
        <div className="col-span-2">
          <Input label="Website" type="url" value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://" />
        </div>
        <div className="col-span-2">
          <Input label="Street address" value={form.address} onChange={e => set('address', e.target.value)} />
        </div>
        <Input label="City" value={form.city} onChange={e => set('city', e.target.value)} />
        <Input label="Country" value={form.country} onChange={e => set('country', e.target.value)} />
      </div>
      <div className="mt-5 flex items-center justify-end gap-3">
        {typeof loadState === 'object' && (
          <p className="text-sm text-red-600 mr-auto">Could not load current settings ({loadState.error}). Saving is disabled so existing settings are not overwritten.</p>
        )}
        <Button onClick={handleSave} disabled={saving || loadState !== 'ready'}>{saving ? 'Saving…' : 'Save Changes'}</Button>
      </div>
    </Section>
  );
}

// ─── Branding ────────────────────────────────────────────────────────────────

const BRAND_COLORS = ['#00BF62', '#3B82F6', '#8B5CF6', '#EF4444', '#F59E0B', '#EC4899'];

export function BrandingSection() {
  const toast = useToast();
  const [color, setColor] = useState('#00BF62');
  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    settingsApi.get().then(raw => {
      setLoadState('ready');
      const d = raw as OrgSettings;
      if (d.name) setName(d.name);
      setLogo(d.logoUpload?.url ?? null);
    }).catch((e: Error) => setLoadState({ error: e.message || 'Failed to load settings' }));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await settingsApi.update({ name });
      toast.success('Branding settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Branding" description="Customize your public-facing brand appearance">
      <div className="space-y-6">
        <ImageUpload label="Logo" value={logo} onChange={setLogo} disabled={loadState !== 'ready'}
          upload={file => mediaApi.uploadLogo(file)} remove={() => mediaApi.removeLogo()} />
        <p className="text-xs text-text-muted -mt-3">Shown on your public booking pages when “Show logo” is on for the page.</p>
        <div>
          <p className="text-sm font-medium text-text-primary mb-1">Preview colour</p>
          <p className="text-xs text-text-muted mb-2">
            Only changes the preview below. Booking-page colours are set for each page in <Link to="/booking-pages" className="text-primary hover:underline">Booking Pages</Link>.
          </p>
          <div className="flex items-center gap-2">
            {BRAND_COLORS.map(c => (
              <button key={c} type="button" onClick={() => setColor(c)} title={c}
                className={cn('w-8 h-8 rounded-lg transition-all border-2', color === c ? 'border-gray-400 ring-2 ring-offset-2 ring-gray-300' : 'border-transparent')}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <div>
          <Input label="Business display name" value={name} onChange={e => setName(e.target.value)} />
          <div className="mt-3 p-4 rounded-xl border border-border" style={{ backgroundColor: color + '18' }}>
            <p className="text-sm font-semibold" style={{ color }}>{name || 'Business Name'}</p>
            <p className="text-xs text-text-secondary mt-1">Preview of how your name appears on booking pages</p>
          </div>
        </div>
        <div className="flex justify-end">
          {typeof loadState === 'object' && <p className="text-sm text-red-600">Could not load current settings ({loadState.error}). Saving is disabled.</p>}
          <Button onClick={handleSave} disabled={saving || loadState !== 'ready'}>{saving ? 'Saving…' : 'Save Changes'}</Button>
        </div>
      </div>
    </Section>
  );
}

// ─── Working Hours ────────────────────────────────────────────────────────────

const DAY_FULL: Record<string, string> = {
  monday: 'Monday', tuesday: 'Tuesday', wednesday: 'Wednesday',
  thursday: 'Thursday', friday: 'Friday', saturday: 'Saturday', sunday: 'Sunday',
};

const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2).toString().padStart(2, '0');
  const m = i % 2 === 0 ? '00' : '30';
  return { value: `${h}:${m}`, label: `${h}:${m}` };
});

const DEFAULT_WH = (day: string) => ({
  day,
  enabled: !['saturday', 'sunday'].includes(day),
  start: '09:00',
  end: '17:00',
});

export function WorkingHoursSection() {
  const toast = useToast();
  const [hours, setHours] = useState(() => DAYS.map(DEFAULT_WH));
  const [saving, setSaving] = useState(false);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    settingsApi.get().then(raw => {
      setLoadState('ready');
      const d = raw as OrgSettings;
      if (d.workingHours && Object.keys(d.workingHours).length > 0) {
        setHours(DAYS.map(day => ({ day, ...(d.workingHours![day] ?? { enabled: false, start: '09:00', end: '17:00' }) })));
      }
    }).catch((e: Error) => setLoadState({ error: e.message || 'Failed to load settings' }));
  }, []);

  function setDay(day: string, field: string, value: boolean | string) {
    setHours(h => h.map(d => d.day === day ? { ...d, [field]: value } : d));
  }

  function applyToAll() {
    const active = hours.find(h => h.enabled);
    if (!active) { toast.warning('No active days to copy from'); return; }
    setHours(h => h.map(d => d.enabled ? { ...d, start: active.start, end: active.end } : d));
    toast.info('Times applied to all active days');
  }

  async function handleSave() {
    const wh: Record<string, { enabled: boolean; start: string; end: string }> = {};
    for (const d of hours) wh[d.day] = { enabled: d.enabled, start: d.start, end: d.end };
    setSaving(true);
    try {
      await settingsApi.update({ workingHours: wh });
      toast.success('Working hours saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Working Hours" description="Set your default business operating hours">
      <div className="divide-y divide-border">
        {hours.map(d => (
          <div key={d.day} className="flex items-center gap-3 py-3">
            <Toggle checked={d.enabled} onChange={v => setDay(d.day, 'enabled', v)} />
            <span className={cn('w-28 text-sm shrink-0', d.enabled ? 'text-text-primary font-medium' : 'text-text-muted')}>
              {DAY_FULL[d.day]}
            </span>
            {d.enabled ? (
              <div className="flex items-center gap-2 flex-1">
                <select value={d.start} onChange={e => setDay(d.day, 'start', e.target.value)}
                  className="flex-1 text-sm border border-border rounded-lg px-2 py-1.5 bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                  {TIME_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <span className="text-text-muted text-sm shrink-0">to</span>
                <select value={d.end} onChange={e => setDay(d.day, 'end', e.target.value)}
                  className="flex-1 text-sm border border-border rounded-lg px-2 py-1.5 bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary">
                  {TIME_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
            ) : (
              <span className="text-sm text-text-muted">Closed</span>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={applyToAll}>Apply to all active days</Button>
        {typeof loadState === 'object' && <p className="text-sm text-red-600">Could not load current settings ({loadState.error}). Saving is disabled.</p>}
        <Button onClick={handleSave} disabled={saving || loadState !== 'ready'}>{saving ? 'Saving…' : 'Save Changes'}</Button>
      </div>
    </Section>
  );
}

// ─── Booking Rules ────────────────────────────────────────────────────────────

export function BookingRulesSection() {
  const toast = useToast();
  // Defaults mirror what the server enforces when an organization has never saved rules.
  const [rules, setRules] = useState({ duration: '60', buffer: '0', minNotice: '0', maxAdvance: '0', sameDay: true, requirePhone: true });
  const [saving, setSaving] = useState(false);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    settingsApi.get().then(raw => {
      setLoadState('ready');
      const br = ((raw as OrgSettings).bookingRules ?? {}) as Record<string, unknown>;
      const num = (canonical: unknown, legacy: unknown, fallback: string) =>
        typeof canonical === 'number' ? String(canonical) : legacy !== undefined ? String(legacy) : fallback;
      setRules(r => ({
        duration:     num(br.defaultDurationMinutes, br.duration, r.duration),
        buffer:       num(br.defaultBufferMinutes, br.buffer, r.buffer),
        minNotice:    num(br.minNoticeHours, br.minNotice, r.minNotice),
        maxAdvance:   num(br.maxAdvanceDays, br.maxAdvance, r.maxAdvance),
        sameDay:      typeof br.sameDay === 'boolean' ? br.sameDay : r.sameDay,
        requirePhone: typeof br.requirePhone === 'boolean' ? br.requirePhone : r.requirePhone,
      }));
    }).catch((e: Error) => setLoadState({ error: e.message || 'Failed to load settings' }));
  }, []);

  const set = (key: string, value: string | boolean) => setRules(r => ({ ...r, [key]: value }));

  async function handleSave() {
    setSaving(true);
    try {
      // Canonical units: minutes for duration/buffer, hours for notice, days for advance (0 = no limit).
      await settingsApi.update({
        bookingRules: {
          defaultDurationMinutes: Number(rules.duration),
          defaultBufferMinutes: Number(rules.buffer),
          minNoticeHours: Number(rules.minNotice),
          maxAdvanceDays: Number(rules.maxAdvance),
          sameDay: rules.sameDay,
          requirePhone: rules.requirePhone,
        },
      });
      toast.success('Booking rules saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Booking Rules" description="Rules for public online booking. A service's own notice and advance settings apply too; the stricter one wins. Staff booking from the admin screens is not restricted.">
      <div className="grid grid-cols-2 gap-4">
        <Select label="Default duration for new services" value={rules.duration} onChange={e => set('duration', e.target.value)}
          options={[{ value: '15', label: '15 minutes' }, { value: '30', label: '30 minutes' }, { value: '45', label: '45 minutes' }, { value: '60', label: '1 hour' }, { value: '90', label: '1.5 hours' }, { value: '120', label: '2 hours' }]} />
        <Select label="Default buffer after appointments (new services)" value={rules.buffer} onChange={e => set('buffer', e.target.value)}
          options={[{ value: '0', label: 'No buffer' }, { value: '5', label: '5 minutes' }, { value: '10', label: '10 minutes' }, { value: '15', label: '15 minutes' }]} />
        <Select label="Minimum booking notice" value={rules.minNotice} onChange={e => set('minNotice', e.target.value)}
          options={[{ value: '0', label: 'No minimum' }, { value: '1', label: '1 hour' }, { value: '2', label: '2 hours' }, { value: '4', label: '4 hours' }, { value: '8', label: '8 hours' }, { value: '12', label: '12 hours' }, { value: '24', label: '24 hours' }, { value: '48', label: '48 hours' }]} />
        <Select label="Maximum advance booking" value={rules.maxAdvance} onChange={e => set('maxAdvance', e.target.value)}
          options={[{ value: '0', label: 'No limit' }, { value: '7', label: '7 days' }, { value: '14', label: '14 days' }, { value: '30', label: '30 days' }, { value: '60', label: '60 days' }, { value: '90', label: '90 days' }]} />
      </div>
      <div className="mt-4 space-y-4 border-t border-border pt-4">
        {[
          { key: 'sameDay', label: 'Allow same-day booking', desc: 'Customers can book appointments for the current day' },
          { key: 'requirePhone', label: 'Require phone number', desc: 'Make phone number a mandatory field at checkout' },
        ].map(item => (
          <div key={item.key} className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-primary">{item.label}</p>
              <p className="text-xs text-text-secondary mt-0.5">{item.desc}</p>
            </div>
            <Toggle checked={rules[item.key as 'sameDay' | 'requirePhone']} onChange={v => set(item.key, v)} />
          </div>
        ))}
      </div>
      <div className="mt-5 flex items-center justify-end gap-3">
        {typeof loadState === 'object' && (
          <p className="text-sm text-red-600 mr-auto">Could not load current settings ({loadState.error}). Saving is disabled so existing settings are not overwritten.</p>
        )}
        <Button onClick={handleSave} disabled={saving || loadState !== 'ready'}>{saving ? 'Saving…' : 'Save Changes'}</Button>
      </div>
    </Section>
  );
}
