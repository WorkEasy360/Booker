import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CalendarPlus, CalendarClock, PencilLine, ArrowLeft, Loader2, Info } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { PageTitle, useToast } from '@/components/ui';
import { appointmentsApi, servicesApi, staffApi, customersApi } from '@/api/client';
import { toastWithEmailOutcome, type EmailOutcome } from '@/lib/emailStatus';
import { cn, todayInTimeZone } from '@/lib/utils';
import { useBusiness } from '@/hooks/useBusiness';
import { CustomerPicker, type PickedCustomer } from '@/features/customers/CustomerPicker';
import { clock, longDay, addDays } from './listModel';

interface ApiSlot { start: string; end: string; available: boolean }
interface ApiService { id: string; name: string; duration: number; isActive: boolean; staffIds: string[] }
interface ApiStaff { id: string; name: string; isActive: boolean; serviceIds: string[] }
interface ApiAppointment {
  id: string; bookingRef: string; customerId: string; serviceId: string; staffId: string; status: string;
  date: string; startTime: string; endTime: string; duration: number; location: string; internalNotes: string;
  customerName: string; customerPhone: string | null; customerEmail: string | null; serviceName: string; staffName: string;
}

type Mode = 'create' | 'edit' | 'reschedule';

const SECTION = 'panel p-5 sm:p-6';
const STEP = 'w-8 h-8 rounded-full bg-brand-active text-white text-[15px] font-bold flex items-center justify-center shrink-0';
const LABEL = 'block text-[15px] font-semibold text-text-primary mb-1.5';
const FIELD = 'w-full h-12 px-3.5 text-[15px] bg-white border border-border rounded-xl text-text-primary focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:bg-gray-50 disabled:text-text-secondary';

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * One appointment form for creating, editing and rescheduling (V4 3.3 / 3.4): find or add the customer, choose the
 * service, the provider only when more than one can deliver it, and a free slot from the server; review and save.
 * The same booking rules as public booking apply on the server, which checks the slot again when saving.
 */
