import db from '../../db/init';
import { DEFAULT_TIMEZONE } from '../business-locale';
import { issueManageToken, emailLinkExpiry } from '../booking-access';
import { getPreferences, getTemplate, type BookingLanguage } from '../email/preferences';
import {
  renderAppointmentEmail, renderSimpleEmail, formatSlot, formatEmailDate, formatEmailTime, type AppointmentEmailData,
} from '../email/templates';
import type { NotificationEvent } from './types';

// What each recipient is told, per channel and language. Built from the appointment as it is stored now (the source
// of truth), never from what a request claimed. Customers never see staff contact details; staff and business
// recipients get the customer's name, not their contact details (those stay in the app).

export interface AppointmentInfo {
  id: string; organization_id: string; booking_ref: string; status: string; date: string; start_time: string; end_time: string;
  timezone: string; location: string | null; updated_at: string; customer_id: string; customer_name: string; customer_email: string;
  customer_phone: string | null; staff_id: string; staff_name: string; staff_email: string; staff_phone: string | null;
  service_name: string; org_name: string; time_format: string | null;
}

export function loadAppointmentInfo(appointmentId: string): AppointmentInfo | undefined {
  return db.prepare(
    `SELECT a.id, a.organization_id, a.booking_ref, a.status, a.date, a.start_time, a.end_time, COALESCE(a.timezone, o.timezone) AS timezone,
            a.location, a.updated_at, c.id AS customer_id, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
            st.id AS staff_id, st.name AS staff_name, st.email AS staff_email, st.phone AS staff_phone, s.name AS service_name,
            o.name AS org_name, o.time_format
     FROM appointments a JOIN customers c ON c.id = a.customer_id JOIN staff st ON st.id = a.staff_id
     JOIN services s ON s.id = a.service_id JOIN organizations o ON o.id = a.organization_id
     WHERE a.id = ?`
  ).get(appointmentId) as AppointmentInfo | undefined;
}

export function emailData(a: AppointmentInfo, appUrl: string, previous?: { date: string; startTime: string; endTime: string }): AppointmentEmailData {
  return {
    language: getPreferences(a.organization_id).bookingLanguage,
    businessName: a.org_name, customerName: a.customer_name, bookingRef: a.booking_ref, serviceName: a.service_name, staffName: a.staff_name,
    date: a.date, startTime: a.start_time, endTime: a.end_time, timezone: a.timezone || DEFAULT_TIMEZONE,
    timeFormat: a.time_format === '24h' ? '24h' : '12h', location: a.location ?? undefined,
    manageUrl: `${appUrl}/book/lookup/manage#token=${encodeURIComponent(issueManageToken(a.id, a.customer_email, emailLinkExpiry(a.date)))}`,
    previous,
  };
}

type Audience = 'customer' | 'team';
const STATUS_LABEL: Record<BookingLanguage, Record<string, string>> = {
  en: { scheduled: 'scheduled', confirmed: 'confirmed', completed: 'completed', cancelled: 'cancelled', no_show: 'a no-show' },
  hi: { scheduled: 'निर्धारित', confirmed: 'पुष्ट', completed: 'पूर्ण', cancelled: 'रद्द', no_show: 'नहीं आए' },
};

/** Which status-change messages make sense: customers hear only that the business confirmed their booking. */
export function statusChangeRelevant(audience: Audience, toStatus: string): boolean {
  return audience === 'customer' ? toStatus === 'confirmed' : ['confirmed', 'completed', 'no_show'].includes(toStatus);
}

// ─── SMS ─────────────────────────────────────────────────────────────────────

