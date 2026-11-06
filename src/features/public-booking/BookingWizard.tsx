import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Check, ChevronLeft, ChevronRight, Clock, User } from 'lucide-react';
import { publicApi } from '@/api/client';
import { AvailabilityCalendar } from './AvailabilityCalendar';
import type { EmailStatus } from '@/lib/emailStatus';
import { formatTime, formatDuration, formatCurrency, cn } from '@/lib/utils';
import { Avatar, Spinner } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';
import { businessPageTitle, pageTitle } from '@/lib/brand';
import { HEX, themeCss } from './businessTheme';
import { availabilityStaffId } from './staffChoice';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';
import { layoutFor, type StepStyle } from './layouts';
import { useLanguage } from '@/i18n/LanguageContext';
import { LANGUAGES, isLanguage, type MessageKey } from '@/i18n/messages';
import { longDate, shortDate } from '@/i18n/format';

// ─── Local types (match public API response shapes) ───────────────────────────

interface PageService {
  id: string;
  name: string;
  description: string;
  duration: number;
  price: number;
  currency: string;
  color: string;
  category: string;
}

interface PageStaff {
  id: string;
  name: string;
  title?: string;
  bio?: string;
  color: string;
  photoUrl?: string | null;
}

interface PageField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox' | 'phone' | 'email';
  required: boolean;
}

interface PageTheme {
  primaryColor?: string;
  backgroundColor?: string;
  fontFamily?: string;
  buttonText?: string;
  headerText?: string;
  footerText?: string;
  showLogo?: boolean;
  showStaffPhoto?: boolean;
  layout?: string;
}

interface PageData {
  id: string;
  title: string;
  description?: string;
  slug: string;
  orgName: string;
  logoUrl?: string | null;
  language?: string;
  timezone: string;
  services: PageService[];
  theme?: PageTheme;
  formFields?: PageField[];
  requirePhone?: boolean;
  /** Channels the business sends customers messages on; the form asks for consent for each (unticked). */
  messaging?: { sms: boolean; whatsapp: boolean };
}

const FONTS = new Set(['Inter', 'Roboto', 'Open Sans', 'Lato']);

interface Slot {
  start: string;
  end: string;
  available: boolean;
}

interface WizardState {
  step: number;
  selectedService?: PageService;
  selectedStaff?: PageStaff;
  selectedDate?: string;
  selectedSlot?: string;
  selectedSlotEnd?: string;
  customerInfo?: { name: string; email: string; phone: string };
  answers: Record<string, string>;
  /** The customer's own choice; nothing is ticked for them. */
  consent: { sms: boolean; whatsapp: boolean };
  serviceStaff: PageStaff[];
  staffLoading: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STEP_KEYS: MessageKey[] = ['step.service', 'step.staff', 'step.date', 'step.time', 'step.info', 'step.review'];
const INPUT_CLS = 'w-full px-3 py-2.5 rounded-lg border border-border text-sm bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/25 focus:border-primary transition-colors';
const INVALID_CLS = 'border-red-500 focus:ring-red-500/25 focus:border-red-500';

/** The error for a custom question of type email or phone ('' when valid or empty). */
function answerError(field: PageField, value: string): string {
  if (field.type === 'email') return emailError(value);
  if (field.type === 'phone') return phoneError(value);
  return '';
}

/** Up to two initials of the business name, e.g. "Green Leaf Spa" → "GL". */
function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(w => /\p{L}|\p{N}/u.test(w));
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '').slice(0, 2)).toUpperCase() || '·';
}

