import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Clock, KeyRound, Mail, Phone } from 'lucide-react';
import { Avatar, Button, Input, Modal, useToast } from '@/components/ui';
import { mediaApi, servicesApi, staffApi, type StaffAccount } from '@/api/client';
import { ImageUpload } from '@/components/ImageUpload';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';
import { Section, Toggle, Pill, Loading } from './ui';
import { StaffAccessCard } from './StaffAccessCard';

interface StaffMember {
  id: string; name: string; email: string; phone: string | null; isActive: boolean;
  serviceIds: string[]; color?: string; photoUrl?: string | null; account?: StaffAccount;
}
interface ServiceLite { id: string; name: string; isActive: boolean }

const ACCESS_LABEL: Record<StaffAccount['status'], { text: string; tone: 'green' | 'gray' | 'blue' | 'amber' }> = {
  none: { text: 'No login', tone: 'gray' },
  invited: { text: 'Invited', tone: 'blue' },
  active: { text: 'Can log in', tone: 'green' },
  disabled: { text: 'Login off', tone: 'amber' },
};

/**
 * 4.5 Team: the people who take appointments (providers). A provider is not automatically a login; login access is
 * optional (Owner or Staff). Working hours live in Availability only.
 */
export function TeamSection() {
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [services, setServices] = useState<ServiceLite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<StaffMember | 'new' | null>(null);
  const [access, setAccess] = useState<StaffMember | null>(null);

  const load = useCallback(() => {
    Promise.all([staffApi.list() as Promise<StaffMember[]>, servicesApi.list() as Promise<ServiceLite[]>])
      .then(([s, svc]) => { setStaff(s); setServices(svc); setError(null); })
      .catch((e: Error) => setError(e.message || 'Could not load your team'));
  }, []);
  useEffect(load, [load]);

  // Keep the open access dialog in step with the reloaded record.
  useEffect(() => { if (access && staff) setAccess(staff.find(s => s.id === access.id) ?? null); }, [staff]); // eslint-disable-line react-hooks/exhaustive-deps

  const serviceName = (id: string) => services.find(s => s.id === id)?.name;
  const sorted = [...(staff ?? [])].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));

  return (
    <Section id="team" title="Team" description="People who take appointments. Customers choose a provider only when more than one can do the service."
      action={<button type="button" className="btn-primary" onClick={() => setEditing('new')}><Plus className="w-4 h-4" aria-hidden="true" />Add Staff</button>}>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !staff ? <Loading /> : staff.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-sm font-medium text-text-primary">No team members yet</p>
          <p className="text-sm text-text-secondary mt-1">You can take bookings yourself. Add staff only when someone else takes appointments.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border border-border rounded-xl">
          {sorted.map(m => {
            const acc = ACCESS_LABEL[m.account?.status ?? 'none'];
            const names = m.serviceIds.map(serviceName).filter(Boolean) as string[];
            return (
              <li key={m.id} className="px-4 py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <Avatar name={m.name} src={m.photoUrl ?? undefined} color={m.color ?? '#16A34A'} size="md" decorative />
                  <div className="flex-1 min-w-[12rem]">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={m.isActive ? 'text-sm font-semibold text-text-primary' : 'text-sm font-semibold text-text-muted'}>{m.name}</p>
                      {!m.isActive && <Pill tone="gray">Inactive</Pill>}
                      {m.account && <Pill tone={acc.tone}>{m.account.status === 'active' && m.account.role === 'admin' ? 'Owner login' : acc.text}</Pill>}
                    </div>
                    <p className="text-sm text-text-secondary mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                      <span className="inline-flex items-center gap-1"><Mail className="w-3.5 h-3.5" aria-hidden="true" />{m.email}</span>
                      {m.phone && <span className="inline-flex items-center gap-1"><Phone className="w-3.5 h-3.5" aria-hidden="true" />{m.phone}</span>}
                    </p>
                    <p className="text-xs text-text-muted mt-1">{names.length ? `Services: ${names.join(', ')}` : 'No services assigned — cannot be booked yet'}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" icon={<Pencil className="w-3.5 h-3.5" />} onClick={() => setEditing(m)} aria-label={`Edit ${m.name}`}>Edit</Button>
                    {m.account && <Button variant="ghost" size="sm" icon={<KeyRound className="w-3.5 h-3.5" />} onClick={() => setAccess(m)}>Login access</Button>}
                    <Link to={`/availability?staff=${encodeURIComponent(m.id)}`} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-primary hover:bg-primary-light">
                      <Clock className="w-3.5 h-3.5" aria-hidden="true" />Working hours
                    </Link>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && (
        <StaffForm member={editing === 'new' ? null : editing} services={services.filter(s => s.isActive || (editing !== 'new' && editing.serviceIds.includes(s.id)))}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} onPhoto={load} />
      )}
      <Modal isOpen={!!access} onClose={() => setAccess(null)} title={access ? `Login access — ${access.name}` : ''} size="md">
        {access && <StaffAccessCard staff={access} onChanged={load} />}
      </Modal>
    </Section>
  );
}

function StaffForm({ member, services, onClose, onSaved, onPhoto }: {
  member: StaffMember | null; services: ServiceLite[]; onClose: () => void; onSaved: () => void; onPhoto?: () => void;
}) {
  const toast = useToast();
  const [photo, setPhoto] = useState<string | null>(member?.photoUrl ?? null);
  const [form, setForm] = useState({
    name: member?.name ?? '', email: member?.email ?? '', phone: member?.phone ?? '',
    serviceIds: member?.serviceIds ?? services.filter(s => s.isActive).map(s => s.id), isActive: member?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => { setForm(f => ({ ...f, [k]: v })); setErrors(e => ({ ...e, [k]: '' })); };

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.name.trim()) errs.name = 'Enter a name.';
    if (!form.email.trim()) errs.email = 'Enter an email address.';
    else if (emailError(form.email)) errs.email = emailError(form.email);
    if (form.phone.trim() && phoneError(form.phone)) errs.phone = phoneError(form.phone);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const body = { name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(), serviceIds: form.serviceIds, isActive: form.isActive };
    try {
      if (member) await staffApi.update(member.id, body);
      else await staffApi.create({ ...body, role: 'staff' });
      toast.success(member ? 'Team member saved' : 'Team member added', member ? undefined : 'Set their working hours in Availability.');
      onSaved();
    } catch (err) {
      toast.error('Team member was not saved', (err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Modal isOpen onClose={onClose} title={member ? 'Edit Team Member' : 'Add Team Member'} size="md"
      footer={<>
        <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </>}>
      <form onSubmit={save} noValidate className="space-y-4">
        {member && (
          <ImageUpload
            label="Photo"
            value={photo}
            upload={file => mediaApi.uploadStaffPhoto(member.id, file)}
            remove={() => mediaApi.removeStaffPhoto(member.id)}
            onChange={url => { setPhoto(url); onPhoto?.(); }}
            shape="round"
          />
        )}
        <Input label="Name" required value={form.name} maxLength={100} autoFocus onChange={e => set('name', e.target.value)} error={errors.name} />
        <div className="grid sm:grid-cols-2 gap-4">
          <Input label="Email" required type="email" value={form.email} onChange={e => set('email', e.target.value)} error={errors.email} />
          <Input label="Phone" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} error={errors.phone} placeholder={PHONE_PLACEHOLDER} />
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-text-primary mb-2">Assigned services</legend>
          {services.length === 0 ? (
            <p className="text-sm text-text-muted">No services yet. Add them in Settings → Services.</p>
          ) : (
            <div className="grid sm:grid-cols-2 gap-2">
              {services.map(s => (
                <label key={s.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border text-sm text-text-primary cursor-pointer hover:bg-muted">
                  <input type="checkbox" className="w-4 h-4 accent-primary" checked={form.serviceIds.includes(s.id)}
                    onChange={e => set('serviceIds', e.target.checked ? [...form.serviceIds, s.id] : form.serviceIds.filter(x => x !== s.id))} />
                  <span className="truncate">{s.name}{!s.isActive && ' (inactive)'}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-text-primary">Active</p>
            <p className="text-xs text-text-secondary">Inactive members cannot be booked. Their appointments are kept.</p>
          </div>
          <Toggle checked={form.isActive} onChange={v => set('isActive', v)} label="Active" />
        </div>
        <p className="text-xs text-text-muted flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" aria-hidden="true" />Working hours are set in <Link to="/availability" className="text-primary font-medium hover:underline">Availability</Link>.
        </p>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
