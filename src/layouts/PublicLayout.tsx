import React from 'react';
import { Outlet, useMatch } from 'react-router-dom';
import { PRODUCT_DESCRIPTION } from '@/lib/brand';
import { PlatformFooter, PoweredByFooter, ProductLogo } from '@/components/brand';

/**
 * Frame of the public pages.
 * On a business's pages (booking, confirmation, manage) the business is the identity: its name, page title and theme
 * lead, and the platform appears only as a quiet "Powered by" credit at the bottom.
 * The /book entry page belongs to no business, so it carries the product name instead.
 */
export function PublicLayout() {
  const isEntryPage = useMatch({ path: '/book', end: true }) !== null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {isEntryPage && (
        <header className="px-4 pt-10 flex flex-col items-center text-center">
          <ProductLogo size="md" />
          <p className="text-xs text-text-primary/75 mt-2.5">{PRODUCT_DESCRIPTION}</p>
        </header>
      )}
      <main className="flex-1">
        <Outlet />
      </main>
      {isEntryPage ? <PlatformFooter /> : <PoweredByFooter />}
    </div>
  );
}
