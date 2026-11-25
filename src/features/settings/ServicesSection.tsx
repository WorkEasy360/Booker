import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Clock } from 'lucide-react';
import { Button, Input, Modal, useToast } from '@/components/ui';
import { servicesApi, staffApi } from '@/api/client';
import { Section, Toggle, Pill, Loading } from './ui';

interface Service { id: string; name: string; duration: number; isActive: boolean }
interface StaffLite { id: string; isActive: boolean }

const DURATIONS = [15, 30, 45, 60, 90, 120];

/**
 * 4.2 Services: only Name, Duration and Active. Editing a service never changes existing appointments (they keep the
 * duration they were booked with); deactivating stops new bookings and keeps every existing one.
 */
export function ServicesSection({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [services, setServices] = useState<Service[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    (servicesApi.list() as Promise<Service[]>)
      .then(list => { setServices(list); setError(null); })
      .catch((e: Error) => setError(e.message || 'Could not load services'));
  }, []);
  useEffect(load, [load]);

  async function setActive(s: Service, isActive: boolean) {
    setBusyId(s.id);
    try {
      await servicesApi.update(s.id, { isActive });
      toast.success(isActive ? `${s.name} is bookable again` : `${s.name} deactivated`, isActive ? undefined : 'Existing appointments are kept; no new bookings.');
      load();
    } catch (e) {
      toast.error('Service was not changed', (e as Error).message);
    } finally { setBusyId(null); }
  }

  const active = services?.filter(s => s.isActive) ?? [];
  const inactive = services?.filter(s => !s.isActive) ?? [];

  return (
    <Section id="services" title="Services" description="What customers can book and how long each appointment lasts."
      action={canEdit ? <button type="button" className="btn-primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" aria-hidden="true" />Add Service</button> : undefined}>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !services ? <Loading /> : services.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-sm font-medium text-text-primary">No services yet</p>
          <p className="text-sm text-text-secondary mt-1">Add your first service so customers can book it.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-xl">
          {[...active, ...inactive].map(s => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
              <div className="flex-1 min-w-[10rem]">
                <p className={s.isActive ? 'text-sm font-semibold text-text-primary' : 'text-sm font-semibold text-text-muted'}>{s.name}</p>
                <p className="text-sm text-text-secondary flex items-center gap-1 mt-0.5"><Clock className="w-3.5 h-3.5" aria-hidden="true" />{s.duration} min</p>
              </div>
              <Pill tone={s.isActive ? 'green' : 'gray'}>{s.isActive ? 'Active' : 'Inactive'}</Pill>
              {canEdit && (
                <div className="flex items-center gap-2">
                  <Button variant="secondary" size="sm" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>Edit</Button>
                  <Button variant="ghost" size="sm" disabled={busyId === s.id} onClick={() => setActive(s, !s.isActive)}>
                    {s.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ServiceForm
          service={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </Section>
  );
}

function ServiceForm({ service, onClose, onSaved }: { service: Service | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(service?.name ?? '');
  const [duration, setDuration] = useState(String(service?.duration ?? 30));
  const [isActive, setIsActive] = useState(service?.isActive ?? true);
  const [errors, setErrors] = useState<{ name?: string; duration?: string }>({});
  const [busy, setBusy] = useState(false);

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    const minutes = Number(duration);
    const errs: typeof errors = {};
    if (!name.trim()) errs.name = 'Enter a service name.';
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) errs.duration = 'Enter whole minutes between 5 and 1440.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      if (service) {
        await servicesApi.update(service.id, { name: name.trim(), duration: minutes, isActive });
        toast.success('Service saved', 'Existing appointments keep their booked time and duration.');
      } else {
        // New services are offered by every active provider; assign services per person in Team.
        const staff = (await staffApi.list().catch(() => [])) as StaffLite[];
        await servicesApi.create({
          name: name.trim(), duration: minutes, isActive,
          category: 'consultation', price: 0,
          staffIds: staff.filter(s => s.isActive).map(s => s.id),
        });
        toast.success('Service added');
      }
      onSaved();
    } catch (err) {
      toast.error('Service was not saved', (err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Modal isOpen onClose={onClose} title={service ? 'Edit Service' : 'Add Service'} size="sm"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form onSubmit={save} noValidate className="space-y-4">
        <Input label="Service name" required value={name} maxLength={100} autoFocus
          onChange={e => { setName(e.target.value); setErrors(x => ({ ...x, name: undefined })); }} error={errors.name} placeholder="e.g. Consultation" />
        <div>
          <Input label="Duration (minutes)" required type="number" min={5} max={1440} step={5} inputMode="numeric" value={duration}
            onChange={e => { setDuration(e.target.value); setErrors(x => ({ ...x, duration: undefined })); }} error={errors.duration}
            hint={service ? 'Changing the duration applies to new bookings only.' : 'End time is calculated from the start time and this duration.'} />
          <div className="flex flex-wrap gap-2 mt-2" aria-label="Common durations">
            {DURATIONS.map(d => (
              <button key={d} type="button" onClick={() => setDuration(String(d))}
                className={Number(duration) === d ? 'px-3 py-1 rounded-full text-xs font-medium bg-primary text-white' : 'px-3 py-1 rounded-full text-xs font-medium bg-muted text-text-secondary hover:bg-primary-light'}>
                {d} min
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 pt-1">
          <div>
            <p className="text-sm font-semibold text-text-primary">Active</p>
            <p className="text-xs text-text-secondary">Inactive services cannot be booked; existing appointments stay.</p>
          </div>
          <Toggle checked={isActive} onChange={setIsActive} label="Active" />
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
