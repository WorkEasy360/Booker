import React from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from './app/router';
import { ToastProvider } from './components/ui/Toast';
import { AuthProvider } from './contexts/AuthContext';
import { LanguageProvider } from './i18n/LanguageContext';

export default function App() {
  return (
    <LanguageProvider>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </LanguageProvider>
  );
}
