import React from 'react';
import { cn } from '@/lib/utils';
import { PRODUCT_ATTRIBUTION, PRODUCT_NAME, copyrightNotice } from '@/lib/brand';
import { ProductMark, type BrandTone } from './ProductLogo';

/*
 * Small print on the grey page background uses text-primary at 75% opacity (about 6.7:1 contrast): text-secondary
 * there is only about 4.4:1, below WCAG AA for small text.
 */
const SMALL_PRINT = 'text-text-primary/75';

/** "A WorkEasy360 Product". */
export function ProductAttribution({ tone = 'light', className }: { tone?: BrandTone; className?: string }) {
  return (
    <p data-brand="attribution" className={cn('text-xs', tone === 'dark' ? 'text-white/70' : SMALL_PRINT, className)}>
      {PRODUCT_ATTRIBUTION}
    </p>
  );
}

/** Footer of the signed-in application. */
export function AppFooter() {
  return (
    <footer
      data-brand="app-footer"
      className={cn('mt-10 border-t border-border px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-xs text-center sm:text-left', SMALL_PRINT)}
    >
      <p className="inline-flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
        <ProductMark size={16} />
        <span className="font-semibold text-text-primary">{PRODUCT_NAME}</span>
        <span aria-hidden="true">·</span>
        <span>{PRODUCT_ATTRIBUTION}</span>
      </p>
      <p>{copyrightNotice()}</p>
    </footer>
  );
}

/**
 * Platform credit at the foot of a business's public booking pages. Deliberately quiet: the business is the main
 * identity on those pages.
 */
export function PoweredByFooter() {
  return (
    <footer data-brand="powered-by" className="px-4 pt-4 pb-8 flex justify-center">
      <p className={cn('inline-flex items-center gap-1.5 text-xs', SMALL_PRINT)}>
        <ProductMark size={14} />
        <span>Powered by <span className="font-semibold">{PRODUCT_NAME}</span></span>
      </p>
    </footer>
  );
}

/** Footer for platform pages that belong to no single business (booking lookup, page not found). */
export function PlatformFooter({ className }: { className?: string }) {
  return (
    <footer data-brand="platform-footer" className={cn('px-4 pt-4 pb-8 text-center text-xs', SMALL_PRINT, className)}>
      <p>{PRODUCT_ATTRIBUTION} · {copyrightNotice()}</p>
    </footer>
  );
}
