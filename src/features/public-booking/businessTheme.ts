// A business's booking-page colour, applied to its public pages (tenant branding, separate from the platform's).

export const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Scoped overrides for the business's brand colour inside a `.booking-theme` container.
 * Only strict hex values are ever interpolated.
 */
export function themeCss(color?: string): string | null {
  if (!color || !HEX.test(color)) return null;
  const c = color.toLowerCase();
  return [
    `.booking-theme .bg-primary, .booking-theme .hover\\:bg-primary-dark:hover { background-color: ${c} !important; }`,
    `.booking-theme .text-primary { color: ${c} !important; }`,
    `.booking-theme .border-primary { border-color: ${c} !important; }`,
    `.booking-theme .bg-primary-light { background-color: ${c}1a !important; }`,
    `.booking-theme .ring-primary\\/20 { --tw-ring-color: ${c}33 !important; }`,
  ].join('\n');
}
