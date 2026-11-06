import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDialogA11y } from './useDialogA11y';

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  footer?: React.ReactNode;
  side?: 'right' | 'left';
}

export function Drawer({ isOpen, onClose, title, subtitle, children, size = 'md', footer, side = 'right' }: DrawerProps) {
  const panelRef = useDialogA11y(isOpen, onClose);
  const titleId = useId();

  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  const widths = { sm: 'w-80', md: 'w-[480px]', lg: 'w-[640px]' };

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className={cn(
              'relative ml-auto bg-surface shadow-modal flex flex-col h-full max-w-full transition-transform focus:outline-none',
              widths[size],
              side === 'left' && 'mr-auto ml-0',
            )}
          >
            <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
              <div>
                <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
                {subtitle && <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>}
              </div>
              <button onClick={onClose} aria-label="Close panel" className="ml-4 p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-primary transition-colors shrink-0">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">{children}</div>
            {footer && (
              <div className="flex flex-wrap items-center justify-end gap-3 p-5 border-t border-border shrink-0">
                {footer}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
