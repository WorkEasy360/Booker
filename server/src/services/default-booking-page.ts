// V4: one default business booking page per organization. It offers every active service, and "Accept online
// bookings" is its published flag. It is created on first use; an organization that already has business pages has
// its oldest one adopted as the default. Other existing pages are left exactly as they are.
import { nanoid } from 'nanoid';
import db from '../db/init';

export interface DefaultBookingPage { id: string; slug: string; title: string; isPublished: boolean }

interface PageRow { id: string; slug: string; title: string; is_published: number }

const RESERVED_SLUGS = new Set(['lookup']);

const toApi = (r: PageRow): DefaultBookingPage => ({ id: r.id, slug: r.slug, title: r.title, isPublished: !!r.is_published });

/** "Acme Wellness Clinic" → "acme-wellness-clinic" (lower-case letters, digits and hyphens; never empty). */
export function slugFor(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '');
  return base || 'booking';
}

/** A slug no organization uses yet (public pages are found by slug alone): the name, then the name with a number. */
function uniqueSlug(name: string): string {
  const base = slugFor(name);
  const taken = (s: string) => RESERVED_SLUGS.has(s) || !!db.prepare('SELECT 1 FROM booking_pages WHERE slug = ?').get(s);
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

function activeServiceIds(orgId: string): string[] {
  return db.prepare('SELECT id FROM services WHERE organization_id = ? AND is_active = 1 ORDER BY created_at, name')
    .pluck().all(orgId) as string[];
}

function findDefault(orgId: string): PageRow | undefined {
  return db.prepare('SELECT id, slug, title, is_published FROM booking_pages WHERE organization_id = ? AND is_default = 1')
    .get(orgId) as PageRow | undefined;
}

/** The organization's default booking page; adopted or created (published, every active service) when it has none. */
export function ensureDefaultBookingPage(orgId: string): DefaultBookingPage {
  // A plain (not IMMEDIATE) transaction, so it can also run inside a caller's transaction as a savepoint.
  return db.transaction((): DefaultBookingPage => {
    const existing = findDefault(orgId);
    if (existing) return toApi(existing);
    const services = JSON.stringify(activeServiceIds(orgId));
    const oldest = db.prepare(
      "SELECT id FROM booking_pages WHERE organization_id = ? AND type = 'business' ORDER BY created_at, id LIMIT 1"
    ).get(orgId) as { id: string } | undefined;
    if (oldest) {
      db.prepare('UPDATE booking_pages SET is_default = 1, service_ids = ? WHERE id = ?').run(services, oldest.id);
    } else {
      const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as { name: string } | undefined;
      if (!org) throw new Error(`Organization ${orgId} not found`);
      db.prepare(
        `INSERT INTO booking_pages (id, organization_id, type, title, description, slug, is_published, service_ids, is_default)
         VALUES (?, ?, 'business', ?, '', ?, 1, ?, 1)`
      ).run(`bp-${nanoid(10)}`, orgId, org.name, uniqueSlug(org.name), services);
    }
    return toApi(findDefault(orgId)!);
  })();
}

/** Keeps the default page offering exactly the active services (after a service is added, edited or removed). */
export function syncDefaultBookingPage(orgId: string): void {
  db.prepare('UPDATE booking_pages SET service_ids = ? WHERE organization_id = ? AND is_default = 1')
    .run(JSON.stringify(activeServiceIds(orgId)), orgId);
}

/** "Accept online bookings" on or off. */
export function setOnlineBooking(orgId: string, isPublished: boolean): DefaultBookingPage {
  const page = ensureDefaultBookingPage(orgId);
  db.prepare('UPDATE booking_pages SET is_published = ? WHERE id = ? AND organization_id = ?').run(isPublished ? 1 : 0, page.id, orgId);
  return toApi(findDefault(orgId)!);
}

/** The business's one appointment location or online instructions ('' when not set). */
export function businessLocation(orgId: string): string {
  const row = db.prepare('SELECT appointment_location FROM organizations WHERE id = ?').get(orgId) as { appointment_location: string | null } | undefined;
  return (row?.appointment_location ?? '').trim();
}

/** Location stored on a new appointment: the business location when set, otherwise the service's own (older data). */
export function appointmentLocation(orgId: string, serviceLocation: string | null | undefined): string {
  return businessLocation(orgId) || (serviceLocation ?? '');
}
