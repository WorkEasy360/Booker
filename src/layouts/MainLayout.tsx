import React, { useState, useEffect, useCallback } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from '@/components/navigation/Sidebar';
import { Header } from '@/components/navigation/Header';
import { cn } from '@/lib/utils';
import { AIProvider } from '@/contexts/AIContext';
import { AIPanel } from '@/features/ai/AIPanel';
import { AILauncher } from '@/features/ai/AILauncher';
import { useAuth } from '@/contexts/AuthContext';
import { AppFooter } from '@/components/brand';

function MainLayoutInner() {
  const { can } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Scroll lock while mobile drawer is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [mobileOpen]);

  // Close mobile drawer on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && mobileOpen) setMobileOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [mobileOpen]);

  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const toggleMobile = useCallback(() => setMobileOpen(v => !v), []);

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile sidebar backdrop */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-20"
          aria-hidden="true"
          onClick={closeMobile}
        />
      )}

      <Sidebar
        collapsed={collapsed}
        onCollapse={setCollapsed}
        mobileOpen={mobileOpen}
        onMobileClose={closeMobile}
      />
      <Header
        sidebarCollapsed={collapsed}
        onMobileMenuToggle={toggleMobile}
        mobileMenuOpen={mobileOpen}
      />
      <main className={cn(
        'transition-all duration-200 pt-14 pb-24 md:pb-0', // keeps the floating assistant button off the last row on phones
        collapsed ? 'md:ml-16' : 'md:ml-60',
      )}>
        <Outlet />
        <AppFooter />
      </main>

      {/* AI assistant — overlays on desktop, full-width drawer on mobile. It searches business data, so only roles with access see it. */}
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
