import React from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { PlatformFooter, PoweredByFooter, ProductLogo } from '@/components/brand';

interface Props {
  /**
   * page: full screen with the product logo (sign-in pages, app start-up);
   * shell: inside the signed-in layout, which stays usable;
   * public: a business's public pages, where the platform only appears as a "Powered by" credit.
   */
  variant?: 'page' | 'shell' | 'public';
}

/**
 * Shown when a page fails to load or render, for example a page file that is no longer on the server after an update.
 * Details stay out of the page (they can name internal files); React Router reports them in the browser console.
 */
export default function RouteErrorPage({ variant = 'page' }: Props) {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  usePageTitle(notFound ? 'Page not found' : 'Page could not be loaded');

  const home = variant === 'public' ? '/book' : '/';
  const message = (
    <div role="alert" data-brand="error-page" className="text-center max-w-sm">
      <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-4">
        <AlertTriangle className="w-7 h-7 text-amber-600" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-semibold text-text-primary mb-2">
        {notFound ? 'Page not found' : 'This page could not be loaded'}
      </h1>
      <p className="text-sm text-text-secondary mb-6">
        {notFound
          ? 'The page you are looking for does not exist or has moved.'
          : 'Something went wrong while opening this page. Reloading usually fixes it; if it keeps happening, try again in a few minutes.'}
      </p>
      <div className="flex flex-col sm:flex-row gap-2 justify-center">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary hover:bg-primary-dark text-white text-sm font-semibold transition-colors"
        >
          <RotateCw className="w-4 h-4" aria-hidden="true" /> Reload page
        </button>
        {/* A full page load, so a stale copy of the app is replaced too. */}
        <Link
          to={home}
          reloadDocument
          className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg border border-border text-sm font-medium text-text-secondary hover:text-text-primary hover:bg-muted transition-colors"
        >
          {variant === 'public' ? 'Find a booking' : 'Go to my home page'}
        </Link>
      </div>
    </div>
  );

  if (variant === 'shell') return <div className="flex justify-center px-4 py-16">{message}</div>;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-center gap-10 px-4 py-10">
        {variant === 'page' && <ProductLogo size="md" />}
        {message}
      </main>
      {variant === 'public' ? <PoweredByFooter /> : <PlatformFooter />}
    </div>
  );
}
