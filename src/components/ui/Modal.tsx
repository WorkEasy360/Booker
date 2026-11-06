import React, { useEffect, useId } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { useDialogA11y } from './useDialogA11y';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  footer?: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, description, children, size = 'md', footer }: ModalProps) {
  const panelRef = useDialogA11y(isOpen, onClose);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn('relative bg-surface rounded-xl shadow-modal w-full max-h-[90vh] flex flex-col focus:outline-none', sizes[size])}
      >
        <div className="flex items-start justify-between p-5 border-b border-border shrink-0">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-text-primary">{title}</h2>
            {description && <p id={descId} className="text-sm text-text-secondary mt-1">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Close dialog" className="ml-4 p-1.5 rounded-lg hover:bg-gray-100 text-text-muted hover:text-text-primary transition-colors shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto flex-1 p-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-3 p-5 border-t border-border shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning';
  loading?: boolean;
}

export function ConfirmModal({
  isOpen, onClose, onConfirm, title, message,
  confirmLabel = 'Confirm', cancelLabel = 'Cancel', variant = 'danger', loading,
}: ConfirmModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>{cancelLabel}</Button>
          <Button variant={variant === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">{message}</p>
    </Modal>
  );
}
