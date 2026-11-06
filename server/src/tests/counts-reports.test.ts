// One definition of an active customer (Dashboard and Customers page both read GET /customers/summary), and reports
// whose service and staff charts include upcoming bookings, leave cancellations out, count revenue only for confirmed
// or completed appointments up to today, and use the business's own date. Report windows are N calendar days with
// today included, the same days the Dashboard counts; customers' booking counts come from their appointments.
// Synthetic data in the per-file test database.

import request from 'supertest';
import { nanoid } from 'nanoid';
import app from '../index';
import db from '../db/init';
import { dateRangeBounds } from '../routes/reports';
import { sessionToken, signUpAndSignIn } from './session-helpers';

jest.setTimeout(60_000);

const RUN = Date.now().toString(36);
const TZ = 'Asia/Kolkata';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });
let seq = 0;

async function business(label: string) {
  const res = await signUpAndSignIn(app, { name: `Owner ${label}`, email: `counts-${label}-${RUN}@example.com`, company: `Counts ${label} ${RUN}`, password: 'StartPass123', timezone: TZ });
  const h = { Authorization: `Bearer ${sessionToken(res)}` };
  const orgId = res.body.data.user.organization_id as string;
  const service = (await request(app).post('/api/services').set(h).send({ name: `Svc ${label}`, category: 'consultation', duration: 30, price: 500, maxAdvance: 365 })).body.data.id as string;
  const staff = (await request(app).post('/api/staff').set(h).send({ name: `Staff ${label}`, email: `counts-staff-${label}-${RUN}@example.com`, serviceIds: [service] })).body.data.id as string;
  const customer = async (name: string) => (await request(app).post('/api/customers').set(h).send({ name, email: `c${++seq}-${RUN}@example.com` })).body.data.id as string;
  /** An appointment row (past ones cannot be booked through the API). */
  const appointment = (customerId: string, date: string, status: string, price = 500) => db.prepare(
    `INSERT INTO appointments (id, booking_ref, organization_id, service_id, staff_id, customer_id, status, date, start_time, end_time, duration, price, currency, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '10:00', '10:30', 30, ?, 'INR', ?)`
  ).run(`appt-${nanoid(8)}`, `WE-${nanoid(8).toUpperCase()}`, orgId, service, staff, customerId, status, date, price, TZ);
  const get = async (path: string) => (await request(app).get(`/api${path}`).set(h)).body.data;
  return { h, orgId, customer, appointment, get };
}

describe('active customers: one definition for the Dashboard and the Customers page', () => {
  it('zero, one and several customers; cancelled-only customers are not active; other businesses never count', async () => {
    const b = await business('active');
    const other = await business('other');
    expect(await b.get('/customers/summary')).toEqual({ total: 0, active: 0 });

    const ana = await b.customer('Ana');
    expect(await b.get('/customers/summary')).toEqual({ total: 1, active: 0 });   // no appointment yet
    b.appointment(ana, day(3), 'scheduled');                                        // an upcoming booking
    expect(await b.get('/customers/summary')).toEqual({ total: 1, active: 1 });

    const ben = await b.customer('Ben');
    const cara = await b.customer('Cara');
    b.appointment(ben, day(-2), 'completed');
    b.appointment(ben, day(-1), 'no_show');                                         // one customer counts once
    b.appointment(cara, day(4), 'cancelled');                                       // only a cancelled booking
    const otherCust = await other.customer('Elsewhere');
    other.appointment(otherCust, day(2), 'confirmed');
    expect(await b.get('/customers/summary')).toEqual({ total: 3, active: 2 });
    expect(await other.get('/customers/summary')).toEqual({ total: 1, active: 1 });
  });
});

describe('reports by service and by staff', () => {
  it('count completed, upcoming and no-show bookings, leave cancellations out, and agree with each other', async () => {
    const b = await business('reports');
    const c = await b.customer('Report Customer');
    b.appointment(c, day(-3), 'completed', 500);
    b.appointment(c, day(-2), 'no_show', 500);
    b.appointment(c, day(5), 'scheduled', 500);       // upcoming: shown (it used to be missing)
    b.appointment(c, day(6), 'confirmed', 700);       // upcoming and confirmed: a booking, not yet revenue
    b.appointment(c, day(-1), 'cancelled', 900);      // never counted
    b.appointment(c, day(-60), 'completed', 500);     // outside the 30-day window

    const byService = await b.get('/reports/by-service?range=30d');
    expect(byService).toEqual([{ name: 'Svc reports', currency: 'INR', bookings: 4, revenue: 500 }]);
    const byStaff = await b.get('/reports/by-staff?range=30d');
    expect(byStaff).toEqual([{ name: 'Staff reports', bookings: 4 }]);
    // The 12-month window includes the older completed one.
    expect((await b.get('/reports/by-service?range=12m'))[0]).toMatchObject({ bookings: 5, revenue: 1000 });
  });

  it('a business whose only booking is cancelled has no service or staff rows (a genuine empty state)', async () => {
    const b = await business('empty');
    b.appointment(await b.customer('Only Cancelled'), day(2), 'cancelled');
    expect(await b.get('/reports/by-service?range=30d')).toEqual([]);
    expect(await b.get('/reports/by-staff?range=30d')).toEqual([]);
  });
});

