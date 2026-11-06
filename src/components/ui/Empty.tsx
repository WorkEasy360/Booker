import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './Button';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
  };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 px-4 text-center', className)}>
      {icon && (
        <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center text-text-muted mb-4">
          {icon}
        </div>
      )}
      <h3 className="text-sm font-semibold text-text-primary mb-1">{title}</h3>
      {description && <p className="text-sm text-text-secondary max-w-xs">{description}</p>}
      {action && (
        <Button className="mt-4" onClick={action.onClick} icon={action.icon}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center p-8', className)}>
      <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