export function smsText(event: NotificationEvent, audience: Audience, a: AppointmentInfo, lang: BookingLanguage, recipientName: string): string {
  const d = { ...emailData(a, '') };
  const date = formatEmailDate(a.date, lang);
  const time = formatEmailTime(a.start_time, d.timeFormat);
  const status = STATUS_LABEL[lang][a.status] ?? a.status;
  if (lang === 'hi') {
    if (audience === 'customer') {
      const stop = ' बंद करने के लिए STOP लिखें।';
      switch (event) {
        case 'confirmed': return `${a.org_name}: आपकी ${a.service_name} बुकिंग ${date} ${time} के लिए पक्की है (${a.booking_ref}). बदलाव के लिए ईमेल का लिंक देखें।${stop}`;
        case 'rescheduled': return `${a.org_name}: आपकी ${a.service_name} बुकिंग (${a.booking_ref}) अब ${date} ${time} पर है।${stop}`;
        case 'cancelled': return `${a.org_name}: ${date} ${time} की आपकी ${a.service_name} बुकिंग (${a.booking_ref}) रद्द हो गई है।${stop}`;
        case 'reminder': return `${a.org_name}: याद दिलाना – ${a.service_name}, ${date} ${time} (${a.booking_ref}).${stop}`;
        default: return `${a.org_name}: आपकी बुकिंग ${a.booking_ref} (${date} ${time}) ${status} है।${stop}`;
      }
    }
    switch (event) {
      case 'confirmed': return `नई बुकिंग: ${a.service_name}, ${a.customer_name}, ${date} ${time} (${a.booking_ref})।`;
      case 'rescheduled': return `बुकिंग का समय बदला: ${a.service_name}, ${a.customer_name}, अब ${date} ${time} (${a.booking_ref})।`;
      case 'cancelled': return `बुकिंग रद्द: ${a.service_name}, ${a.customer_name}, ${date} ${time} (${a.booking_ref})।`;
      case 'reminder': return `याद दिलाना: ${a.service_name}, ${a.customer_name}, ${date} ${time} (${a.booking_ref})।`;
      default: return `बुकिंग ${a.booking_ref} (${a.customer_name}, ${date} ${time}) अब ${status} है।`;
    }
  }
  if (audience === 'customer') {
    const stop = ' Reply STOP to opt out.';
    switch (event) {
      case 'confirmed': return `${a.org_name}: your ${a.service_name} booking is confirmed for ${date}, ${time} (${a.booking_ref}). To change it, use the link in your email.${stop}`;
      case 'rescheduled': return `${a.org_name}: your ${a.service_name} booking (${a.booking_ref}) is now ${date}, ${time}.${stop}`;
      case 'cancelled': return `${a.org_name}: your ${a.service_name} booking on ${date}, ${time} (${a.booking_ref}) is cancelled.${stop}`;
      case 'reminder': return `${a.org_name}: reminder of your ${a.service_name} booking on ${date}, ${time} (${a.booking_ref}).${stop}`;
      default: return `${a.org_name}: your booking ${a.booking_ref} on ${date}, ${time} is ${status}.${stop}`;
    }
  }
  void recipientName;
  switch (event) {
    case 'confirmed': return `New booking: ${a.service_name} with ${a.customer_name}, ${date}, ${time} (${a.booking_ref}), staff ${a.staff_name}.`;
    case 'rescheduled': return `Booking moved: ${a.service_name} with ${a.customer_name} is now ${date}, ${time} (${a.booking_ref}).`;
    case 'cancelled': return `Booking cancelled: ${a.service_name} with ${a.customer_name}, ${date}, ${time} (${a.booking_ref}).`;
    case 'reminder': return `Reminder: ${a.service_name} with ${a.customer_name}, ${date}, ${time} (${a.booking_ref}).`;
    default: return `Booking ${a.booking_ref} (${a.customer_name}, ${date}, ${time}) is now ${status}.`;
  }
}

// ─── WhatsApp (approved templates; see docs/NOTIFICATIONS.md for the texts to submit for approval) ───────────────

export const WHATSAPP_TEMPLATES: Record<Audience, Record<NotificationEvent, { name: string; params: string[] }>> = {
  customer: {
    confirmed: { name: 'we360_booking_confirmed', params: ['customerName', 'serviceName', 'date', 'time', 'businessName', 'bookingRef'] },
    rescheduled: { name: 'we360_booking_rescheduled', params: ['customerName', 'serviceName', 'date', 'time', 'businessName', 'bookingRef'] },
    cancelled: { name: 'we360_booking_cancelled', params: ['customerName', 'serviceName', 'date', 'time', 'businessName', 'bookingRef'] },
    reminder: { name: 'we360_booking_reminder', params: ['customerName', 'serviceName', 'date', 'time', 'businessName', 'bookingRef'] },
    status_changed: { name: 'we360_booking_status', params: ['customerName', 'bookingRef', 'status', 'businessName'] },
  },
  team: {
    confirmed: { name: 'we360_team_booking_new', params: ['recipientName', 'serviceName', 'customerName', 'date', 'time', 'bookingRef'] },
    rescheduled: { name: 'we360_team_booking_moved', params: ['recipientName', 'serviceName', 'customerName', 'date', 'time', 'bookingRef'] },
    cancelled: { name: 'we360_team_booking_cancelled', params: ['recipientName', 'serviceName', 'customerName', 'date', 'time', 'bookingRef'] },
    reminder: { name: 'we360_team_booking_reminder', params: ['recipientName', 'serviceName', 'customerName', 'date', 'time', 'bookingRef'] },
    status_changed: { name: 'we360_team_booking_status', params: ['recipientName', 'bookingRef', 'status', 'customerName'] },
  },
};

/** WhatsApp template values may not contain new lines or tabs, nor more than four spaces in a row, and are limited in length. */
export function whatsappParam(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/ {5,}/g, '    ').trim().slice(0, 1000) || '-';
}