/** The business's logo, or its monogram when there is no logo (or it fails to load). Decorative: the name is shown beside it. */
function BusinessMark({ name, logoUrl }: { name: string; logoUrl?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (logoUrl && !failed) {
    return (
      <img src={logoUrl} alt="" aria-hidden="true" onError={() => setFailed(true)}
        className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl object-contain bg-white border border-border shrink-0" />
    );
  }
  return (
    <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center text-white font-bold text-base shrink-0 bg-primary tracking-wide" aria-hidden="true">
      {monogram(name)}
    </div>
  );
}

function FieldError({ id, message }: { id: string; message: string }) {
  return message ? <p id={id} className="mt-1.5 text-xs text-red-600" role="alert">{message}</p> : null;
}

// ─── Step Indicator ───────────────────────────────────────────────────────────

function StepIndicator({ step, variant = 'circles' }: { step: number; variant?: StepStyle }) {
  const { t } = useLanguage();
  const STEP_LABELS = STEP_KEYS.map(k => t(k));
  const label = STEP_LABELS[step - 1];
  const progress = t('step.progress', { step, total: STEP_LABELS.length });
  if (variant === 'text') {
    return (
      <p className="text-sm text-text-muted mb-4" aria-live="polite">
        {progress} · <span className="font-medium text-text-primary">{label}</span>
      </p>
    );
  }
  if (variant === 'bar') {
    return (
      <div className="mb-8">
        <div className="flex justify-between text-xs mb-2">
          <span className="font-semibold text-primary">{label}</span>
          <span className="text-text-muted">{progress}</span>
        </div>
        <div className="flex gap-1.5" role="progressbar" aria-label={t('step.progressLabel')} aria-valuemin={1} aria-valuemax={STEP_LABELS.length}
          aria-valuenow={step} aria-valuetext={`${progress}: ${label}`}>
          {STEP_LABELS.map((l, i) => <div key={l} className={cn('h-1.5 flex-1 rounded-full', i < step ? 'bg-primary' : 'bg-muted')} />)}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center mb-8 gap-0 overflow-x-auto pb-1">
      {STEP_LABELS.map((label, i) => (
        <React.Fragment key={label}>
          <div className="flex flex-col items-center shrink-0 px-1">
            <div className={cn(
              'w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all',
              i + 1 < step && 'bg-primary text-white',
              i + 1 === step && 'bg-primary text-white ring-4 ring-primary/20',
              i + 1 > step && 'bg-muted text-text-muted',
            )}>
              {i + 1 < step ? <Check className="w-3.5 h-3.5" /> : i + 1}
            </div>
            <span className={cn('text-xs mt-1 whitespace-nowrap', i + 1 === step ? 'text-primary font-semibold' : 'text-text-muted')}>
              {label}
            </span>
          </div>
          {i < STEP_LABELS.length - 1 && (
            <div className={cn('h-px w-6 sm:w-10 mb-5 shrink-0 transition-colors', i + 1 < step ? 'bg-primary' : 'bg-border')} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Step 1: Service ──────────────────────────────────────────────────────────

function ServiceStep({ services, selected, onSelect }: { services: PageService[]; selected?: PageService; onSelect: (s: PageService) => void }) {
  const { t } = useLanguage();
  const catColor: Record<string, string> = {
    consultation: 'bg-blue-50 text-blue-700', treatment: 'bg-amber-50 text-amber-700',
    class: 'bg-red-50 text-red-700', meeting: 'bg-purple-50 text-purple-700', other: 'bg-muted text-text-muted',
    workshop: 'bg-green-50 text-green-700', session: 'bg-teal-50 text-teal-700',
    tour: 'bg-orange-50 text-orange-700', rental: 'bg-indigo-50 text-indigo-700',
  };
  return (
    <div>
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('service.title')}</h2>
      <p className="text-sm text-text-secondary mb-5">{t('service.subtitle')}</p>
      {services.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-8">{t('service.none')}</p>
      ) : (
        <div className="space-y-3">
          {services.map(svc => (
            <button key={svc.id} onClick={() => onSelect(svc)}
              className={cn('w-full text-left p-4 rounded-xl border-2 transition-all bg-surface',
                selected?.id === svc.id ? 'border-primary bg-primary-light' : 'border-border hover:border-primary/40')}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: svc.color }} />
                    <span className="font-semibold text-text-primary text-sm">{svc.name}</span>
                    <span className={cn('text-xs px-2 py-0.5 rounded-full font-medium capitalize', catColor[svc.category] ?? catColor.other)}>
                      {svc.category}
                    </span>
                  </div>
                  {svc.description && <p className="text-xs text-text-secondary line-clamp-2">{svc.description}</p>}
                  <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(svc.duration)}</span>
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="font-bold text-text-primary text-base">{formatCurrency(svc.price, svc.currency)}</p>
                  {selected?.id === svc.id && <Check className="w-4 h-4 text-primary ml-auto mt-1" />}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Step 2: Staff ────────────────────────────────────────────────────────────

function StaffStep({ staffList, loading, selected, onSelect, showPhotos }: {
  staffList: PageStaff[];
  loading: boolean;
  showPhotos: boolean;
  selected?: PageStaff;
  onSelect: (s?: PageStaff) => void;
}) {
  const { t } = useLanguage();
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }
  return (
    <div>
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('staff.title')}</h2>
      <p className="text-sm text-text-secondary mb-5">{t('staff.subtitle')}</p>
      <div className="space-y-3">
        <button onClick={() => onSelect(undefined)}
          className={cn('w-full text-left p-4 rounded-xl border-2 transition-all flex items-center gap-3 bg-surface',
            selected === undefined ? 'border-primary bg-primary-light' : 'border-border hover:border-primary/40')}>
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
            <User className="w-5 h-5 text-text-muted" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-text-primary text-sm">{t('staff.any')}</p>
            <p className="text-xs text-text-secondary">{t('staff.anyHint')}</p>
          </div>
          {selected === undefined && <Check className="w-4 h-4 text-primary shrink-0" />}
        </button>
        {staffList.map(s => (
          <button key={s.id} onClick={() => onSelect(s)}
            className={cn('w-full text-left p-4 rounded-xl border-2 transition-all flex items-center gap-3 bg-surface',
              selected?.id === s.id ? 'border-primary bg-primary-light' : 'border-border hover:border-primary/40')}>
            <Avatar name={s.name} src={showPhotos && s.photoUrl ? s.photoUrl : undefined} color={s.color} size="md" decorative />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-text-primary text-sm">{s.name}</p>
              {s.title && <p className="text-xs text-text-secondary">{s.title}</p>}
            </div>
            {selected?.id === s.id && <Check className="w-4 h-4 text-primary shrink-0" />}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Step 3: Date ─────────────────────────────────────────────────────────────

function DateStep({ serviceId, staffId, timeZone, selected, onSelect }: {
  serviceId: string;
  staffId: string;
  timeZone?: string;
  selected?: string;
  onSelect: (d: string) => void;
}) {
  const { t } = useLanguage();
  return (
    <div>
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('date.title')}</h2>
      <p className="text-sm text-text-secondary mb-5">{t('date.subtitle')}</p>
      <AvailabilityCalendar serviceId={serviceId} staffId={staffId} timeZone={timeZone} selected={selected} onSelect={onSelect} />
    </div>
  );
}

// ─── Step 4: Time ─────────────────────────────────────────────────────────────

function TimeStep({ date, serviceId, staffId, selected, onSelect, timeZone }: {
  date: string;
  serviceId: string;
  staffId?: string;
  selected?: string;
  onSelect: (slot: Slot) => void;
  timeZone?: string;
}) {
  const { t, lang } = useLanguage();
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serviceId || !staffId) {
      setSlots([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    publicApi.availability({ date, serviceId, staffId })
      .then(data => {
        setSlots(data as Slot[]);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message ?? '');
        setLoading(false);
      });
  }, [date, serviceId, staffId]);

  const morning   = slots.filter(s => s.start < '12:00');
  const afternoon = slots.filter(s => s.start >= '12:00');

  function SlotGrid({ items }: { items: Slot[] }) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {items.map(slot => (
          <button key={slot.start} type="button" disabled={!slot.available} onClick={() => slot.available && onSelect(slot)}
            aria-pressed={selected === slot.start}
            aria-label={slot.available ? t('time.slotLabel', { start: formatTime(slot.start), end: formatTime(slot.end) }) : t('time.slotUnavailable', { start: formatTime(slot.start) })}
            className={cn(
              'py-2.5 rounded-lg text-sm font-medium border-2 transition-all text-center',
              !slot.available && 'border-transparent bg-muted text-text-muted opacity-50 cursor-not-allowed',
              slot.available && selected === slot.start && 'border-primary bg-primary text-white',
              slot.available && selected !== slot.start && 'border-border bg-surface text-text-primary hover:border-primary/50',
            )}>
            {slot.available ? formatTime(slot.start) : <span className="text-xs">{t('time.unavailable')}</span>}
          </button>
        ))}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-red-600 mb-2">{error || t('time.loadFailed')}</p>
        <p className="text-xs text-text-muted">{t('time.tryOther')}</p>
      </div>
    );
  }

  const available = slots.filter(s => s.available);
  if (available.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-text-secondary mb-1">{t('time.noneLeft', { date: shortDate(date, lang) })}</p>
        <p className="text-xs text-text-muted">{t('time.noneLeftHint')}</p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('time.title')}</h2>
      <p className="text-sm text-text-secondary mb-5">
        {t('time.subtitle', { date: shortDate(date, lang) })}{timeZone ? ` (${timeZone})` : ''}
      </p>
      <div className="space-y-5">
        {morning.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t('time.morning')}</p>
            <SlotGrid items={morning} />
          </div>
        )}
        {afternoon.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t('time.afternoon')}</p>
            <SlotGrid items={afternoon} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 5: Details ──────────────────────────────────────────────────────────

function SummaryLine({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <p className={cn('text-text-primary', bold ? 'font-bold text-primary text-base' : 'font-medium')}>{value}</p>
    </div>
  );
}

function DetailsStep({ state, onChange, service, fields, requirePhone, onAnswer, messaging, onConsent }: {
  state: WizardState;
  onChange: (k: 'name' | 'email' | 'phone', v: string) => void;
  service: PageService;
  fields: PageField[];
  requirePhone: boolean;
  onAnswer: (id: string, v: string) => void;
  messaging: { sms: boolean; whatsapp: boolean };
  onConsent: (channel: 'sms' | 'whatsapp', v: boolean) => void;
}) {
  const { t, lang } = useLanguage();
  const ci = state.customerInfo ?? { name: '', email: '', phone: '' };
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const leave = (k: string) => setTouched(tt => (tt[k] ? tt : { ...tt, [k]: true }));
  // In Hindi the shared validation messages are replaced by their translations (same rule, same moment).
  const say = (msg: string, key: 'valid.email' | 'valid.phone') => (msg && lang !== 'en' ? t(key, { example: PHONE_PLACEHOLDER }) : msg);
  const nameMsg = touched.name && !ci.name.trim() ? t('info.nameRequired') : '';
  const emailMsg = touched.email ? (ci.email.trim() ? say(emailError(ci.email), 'valid.email') : t('info.emailRequired')) : '';
  const phoneMsg = touched.phone ? (ci.phone.trim() ? say(phoneError(ci.phone), 'valid.phone') : requirePhone ? t('info.phoneRequired') : '') : '';
  const aria = (id: string, msg: string) => ({ 'aria-invalid': msg ? true : undefined, 'aria-describedby': msg ? `${id}-error` : undefined });
  return (
    <div className="flex flex-col lg:flex-row gap-6">
      <div className="flex-1 space-y-3">
        <h2 className="text-xl font-bold text-text-primary mb-1">{t('info.title')}</h2>
        <div>
          <label htmlFor="bw-name" className="block text-sm font-medium text-text-primary mb-1.5">{t('info.name')} <span className="text-red-500">*</span></label>
          <input id="bw-name" type="text" autoComplete="name" value={ci.name} onChange={e => onChange('name', e.target.value)} onBlur={() => leave('name')}
            placeholder={t('info.namePlaceholder')} className={cn(INPUT_CLS, nameMsg && INVALID_CLS)} {...aria('bw-name', nameMsg)} />
          <FieldError id="bw-name-error" message={nameMsg} />
        </div>
        <div>
          <label htmlFor="bw-email" className="block text-sm font-medium text-text-primary mb-1.5">{t('info.email')} <span className="text-red-500">*</span></label>
          <input id="bw-email" type="email" autoComplete="email" value={ci.email} onChange={e => onChange('email', e.target.value)} onBlur={() => leave('email')}
            placeholder="jane@example.com" className={cn(INPUT_CLS, emailMsg && INVALID_CLS)} {...aria('bw-email', emailMsg)} />
          <FieldError id="bw-email-error" message={emailMsg} />
        </div>
        <div>
          <label htmlFor="bw-phone" className="block text-sm font-medium text-text-primary mb-1.5">
            {t('info.phone')} {requirePhone ? <span className="text-red-500">*</span> : <span className="text-text-muted font-normal">{t('info.optional')}</span>}
          </label>
          <input id="bw-phone" type="tel" autoComplete="tel" value={ci.phone} onChange={e => onChange('phone', e.target.value)} onBlur={() => leave('phone')}
            placeholder={PHONE_PLACEHOLDER} className={cn(INPUT_CLS, phoneMsg && INVALID_CLS)} {...aria('bw-phone', phoneMsg)} />
          <FieldError id="bw-phone-error" message={phoneMsg} />
        </div>
        {fields.map(f => {
          const value = state.answers[f.id] ?? '';
          const id = `bw-q-${f.id}`;
          const label = (
            <label htmlFor={id} className="block text-sm font-medium text-text-primary mb-1.5">
              {f.label} {f.required && <span className="text-red-500">*</span>}
            </label>
          );
          if (f.type === 'checkbox') {
            return (
              <label key={f.id} htmlFor={id} className="flex items-center gap-2 text-sm text-text-primary">
                <input id={id} type="checkbox" checked={value === 'Yes'} onChange={e => onAnswer(f.id, e.target.checked ? 'Yes' : '')} />
                {f.label} {f.required && <span className="text-red-500">*</span>}
              </label>
            );
          }
          if (f.type === 'textarea') {
            return <div key={f.id}>{label}<textarea id={id} rows={3} maxLength={1000} value={value} onChange={e => onAnswer(f.id, e.target.value)} className={INPUT_CLS} /></div>;
          }
          const type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
          const msg = touched[id] ? say(answerError(f, value), f.type === 'phone' ? 'valid.phone' : 'valid.email') : '';
          return (
            <div key={f.id}>{label}
              <input id={id} type={type} maxLength={1000} value={value} onChange={e => onAnswer(f.id, e.target.value)} onBlur={() => leave(id)}
                placeholder={f.type === 'phone' ? PHONE_PLACEHOLDER : undefined} className={cn(INPUT_CLS, msg && INVALID_CLS)} {...aria(id, msg)} />
              <FieldError id={`${id}-error`} message={msg} />
            </div>
          );
        })}
        {(messaging.sms || messaging.whatsapp) && (
          <fieldset className="pt-2" data-consent>
            <legend className="text-sm font-medium text-text-primary mb-1.5">{t('consent.title')}</legend>
            <div className="space-y-1.5">
              {(['sms', 'whatsapp'] as const).filter(ch => messaging[ch]).map(ch => (
                <label key={ch} htmlFor={`bw-consent-${ch}`} className="flex items-center gap-2 text-sm text-text-primary">
                  <input id={`bw-consent-${ch}`} type="checkbox" className="w-4 h-4 accent-primary" checked={state.consent[ch]}
                    onChange={e => onConsent(ch, e.target.checked)} />
                  {t(ch === 'sms' ? 'consent.sms' : 'consent.whatsapp')}
                </label>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-1.5">{t('consent.hint')}</p>
            {(state.consent.sms || state.consent.whatsapp) && !ci.phone.trim() && <p className="text-xs text-amber-700 mt-1">{t('consent.needsPhone')}</p>}
          </fieldset>
        )}
      </div>
      {/* Summary sidebar */}
      <div className="lg:w-56 shrink-0">
        <div className="bg-primary-light rounded-xl border border-primary/20 p-4">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider mb-3">{t('info.summary')}</p>
          <div className="space-y-2.5 text-sm">
            <SummaryLine label={t('field.service')} value={service.name} />
            <SummaryLine label={t('field.duration')} value={formatDuration(service.duration)} />
            <SummaryLine label={t('field.price')} value={formatCurrency(service.price, service.currency)} bold />
            <p className="text-xs text-text-muted">{t('info.payDirectly')}</p>
            {state.selectedStaff && <SummaryLine label={t('field.provider')} value={state.selectedStaff.name} />}
            {state.selectedDate && <SummaryLine label={t('field.date')} value={shortDate(state.selectedDate, lang)} />}
            {state.selectedSlot && <SummaryLine label={t('field.time')} value={state.selectedSlotEnd ? `${formatTime(state.selectedSlot)} – ${formatTime(state.selectedSlotEnd)}` : formatTime(state.selectedSlot)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Step 6: Review ───────────────────────────────────────────────────────────

function ReviewStep({ state, fields }: { state: WizardState; fields: PageField[] }) {
  const { t, lang } = useLanguage();
  const { selectedService: svc, selectedStaff: staff, selectedDate: date, selectedSlot: slot, customerInfo: ci } = state;
  if (!svc || !ci) return null;
  const rows = [
    { key: 'service', label: t('field.service'), value: svc.name },
    { key: 'duration', label: t('field.duration'), value: formatDuration(svc.duration) },
    { key: 'price', label: t('field.price'), value: formatCurrency(svc.price, svc.currency) },
    { key: 'provider', label: t('field.provider'), value: staff?.name ?? t('staff.any') },
    { key: 'date', label: t('field.date'), value: date ? longDate(date, lang) : '' },
    { key: 'time', label: t('field.time'), value: slot ? (state.selectedSlotEnd ? `${formatTime(slot)} – ${formatTime(state.selectedSlotEnd)}` : formatTime(slot)) : '' },
    { key: 'name', label: t('field.name'), value: ci.name },
    { key: 'email', label: t('field.email'), value: ci.email },
    { key: 'phone', label: t('field.phone'), value: ci.phone },
    ...fields.map(f => ({ key: `q-${f.id}`, label: f.label, value: state.answers[f.id] ?? '' })),
  ].filter(r => r.value);

  return (
    <div>
      <h2 className="text-xl font-bold text-text-primary mb-1">{t('review.title')}</h2>
      <p className="text-sm text-text-secondary mb-5">{t('review.subtitle')}</p>
      <div className="bg-surface rounded-xl border border-border divide-y divide-border">
        {rows.map(row => (
          <div key={row.key} className="flex items-center justify-between px-4 py-3">
            <span className="text-sm text-text-muted">{row.label}</span>
            <span className={cn('text-sm font-medium text-text-primary max-w-[60%] text-right', row.key === 'price' && 'text-primary font-bold text-base')}>
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Wizard ──────────────────────────────────────────────────────────────

export default function BookingWizard() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { t, lang, setLang, setDefault } = useLanguage();

  const [pageData, setPageData] = useState<PageData | null>(null);
  const [pageLoading, setPageLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  const [state, setState] = useState<WizardState>({ step: 1, answers: {}, consent: { sms: false, whatsapp: false }, serviceStaff: [], staffLoading: false });
  const [submitting, setSubmitting] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  // Tab title: the business's own page heading and name first, the platform last.
  const heading = pageData ? (pageData.theme?.headerText?.trim() || pageData.title || pageData.orgName) : '';
  usePageTitle(pageData ? businessPageTitle(pageData.orgName, heading) : pageTitle('Book an appointment'), { raw: true });

  // Load booking page data on mount
  useEffect(() => {
    // The message is chosen when shown, in the current language (see below).
    if (!slug) { setPageError(''); setPageLoading(false); return; }
    publicApi.getPage(slug)
      .then(data => {
        setPageData(data as PageData);
        // The business's language, unless this visitor chose one before.
        const pageLanguage = (data as PageData).language;
        if (isLanguage(pageLanguage)) setDefault(pageLanguage);
      })
      .catch((e: Error) => { setPageError(e.message ?? ''); })
      .finally(() => setPageLoading(false));
  }, [slug, setDefault]);

  // Load staff when entering step 2
  useEffect(() => {
    if (state.step !== 2 || !state.selectedService) return;
    setState(prev => ({ ...prev, staffLoading: true }));
    publicApi.getServiceStaff(state.selectedService.id)
      .then(data => {
        const staff = data as PageStaff[];
        setState(prev => ({ ...prev, serviceStaff: staff, staffLoading: false }));
      })
      .catch((e: Error) => {
        setBookingError(`Could not load staff for this service: ${e.message}`);
        setState(prev => ({ ...prev, serviceStaff: [], staffLoading: false }));
      });
  // Reload staff only when the step or the chosen service (by id) changes.
  }, [state.step, state.selectedService?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-skip staff step when only 1 staff member available
  useEffect(() => {
    if (state.step === 2 && !state.staffLoading && state.serviceStaff.length === 1) {
      setState(prev => ({ ...prev, selectedStaff: prev.serviceStaff[0], step: 3 }));
    }
  }, [state.step, state.staffLoading, state.serviceStaff.length]);

  function updateCI(k: 'name' | 'email' | 'phone', v: string) {
    setState(prev => ({ ...prev, customerInfo: { name: '', email: '', phone: '', ...prev.customerInfo, [k]: v } }));
  }

  const fields = pageData?.formFields ?? [];
  const requirePhone = pageData?.requirePhone !== false;
  const missingAnswer = fields.find(f => f.required && !(state.answers[f.id] ?? '').trim());
  const invalidAnswer = fields.find(f => answerError(f, state.answers[f.id] ?? ''));

  /** A named provider, the only provider, or "any" (the server assigns whoever is free); never empty. */
  function effectiveStaffId(s: WizardState): string {
    return availabilityStaffId(s.selectedStaff, s.serviceStaff);
  }

  function canContinue(): boolean {
    const s = state;
    if (s.step === 1) return !!s.selectedService;
    // Past the staff step only once the service's staff are known and at least one offers it online.
    if (s.step === 2) return !s.staffLoading && s.serviceStaff.length > 0;
    if (s.step === 3) return !!s.selectedDate;
    if (s.step === 4) return !!s.selectedSlot;
    if (s.step === 5) {
      const ci = s.customerInfo;
      return !!(ci?.name.trim() && ci?.email.trim() && !emailError(ci.email) && (!requirePhone || ci?.phone.trim())
        && !phoneError(ci?.phone ?? '') && !missingAnswer && !invalidAnswer);
    }
    return true;
  }

  function continueBlockedReason(): string | null {
    const s = state;
    if (s.step === 1 && !s.selectedService) return t('block.service');
    if (s.step === 2 && s.staffLoading) return t('block.staffLoading');
    if (s.step === 2 && !s.serviceStaff.length) return t('block.noStaff');
    if (s.step === 3 && !s.selectedDate) return t('block.date');
    if (s.step === 4 && !s.selectedSlot) return t('block.time');
    if (s.step === 5) {
      const ci = s.customerInfo;
      if (!ci?.name.trim()) return t('block.name');
      if (!ci?.email.trim()) return t('block.email');
      if (emailError(ci.email)) return t('block.emailInvalid');
      if (requirePhone && !ci?.phone.trim()) return t('block.phone');
      if (phoneError(ci?.phone ?? '')) return t('block.phoneInvalid');
      if (missingAnswer) return t('block.answer', { label: missingAnswer.label });
      if (invalidAnswer) return t('block.answerInvalid', { label: invalidAnswer.label });
    }
    return null;
  }

  async function confirmBooking() {
    if (!state.selectedService || !state.selectedDate || !state.selectedSlot || !state.customerInfo) return;
    const staffId = effectiveStaffId(state);
    if (!state.serviceStaff.length) { setBookingError(t('booking.noStaff')); return; }

    setSubmitting(true);
    setBookingError(null);
    try {
      const result = await publicApi.book({
        pageSlug: slug,
        serviceId: state.selectedService.id,
        staffId,
        date: state.selectedDate,
        startTime: state.selectedSlot,
        customer: {
          name: state.customerInfo.name.trim(),
          email: state.customerInfo.email.trim(),
          phone: state.customerInfo.phone.trim() || undefined,
        },
        notes: '',
        // Sent only for the channels the form asked about; an unticked box is a "no".
        consent: pageData?.messaging && (pageData.messaging.sms || pageData.messaging.whatsapp)
          ? Object.fromEntries((['sms', 'whatsapp'] as const).filter(ch => pageData.messaging![ch]).map(ch => [ch, state.consent[ch] && !!state.customerInfo!.phone.trim()]))
          : undefined,
        customerAnswers: fields
          .filter(f => (state.answers[f.id] ?? '').trim())
          .map(f => ({ fieldId: f.id, answer: state.answers[f.id].trim() })),
      }) as { bookingRef: string; staffName?: string; endTime: string; email?: { status: EmailStatus }; manageToken?: string; messages?: Partial<Record<'sms' | 'whatsapp', 'sent' | 'queued' | 'not_sent'>> };

      navigate(`/book/${slug}/confirmation`, {
        state: {
          bookingRef: result.bookingRef,
          manageToken: result.manageToken,
          service: state.selectedService,
          staff: state.selectedStaff ?? (result.staffName ? { name: result.staffName } : undefined),
          date: state.selectedDate,
          slot: state.selectedSlot,
          endTime: result.endTime,
          emailStatus: result.email?.status,
          messages: result.messages,
          timezone: pageData?.timezone,
          customerInfo: state.customerInfo,
          workspace: undefined,
          // The business stays the identity on the confirmation page: its name, colour and "show logo" choice.
          businessName: pageData?.orgName,
          themeColor: pageData?.theme?.primaryColor,
          showLogo: pageData?.theme?.showLogo !== false,
        },
      });
    } catch (e) {
      setBookingError((e as Error).message || t('booking.failed'));
      setSubmitting(false);
    }
  }

  function renderStep() {
    const s = state;
    if (!pageData) return null;
    if (s.step === 1) return (
      <ServiceStep
        services={pageData.services}
        selected={s.selectedService}
        onSelect={svc => setState(prev => ({ ...prev, selectedService: svc }))}
      />
    );
    if (s.step === 2 && s.selectedService) return (
      <StaffStep
        staffList={s.serviceStaff}
        loading={s.staffLoading}
        showPhotos={pageData?.theme?.showStaffPhoto === true}
        selected={s.selectedStaff}
        onSelect={staff => setState(prev => ({ ...prev, selectedStaff: staff }))}
      />
    );
    if (s.step === 3 && s.selectedService) return (
      <DateStep
        serviceId={s.selectedService.id}
        staffId={effectiveStaffId(s)}
        timeZone={pageData.timezone}
        selected={s.selectedDate}
        onSelect={d => setState(prev => ({ ...prev, selectedDate: d, selectedSlot: undefined, selectedSlotEnd: undefined }))}
      />
    );
    if (s.step === 4 && s.selectedDate && s.selectedService) {
      const staffId = effectiveStaffId(s);
      return (
        <TimeStep
          date={s.selectedDate}
          serviceId={s.selectedService.id}
          staffId={staffId}
          selected={s.selectedSlot}
          onSelect={slot => setState(prev => ({ ...prev, selectedSlot: slot.start, selectedSlotEnd: slot.end }))}
          timeZone={pageData.timezone}
        />
      );
    }
    if (s.step === 5 && s.selectedService) return (
      <DetailsStep
        state={s}
        onChange={updateCI}
        service={s.selectedService}
        fields={fields}
        requirePhone={requirePhone}
        onAnswer={(id, v) => setState(prev => ({ ...prev, answers: { ...prev.answers, [id]: v } }))}
        messaging={pageData?.messaging ?? { sms: false, whatsapp: false }}
        onConsent={(ch, v) => setState(prev => ({ ...prev, consent: { ...prev.consent, [ch]: v } }))}
      />
    );
    if (s.step === 6) return <ReviewStep state={s} fields={fields} />;
    return null;
  }

  if (pageLoading) {
    return (
      <div className="flex justify-center items-center py-24">
        <Spinner />
      </div>
    );
  }

  if (pageError || !pageData) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <p className="text-text-secondary mb-4">{pageError || t('page.notFound')}</p>
        <button onClick={() => navigate('/book')} className="text-primary hover:underline text-sm font-medium">
          {t('page.findExisting')}
        </button>
      </div>
    );
  }

  const theme = pageData.theme ?? {};
  const css = themeCss(theme.primaryColor);
  const background = theme.backgroundColor && HEX.test(theme.backgroundColor) && theme.backgroundColor.toLowerCase() !== '#13222e'
    ? theme.backgroundColor : undefined;
  const font = theme.fontFamily && FONTS.has(theme.fontFamily) ? `'${theme.fontFamily}', system-ui, sans-serif` : undefined;
  const { name: layoutName, style: layout } = layoutFor(theme.layout);

  return (
    // The business's background fills the screen down to the 4rem "Powered by" credit at the foot of the page.
    <div className="booking-theme min-h-[calc(100dvh-4rem)]" style={{ backgroundColor: background, fontFamily: font }}>
    {css && <style>{css}</style>}
    <div className={layout.container} data-layout={layoutName}>
      {/* Page header */}
      <div className={layout.header}>
        {layout.showMark && theme.showLogo !== false && <BusinessMark name={pageData.orgName} logoUrl={pageData.logoUrl} />}
        <div className="min-w-0">
          <h1 className={layout.title}>{heading}</h1>
          <p className={layout.subtitle}>{pageData.orgName}</p>
          {pageData.description && <p className="text-sm text-text-secondary mt-1">{pageData.description}</p>}
        </div>
        <label className="ml-auto shrink-0 text-xs text-text-muted flex items-center gap-1.5">
          <span className="sr-only">{t('language.label')}</span>
          <select value={lang} onChange={e => isLanguage(e.target.value) && setLang(e.target.value)} data-language-switch
            className="rounded-lg border border-border bg-surface text-text-primary text-xs px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/25">
            {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
      </div>

      <StepIndicator step={state.step} variant={layout.steps} />

      {/* Step content */}
      <div className={layout.card}>
        {renderStep()}
      </div>

      {/* Booking error */}
      {bookingError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {bookingError}
        </div>
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={() => state.step > 1 ? setState(prev => ({ ...prev, step: prev.step - 1 })) : navigate('/book')}
          className={cn('flex items-center gap-1.5 px-4 py-2.5 border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-muted transition-colors', layout.button)}
        >
          <ChevronLeft className="w-4 h-4" aria-hidden="true" /> {t('nav.back')}
        </button>

        <div className="flex flex-col items-end gap-1">
          {!canContinue() && continueBlockedReason() && (
            <p className="text-xs text-amber-700 text-right" role="status" aria-live="polite">
              {continueBlockedReason()}
            </p>
          )}
          {state.step < 6 ? (
            <button
              disabled={!canContinue()}
              aria-disabled={!canContinue()}
              onClick={() => setState(prev => ({ ...prev, step: prev.step + 1 }))}
              className={cn('flex items-center gap-1.5 px-6 py-2.5 text-sm font-semibold transition-colors', layout.button,
                canContinue() ? 'bg-primary hover:bg-primary-dark text-white' : 'bg-muted text-text-muted cursor-not-allowed'
              )}
            >
              {t('nav.continue')} <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
          ) : (
            <button
              disabled={submitting || !canContinue()}
              aria-disabled={submitting || !canContinue()}
              onClick={confirmBooking}
              className={cn('flex items-center gap-2 px-6 py-2.5 text-sm font-semibold transition-colors', layout.button,
                !submitting && canContinue() ? 'bg-primary hover:bg-primary-dark text-white' : 'bg-muted text-text-muted cursor-not-allowed'
              )}
            >
              {submitting ? <Spinner /> : <Check className="w-4 h-4" aria-hidden="true" />}
              {theme.buttonText?.trim() || t('nav.confirm')}
            </button>
          )}
        </div>
      </div>

      {theme.footerText?.trim() && (
        <p className="mt-8 text-center text-xs text-text-muted">{theme.footerText}</p>
      )}
    </div>
    </div>
  );
}
