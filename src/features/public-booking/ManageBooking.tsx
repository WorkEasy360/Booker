import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams, useLocation, useNavigate, Link } from 'react-router-dom';
import { Search, Calendar, Clock, X, Check, ChevronLeft, HelpCircle, User, Tag, Banknote, ShieldCheck } from 'lucide-react';
import { publicApi, ApiError, type ManagedBooking } from '@/api/client';
import { AvailabilityCalendar } from './AvailabilityCalendar';
import { customerEmailMessage, type EmailStatus } from '@/lib/emailStatus';
import { formatDate, formatTime, formatDuration, formatCurrency, cn } from '@/lib/utils';
import { useToast, ConfirmModal, StatusBadge, Avatar } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';
import { businessPageTitle } from '@/lib/brand';
import { BusinessIdentity } from './BusinessIdentity';
import { AddToCalendar } from './AddToCalendar';
import { hasStarted } from '../appointments/appointmentStatus';
import { useLanguage } from '@/i18n/LanguageContext';
import { LANGUAGES, isLanguage } from '@/i18n/messages';
import { longDate } from '@/i18n/format';

// A booking reference on its own grants nothing. Customers either open the signed link from their booking email
// (#token=…), arrive from the confirmation page with a token, or enter their reference plus the email they booked
// with. The token is kept for this browser tab only, so a reload does not ask again.

const TOKEN_KEY = 'we360_manage_token';

function readStoredToken(): string | null {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function storeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable: the token simply lives in memory */ }
}

interface ApiSlot {
  start: string;
  end: string;
  available: boolean;
}

const VIEW_TITLES = {
  loading: 'Your booking', lookup: 'Manage your booking', details: 'Your booking',
  reschedule: 'Reschedule your booking', cancelled: 'Booking cancelled',
} as const;

function SlotGrid({ slots, selected, onSelect }: { slots: ApiSlot[]; selected?: string; onSelect: (t: string) => void }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {slots.map(slot => (
        <button key={slot.start} type="button" disabled={!slot.available} onClick={() => slot.available && onSelect(slot.start)}
          aria-pressed={selected === slot.start}
          aria-label={slot.available ? `${formatTime(slot.start)} to ${formatTime(slot.end)}` : `${formatTime(slot.start)}, unavailable`}
          className={cn(
            'py-2.5 rounded-lg text-sm font-medium border-2 transition-all text-center',
            !slot.available && 'border-transparent bg-muted text-text-muted opacity-50 cursor-not-allowed',
            slot.available && selected === slot.start && 'border-primary bg-primary text-white',
            slot.available && selected !== slot.start && 'border-border bg-surface text-text-primary hover:border-primary/50',
          )}>
          {slot.available ? formatTime(slot.start) : '—'}
        </button>
      ))}
    </div>
  );
}