export function whatsappMessage(event: NotificationEvent, audience: Audience, a: AppointmentInfo, lang: BookingLanguage, recipientName: string,
  overrides: Record<string, string> = {}): { template: string; language: string; params: string[] } {
  const spec = WHATSAPP_TEMPLATES[audience][event];
  const timeFormat = a.time_format === '24h' ? '24h' : '12h';
  const values: Record<string, string> = {
    customerName: a.customer_name, serviceName: a.service_name, date: formatEmailDate(a.date, lang), time: formatEmailTime(a.start_time, timeFormat),
    businessName: a.org_name, bookingRef: a.booking_ref, status: STATUS_LABEL[lang][a.status] ?? a.status, recipientName,
  };
  return {
    template: overrides[`${audience}.${event}`] || spec.name,
    language: lang === 'hi' ? 'hi' : 'en',
    params: spec.params.map(p => whatsappParam(values[p] ?? '')),
  };
}

// ─── Email (customer reminders and status changes; staff and business notifications) ─────────────────────────────

export function customerEmail(event: NotificationEvent, a: AppointmentInfo, appUrl: string): { subject: string; text: string; html: string } {
  const d = emailData(a, appUrl);
  if (event === 'reminder') {
    const custom = getTemplate(a.organization_id, 'reminder');
    return renderAppointmentEmail('reminder', { ...d, custom: custom ? { subject: custom.subject, intro: custom.intro } : undefined });
  }
  const lang = d.language ?? 'en';
  return renderSimpleEmail({
    lang, businessName: a.org_name,
    subject: lang === 'hi' ? `बुकिंग पुष्ट: ${a.service_name} (${a.booking_ref})` : `Booking confirmed by ${a.org_name}: ${a.service_name} (${a.booking_ref})`,
    greeting: lang === 'hi' ? `नमस्ते ${a.customer_name},` : `Hi ${a.customer_name},`,
    intro: lang === 'hi' ? `${a.org_name} ने आपकी बुकिंग की पुष्टि कर दी है।` : `${a.org_name} has confirmed your booking.`,
    rows: [[lang === 'hi' ? 'संदर्भ संख्या' : 'Reference', a.booking_ref], [lang === 'hi' ? 'सेवा' : 'Service', a.service_name], [lang === 'hi' ? 'समय' : 'When', formatSlot(d)]],
    button: { url: d.manageUrl, label: lang === 'hi' ? 'बुकिंग देखें, समय बदलें या रद्द करें' : 'View, reschedule or cancel your booking' },
  });
}

export function teamEmail(event: NotificationEvent, a: AppointmentInfo, appUrl: string, recipientName: string,
  previous?: { date: string; startTime: string; endTime: string }): { subject: string; text: string; html: string } {
  const d = emailData(a, appUrl, previous);
  const lang = d.language ?? 'en';
  const hi = lang === 'hi';
  const titles: Record<NotificationEvent, [string, string, string, string]> = {
    confirmed: ['New booking', 'You have a new booking.', 'नई बुकिंग', 'एक नई बुकिंग है।'],
    rescheduled: ['Booking moved', 'A booking was moved to a new time.', 'बुकिंग का समय बदला', 'एक बुकिंग का समय बदल गया।'],
    cancelled: ['Booking cancelled', 'A booking was cancelled.', 'बुकिंग रद्द', 'एक बुकिंग रद्द हो गई।'],
    reminder: ['Upcoming booking', 'A reminder of an upcoming booking.', 'आने वाली बुकिंग', 'आने वाली बुकिंग की याद।'],
    status_changed: ['Booking status changed', `The booking is now ${STATUS_LABEL.en[a.status] ?? a.status}.`, 'बुकिंग की स्थिति बदली', `बुकिंग अब ${STATUS_LABEL.hi[a.status] ?? a.status} है।`],
  };
  const [subjEn, introEn, subjHi, introHi] = titles[event];
  const rows: Array<[string, string]> = [
    [hi ? 'ग्राहक' : 'Customer', a.customer_name], [hi ? 'सेवा' : 'Service', a.service_name], [hi ? 'स्टाफ़' : 'Staff', a.staff_name],
    [event === 'rescheduled' ? (hi ? 'नया समय' : 'New time') : (hi ? 'समय' : 'When'), formatSlot(d)], [hi ? 'संदर्भ संख्या' : 'Reference', a.booking_ref],
  ];
  if (event === 'rescheduled' && previous) rows.push([hi ? 'पिछला समय' : 'Previous time', formatSlot(d, previous)]);
  return renderSimpleEmail({
    lang, businessName: a.org_name,
    subject: `${hi ? subjHi : subjEn}: ${a.service_name}, ${formatEmailDate(a.date, lang)} ${formatEmailTime(a.start_time, d.timeFormat)} (${a.booking_ref})`,
    greeting: hi ? `नमस्ते ${recipientName},` : `Hi ${recipientName},`,
    intro: hi ? introHi : introEn,
    rows,
    button: { url: `${appUrl}/appointments/${a.id}`, label: hi ? 'अपॉइंटमेंट खोलें' : 'Open the appointment' },
  });
}
