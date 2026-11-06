import { BRAND_COLORS, PRODUCT_ATTRIBUTION, PRODUCT_NAME } from '../../brand';
import { fillTemplate, type BookingLanguage, type Placeholder } from './preferences';

export type EmailKind = 'confirmation' | 'reschedule' | 'cancellation';
/** Emails to the customer about a booking: the outbox kinds plus the reminder. */
export type CustomerEmailKind = EmailKind | 'reminder';

export interface AppointmentEmailData {
  businessName: string;
  customerName: string;
  bookingRef: string;
  serviceName: string;
  staffName: string;
  date: string;       // YYYY-MM-DD in the business time zone
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  timezone: string;   // IANA name
  timeFormat: '12h' | '24h';
  location?: string;
  manageUrl: string;
  previous?: { date: string; startTime: string; endTime: string };
  /** The business's booking language (default English). */
  language?: BookingLanguage;
  /** The business's own subject and opening text for this kind of email, with {placeholders}. */
  custom?: { subject: string; intro: string };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function formatDate(date: string, lang: BookingLanguage = 'en'): string {
  return new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`));
}

function formatTime(time: string, fmt: '12h' | '24h'): string {
  if (fmt === '24h') return time;
  const [h, m] = time.split(':').map(Number);
  const hour = h % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(m).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Short zone label (e.g. EST, IST) for that calendar date, falling back to the IANA name. */
function zoneLabel(date: string, timezone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(new Date(`${date}T12:00:00Z`)).find(p => p.type === 'timeZoneName')?.value;
    return part && !/^GMT[+-]/.test(part) ? `${part} (${timezone})` : timezone;
  } catch {
    return timezone;
  }
}

function when(d: AppointmentEmailData, slot: { date: string; startTime: string; endTime: string }): string {
  return `${formatDate(slot.date, d.language)}, ${formatTime(slot.startTime, d.timeFormat)}–${formatTime(slot.endTime, d.timeFormat)} ${zoneLabel(slot.date, d.timezone)}`;
}

// ─── Shared layout ────────────────────────────────────────────────────────────
// Every email has a small text-based WorkeasyBooking header, opens with the business's own name (the identity the
// customer or staff member knows), and ends with a footer saying who sent it. Tables and inline styles only, for email
// clients; no images, so nothing can be blocked or broken.

const FONT = 'Arial,Helvetica,sans-serif';
const PAGE = '#F6F8F9';
const BORDER = '#E1E7EB';
/** Secondary text: 5.1:1 contrast on the page background, 6.0:1 on white. */
const MUTED = '#5B6B78';

/** "WorkeasyBooking" as text, in the brand navy. */
function brandWordmark(): string {
  return `<span style="color:${BRAND_COLORS.navy};font-weight:700">${escapeHtml(PRODUCT_NAME)}</span>`;
}

/** A link styled as a button that also works in Outlook (navy on brand green: 6.7:1 contrast). */
function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr>`
    + `<td bgcolor="${BRAND_COLORS.primary}" style="border-radius:8px;background:${BRAND_COLORS.primary}">`
    + `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;font-family:${FONT};font-size:15px;font-weight:700;line-height:1.2;color:${BRAND_COLORS.navy};text-decoration:none;border-radius:8px">${escapeHtml(label)}</a>`
    + `</td></tr></table>`;
}

/** Who sent the email; the same two lines end the plain-text version. */
function senderLines(businessName: string, lang: BookingLanguage = 'en'): [string, string] {
  return [
    lang === 'hi' ? `${PRODUCT_NAME} द्वारा ${businessName} की ओर से भेजा गया।` : `Sent by ${PRODUCT_NAME} on behalf of ${businessName}.`,
    `${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`,
  ];
}

/** Plain-text footer, after the conventional "-- " signature separator. */
function textFooter(businessName: string, lang: BookingLanguage = 'en'): string[] {
  return ['', '-- ', ...senderLines(businessName, lang)];
}

function emailHtml(o: { subject: string; preheader: string; businessName: string; body: string; footer?: [string, string]; lang?: BookingLanguage }): string {
  const [sentBy, attribution] = o.footer ?? senderLines(o.businessName, o.lang);
  return `<!doctype html>
<html lang="${o.lang ?? 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(o.subject)}</title></head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(o.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
<tr><td style="padding:0 4px 12px;font-family:${FONT};font-size:14px;line-height:1.4">${brandWordmark()}</td></tr>
<tr><td style="background:#FFFFFF;border:1px solid ${BORDER};border-radius:12px;padding:28px 24px;font-family:${FONT};font-size:15px;line-height:1.55;color:${BRAND_COLORS.navy}">
<div style="font-size:20px;font-weight:700;line-height:1.3;margin:0 0 16px">${escapeHtml(o.businessName)}</div>
${o.body}
</td></tr>
<tr><td style="padding:16px 8px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${MUTED};text-align:center">${escapeHtml(sentBy)}<br>${escapeHtml(attribution)}</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ─── Booking emails ───────────────────────────────────────────────────────────
// Built-in texts in English and Hindi. A business can replace the subject and the opening text of each kind with its
// own (Notifications page); the details table, the manage button and the footer always stay.

interface BookingWords {
  subject: Record<CustomerEmailKind, (d: AppointmentEmailData, date: string) => string>;
  intro: Record<CustomerEmailKind, string>;
  hi: (name: string) => string;
  reference: string; service: string; with: string; when: string; newTime: string; previousTime: string; location: string;
  manage: string; manageText: (url: string) => string; rebook: string;
}

const WORDS: Record<BookingLanguage, BookingWords> = {
  en: {
    subject: {
      confirmation: (d, date) => `Booking confirmed: ${d.serviceName} on ${date} (${d.bookingRef})`,
      reschedule: (d, date) => `Booking rescheduled: ${d.serviceName} now on ${date} (${d.bookingRef})`,
      cancellation: (d, date) => `Booking cancelled: ${d.serviceName} on ${date} (${d.bookingRef})`,
      reminder: (d, date) => `Reminder: ${d.serviceName} on ${date} (${d.bookingRef})`,
    },
    intro: {
      confirmation: 'Your booking is confirmed.',
      reschedule: 'Your booking has been moved to a new time.',
      cancellation: 'Your booking has been cancelled.',
      reminder: 'This is a reminder of your upcoming appointment.',
    },
    hi: name => `Hi ${name},`,
    reference: 'Reference', service: 'Service', with: 'With', when: 'When', newTime: 'New time', previousTime: 'Previous time', location: 'Location',
    manage: 'View, reschedule or cancel your booking', manageText: url => `View, reschedule or cancel your booking: ${url}`,
    rebook: 'To make a new booking, visit the booking page you used before.',
  },
  hi: {
    subject: {
      confirmation: (d, date) => `बुकिंग की पुष्टि: ${d.serviceName}, ${date} (${d.bookingRef})`,
      reschedule: (d, date) => `बुकिंग का नया समय: ${d.serviceName}, ${date} (${d.bookingRef})`,
      cancellation: (d, date) => `बुकिंग रद्द: ${d.serviceName}, ${date} (${d.bookingRef})`,
      reminder: (d, date) => `याद दिलाना: ${d.serviceName}, ${date} (${d.bookingRef})`,
    },
    intro: {
      confirmation: 'आपकी बुकिंग की पुष्टि हो गई है।',
      reschedule: 'आपकी बुकिंग का समय बदल दिया गया है।',
      cancellation: 'आपकी बुकिंग रद्द कर दी गई है।',
      reminder: 'यह आपके आने वाले अपॉइंटमेंट की याद दिलाने के लिए है।',
    },
    hi: name => `नमस्ते ${name},`,
    reference: 'संदर्भ संख्या', service: 'सेवा', with: 'किसके साथ', when: 'समय', newTime: 'नया समय', previousTime: 'पिछला समय', location: 'स्थान',
    manage: 'बुकिंग देखें, समय बदलें या रद्द करें', manageText: url => `बुकिंग देखें, समय बदलें या रद्द करें: ${url}`,
    rebook: 'नई बुकिंग के लिए पहले वाला बुकिंग पेज खोलें।',
  },
};

/** The values a business's own text can use. */
export function placeholderValues(d: AppointmentEmailData): Record<Placeholder, string> {
  return {
    customerName: d.customerName, businessName: d.businessName, serviceName: d.serviceName, staffName: d.staffName,
    date: formatDate(d.date, d.language), time: formatTime(d.startTime, d.timeFormat), bookingRef: d.bookingRef,
  };
}

/** The built-in subject and opening text (shown as the starting point when a business edits them). */
export function defaultTemplateText(kind: CustomerEmailKind, lang: BookingLanguage): { subject: string; intro: string } {
  const w = WORDS[lang];
  const sample = { serviceName: '{serviceName}', bookingRef: '{bookingRef}' } as AppointmentEmailData;
  return { subject: w.subject[kind](sample, '{date}'), intro: w.intro[kind] };
}

const htmlLines = (text: string) => escapeHtml(text).replace(/\r?\n/g, '<br>');

export function renderAppointmentEmail(kind: CustomerEmailKind, d: AppointmentEmailData): { subject: string; text: string; html: string } {
  const lang = d.language ?? 'en';
  const w = WORDS[lang];
  const values = placeholderValues(d);
  const subject = (d.custom ? fillTemplate(d.custom.subject, values) : w.subject[kind](d, formatDate(d.date, lang))).replace(/[\r\n]+/g, ' ');
  const intro = d.custom ? fillTemplate(d.custom.intro, values) : w.intro[kind];
  const rows: Array<[string, string]> = [
    [w.reference, d.bookingRef],
    [w.service, d.serviceName],
    [w.with, d.staffName],
    [kind === 'reschedule' ? w.newTime : w.when, when(d, d)],
  ];
  if (kind === 'reschedule' && d.previous) rows.push([w.previousTime, when(d, d.previous)]);
  if (d.location) rows.push([w.location, d.location]);

  const action = kind === 'cancellation' ? w.rebook : w.manageText(d.manageUrl);

  const text = [
    w.hi(d.customerName),
    '',
    intro,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    action,
    '',
    d.businessName,
    ...textFooter(d.businessName, lang),
  ].join('\n');

  const body = `<p style="margin:0 0 12px">${escapeHtml(w.hi(d.customerName))}</p>
<p style="margin:0 0 16px">${htmlLines(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:700">${escapeHtml(v)}</td></tr>`).join('\n')}
</table>
${kind === 'cancellation'
    ? `<p style="margin:20px 0 0">${escapeHtml(action)}</p>`
    : button(d.manageUrl, w.manage)}
<p style="margin:24px 0 0">${escapeHtml(d.businessName)}</p>`;

  const html = emailHtml({ subject, preheader: `${intro.split('\n')[0]} ${when(d, d)}`, businessName: d.businessName, body, lang });
  return { subject, text, html };
}

// ─── Shared helpers for the notification platform (services/notifications) ───

/** A date and time range in the booking language, with its zone. */
export function formatSlot(d: AppointmentEmailData, slot?: { date: string; startTime: string; endTime: string }): string {
  return when(d, slot ?? d);
}
export const formatEmailDate = formatDate;
export const formatEmailTime = formatTime;

/** One plain email in the product layout: greeting, opening text, a table of details, an optional button. */
export function renderSimpleEmail(o: {
  subject: string; greeting: string; intro: string; rows: Array<[string, string]>; businessName: string;
  button?: { url: string; label: string }; lang?: BookingLanguage;
}): { subject: string; text: string; html: string } {
  const subject = o.subject.replace(/[\r\n]+/g, ' ');
  const text = [o.greeting, '', o.intro, '', ...o.rows.map(([k, v]) => `${k}: ${v}`),
    ...(o.button ? ['', `${o.button.label}: ${o.button.url}`] : []), ...textFooter(o.businessName, o.lang)].join('\n');
  const body = `<p style="margin:0 0 12px">${escapeHtml(o.greeting)}</p>
<p style="margin:0 0 16px">${escapeHtml(o.intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
${o.rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:700">${escapeHtml(v)}</td></tr>`).join('\n')}
</table>
${o.button ? button(o.button.url, o.button.label) : ''}`;
  return { subject, text, html: emailHtml({ subject, preheader: o.intro, businessName: o.businessName, body, lang: o.lang }) };
}

// ─── Staff alerts ─────────────────────────────────────────────────────────────
// To the staff member a booking is with, when it is made, cancelled or moved (if the business turned alerts on).
// Only what they need to know; the customer's contact details stay in the app.

export type StaffAlertKind = 'staff_new' | 'staff_cancelled' | 'staff_rescheduled';

const STAFF_WORDS: Record<BookingLanguage, { subject: Record<StaffAlertKind, string>; intro: Record<StaffAlertKind, string>; customer: string; open: string }> = {
  en: {
    subject: { staff_new: 'New booking', staff_cancelled: 'Booking cancelled', staff_rescheduled: 'Booking moved' },
    intro: { staff_new: 'You have a new booking.', staff_cancelled: 'A booking with you was cancelled.', staff_rescheduled: 'A booking with you was moved to a new time.' },
    customer: 'Customer', open: 'Open the appointment',
  },
  hi: {
    subject: { staff_new: 'नई बुकिंग', staff_cancelled: 'बुकिंग रद्द', staff_rescheduled: 'बुकिंग का समय बदला' },
    intro: { staff_new: 'आपकी एक नई बुकिंग है।', staff_cancelled: 'आपके साथ की एक बुकिंग रद्द हो गई।', staff_rescheduled: 'आपके साथ की एक बुकिंग का समय बदल गया।' },
    customer: 'ग्राहक', open: 'अपॉइंटमेंट खोलें',
  },
};

export function renderStaffAlert(kind: StaffAlertKind, d: AppointmentEmailData & { appointmentUrl: string }): { subject: string; text: string; html: string } {
  const lang = d.language ?? 'en';
  const w = WORDS[lang];
  const sw = STAFF_WORDS[lang];
  const subject = `${sw.subject[kind]}: ${d.serviceName}, ${formatDate(d.date, lang)} ${formatTime(d.startTime, d.timeFormat)} (${d.bookingRef})`;
  const rows: Array<[string, string]> = [
    [sw.customer, d.customerName],
    [w.service, d.serviceName],
    [kind === 'staff_rescheduled' ? w.newTime : w.when, when(d, d)],
    [w.reference, d.bookingRef],
  ];
  if (kind === 'staff_rescheduled' && d.previous) rows.push([w.previousTime, when(d, d.previous)]);
  const text = [w.hi(d.staffName), '', sw.intro[kind], '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `${sw.open}: ${d.appointmentUrl}`, ...textFooter(d.businessName, lang)].join('\n');
  const body = `<p style="margin:0 0 12px">${escapeHtml(w.hi(d.staffName))}</p>
<p style="margin:0 0 16px">${escapeHtml(sw.intro[kind])}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%">
${rows.map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:${MUTED};vertical-align:top;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 0;font-weight:700">${escapeHtml(v)}</td></tr>`).join('\n')}
</table>
${button(d.appointmentUrl, sw.open)}`;
  return { subject, text, html: emailHtml({ subject, preheader: `${sw.intro[kind]} ${when(d, d)}`, businessName: d.businessName, body, lang }) };
}

// ─── Staff invitations ────────────────────────────────────────────────────────

export interface InvitationEmailData {
  businessName: string;
  staffName: string;
  inviterName: string;
  role: 'staff' | 'manager';
  acceptUrl: string;
  expiresAt: string;   // ISO timestamp
  timezone: string;    // business time zone, for showing the expiry
}

const ROLE_SUMMARY: Record<InvitationEmailData['role'], string> = {
  staff: 'see your own schedule and appointments',
  manager: 'manage appointments, customers, services, booking pages and reports',
};

function formatExpiry(iso: string, timezone: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(iso));
  }
}

export function renderInvitationEmail(d: InvitationEmailData): { subject: string; text: string; html: string } {
  const subject = `${d.inviterName} invited you to ${d.businessName} on ${PRODUCT_NAME}`;
  const expiry = formatExpiry(d.expiresAt, d.timezone);
  const roleName = d.role === 'manager' ? 'a manager' : 'a staff member';
  const text = [
    `Hi ${d.staffName},`,
    '',
    `${d.inviterName} invited you to sign in to ${d.businessName} on ${PRODUCT_NAME} as ${roleName}, so you can ${ROLE_SUMMARY[d.role]}.`,
    '',
    `Choose your password here (the link works once and expires ${expiry}):`,
    d.acceptUrl,
    '',
    'If you were not expecting this, you can ignore this email; no account is created unless you open the link.',
    ...textFooter(d.businessName),
  ].join('\n');
  const body = `<p style="margin:0 0 12px">Hi ${escapeHtml(d.staffName)},</p>
<p style="margin:0">${escapeHtml(d.inviterName)} invited you to sign in to <strong>${escapeHtml(d.businessName)}</strong> on ${escapeHtml(PRODUCT_NAME)} as ${roleName}, so you can ${escapeHtml(ROLE_SUMMARY[d.role])}.</p>
${button(d.acceptUrl, 'Accept the invitation and choose your password')}
<p style="margin:20px 0 0;color:${MUTED};font-size:13px">The link works once and expires ${escapeHtml(expiry)}. If you were not expecting this, ignore this email; no account is created unless you open the link.</p>`;
  const html = emailHtml({ subject, preheader: `Join ${d.businessName} on ${PRODUCT_NAME}.`, businessName: d.businessName, body });
  return { subject, text, html };
}

// ─── Account emails (sign-up verification, password reset) ───────────────────
// These come from the product itself, not from a business. Links carry their token in the URL fragment.

export type AccountEmailKind = 'verify' | 'verify_again' | 'existing_account' | 'password_reset' | 'password_changed';

export interface AccountEmailData {
  name?: string;        // greeting name, when known
  company?: string;     // the business being created (verification emails)
  actionUrl?: string;   // verification or reset link
  signInUrl: string;
  forgotUrl: string;
  changedAt?: string;   // ISO timestamp (password changed)
}

const PLATFORM_FOOTER: [string, string] = [`Sent by ${PRODUCT_NAME}.`, `${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`];

function accountEmail(subject: string, preheader: string, textLines: string[], body: string) {
  const text = [...textLines, '', '-- ', ...PLATFORM_FOOTER].join('\n');
  const html = emailHtml({ subject, preheader, businessName: PRODUCT_NAME, body, footer: PLATFORM_FOOTER });
  return { subject, text, html };
}

const note = (s: string) => `<p style="margin:20px 0 0;color:${MUTED};font-size:13px">${s}</p>`;
const greeting = (name?: string) => (name ? `Hi ${name},` : 'Hello,');

export function renderAccountEmail(kind: AccountEmailKind, d: AccountEmailData): { subject: string; text: string; html: string } {
  const hi = greeting(d.name);
  const hiHtml = `<p style="margin:0 0 12px">${escapeHtml(hi)}</p>`;
  switch (kind) {
    case 'verify':
    case 'verify_again': {
      const again = kind === 'verify_again';
      const subject = again ? `Your new link to confirm your ${PRODUCT_NAME} account` : `Confirm your email for ${PRODUCT_NAME}`;
      const lead = again
        ? `Here is a new link to confirm your email address and finish creating ${d.company ? `the account for ${d.company}` : 'your account'}. Links sent earlier no longer work.`
        : `Confirm your email address to finish creating ${d.company ? `the ${PRODUCT_NAME} account for ${d.company}` : `your ${PRODUCT_NAME} account`}.`;
      const after = 'The link works once and expires in 24 hours. If you did not sign up, ignore this email: no account is created unless you open the link and confirm.';
      return accountEmail(subject, lead,
        [hi, '', lead, '', d.actionUrl!, '', after],
        `${hiHtml}<p style="margin:0">${escapeHtml(lead)}</p>${button(d.actionUrl!, 'Confirm my email')}${note(escapeHtml(after))}`);
    }
    case 'existing_account': {
      const subject = `Sign-in help for your ${PRODUCT_NAME} account`;
      const lead = `Someone, probably you, tried to create a ${PRODUCT_NAME} account with this email address. An account already exists for it, so no new account was created.`;
      const help = 'If you forgot your password, you can choose a new one:';
      const after = 'If this was not you, you can ignore this email. Nothing has changed.';
      return accountEmail(subject, lead,
        [hi, '', lead, '', `Sign in: ${d.signInUrl}`, `${help} ${d.forgotUrl}`, '', after],
        `${hiHtml}<p style="margin:0">${escapeHtml(lead)}</p>${button(d.signInUrl, 'Sign in')}`
        + `<p style="margin:20px 0 0">${escapeHtml(help)} <a href="${escapeHtml(d.forgotUrl)}" style="color:${BRAND_COLORS.navy}">reset your password</a>.</p>${note(escapeHtml(after))}`);
    }
    case 'password_reset': {
      const subject = `Reset your ${PRODUCT_NAME} password`;
      const lead = `We received a request to reset the password for your ${PRODUCT_NAME} account.`;
      const after = 'The link works once and expires in 60 minutes. If you did not ask for this, ignore this email: your password stays the same.';
      return accountEmail(subject, lead,
        [hi, '', lead, 'Choose a new password here:', d.actionUrl!, '', after],
        `${hiHtml}<p style="margin:0">${escapeHtml(lead)}</p>${button(d.actionUrl!, 'Choose a new password')}${note(escapeHtml(after))}`);
    }
    case 'password_changed': {
      const subject = `Your ${PRODUCT_NAME} password was changed`;
      const when = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(d.changedAt ?? Date.now()));
      const lead = `The password for your ${PRODUCT_NAME} account was changed on ${when} (UTC). Every device that was signed in has been signed out.`;
      const after = 'If you did not do this, reset your password now and tell your administrator:';
      return accountEmail(subject, lead,
        [hi, '', lead, '', `Sign in: ${d.signInUrl}`, '', `${after} ${d.forgotUrl}`],
        `${hiHtml}<p style="margin:0">${escapeHtml(lead)}</p>${button(d.signInUrl, 'Sign in')}`
        + `<p style="margin:20px 0 0">${escapeHtml(after)} <a href="${escapeHtml(d.forgotUrl)}" style="color:${BRAND_COLORS.navy}">reset your password</a>.</p>`);
    }
  }
}
