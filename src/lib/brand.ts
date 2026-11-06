/**
 * Platform identity: WorkeasyBooking, a product of WorkEasy360.
 *
 * These describe the platform only. A business's own name, logo and booking-page theme are tenant data: they always
 * come from that business's records and are never replaced by these values.
 * The server keeps the same values in server/src/brand.ts for emails (tests/unit/brand.test.ts checks they match).
 * Plain TypeScript with no imports, so the Node unit tests can load it directly.
 */
export const PRODUCT_NAME = 'WorkeasyBooking';
export const COMPANY_NAME = 'WorkEasy360';
export const PRODUCT_ATTRIBUTION = 'A WorkEasy360 Product';
export const PRODUCT_DESCRIPTION = 'Smart appointment scheduling for businesses';
/** Subtle platform credit on a business's public booking pages. */
export const POWERED_BY = `Powered by ${PRODUCT_NAME}`;

/** The same values as `primary`, `primary-dark`, `navy` and `accent` in tailwind.config.js. */
export const BRAND_COLORS = {
  primary: '#00BF62',
  secondary: '#008F49',
  navy: '#13222E',
  accent: '#FFC940',
} as const;

const SEPARATOR = ' — ';

/** Browser tab title: "Dashboard — WorkeasyBooking"; without a page name, the product name and description. */
export function pageTitle(page?: string | null): string {
  const name = page?.trim();
  return name ? `${name}${SEPARATOR}${PRODUCT_NAME}` : `${PRODUCT_NAME}${SEPARATOR}${PRODUCT_DESCRIPTION}`;
}

/**
 * Tab title for a business's public page. The business leads and the platform comes last:
 * "Booking confirmed · Glow Studio — WorkeasyBooking".
 */
export function businessPageTitle(business: string | null | undefined, page?: string | null): string {
  const biz = business?.trim();
  const name = page?.trim();
  if (!biz) return pageTitle(name);
  return pageTitle(name && name !== biz ? `${name} · ${biz}` : biz);
}

/** "© 2026 WorkEasy360". */
export function copyrightNotice(year: number = new Date().getFullYear()): string {
  return `© ${year} ${COMPANY_NAME}`;
}
