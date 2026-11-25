import React, { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/navigation/Sidebar';
import { Header } from '@/components/navigation/Header';
import { AIProvider } from '@/contexts/AIContext';
import { AIPanel } from '@/features/ai/AIPanel';
import { AILauncher } from '@/features/ai/AILauncher';
import { useAuth } from '@/contexts/AuthContext';
import { useDesignScale } from '@/hooks/useDesignScale';

function MainLayoutInner() {
  const { can } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  useDesignScale();

  // Scroll lock while the phone navigation drawer is open
  useEffect(() => {
    document.body.style.overflow = mobileOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && mobileOpen) setMobileOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mobileOpen]);

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const toggleMobile = useCallback(() => setMobileOpen(v => !v), []);

  return (
    <div className="min-h-screen bg-background">
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 bg-black/50 z-20" aria-hidden="true" onClick={closeMobile} />
      )}

      <Sidebar mobileOpen={mobileOpen} onMobileClose={closeMobile} />
      <Header onMobileMenuToggle={toggleMobile} mobileMenuOpen={mobileOpen} />
      {/* Bottom padding on phones keeps the floating assistant button clear of the last row of content. */}
      <main className="pt-16 md:pt-[calc(78px*var(--shell-zoom,1))] md:ml-[calc(252px*var(--shell-zoom,1))] pb-24 md:pb-8 min-w-0">
        <Outlet />
      </main>

      {/* AI Assistant: one floating, staff-facing entry (not a menu). Only roles with access see it. */}
      {can('ai:use') && (
        <>
          <AIPanel />
          <AILauncher />
        </>
      )}
    </div>
  );
}

export function MainLayout() {
  return (
    <AIProvider>
      <MainLayoutInner />
    </AIProvider>
  );
}
