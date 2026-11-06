import React from 'react';
import { Link } from 'react-router-dom';
import { Home, Search } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { PlatformFooter, ProductLogo } from '@/components/brand';

export default function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-center gap-10 p-4">
        <ProductLogo size="md" />
        <div className="text-center max-w-sm">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <Search className="w-10 h-10 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-5xl font-bold text-text-primary mb-3">404</h1>
          <h2 className="text-xl font-semibold text-text-primary mb-2">Page not found</h2>
          <p className="text-sm text-text-secondary mb-8">
            The page you're looking for doesn't exist or has been moved.
          </p>
          <Link
            to="/dashboard"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-white text-sm font-semibold rounded-lg hover:bg-primary-dark transition-colors"
          >
            <Home className="w-4 h-4" aria-hidden="true" />
            Back to Dashboard
          </Link>
        </div>
      </main>
      <PlatformFooter />
    </div>
  );
}