describe('the report window uses the business\'s own date', () => {
  it('just after midnight in India the window ends on the Indian date, not the UTC one', () => {
    const at = Date.parse('2026-10-24T19:00:00Z'); // 00:30 on 25 October in India, still 24 October in UTC
    expect(dateRangeBounds('7d', 'Asia/Kolkata', at)).toEqual({ from: '2026-10-19', to: '2026-10-25' });
    expect(dateRangeBounds('7d', 'UTC', at)).toEqual({ from: '2026-10-18', to: '2026-10-24' });
    expect(dateRangeBounds('30d', 'Asia/Kolkata', at).from).toBe('2026-09-26');
    expect(dateRangeBounds('unknown', 'Asia/Kolkata', at).from).toBe('2025-10-26');
  });

  it('"Last N days" is exactly N calendar days with today included (it was N + 1), and "1y" is the year the page asks for', () => {
    const at = Date.parse('2026-10-26T06:00:00Z');
    const days = (r: string) => { const { from, to } = dateRangeBounds(r, 'Asia/Kolkata', at); return (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1; };
    expect([days('7d'), days('30d'), days('3m'), days('12m'), days('1y')]).toEqual([7, 30, 91, 365, 365]);
    expect(dateRangeBounds('1y', 'Asia/Kolkata', at)).toEqual(dateRangeBounds('12m', 'Asia/Kolkata', at));
  });
});

describe('the Dashboard and the Reports page agree', () => {
  it('"This Week" on the Dashboard (from the appointment list) equals Reports "Last 7 days"; the 8th day back is in neither', async () => {
    const b = await business('agree');
    const c = await b.customer('Agree Customer');
    b.appointment(c, day(0), 'scheduled');
    b.appointment(c, day(-6), 'completed');
    b.appointment(c, day(-2), 'cancelled');
    b.appointment(c, day(-7), 'completed');     // outside both 7-day windows
    b.appointment(c, day(3), 'scheduled');      // upcoming: in neither window
    const summary = await b.get('/reports/summary?range=7d');
    expect([summary.from, summary.to]).toEqual([day(-6), day(0)]);
    // The Dashboard counts the same list with the same window (src/lib/reportWindow.ts).
    const list = await b.get('/appointments') as Array<{ date: string; status: string }>;
    const thisWeek = list.filter(a => a.date >= day(-6) && a.date <= day(0));
    expect(summary.totalAppointments).toBe(thisWeek.length);
    expect(summary.totalAppointments).toBe(3);
    expect(summary.avgPerDay).toBeCloseTo(3 / 7);
    expect(summary.cancellationRate).toBeCloseTo((1 / 3) * 100);
    expect(summary.completionRate).toBeCloseTo((1 / 3) * 100);
  });
});

describe('customer booking counts come from the appointments', () => {
  it('Top Customers and the customer list match the real appointments even when the stored counter is wrong', async () => {
    const b = await business('custcount');
    const busy = await b.customer('Busy Customer');
    const once = await b.customer('Once Customer');
    const none = await b.customer('No Bookings');
    b.appointment(busy, day(-3), 'completed');
    b.appointment(busy, day(-1), 'cancelled');
    b.appointment(busy, day(4), 'scheduled');
    b.appointment(once, day(-2), 'completed');
    // As in the demo data: stored counts that match no appointment.
    db.prepare('UPDATE customers SET total_bookings = 12 WHERE id = ?').run(none);
    db.prepare('UPDATE customers SET total_bookings = 8 WHERE id = ?').run(once);
    const top = await b.get('/reports/top-customers') as Array<{ id: string; totalBookings: number; lastBookingDate: string }>;
    expect(top.map(t => [t.id, t.totalBookings])).toEqual([[busy, 3], [once, 1]]);   // the customer with none is not listed
    expect(top[0].lastBookingDate).toBe(day(4));
    const customers = await b.get('/customers') as Array<{ id: string; totalBookings: number }>;
    const appointments = await b.get('/appointments') as unknown[];
    // The Dashboard's "Total Bookings" (every appointment) equals the customers' bookings added up.
    expect(customers.reduce((n, x) => n + x.totalBookings, 0)).toBe(appointments.length);
    expect((await b.get(`/customers/${none}`)).totalBookings).toBe(0);
  });

  it('deleting a booking lowers the count, and another business\'s bookings never count', async () => {
    const a = await business('custdel');
    const other = await business('custother');
    const c = await a.customer('Deleted Booking Customer');
    a.appointment(c, day(-4), 'completed');
    a.appointment(c, day(-3), 'completed');
    const oc = await other.customer('Other Business Customer');
    other.appointment(oc, day(-4), 'completed');
    expect((await a.get(`/customers/${c}`)).totalBookings).toBe(2);
    const first = (await a.get('/appointments') as Array<{ id: string }>)[0];
    expect((await request(app).delete(`/api/appointments/${first.id}`).set(a.h)).status).toBe(200);
    expect((await a.get(`/customers/${c}`)).totalBookings).toBe(1);
    expect((await a.get('/reports/top-customers') as Array<{ id: string }>).map(t => t.id)).toEqual([c]);
    expect((await other.get('/reports/top-customers') as Array<{ id: string }>).map(t => t.id)).toEqual([oc]);
  });
});
