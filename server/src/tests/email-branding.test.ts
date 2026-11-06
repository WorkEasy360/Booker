// Email branding: every email carries the WorkeasyBooking identity and attribution, while the business it is
// sent for stays the identity the reader sees first. Uses the in-memory transport; nothing leaves the machine.

import request from 'supertest';
import app from '../index';
import db from '../db/init';
import { initEmail, testOutbox } from '../services/email/notify';
import { renderAppointmentEmail, renderInvitationEmail, type AppointmentEmailData, type EmailKind } from '../services/email/templates';
import { PRODUCT_ATTRIBUTION, PRODUCT_NAME } from '../brand';
import { sessionToken, signUpAndSignIn } from './session-helpers';
import { publishBookingPage } from './fixtures';

jest.setTimeout(30_000); // hooks sign up for real: password hashing, emailed confirmation, sign-in

const RUN = Date.now().toString(36);
const BUSINESS = 'Glow & Co <Studio>';
const BUSINESS_HTML = 'Glow &amp; Co &lt;Studio&gt;';
const MANAGE_URL = 'https://book.example.com/book/lookup/manage#token=v1.abc.def.ghijklmnopqrstuvwxyz';

const data: AppointmentEmailData = {
  businessName: BUSINESS,
  customerName: 'Priya Patel',
  bookingRef: 'WE-AB12CD34',
  serviceName: 'Deep Tissue Massage',
  staffName: 'Lena Ortiz',
  date: '2026-11-03',
  startTime: '10:00',
  endTime: '11:00',
  timezone: 'America/New_York',
  timeFormat: '12h',
  location: '12 Market Street',
  manageUrl: MANAGE_URL,
  previous: { date: '2026-11-02', startTime: '09:00', endTime: '10:00' },
};

