import request from 'supertest';
import type { Express } from 'express';

let counter = 0;

/** Public booking only works for services listed on a published booking page, exactly as in real use. */
export async function publishBookingPage(app: Express, headers: Record<string, string>, serviceIds: string[], label = 'page'): Promise<string> {
  const slug = `${label}-${Date.now().toString(36)}-${++counter}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const res = await request(app).post('/api/booking-pages').set(headers)
    .send({ title: `Book ${label}`, slug, serviceIds, isPublished: true });
  if (res.status !== 201) throw new Error(`Publishing a booking page failed: ${res.status} ${JSON.stringify(res.body)}`);
  return slug;
}
