import React from 'react';
import { Link, useParams, useLocation } from 'react-router-dom';
import { CheckCircle, Calendar, Clock, MapPin, User, Banknote, Mail, Tag } from 'lucide-react';
import type { Service, Staff, Workspace } from '@/types';
import { formatDate, formatTime, formatCurrency, formatDuration } from '@/lib/utils';
import { customerEmailMessage, type EmailStatus } from '@/lib/emailStatus';
import { businessPageTitle } from '@/lib/brand';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useLanguage } from '@/i18n/LanguageContext';
import { BusinessIdentity } from './BusinessIdentity';
import { themeCss } from './businessTheme';
import { AddToCalendar } from './AddToCalendar';

interface ConfirmationState {
  /** The business booked with, its booking-page colour and "show logo" choice: the identity of this page. */
  businessName?: string;
  themeColor?: string;
  showLogo?: boolean;
  bookingRef: string;
  /** Lets the customer open "manage booking" right away without looking the booking up. */
  manageToken?: string;
  service: Service;
  staff?: Staff;
  date: string;
  slot: string;
  customerInfo: { name: string; email: string; phone: string };
  workspace?: Workspace;
  endTime?: string;
  emailStatus?: EmailStatus;
  /** The business's time zone: the booking's date and times are in it. */
  timezone?: string;
  /** Per channel the customer agreed to: sent, will be sent, or could not be sent. */
  messages?: Partial<Record<'sms' | 'whatsapp', 'sent' | 'queued' | 'not_sent'>>;
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-5 py-3">
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <span className="text-text-muted shrink-0">{icon}</span>
        <span>{label}</span>
      </div>
      <span className="text-sm font-medium text-text-primary text-right max-w-[55%]">{value}</span>
    </div>
  );
}

/** HH:MM plus minutes (wraps past midnight). */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function BookingConfirmation() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const { t } = useLanguage();
  const state = location.state as ConfirmationState | null;
  usePageTitle(businessPageTitle(state?.businessName, state?.bookingRef ? 'Booking confirmed' : 'Booking'), { raw: true });

  if (!state?.bookingRef) {
    return (
      <div className="max-w-lg mx-auto px-4 py-16 text-center">
        <p className="text-text-secondary mb-4">No booking information found.</p>
        <Link to={`/book/${slug}`} className="text-primary hover:underline text-sm font-medium">
          Start a new booking →
        </Link>
      </div>
    );
  }

  const { bookingRef, manageToken, service, staff, date, slot, customerInfo, workspace, endTime, emailStatus, businessName, themeColor, showLogo, timezone, messages } = state;
  const emailNote = customerEmailMessage('confirmation', emailStatus, customerInfo.email);
  const css = themeCss(themeColor);

  const end = endTime ?? addMinutes(slot, service.duration);
  const calendarEvent = {
    title: businessName ? `${service.name} — ${businessName}` : service.name,
    details: [`Booking reference: ${bookingRef}`, staff?.name ? `With: ${staff.name}` : '', 'To change or cancel, use the link in your confirmation email.'].filter(Boolean).join('\n'),
    location: workspace?.address,
    date, start: slot, end, timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const messageNotes = (['sms', 'whatsapp'] as const).filter(ch => messages?.[ch]).map(ch => ({ ch, status: messages![ch]! }));

  return (
    <div className="booking-theme max-w-lg mx-auto px-4 py-10">
      {css && <style>{css}</style>}
      {businessName && <BusinessIdentity name={businessName} showInitial={showLogo} className="justify-center mb-8" />}

      {/* Success hero */}
      <div className="flex flex-col items-center text-center mb-8">
        <div className="w-20 h-20 rounded-full bg-primary-light flex items-center justify-center mb-4">
          <CheckCircle className="w-10 h-10 text-primary" />
        </div>
        <h1 className="text-2xl font-bold text-text-primary">Booking Confirmed!</h1>
        <p className="text-text-secondary mt-1 text-sm">
          {businessName ? `Your appointment with ${businessName} has been scheduled.` : 'Your appointment has been successfully scheduled.'}
        </p>
        {emailNote && (
          <p role="status" className={`mt-3 text-sm px-3 py-2 rounded-lg ${emailNote.tone === 'success' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
            {emailNote.text}
          </p>
        )}
        {messageNotes.map(({ ch, status }) => (
          <p key={ch} role="status" data-message-status={ch} className={`mt-2 text-sm px-3 py-2 rounded-lg ${status === 'not_sent' ? 'bg-amber-50 text-amber-800' : 'bg-emerald-50 text-emerald-800'}`}>
            {t(`msg.${ch}.${status}` as const)}
          </p>
        ))}
      </div>

      {/* Booking reference */}
      <div className="bg-primary rounded-xl p-5 text-center mb-6">
        <p className="text-primary-light text-xs font-semibold uppercase tracking-widest mb-1.5">Booking Reference</p>
        <p className="text-white text-3xl font-bold tracking-widest">{bookingRef}</p>
      </div>

      {/* Details card */}
      <div className="bg-surface rounded-xl border border-border shadow-card divide-y divide-border mb-6">
        <Row icon={<Tag className="w-4 h-4" />} label="Service" value={service.name} />
        <Row icon={<Clock className="w-4 h-4" />} label="Duration" value={formatDuration(service.duration)} />
        <Row icon={<Calendar className="w-4 h-4" />} label="Date" value={formatDate(date, 'EEEE, MMMM d, yyyy')} />
        <Row icon={<Clock className="w-4 h-4" />} label="Time" value={endTime ? `${formatTime(slot)} – ${formatTime(endTime)}` : formatTime(slot)} />
        {staff && <Row icon={<User className="w-4 h-4" />} label="Provider" value={staff.name} />}
        {workspace?.address && <Row icon={<MapPin className="w-4 h-4" />} label="Location" value={workspace.address} />}
        <Row icon={<Banknote className="w-4 h-4" />} label="Price" value={`${formatCurrency(service.price, service.currency)} · pay the business directly`} />
        <Row icon={<User className="w-4 h-4" />} label="Name" value={customerInfo.name} />
        <Row icon={<Mail className="w-4 h-4" />} label="Email" value={customerInfo.email} />
      </div>

      <AddToCalendar event={calendarEvent} manageToken={manageToken} />

      {/* Actions */}
      <div className="flex flex-col gap-2 mb-6">
        <Link
          to={`/book/${slug}/manage?ref=${encodeURIComponent(bookingRef)}`}
          state={manageToken ? { manageToken } : undefined}
          className="w-full text-center py-2.5 px-4 rounded-lg border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-muted transition-colors"
        >
          Manage your booking
        </Link>
        <Link
          to={`/book/${slug}`}
          className="w-full text-center py-2.5 px-4 rounded-lg bg-primary hover:bg-primary-dark text-white text-sm font-semibold transition-colors"
        >
          Book another appointment
        </Link>
      </div>

      {/* Reference reminder */}
      <div className="flex items-center gap-2 text-xs text-text-muted bg-muted rounded-lg p-3">
        <Mail className="w-3.5 h-3.5 shrink-0" />
        <span>
          Save your booking reference <strong className="text-text-secondary">{bookingRef}</strong>. To manage or cancel later, use the link in your confirmation email, or this reference with your email address.
        </span>
      </div>
    </div>
  );
}
