import React from 'react';
import { cn } from '@/lib/utils';
import { PRODUCT_NAME } from '@/lib/brand';
// Right-sized copy of the official "W" mark in src/assets (logo-icon.png). The full logo artwork is not used for the
// product: its wordmark spells the company name, and the product is named WorkeasyBooking.
import markImage from '@/assets/brand/workeasy360-mark.png';

/** The name is shown as "Workeasy" in the text colour and "Booking" in brand green. */
const ACCENT = 'Booking';
const [NAME_LEAD, NAME_ACCENT] = PRODUCT_NAME.endsWith(ACCENT)
  ? [PRODUCT_NAME.slice(0, -ACCENT.length), ACCENT]
  : [PRODUCT_NAME, ''];

/** Sizes in px: the mark's height, the name's font size and the space between them. */
const INLINE = {
  sm: { mark: 20, text: 15, gap: 6 },
  md: { mark: 26, text: 19, gap: 8 },
  lg: { mark: 34, text: 25, gap: 10 },
} as const;
/** Slightly smaller name, for narrow places such as the navigation. */
const STACKED = {
  sm: { mark: 22, text: 14, gap: 6 },
  md: { mark: 26, text: 17, gap: 8 },
  lg: { mark: 34, text: 21, gap: 10 },
} as const;

export type BrandTone = 'light' | 'dark';

interface ProductLogoProps {
  /** The background the logo sits on. Dark backgrounds get a white name. */
  tone?: BrandTone;
  /** "stacked": the compact sizes, for narrow places such as the navigation. */
  layout?: 'inline' | 'stacked';
  size?: keyof typeof INLINE;
  /** Hide from assistive technology when the surrounding text already names the product. */
  decorative?: boolean;
  className?: string;
}

/**
 * WorkeasyBooking: the official "W" mark followed by the product name.
 * The lockup has a single accessible name, "WorkeasyBooking".
 */
export function ProductLogo({ tone = 'light', layout = 'inline', size = 'md', decorative = false, className }: ProductLogoProps) {
  const s = layout === 'stacked' ? STACKED[size] : INLINE[size];
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': PRODUCT_NAME };

  return (
    <span
      {...a11y}
      data-brand="product-logo"
      className={cn('inline-flex shrink-0 select-none items-center', className)}
      style={{ columnGap: s.gap }}
    >
      <img
        src={markImage}
        alt=""
        width={s.mark}
        height={s.mark}
        draggable={false}
        className="block max-w-none"
        style={{ width: s.mark, height: s.mark }}
      />
      <span
        aria-hidden="true"
        className={cn('block whitespace-nowrap leading-none font-bold tracking-tight', tone === 'dark' ? 'text-white' : 'text-navy')}
        style={{ fontSize: s.text }}
      >
        {NAME_LEAD}<span className="text-primary">{NAME_ACCENT}</span>
      </span>
    </span>
  );
}

interface ProductMarkProps {
  size?: number;
  /** Accessible name; leave empty when the mark sits next to text that names the product. */
  label?: string;
  className?: string;
}

/** The official WorkEasy360 "W" mark on its own: collapsed navigation, compact headers and credit lines. */
export function ProductMark({ size = 24, label = '', className }: ProductMarkProps) {
  return (
    <img
      src={markImage}
      alt={label}
      width={size}
      height={size}
      draggable={false}
      data-brand="product-mark"
      className={cn('shrink-0 select-none', className)}
      style={{ width: size, height: size }}
    />
  );
}
