/**
 * Platform identity used in emails: WorkeasyBooking, a product of WorkEasy360.
 *
 * These describe the platform only. A business's own name always comes from its records and is never replaced by
 * these values. Must match src/lib/brand.ts in the web app (tests/unit/brand.test.ts compares the two).
 */
export const PRODUCT_NAME = 'WorkEasy360 Booking';
export const COMPANY_NAME = 'WorkEasy360';
export const PRODUCT_ATTRIBUTION = 'A WorkEasy360 Product';
export const PRODUCT_DESCRIPTION = 'Simple Appointment Scheduling for Growing Businesses';

export const BRAND_COLORS = {
  primary: '#16A34A',
  secondary: '#15803D',
  navy: '#0B3D35',
  accent: '#FFC940',
} as const;
