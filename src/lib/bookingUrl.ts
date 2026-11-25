/**
 * Public address of the business's one booking page. VITE_BOOKING_BASE_URL can point at a dedicated booking domain
 * once it is confirmed (V4 17.1); otherwise the page is served by this app under /book/<slug>.
 */
export function bookingUrl(slug: string): string {
  const base = (import.meta.env.VITE_BOOKING_BASE_URL as string | undefined)?.replace(/\/$/, '');
  return base ? `${base}/${slug}` : `${window.location.origin}/book/${slug}`;
}
