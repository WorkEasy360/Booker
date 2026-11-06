import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { homePath } from '@/lib/permissions';
import { PRODUCT_DESCRIPTION, copyrightNotice } from '@/lib/brand';
import { usePageTitle } from '@/hooks/usePageTitle';
import { BrandedLoader, ProductAttribution, ProductLogo } from '@/components/brand';

interface Props {
  children: React.ReactNode;
  title: string;
  subtitle: string;
  /** Browser tab title (before " — WorkeasyBooking"); defaults to `title`. */
  documentTitle?: string;
  /** Send signed-in users to their home page (off for pages that handle a signed-in user themselves). */
  redirectIfSignedIn?: boolean;
}

/** Shared frame of the sign-in, sign-up and staff invitation pages. */
export default function AuthLayout({ children, title, subtitle, documentTitle, redirectIfSignedIn = true }: Props) {
  const { user, isLoading } = useAuth();
  usePageTitle(documentTitle ?? title);

  if (isLoading) return <BrandedLoader tone="dark" />;

  // Redirect authenticated users away from auth pages, to the home page of their role
  if (user && redirectIfSignedIn) return <Navigate to={homePath(user.permissions)} replace />;

  return (
    <div className="min-h-screen bg-gradient-to-br from-navy to-[#1a3040] flex flex-col items-center justify-center p-4">
      <header className="mb-8 flex flex-col items-center text-center">
        <ProductLogo tone="dark" size="lg" />
        <p className="text-xs text-white/70 mt-2.5">{PRODUCT_DESCRIPTION}</p>
        <h1 className="text-xl font-semibold text-white mt-7">{title}</h1>
        <p className="text-sm text-white/70 mt-1">{subtitle}</p>
      </header>

      <main className="w-full max-w-sm bg-white rounded-2xl shadow-2xl p-6">
        {children}
      </main>

      <footer className="mt-6 text-center space-y-1">
        <ProductAttribution tone="dark" />
        <p className="text-xs text-white/60">{copyrightNotice()}. Secure access only.</p>
      </footer>
    </div>
  );
}
