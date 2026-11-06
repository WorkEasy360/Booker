import React, { createContext, useContext, useState, useCallback } from 'react';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, 'id'>) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(prev => [...prev, { ...toast, id }]);
    setTimeout(() => remove(id), 4000);
  }, [remove]);

  const success = useCallback((title: string, message?: string) => addToast({ type: 'success', title, message }), [addToast]);
  const error   = useCallback((title: string, message?: string) => addToast({ type: 'error',   title, message }), [addToast]);
  const warning = useCallback((title: string, message?: string) => addToast({ type: 'warning', title, message }), [addToast]);
  const info    = useCallback((title: string, message?: string) => addToast({ type: 'info',    title, message }), [addToast]);

  return (
    <ToastContext.Provider value={{ addToast, success, error, warning, info }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80">
        {toasts.map(t => <ToastItem key={t.id} toast={t} onRemove={remove} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: (id: string) => void }) {
  const icons = {
    success: <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />,
    error:   <XCircle    className="w-4 h-4 text-red-600    shrink-0" />,
    warning: <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />,
    info:    <Info        className="w-4 h-4 text-blue-600  shrink-0" />,
  };
  const styles = {
    success: 'border-emerald-200 bg-emerald-50',
    error:   'border-red-200    bg-red-50',
    warning: 'border-amber-200  bg-amber-50',
    info:    'border-blue-200   bg-blue-50',
  };

  return (
    <div className={cn('flex items-start gap-3 p-3.5 rounded-xl border shadow-dropdown bg-white', styles[toast.type])}>
      {icons[toast.type]}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary">{toast.title}</p>
        {toast.message && <p className="text-xs text-text-secondary mt-0.5">{toast.message}</p>}
      </div>
      <button onClick={() => onRemove(toast.id)} className="text-text-muted hover:text-text-primary transition-colors ml-1 shrink-0">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
