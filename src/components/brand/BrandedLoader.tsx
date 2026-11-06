import React from 'react';
import { cn } from '@/lib/utils';
import { PRODUCT_NAME } from '@/lib/brand';
import { Spinner } from '@/components/ui';
import { ProductLogo, type BrandTone } from './ProductLogo';

/** Full-screen loading state shown while the app checks the session, before any page can render. */
export function BrandedLoader({ tone = 'light' }: { tone?: BrandTone }) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-brand="loader"
      className={cn('min-h-screen flex flex-col items-center justify-center gap-2 px-4', tone === 'dark' ? 'bg-gradient-to-br from-navy to-[#1a3040]' : 'bg-background')}
    >
      <ProductLogo tone={tone} size="lg" decorative />
      <Spinner />
      <span className="sr-only">Loading {PRODUCT_NAME}…</span>
    </div>
  );
}
