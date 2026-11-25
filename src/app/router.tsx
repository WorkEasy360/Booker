// This module builds and exports the router; its small route guards below reload with the whole file in development.
/* eslint-disable react-refresh/only-export-components */
import React, { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet, Link, useLocation } from 'react-router-dom';
import NotFoundPage from '@/pages/NotFoundPage';
import RouteErrorPage from '@/pages/RouteErrorPage';
import { MainLayout } from '@/layouts/MainLayout';
import { PublicLayout } from '@/layouts/PublicLayout';
import { Spinner } from '@/components/ui';
import { BrandedLoader, ProductLogo } from '@/components/brand';
import { useAuth } from '@/contexts/AuthContext';
import { canOpen, homePath } from '@/lib/permissions';
import { PRODUCT_NAME } from '@/lib/brand';

function RequireAuth() {
  const { user, isLoading, connectionError, retrySession } = useAuth();
  if (isLoading) return <BrandedLoader />;
  if (connectionError && !user) {
    return (
      <div role="alert" className="flex flex-col items-center justify-center h-screen gap-3 px-4 text-center">
        <ProductLogo size="md" className="mb-4" />
        <p className="text-base font-semibold text-text-primary">Cannot reach the {PRODUCT_NAME} server</p>
        <p className="text-sm text-text-secondary max-w-sm">Your session was not checked because the server did not respond ({connectionError}). You have not been signed out.</p>
        <button onClick={retrySession} className="px-4 py-2 rounded-lg bg-primary text-white text-sm font-semibold">Retry</button>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <Outlet />;
}

/** Each signed-in role lands on a page it can use. */
function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePath(user?.permissions)} replace />;
}

/**
 * Hides pages the user's role cannot use. This is for clarity only: the server refuses the underlying requests anyway.
 */
function PermissionGate() {
  const { user } = useAuth();
  const location = useLocation();
  if (canOpen(user?.permissions, location.pathname)) return <Outlet />;
  return (
    <div role="alert" className="max-w-md mx-auto mt-16 text-center px-4">
      <h1 className="text-xl font-semibold text-text-primary mb-2">You don't have access to this page</h1>
      <p className="text-sm text-text-secondary mb-6">Your role ({user?.role ?? 'unknown'}) does not include it. Ask an administrator of your business if you need access.</p>
      <Link to={homePath(user?.permissions)} className="inline-flex px-4 py-2 rounded-lg bg-primary text-white text-sm font-semibold">Go to my home page</Link>
    </div>
  );
}

/** Addresses of screens that V4 removed or merged into the four menus. */
const LEGACY_REDIRECTS: Array<[string, string]> = [
  ['dashboard', '/appointments'],
  ['my-space', '/appointments'],
  ['calendar', '/appointments?view=calendar'],
  ['reports', '/appointments'],
  ['workspaces/*', '/appointments'],
  ['resources/*', '/appointments'],
  ['services/*', '/settings/services'],
  ['staff/*', '/settings/team'],
  ['booking-pages/*', '/settings/public-booking'],
  ['notifications', '/settings/notifications'],
  ['integrations', '/settings/integrations'],
];

function L(factory: () => Promise<{ default: React.ComponentType }>) {
  const Component = lazy(factory);
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-[60vh]"><Spinner /></div>}>
      <Component />
    </Suspense>
  );
}

// errorElement: a branded page instead of the router's generic one when a page fails to load or render.
export const router = createBrowserRouter([
  { path: '/login',  element: L(() => import('@/features/auth/LoginPage')), errorElement: <RouteErrorPage /> },
  { path: '/signup', element: L(() => import('@/features/auth/SignupPage')), errorElement: <RouteErrorPage /> },
  // Public: the invitation token in the link is the credential.
  { path: '/accept-invite', element: L(() => import('@/features/auth/AcceptInvitePage')), errorElement: <RouteErrorPage /> },
  // Public: password reset and sign-up confirmation; the emailed token after # is the credential. Neither signs in.
  { path: '/forgot-password', element: L(() => import('@/features/auth/ForgotPasswordPage')), errorElement: <RouteErrorPage /> },
  { path: '/reset-password', element: L(() => import('@/features/auth/ResetPasswordPage')), errorElement: <RouteErrorPage /> },
  { path: '/verify-email', element: L(() => import('@/features/auth/VerifyEmailPage')), errorElement: <RouteErrorPage /> },
  {
    path: '/',
    element: <RequireAuth />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        path: '/',
        element: <MainLayout />,
        children: [{
         element: <PermissionGate />,
         // Inside the layout, so navigation stays available when one page fails.
         errorElement: <RouteErrorPage variant="shell" />,
         children: [
          { index: true, element: <HomeRedirect /> },
          // Four main menus: Appointments (home), Availability, Customers, Settings.
          {
            path: 'appointments',
            children: [
              { index: true, element: L(() => import('@/features/appointments/AppointmentsPage')) },
              { path: 'new',              element: L(() => import('@/features/appointments/NewAppointmentPage')) },
              { path: ':id',              element: L(() => import('@/features/appointments/AppointmentDetailPage')) },
              { path: ':id/edit',         element: L(() => import('@/features/appointments/NewAppointmentPage')) },
              { path: ':id/reschedule',   element: L(() => import('@/features/appointments/ReschedulePage')) },
            ],
          },
          { path: 'availability', element: L(() => import('@/features/availability/AvailabilityPage')) },
          {
            path: 'customers',
            children: [
              { index: true, element: L(() => import('@/features/customers/CustomersPage')) },
              { path: 'new',      element: L(() => import('@/features/customers/CustomerFormPage')) },
              { path: ':id',      element: L(() => import('@/features/customers/CustomerDetailPage')) },
              { path: ':id/edit', element: L(() => import('@/features/customers/CustomerFormPage')) },
            ],
          },
          {
            path: 'settings',
            children: [
              { index: true, element: L(() => import('@/features/settings/SettingsPage')) },
              { path: ':tab', element: L(() => import('@/features/settings/SettingsPage')) },
              { path: ':tab/*', element: L(() => import('@/features/settings/SettingsPage')) },
            ],
          },
          // Account menu: My Account (shared profile and security).
          { path: 'account', element: L(() => import('@/features/account/MyAccountPage')) },
          // Earlier addresses of removed or merged screens keep working.
          ...LEGACY_REDIRECTS.map(([from, to]) => ({ path: from, element: <Navigate to={to} replace /> })),
         ],
        }],
      },
    ],
  },
  {
    path: '/book',
    element: <PublicLayout />,
    errorElement: <RouteErrorPage variant="public" />,
    children: [
      { index: true, element: L(() => import('@/features/public-booking/BookingLanding')) },
      { path: ':slug', element: L(() => import('@/features/public-booking/BookingWizard')) },
      { path: ':slug/confirmation', element: L(() => import('@/features/public-booking/BookingConfirmation')) },
      { path: ':slug/manage', element: L(() => import('@/features/public-booking/ManageBooking')) },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