/** Visible text of an HTML email: inline tags dropped, block tags as spaces, entities decoded, whitespace collapsed. */
function visibleText(html: string): string {
  const body = html.replace(/^[\s\S]*?<body[^>]*>/, '').replace(/<div style="display:none[^"]*">[\s\S]*?<\/div>/, '');
  return body.replace(/<\/?(?:span|strong|b|a)\b[^>]*>/gi, '').replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

describe('booking email templates', () => {
  const kinds: EmailKind[] = ['confirmation', 'reschedule', 'cancellation'];

  it.each(kinds)('%s: product header and attribution, business first, details intact', kind => {
    const m = renderAppointmentEmail(kind, data);
    const shown = visibleText(m.html);

    // Platform identity: a text header (no images to block or break) and the attribution in the footer.
    expect(shown.startsWith(`${PRODUCT_NAME} ${BUSINESS}`)).toBe(true);
    expect(shown).toContain(`Sent by ${PRODUCT_NAME} on behalf of ${BUSINESS}.`);
    expect(shown.endsWith(`${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`)).toBe(true);
    expect(m.html).not.toMatch(/<img/i);

    // The business leads the message and signs it; the platform never replaces it.
    expect(shown.indexOf(BUSINESS)).toBeLessThan(shown.indexOf('Hi Priya Patel,'));
    expect(shown).toMatch(/Hi Priya Patel, .* Glow & Co <Studio> Sent by/);

    // Appointment details are unchanged.
    for (const detail of ['WE-AB12CD34', 'Deep Tissue Massage', 'Lena Ortiz', '12 Market Street', 'America/New_York']) {
      expect(shown).toContain(detail);
      expect(m.text).toContain(detail);
    }
    expect(m.subject.startsWith({ confirmation: 'Booking confirmed:', reschedule: 'Booking rescheduled:', cancellation: 'Booking cancelled:' }[kind])).toBe(true);
    expect(m.subject).not.toContain(PRODUCT_NAME);

    // Plain text: same content, the business's sign-off, then the platform footer after the signature separator.
    expect(m.text.startsWith('Hi Priya Patel,')).toBe(true);
    expect(m.text.endsWith(`${BUSINESS}\n\n-- \nSent by ${PRODUCT_NAME} on behalf of ${BUSINESS}.\n${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`)).toBe(true);
  });

  it('escapes business and customer text everywhere in the HTML, including the title and preview line', () => {
    const m = renderAppointmentEmail('confirmation', { ...data, customerName: '<b>Eve</b>', serviceName: 'Cut & "Style"' });
    expect(m.html).toContain(BUSINESS_HTML);
    expect(m.html).not.toContain('<Studio>');
    expect(m.html).not.toContain('<b>Eve</b>');
    expect(m.html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(m.html).toMatch(/<title>Booking confirmed: Cut &amp; &quot;Style&quot; on /);
  });

  it('confirmation and reschedule link to manage the booking; cancellation does not', () => {
    for (const kind of ['confirmation', 'reschedule'] as const) {
      const m = renderAppointmentEmail(kind, data);
      expect(m.html).toContain(`href="${MANAGE_URL}"`);
      expect(m.text).toContain(`View, reschedule or cancel your booking: ${MANAGE_URL}\n`);
    }
    const cancelled = renderAppointmentEmail('cancellation', data);
    expect(cancelled.html).not.toContain('/manage');
    expect(cancelled.text).not.toContain('/manage');
  });
});

describe('staff invitation template', () => {
  const invite = {
    businessName: BUSINESS, staffName: 'Ben <Barber>', inviterName: 'Ada Owner', role: 'staff' as const,
    acceptUrl: 'https://book.example.com/accept-invite#token=abcDEF123_-xyz', expiresAt: '2026-11-05T15:00:00.000Z', timezone: 'Asia/Kolkata',
  };

  it('names the business and the product, keeps the link usable and carries the attribution', () => {
    const m = renderInvitationEmail(invite);
    const shown = visibleText(m.html);
    expect(m.subject).toBe(`Ada Owner invited you to ${BUSINESS} on ${PRODUCT_NAME}`);
    expect(shown.startsWith(`${PRODUCT_NAME} ${BUSINESS} Hi Ben <Barber>,`)).toBe(true);
    expect(shown).toContain(`invited you to sign in to ${BUSINESS} on ${PRODUCT_NAME} as a staff member`);
    expect(shown.endsWith(`Sent by ${PRODUCT_NAME} on behalf of ${BUSINESS}. ${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`)).toBe(true);
    expect(m.html).toContain(`href="${invite.acceptUrl}"`);
    expect(m.html).not.toContain('<Barber>');
    // The link sits on its own line in the text version, so mail clients and the tests can pick it up.
    expect(m.text).toContain(`\n${invite.acceptUrl}\n`);
    expect(m.text).toContain(`\n-- \nSent by ${PRODUCT_NAME} on behalf of ${BUSINESS}.\n${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`);
  });
});

describe('an email actually sent for a booking', () => {
  const MEMORY_ENV = { EMAIL_TRANSPORT: 'memory', PUBLIC_APP_URL: 'http://localhost:5173', EMAIL_FROM: 'Test <test@example.com>' };
  const company = `Brand Org ${RUN}`;

  it("uses the business's own name, carries the product branding and exposes no internal identifiers", async () => {
    initEmail(MEMORY_ENV);
    const ownerEmail = `brand-owner-${RUN}@example.com`;
    const s = await signUpAndSignIn(app, { name: 'Brand Owner', email: ownerEmail, company, password: 'TestPass123', confirmPassword: 'TestPass123' });
    const auth = { Authorization: `Bearer ${sessionToken(s)}` };
    const everyDay = Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map(d => [d, { enabled: true, start: '08:00', end: '20:00' }]));
    const serviceId = (await request(app).post('/api/services').set(auth).send({ name: 'Brand Facial', category: 'consultation', duration: 30, price: 20, maxAdvance: 365 })).body.data.id as string;
    const staffId = (await request(app).post('/api/staff').set(auth).send({ name: 'Brand Stylist', email: `brand-staff-${RUN}@example.com`, serviceIds: [serviceId], workingHours: everyDay })).body.data.id as string;
    await publishBookingPage(app, auth, [serviceId], 'brand');
    const date = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

    testOutbox.clear();
    const res = await request(app).post('/api/public/book').send({ serviceId, staffId, date, startTime: '10:00', customer: { name: 'Bea Booker', email: `bea-${RUN}@example.com`, phone: '+91 98765 40100' } });
    expect(res.status).toBe(201);
    expect(testOutbox.messages).toHaveLength(1);
    const m = testOutbox.messages[0];

    const shown = visibleText(m.html);
    expect(shown.startsWith(`${PRODUCT_NAME} ${company}`)).toBe(true);
    expect(shown).toContain(`Sent by ${PRODUCT_NAME} on behalf of ${company}.`);
    expect(m.text).toContain(`${PRODUCT_NAME} · ${PRODUCT_ATTRIBUTION}`);

    const orgId = (db.prepare('SELECT organization_id FROM users WHERE email = ?').get(ownerEmail) as { organization_id: string }).organization_id;
    const apptId = (db.prepare('SELECT id FROM appointments WHERE booking_ref = ?').get(res.body.data.bookingRef) as { id: string }).id;
    for (const internalId of [orgId, apptId, staffId, serviceId]) {
      expect(m.html).not.toContain(internalId);
      expect(m.text).not.toContain(internalId);
      expect(m.subject).not.toContain(internalId);
    }
  });
});