export default function ManageBooking() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { t, lang, setLang } = useLanguage();

  const [refInput, setRefInput] = useState((searchParams.get('ref') ?? '').toUpperCase());
  const [emailInput, setEmailInput] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [appointment, setAppointment] = useState<ManagedBooking | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [sendingLink, setSendingLink] = useState(false);
  const [view, setView] = useState<'loading' | 'lookup' | 'details' | 'reschedule' | 'cancelled'>('loading');

  const [newDate, setNewDate] = useState<string | undefined>();
  const [newSlot, setNewSlot] = useState<string | undefined>();
  const [slotError, setSlotError] = useState<string | null>(null);
  const [slots, setSlots] = useState<ApiSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);

  const [showCancel, setShowCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);

  // Once the booking is known, the business it is with leads the tab title.
  usePageTitle(businessPageTitle(appointment?.business.name, VIEW_TITLES[view]), { raw: true });

  /** The token stopped working (expired or the booking's email changed): go back to the lookup form. */
  const endAccess = useCallback((message: string) => {
    storeToken(null);
    setToken(null);
    setAppointment(null);
    setLookupError(message);
    setView('lookup');
  }, []);

  // Pick up a token from the email link, the confirmation page, or this tab's storage.
  useEffect(() => {
    const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
    const fromState = (location.state as { manageToken?: string } | null)?.manageToken;
    const initial = fromHash || fromState || readStoredToken();
    if (fromHash) {
      // Take the token out of the address bar so it is not left in history or shared by copying the URL.
      navigate(`${location.pathname}${location.search}`, { replace: true });
    }
    if (!initial) { setView('lookup'); return; }
    let cancelled = false;
    publicApi.getManaged(initial)
      .then(found => {
        if (cancelled) return;
        storeToken(initial);
        setToken(initial);
        setAppointment(found);
        setRefInput(found.bookingRef);
        setView('details');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        endAccess(e instanceof ApiError && e.status === 401 ? e.message : 'We could not load your booking. Please look it up with your reference and email.');
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!newDate || !appointment || !token) return;
    setLoadingSlots(true);
    setSlots([]);
    setNewSlot(undefined);
    publicApi.availability({
      date: newDate,
      serviceId: appointment.serviceId,
      staffId: appointment.staffId,
    }, token).then(data => {
      setSlotError(null);
      setSlots(data as ApiSlot[]);
    }).catch((e: Error) => {
      setSlots([]);
      if (e instanceof ApiError && e.status === 401) { endAccess(e.message); return; }
      setSlotError(e.message || 'Could not load available times');
    }).finally(() => {
      setLoadingSlots(false);
    });
  }, [newDate, appointment?.serviceId, appointment?.staffId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    const ref = refInput.trim().toUpperCase();
    const email = emailInput.trim();
    if (!ref || !email) { setLookupError(t('manage.bothRequired')); return; }
    setLooking(true);
    setLookupError(null);
    try {
      const result = await publicApi.lookup(ref, email);
      storeToken(result.token);
      setToken(result.token);
      setAppointment(result.appointment);
      setView('details');
    } catch (err) {
      setLookupError((err as Error).message || 'We could not look up that booking. Please try again.');
    } finally {
      setLooking(false);
    }
  }

  /** Emails a fresh manage link to the address on the booking (for when the confirmation email is lost). */
  async function handleSendLink() {
    const ref = refInput.trim().toUpperCase();
    const email = emailInput.trim();
    if (!ref || !email) { setLinkNote(null); setLookupError(t('manage.bothRequired')); return; }
    setSendingLink(true);
    setLookupError(null);
    setLinkNote(null);
    try {
      setLinkNote((await publicApi.sendManageLink(ref, email)).message);
    } catch (err) {
      setLookupError((err as Error).message || 'We could not send the link. Please try again.');
    } finally {
      setSendingLink(false);
    }
  }

  async function handleCancel() {
    if (!appointment || !token) return;
    setCancelling(true);
    try {
      const result = await publicApi.cancel(token) as { email?: { status: EmailStatus } };
      setAppointment(prev => prev ? { ...prev, status: 'cancelled' } : null);
      setView('cancelled');
      const note = customerEmailMessage('cancellation', result.email?.status, appointment.maskedEmail);
      toast.success('Booking cancelled', note?.text ?? 'Your appointment has been cancelled.');
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) endAccess(e.message);
      else toast.error('Failed to cancel', (e as Error).message);
    } finally {
      setCancelling(false);
      setShowCancel(false);
    }
  }

  async function handleReschedule() {
    if (!newDate || !newSlot || !appointment || !token) return;
    setRescheduling(true);
    try {
      const result = await publicApi.reschedule(token, { date: newDate, startTime: newSlot }) as { endTime: string; email?: { status: EmailStatus } };
      setAppointment(prev => prev ? { ...prev, date: newDate, startTime: newSlot, endTime: result.endTime, status: 'scheduled' } : null);
      setView('details');
      setNewDate(undefined);
      setNewSlot(undefined);
      setSlots([]);
      const note = customerEmailMessage('reschedule', result.email?.status, appointment.maskedEmail);
      toast.success('Booking rescheduled', `Moved to ${formatDate(newDate, 'MMM d')} at ${formatTime(newSlot)}.${note ? ` ${note.text}` : ''}`);
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 401) endAccess(e.message);
      else toast.error('Reschedule failed', (e as Error).message);
    } finally {
      setRescheduling(false);
    }
  }

  if (view === 'loading') {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center text-sm text-text-muted" role="status">{t('manage.loading')}</div>
    );
  }

  if (view === 'lookup') {
    return (
      <div className="max-w-lg mx-auto px-4 py-12">
        <div className="flex justify-end mb-2">
          <label className="text-xs text-text-muted flex items-center gap-1.5">
            <span className="sr-only">{t('language.label')}</span>
            <select value={lang} onChange={e => isLanguage(e.target.value) && setLang(e.target.value)} data-language-switch
              className="rounded-lg border border-border bg-surface text-text-primary text-xs px-2 py-1.5">
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
            </select>
          </label>
        </div>
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-text-primary">{t('manage.title')}</h1>
          <p className="text-sm text-text-secondary mt-2">{t('manage.subtitle')}</p>
        </div>
        <form onSubmit={handleLookup} className="bg-surface rounded-xl border border-border shadow-card p-6 mb-6 space-y-4" noValidate>
          <div>
            <label htmlFor="manage-ref" className="block text-sm font-medium text-text-primary mb-2">{t('manage.ref')}</label>
            <input
              id="manage-ref"
              type="text"
              value={refInput}
              onChange={e => setRefInput(e.target.value.toUpperCase())}
              placeholder="WE-XXXXXXXX"
              autoComplete="off"
              className="w-full px-3 py-2.5 rounded-lg border border-border text-sm bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary transition-colors font-mono"
            />
          </div>
          <div>
            <label htmlFor="manage-email" className="block text-sm font-medium text-text-primary mb-2">{t('manage.email')}</label>
            <input
              id="manage-email"
              type="email"
              value={emailInput}
              onChange={e => setEmailInput(e.target.value)}
              placeholder={t('manage.emailPlaceholder')}
              autoComplete="email"
              className="w-full px-3 py-2.5 rounded-lg border border-border text-sm bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary transition-colors"
            />
          </div>
          {lookupError && <p role="alert" className="text-sm text-red-600">{lookupError}</p>}
          {linkNote && <p role="status" className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">{linkNote}</p>}
          <button
            type="submit"
            disabled={looking}
            className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-semibold transition-colors disabled:opacity-60"
          >
            <Search className="w-4 h-4" />
            {looking ? t('manage.finding') : t('manage.find')}
          </button>
          <p className="text-xs text-text-muted flex items-start gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {t('manage.whereToFind')}
          </p>
          <button
            type="button"
            onClick={handleSendLink}
            disabled={sendingLink}
            className="w-full text-sm font-medium text-primary hover:underline disabled:opacity-60"
          >
            {sendingLink ? t('manage.sending') : t('manage.sendLink')}
          </button>
        </form>
        <HelpSection />
      </div>
    );
  }

  if (view === 'cancelled') {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        {appointment && <BusinessIdentity name={appointment.business.name} className="justify-center mb-8" />}
        <div className="w-20 h-20 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-5">
          <Check className="w-10 h-10 text-emerald-600" />
        </div>
        <h1 className="text-2xl font-bold text-text-primary mb-2">{t('manage.cancelledTitle')}</h1>
        <p className="text-text-secondary text-sm">{t('manage.cancelledText')}</p>
        <Link
          to={slug === 'lookup' ? '/book' : `/book/${slug}`}
          className="mt-6 inline-flex items-center gap-1.5 bg-primary hover:bg-primary-dark text-white px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors"
        >
          {t('manage.bookNew')}
        </Link>
      </div>
    );
  }

  // The API's rule: customers can change a booking only while it is scheduled or confirmed and has not started.
  const isActive = appointment && (appointment.status === 'scheduled' || appointment.status === 'confirmed');
  const started = !!appointment && hasStarted(appointment);

  if (view === 'reschedule') {
    const morningSlots = slots.filter(s => s.start < '12:00');
    const afternoonSlots = slots.filter(s => s.start >= '12:00');

    return (
      <div className="max-w-lg mx-auto px-4 py-8">
        {appointment && <BusinessIdentity name={appointment.business.name} className="mb-6" />}
        <button onClick={() => setView('details')} className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary mb-6 transition-colors">
          <ChevronLeft className="w-4 h-4" /> Back to booking
        </button>
        <h1 className="text-xl font-bold text-text-primary mb-5">Reschedule Appointment</h1>

        <div className="mb-4">
          <p className="text-sm font-medium text-text-primary mb-3">Select a new date</p>
          {appointment && token && (
            <AvailabilityCalendar
              serviceId={appointment.serviceId}
              staffId={appointment.staffId}
              timeZone={appointment.timezone}
              manageToken={token}
              selected={newDate}
              onSelect={d => { setNewDate(d); setNewSlot(undefined); }}
            />
          )}
        </div>

        {newDate && (
          <div className="mb-6">
            <p className="text-sm font-medium text-text-primary mb-3">
              Available times on {formatDate(newDate, 'MMMM d')}
            </p>
            {loadingSlots ? (
              <p className="text-sm text-text-muted">Loading available times…</p>
            ) : slotError ? (
              <p role="alert" className="text-sm text-red-600">{slotError}</p>
            ) : !slots.some(sl => sl.available) ? (
              <p className="text-sm text-text-muted">No times are free on this date any more. Please choose another date.</p>
            ) : (
              <div className="space-y-4">
                {morningSlots.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Morning</p>
                    <SlotGrid slots={morningSlots} selected={newSlot} onSelect={setNewSlot} />
                  </div>
                )}
                {afternoonSlots.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Afternoon</p>
                    <SlotGrid slots={afternoonSlots} selected={newSlot} onSelect={setNewSlot} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <button
          disabled={!newDate || !newSlot || rescheduling}
          onClick={handleReschedule}
          className={cn('w-full py-3 rounded-lg text-sm font-semibold transition-colors',
            newDate && newSlot && !rescheduling ? 'bg-primary hover:bg-primary-dark text-white' : 'bg-muted text-text-muted cursor-not-allowed'
          )}
        >
          {rescheduling ? 'Confirming…' : 'Confirm Reschedule'}
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-8">
      {appointment && <BusinessIdentity name={appointment.business.name} className="mb-6" />}
      <h1 className="text-xl font-bold text-text-primary mb-1">{t('manage.details')}</h1>
      <p className="text-sm text-text-muted mb-5">
        {t('field.reference')}: <span className="font-mono font-bold text-text-primary">{appointment?.bookingRef}</span>
      </p>

      <div className="bg-surface rounded-xl border border-border shadow-card mb-5">
        <div className="flex items-center px-5 py-4 border-b border-border">
          {appointment && <StatusBadge status={appointment.status} />}
        </div>
        <div className="divide-y divide-border">
          {appointment && (
            <>
              <DetailRow icon={<Tag className="w-4 h-4" />} label={t('field.service')} value={appointment.serviceName} />
              <DetailRow icon={<Clock className="w-4 h-4" />} label={t('field.duration')} value={formatDuration(appointment.duration)} />
              <DetailRow icon={<Banknote className="w-4 h-4" />} label={t('field.price')} value={formatCurrency(appointment.price, appointment.currency)} />
              <DetailRow icon={<Calendar className="w-4 h-4" />} label={t('field.date')} value={longDate(appointment.date, lang)} />
              <DetailRow icon={<Clock className="w-4 h-4" />} label={t('field.time')} value={`${formatTime(appointment.startTime)} – ${formatTime(appointment.endTime)}`} />
              {appointment.staffName && (
                <div className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-2 text-sm text-text-secondary">
                    <User className="w-4 h-4 text-text-muted" />
                    <span>{t('field.provider')}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Avatar name={appointment.staffName} size="xs" />
                    <span className="text-sm font-medium text-text-primary">{appointment.staffName}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {appointment && isActive && !started && token && (
        <AddToCalendar manageToken={token} event={{
          title: `${appointment.serviceName} — ${appointment.business.name}`,
          details: [`Booking reference: ${appointment.bookingRef}`, appointment.staffName ? `With: ${appointment.staffName}` : ''].filter(Boolean).join('\n'),
          location: appointment.location || undefined,
          date: appointment.date, start: appointment.startTime, end: appointment.endTime,
          timeZone: appointment.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        }} />
      )}

      {isActive && started ? (
        <p className="mb-8 text-sm text-text-secondary bg-muted rounded-lg p-3">
          {t('manage.started')}
        </p>
      ) : isActive ? (
        <div className="flex flex-col gap-2 mb-8">
          <button
            onClick={() => setView('reschedule')}
            className="w-full py-3 rounded-lg border-2 border-primary text-primary text-sm font-semibold hover:bg-primary-light transition-colors flex items-center justify-center gap-2"
          >
            <Calendar className="w-4 h-4" /> {t('manage.reschedule')}
          </button>
          <button
            onClick={() => setShowCancel(true)}
            className="w-full py-3 rounded-lg border-2 border-red-200 text-red-600 text-sm font-semibold hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" /> {t('manage.cancel')}
          </button>
        </div>
      ) : (
        <div className="mb-8">
          <Link
            to={slug === 'lookup' ? '/book' : `/book/${slug}`}
            className="block w-full text-center py-3 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-semibold transition-colors"
          >
            {t('manage.bookNew')}
          </Link>
        </div>
      )}

      <HelpSection business={appointment?.business} />

      <ConfirmModal
        isOpen={showCancel}
        onClose={() => setShowCancel(false)}
        onConfirm={handleCancel}
        title="Cancel Booking"
        message={`Are you sure you want to cancel your${appointment ? ` ${appointment.serviceName}` : ''} appointment${appointment ? ` on ${formatDate(appointment.date, 'MMMM d')}` : ''}? This action cannot be undone.`}
        confirmLabel="Yes, cancel booking"
        cancelLabel="Keep booking"
        variant="danger"
        loading={cancelling}
      />
    </div>
  );
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <span className="text-text-muted">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-medium text-text-primary">{value}</span>
    </div>
  );
}

function HelpSection({ business }: { business?: ManagedBooking['business'] }) {
  const { t } = useLanguage();
  return (
    <div className="bg-muted rounded-xl p-4 flex items-start gap-3">
      <HelpCircle className="w-5 h-5 text-text-muted shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-medium text-text-secondary">{t('manage.help')}</p>
        <p className="text-sm text-text-muted mt-0.5">
          {business ? (
            <>
              Contact <span className="text-text-primary font-medium">{business.name}</span>
              {business.phone ? <> at <span className="text-text-primary font-medium select-all">{business.phone}</span></> : null}
              {' '}about this booking.
            </>
          ) : (
            t('manage.helpGeneric')
          )}
        </p>
      </div>
    </div>
  );
}