export default function AppointmentFormPage() {
  const { id } = useParams<{ id?: string }>();
  const location = useLocation();
  const mode: Mode = !id ? 'create' : location.pathname.endsWith('/reschedule') ? 'reschedule' : 'edit';
  usePageTitle(mode === 'create' ? 'New Appointment' : mode === 'edit' ? 'Edit Appointment' : 'Reschedule Appointment');
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const { business } = useBusiness();
  const timezone = business?.timezone;
  const today = todayInTimeZone(timezone);

  const [services, setServices] = useState<ApiService[]>([]);
  const [staff, setStaff] = useState<ApiStaff[]>([]);
  const [existing, setExisting] = useState<ApiAppointment | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [date, setDate] = useState(params.get('date') ?? '');
  const [startTime, setStartTime] = useState('');
  const [note, setNote] = useState('');
  const [slots, setSlots] = useState<ApiSlot[]>([]);
  const [slotsState, setSlotsState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Prevents a second save from a repeated tap while the first request is still in flight.
  const inFlight = useRef(false);
  const wantedTime = useRef<string | null>(params.get('time'));

  useEffect(() => {
    const loads: Array<Promise<unknown>> = [
      (servicesApi.list() as Promise<ApiService[]>).then(setServices),
      (staffApi.list() as Promise<ApiStaff[]>).then(setStaff),
    ];
    if (id) {
      loads.push((appointmentsApi.get(id) as Promise<ApiAppointment>).then(a => {
        setExisting(a);
        setCustomer({ id: a.customerId, name: a.customerName, phone: a.customerPhone ?? null, email: a.customerEmail ?? null });
        setServiceId(a.serviceId);
        setStaffId(a.staffId);
        setDate(a.date);
        setNote(a.internalNotes ?? '');
        wantedTime.current = a.startTime;
      }));
    } else {
      const cid = params.get('customerId');
      if (cid) {
        loads.push((customersApi.get(cid) as Promise<PickedCustomer>)
          .then(c => setCustomer({ id: c.id, name: c.name, phone: c.phone ?? null, email: c.email ?? null }))
          .catch(() => { /* customer not found: the picker stays empty */ }));
      }
    }
    Promise.all(loads)
      .catch((e: Error) => setLoadError(e.message || 'Could not load the form'))
      .finally(() => setLoading(false));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeServices = useMemo(() => services.filter(s => s.isActive || s.id === existing?.serviceId), [services, existing]);
  // A single service is chosen automatically (no selection step).
  useEffect(() => {
    if (mode === 'create' && !serviceId && activeServices.length === 1) setServiceId(activeServices[0].id);
  }, [activeServices, mode, serviceId]);

  const service = services.find(s => s.id === serviceId);
  const providers = useMemo(() => staff.filter(s =>
    (s.isActive || s.id === existing?.staffId) && service && (service.staffIds.includes(s.id) || s.serviceIds.includes(service.id))), [staff, service, existing]);
  // A single eligible provider is chosen automatically; the choice is shown only when there are several.
  useEffect(() => {
    if (!service) return;
    if (providers.length === 1 && staffId !== providers[0].id) setStaffId(providers[0].id);
    else if (staffId && !providers.some(p => p.id === staffId)) setStaffId('');
  }, [providers, service]); // eslint-disable-line react-hooks/exhaustive-deps

  // Free start times from the server for the provider and date (whole service duration, no overlaps).
  useEffect(() => {
    setStartTime('');
    if (!serviceId || !staffId || !date) { setSlots([]); setSlotsState('idle'); return; }
    let cancelled = false;
    setSlotsState('loading');
    const query: Record<string, string> = { date, serviceId, staffId };
    if (existing) query.excludeAppointmentId = existing.id;
    (appointmentsApi.availability(query) as Promise<ApiSlot[]>)
      .then(list => {
        if (cancelled) return;
        setSlots(list);
        setSlotsState('ready');
        const want = wantedTime.current;
        if (want && list.some(s => s.available && s.start === want.slice(0, 5))) setStartTime(want.slice(0, 5));
        wantedTime.current = null;
      })
      .catch(() => { if (!cancelled) { setSlots([]); setSlotsState('error'); } });
    return () => { cancelled = true; };
  }, [serviceId, staffId, date, existing]);

  const free = slots.filter(s => s.available);
  const endTime = service && startTime ? addMinutes(startTime, existing?.duration ?? service.duration) : '';
  const unchanged = !!existing && existing.date === date && existing.startTime.slice(0, 5) === startTime && existing.staffId === staffId;
  const ready = !!customer && !!serviceId && !!staffId && !!date && !!startTime;

  async function save() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setSaveError(null);
    try {
      if (mode === 'create') {
        const apt = await appointmentsApi.create({
          customerId: customer!.id, serviceId, staffId, date, startTime,
          ...(note.trim() ? { internalNotes: note.trim() } : {}),
        }) as { id: string; bookingRef: string; email?: EmailOutcome };
        toastWithEmailOutcome(toast, 'Appointment saved', `${longDay(date)} at ${clock(startTime)}.`, 'confirmation', customer!.email ? apt.email : undefined);
        if (!customer!.email) toast.warning('No email on file', 'This customer has no email address, so email updates cannot be sent.');
        navigate(`/appointments/${apt.id}`, { replace: true });
      } else {
        const body: Record<string, string> = {};
        if (!unchanged) { body.date = date; body.startTime = startTime; body.staffId = staffId; }
        if (mode === 'edit' && note !== (existing!.internalNotes ?? '')) body.internalNotes = note;
        if (!Object.keys(body).length) { navigate(`/appointments/${existing!.id}`); return; }
        const apt = await appointmentsApi.update(existing!.id, body) as { email?: EmailOutcome };
        if (!unchanged) toastWithEmailOutcome(toast, 'Appointment rescheduled', `${longDay(date)} at ${clock(startTime)}.`, 'reschedule', customer!.email ? apt.email : undefined);
        else toast.success('Changes saved');
        navigate(`/appointments/${existing!.id}`, { replace: true });
      }
    } catch (err) {
      // The slot may have been taken meanwhile: the server rechecks it. Refresh the times so another can be chosen.
      setSaveError((err as Error).message);
      setDate(d => d);
      setSlotsState('loading');
      const query: Record<string, string> = { date, serviceId, staffId };
      if (existing) query.excludeAppointmentId = existing.id;
      (appointmentsApi.availability(query) as Promise<ApiSlot[]>).then(list => { setSlots(list); setSlotsState('ready'); setStartTime(''); }).catch(() => setSlotsState('error'));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const title = mode === 'create' ? 'New Appointment' : mode === 'edit' ? 'Edit Appointment' : 'Reschedule Appointment';
  const icon = mode === 'create' ? CalendarPlus : mode === 'edit' ? PencilLine : CalendarClock;
  const backTo = existing ? `/appointments/${existing.id}` : '/appointments';
  const lockedService = mode !== 'create';

  if (loading) return <div className="page-container"><div className="panel p-10 text-center text-sm text-text-muted">Loading…</div></div>;
  if (loadError) return <div className="page-container"><div className="panel p-6 text-sm text-red-700" role="alert">{loadError}</div></div>;
  if (existing && existing.status !== 'scheduled' && existing.status !== 'confirmed') {
    return (
      <div className="page-container">
        <div className="panel p-6">
          <p className="text-base font-semibold text-text-primary">This appointment can no longer be changed</p>
          <p className="text-sm text-text-secondary mt-1">Only Scheduled appointments can be edited or rescheduled.</p>
          <Link to={backTo} className="btn-secondary mt-4">Back to appointment</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container max-w-[1100px]">
      <Link to={backTo} className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary mb-4">
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />{existing ? 'Back to appointment' : 'Back to appointments'}
      </Link>
      <PageTitle
        icon={icon}
        title={title}
        description={mode === 'create' ? 'Find or add the customer, choose a service and a free time, then save.'
          : mode === 'edit' ? `${existing?.customerName} · ${existing?.serviceName} · Ref ${existing?.bookingRef}`
          : 'Choose a new available time. The same appointment is updated and its reminder is replaced.'}
      />

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
        <div className="space-y-5 min-w-0">
          {/* 1. Customer */}
          <section className={SECTION} aria-labelledby="step-customer">
            <div className="flex items-center gap-3 mb-4"><span className={STEP}>1</span><h2 id="step-customer" className="text-[18px] font-bold text-text-primary">Customer</h2></div>
            {mode === 'create'
              ? <CustomerPicker value={customer} onChange={setCustomer} disabled={submitting} />
              : (
                <div>
                  <p className="text-[16px] font-semibold text-text-primary">{customer?.name}</p>
                  <p className="text-sm text-text-secondary">{[customer?.phone, customer?.email].filter(Boolean).join(' · ')}</p>
                </div>
              )}
          </section>

          {/* 2. Service, provider and time */}
          <section className={SECTION} aria-labelledby="step-time">
            <div className="flex items-center gap-3 mb-4"><span className={STEP}>2</span><h2 id="step-time" className="text-[18px] font-bold text-text-primary">Service and time</h2></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="apt-service" className={LABEL}>Service</label>
                {lockedService || activeServices.length === 1 ? (
                  <p id="apt-service" className="h-12 flex items-center px-3.5 rounded-xl bg-[#F6F8FA] border border-border text-[15px] text-text-primary">
                    {service?.name ?? existing?.serviceName} <span className="text-text-secondary ml-1.5">({existing?.duration ?? service?.duration} min)</span>
                  </p>
                ) : (
                  <select id="apt-service" value={serviceId} onChange={e => setServiceId(e.target.value)} className={FIELD} disabled={submitting}>
                    <option value="">Choose a service…</option>
                    {activeServices.map(s => <option key={s.id} value={s.id}>{s.name} ({s.duration} min)</option>)}
                  </select>
                )}
                {!activeServices.length && <p className="mt-1.5 text-sm text-amber-700">No active services. <Link to="/settings/services" className="font-semibold underline">Add a service</Link> first.</p>}
              </div>
              {service && providers.length > 1 && (
                <div>
                  <label htmlFor="apt-staff" className={LABEL}>Staff</label>
                  <select id="apt-staff" value={staffId} onChange={e => setStaffId(e.target.value)} className={FIELD} disabled={submitting}>
                    <option value="">Choose who provides it…</option>
                    {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              {service && providers.length === 0 && (
                <p className="sm:col-span-2 text-sm text-amber-700">Nobody is assigned to this service yet. <Link to="/settings/team" className="font-semibold underline">Assign staff</Link>.</p>
              )}
              <div>
                <label htmlFor="apt-date" className={LABEL}>Date</label>
                <input id="apt-date" type="date" min={today} value={date} onChange={e => setDate(e.target.value)} className={FIELD} disabled={submitting} />
              </div>
            </div>

            <div className="mt-5">
              <p className={LABEL} id="slot-label">Available times{date ? ` · ${longDay(date)}` : ''}</p>
              {!serviceId || !staffId || !date ? (
                <p className="text-sm text-text-secondary">Choose {[!serviceId && 'a service', serviceId && !staffId && providers.length > 1 && 'the staff member', !date && 'a date'].filter(Boolean).join(' and ') || 'the details'} to see free times.</p>
              ) : slotsState === 'loading' ? (
                <p className="text-sm text-text-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Loading available times…</p>
              ) : slotsState === 'error' ? (
                <p className="text-sm text-red-600" role="alert">Could not load available times. Try another date.</p>
              ) : free.length === 0 ? (
                <div className="text-sm text-text-secondary">
                  No free times on this date (closed, blocked or fully booked).
                  <button onClick={() => setDate(addDays(date, 1))} className="ml-2 font-semibold text-primary hover:underline">Try next day</button>
                </div>
              ) : (
                <div role="radiogroup" aria-labelledby="slot-label" className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                  {free.map(s => (
                    <button key={s.start} role="radio" aria-checked={startTime === s.start} onClick={() => setStartTime(s.start)} disabled={submitting}
                      className={cn('h-11 rounded-xl border text-[15px] font-medium transition-colors',
                        startTime === s.start ? 'bg-brand-active text-white border-transparent' : 'bg-white border-border text-text-primary hover:border-primary hover:text-primary')}>
                      {clock(s.start)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {mode === 'edit' && (
              <div className="mt-5">
                <label htmlFor="apt-note" className={LABEL}>Internal note <span className="font-normal text-text-secondary">(optional, private)</span></label>
                <textarea id="apt-note" rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} disabled={submitting}
                  className="w-full px-3.5 py-3 text-[15px] bg-white border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent" />
              </div>
            )}
            {mode === 'create' && (
              <div className="mt-5">
                <label htmlFor="apt-note" className={LABEL}>Internal note <span className="font-normal text-text-secondary">(optional, never shown to the customer)</span></label>
                <textarea id="apt-note" rows={2} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} disabled={submitting}
                  className="w-full px-3.5 py-3 text-[15px] bg-white border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent" />
              </div>
            )}
          </section>
        </div>

        {/* 3. Review and save */}
        <aside className={cn(SECTION, 'lg:sticky lg:top-[100px]')} aria-labelledby="step-review">
          <div className="flex items-center gap-3 mb-4"><span className={STEP}>3</span><h2 id="step-review" className="text-[18px] font-bold text-text-primary">Review and save</h2></div>
          <dl className="space-y-3 text-[15px]">
            <Row label="Customer" value={customer?.name} />
            <Row label="Service" value={service ? `${service.name} (${existing?.duration ?? service.duration} min)` : undefined} />
            <Row label="Staff" value={staff.find(s => s.id === staffId)?.name} />
            <Row label="Date" value={date ? longDay(date) : undefined} />
            <Row label="Time" value={startTime ? `${clock(startTime)} – ${clock(endTime)}` : undefined} />
            {timezone && <Row label="Timezone" value={timezone} />}
            {business?.appointmentLocation && <Row label="Location" value={business.appointmentLocation} />}
          </dl>
          {customer && !customer.email && (
            <p className="mt-4 flex gap-2 text-[13px] text-text-secondary bg-[#F6F8FA] rounded-lg px-3 py-2">
              <Info className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />No email on file, so email updates cannot be sent to this customer.
            </p>
          )}
          {saveError && <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2" role="alert">{saveError}</p>}
          <button onClick={save} disabled={!ready || submitting || (mode === 'reschedule' && unchanged)} className="btn-primary w-full h-12 mt-5 text-[16px] rounded-xl">
            {submitting ? <><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />Saving…</>
              : mode === 'create' ? 'Save Appointment' : mode === 'reschedule' ? 'Confirm New Time' : 'Save Changes'}
          </button>
          <button onClick={() => navigate(backTo)} className="btn-ghost w-full h-11 mt-2 justify-center">Cancel</button>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-text-secondary">{label}</dt>
      <dd className={cn('text-right font-medium', value ? 'text-text-primary' : 'text-text-muted')}>{value || '—'}</dd>
    </div>
  );
}
