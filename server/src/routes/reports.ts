import { Router } from 'express';
import db from '../db/init';
import { requireAuth, requirePermission, type AuthRequest } from '../middleware/auth';
import { DEFAULT_CURRENCY } from '../services/business-locale';
import { getOrgTimezone } from '../services/availability';
import { CUSTOMER_BOOKING_COUNT, CUSTOMER_LAST_BOOKING } from '../services/customer-bookings';

const router = Router();
router.use(requireAuth, requirePermission('reports:read'));

// "1y" is what the Reports page sends for "Last year"; "12m" is kept for existing links.
const RANGE_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '3m': 91, '12m': 365, '1y': 365 };
/** Calendar days in a report window (unknown ranges mean a year). */
export const rangeDays = (range: string) => RANGE_DAYS[range] ?? 365;

/**
 * The report window, by appointment date in the business's time zone: the last N calendar days, today included
 * ("Last 7 days" is today and the 6 days before, as the Dashboard's "This Week"). It used to start N days before today,
 * one day too many, and before that it was computed in UTC.
 */
export function dateRangeBounds(range: string, timeZone: string, now = Date.now()): { from: string; to: string } {
  const to = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (rangeDays(range) - 1) * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}
const bounds = (req: AuthRequest) => dateRangeBounds((req.query.range as string) ?? '30d', getOrgTimezone(req.user!.orgId));

router.get('/summary', (req: AuthRequest, res, next) => {
  try {
    const range = (req.query.range as string) ?? '30d';
    const { from, to } = bounds(req);
    const orgId = req.user!.orgId;

    const total = (db.prepare(
      `SELECT COUNT(*) as c FROM appointments WHERE organization_id = ? AND date BETWEEN ? AND ?`
    ).get(orgId, from, to) as { c: number }).c;

    const cancelled = (db.prepare(
      `SELECT COUNT(*) as c FROM appointments WHERE organization_id = ? AND date BETWEEN ? AND ? AND status = 'cancelled'`
    ).get(orgId, from, to) as { c: number }).c;

    const noShow = (db.prepare(
      `SELECT COUNT(*) as c FROM appointments WHERE organization_id = ? AND date BETWEEN ? AND ? AND status = 'no_show'`
    ).get(orgId, from, to) as { c: number }).c;

    const completed = (db.prepare(
      `SELECT COUNT(*) as c FROM appointments WHERE organization_id = ? AND date BETWEEN ? AND ? AND status = 'completed'`
    ).get(orgId, from, to) as { c: number }).c;

    // Amounts in different currencies are never added together: the headline figure is in the business
    // currency and anything priced in another currency is reported separately.
    const currency = ((db.prepare('SELECT currency FROM organizations WHERE id = ?').get(orgId) as { currency: string | null } | undefined)?.currency) ?? DEFAULT_CURRENCY;
    const byCurrency = db.prepare(
      `SELECT currency, COALESCE(SUM(price),0) as revenue FROM appointments
       WHERE organization_id = ? AND date BETWEEN ? AND ? AND status IN ('confirmed','completed')
       GROUP BY currency`
    ).all(orgId, from, to) as Array<{ currency: string; revenue: number }>;
    const revenue = byCurrency.find(r => r.currency === currency)?.revenue ?? 0;
    const otherCurrencyRevenue = byCurrency.filter(r => r.currency !== currency);

    const days = rangeDays(range);

    res.json({
      data: {
        range, from, to,
        totalAppointments: total,
        currency,
        revenue,
        otherCurrencyRevenue,
        avgPerDay: total / days,
        cancellationRate: total > 0 ? (cancelled / total) * 100 : 0,
        noShowRate: total > 0 ? (noShow / total) * 100 : 0,
        completionRate: total > 0 ? (completed / total) * 100 : 0,
      },
    });
  } catch (err) { next(err); }
});

router.get('/by-service', (req: AuthRequest, res, next) => {
  try {
    const { from, to } = bounds(req);
    const orgId = req.user!.orgId;

    // Bookings: every appointment from the start of the window on, upcoming ones included, cancellations excluded.
    // Revenue: confirmed or completed appointments up to today, as in the summary.
    const rows = db.prepare(
      `SELECT s.name, a.currency,
              SUM(CASE WHEN a.status != 'cancelled' THEN 1 ELSE 0 END) as bookings,
              COALESCE(SUM(CASE WHEN a.status IN ('confirmed','completed') AND a.date <= ? THEN a.price ELSE 0 END),0) as revenue
       FROM appointments a
       JOIN services s ON a.service_id = s.id
       WHERE a.organization_id = ? AND a.date >= ?
       GROUP BY a.service_id, a.currency
       HAVING bookings > 0
       ORDER BY bookings DESC`
    ).all(to, orgId, from) as Array<{ name: string; currency: string; bookings: number; revenue: number }>;

    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get('/by-staff', (req: AuthRequest, res, next) => {
  try {
    const { from, to } = bounds(req);
    const orgId = req.user!.orgId;

    // The same booking count as "by service": from the start of the window on, upcoming included, cancellations excluded.
    const rows = db.prepare(
      `SELECT st.name, SUM(CASE WHEN a.status != 'cancelled' THEN 1 ELSE 0 END) as bookings
       FROM appointments a
       JOIN staff st ON a.staff_id = st.id
       WHERE a.organization_id = ? AND a.date >= ?
       GROUP BY a.staff_id
       HAVING bookings > 0
       ORDER BY bookings DESC`
    ).all(orgId, from) as Array<{ name: string; bookings: number }>;

    res.json({ data: rows });
  } catch (err) { next(err); }
});

router.get('/top-customers', (req: AuthRequest, res, next) => {
  try {
    // Counted from the appointments (services/customer-bookings.ts); customers without any booking are not listed.
    const rows = db.prepare(
      `SELECT id, name, email, ${CUSTOMER_BOOKING_COUNT} AS total_bookings, ${CUSTOMER_LAST_BOOKING} AS last_booking_date
       FROM customers WHERE organization_id = ? AND ${CUSTOMER_BOOKING_COUNT} > 0
       ORDER BY total_bookings DESC, last_booking_date DESC, name LIMIT 10`
    ).all(req.user!.orgId) as Record<string, unknown>[];

    res.json({ data: rows.map(r => ({
      id: r.id, name: r.name, email: r.email,
      totalBookings: r.total_bookings, lastBookingDate: r.last_booking_date,
    })) });
  } catch (err) { next(err); }
});

export default router;
