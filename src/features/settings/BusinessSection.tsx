import React, { useEffect, useState } from 'react';
import { Input, Select, Textarea, ConfirmModal, useToast } from '@/components/ui';
import { settingsApi } from '@/api/client';
import { timeZoneOptions } from '@/lib/utils';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';
import { Section, SaveButton, LoadError, Loading } from './ui';
import { useOrgSettings } from './orgSettings';

/**
 * 4.1 Business Details: name, contact details, the one business timezone and an optional single appointment
 * location or online instructions. This is the only place these are edited.
 */
export function BusinessSection() {
  const toast = useToast();
  const { org, state, reload } = useOrgSettings();
  const [form, setForm] = useState({ name: '', email: '', phone: '', timezone: '', appointmentLocation: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmZone, setConfirmZone] = useState(false);

  useEffect(() => {
    if (org) setForm({ name: org.name ?? '', email: org.email ?? '', phone: org.phone ?? '', timezone: org.timezone ?? '', appointmentLocation: org.appointmentLocation ?? '' });
  }, [org]);

  const set = (k: keyof typeof form, v: string) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })); };
  const zoneChanged = !!org && form.timezone !== org.timezone;

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = 'Enter the business name.';
    const em = emailError(form.email.trim());
    if (!form.email.trim()) e.email = 'Enter a contact email.';
    else if (em) e.email = em;
    if (form.phone.trim()) { const p = phoneError(form.phone.trim()); if (p) e.phone = p; }
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    if (zoneChanged) { setConfirmZone(true); return; }
    void save();
  }

  async function save() {
    setConfirmZone(false);
    setSaving(true);
    try {
      await settingsApi.update({
        name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(),
        timezone: form.timezone, appointmentLocation: form.appointmentLocation.trim(),
      });
      await reload();
      toast.success('Business details saved');
    } catch (err) {
      toast.error('Business details were not saved', (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section id="business" title="Business Details" description="Shown on your booking page, emails and reminders.">
      {state === 'loading' ? <Loading /> : typeof state === 'object' ? <LoadError message={state.error} /> : (
        <form onSubmit={submit} noValidate className="space-y-4 max-w-2xl">
          <Input label="Business name" required value={form.name} onChange={e => set('name', e.target.value)} error={errors.name} maxLength={100} />
          <div className="grid sm:grid-cols-2 gap-4">
            <Input label="Contact email" required type="email" value={form.email} onChange={e => set('email', e.target.value)} error={errors.email} />
            <Input label="Phone" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} error={errors.phone} placeholder={PHONE_PLACEHOLDER} />
          </div>
          <Select label="Timezone" value={form.timezone} onChange={e => set('timezone', e.target.value)} options={timeZoneOptions(form.timezone)}
            hint={zoneChanged
              ? 'Existing appointments keep their exact moment in time; their times will be shown in the new timezone. You will be asked to confirm.'
              : 'Used for your booking page, reminders and every appointment view.'} />
          <Textarea label="Appointment location or online instructions (optional)" rows={3} maxLength={500}
            value={form.appointmentLocation} onChange={e => set('appointmentLocation', e.target.value)}
            placeholder="e.g. 2nd floor, 14 MG Road, Pune — or: we will send a video link before your appointment"
            hint="Customers see this before they confirm a booking." />
          <div className="flex justify-end pt-1">
            <SaveButton busy={saving} />
          </div>
        </form>
      )}
      <ConfirmModal
        isOpen={confirmZone}
        onClose={() => setConfirmZone(false)}
        onConfirm={() => void save()}
        title="Change the business timezone?"
        message={`From now on times are shown in ${form.timezone}. Existing appointments are not moved: each keeps its exact moment in time, so its local time may display differently. No customer is notified.`}
        confirmLabel="Change timezone"
        variant="warning"
        loading={saving}
      />
    </Section>
  );
}
