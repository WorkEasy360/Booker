import React from 'react';
import { cn } from '@/lib/utils';
import type { AppointmentStatus } from '@/types';
import { useLanguage } from '@/i18n/LanguageContext';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'purple' | 'outline';
  size?: 'sm' | 'md';
  dot?: boolean;
  className?: string;
}

export function Badge({ children, variant = 'default', size = 'sm', dot, className }: BadgeProps) {
  const base = 'inline-flex items-center gap-1.5 font-medium rounded-full';
  const sizes = { sm: 'px-2.5 py-0.5 text-xs', md: 'px-3 py-1 text-sm' };
  const variants = {
    default:  'bg-gray-100 text-gray-700',
    primary:  'bg-primary-light text-primary',
    success:  'bg-emerald-50 text-emerald-700',
    warning:  'bg-amber-50 text-amber-700',
    danger:   'bg-red-50 text-red-700',
    info:     'bg-blue-50 text-blue-700',
    purple:   'bg-purple-50 text-purple-700',
    outline:  'bg-white text-text-secondary border border-border',
  };
  const dotColors = {
    default:  'bg-gray-400',
    primary:  'bg-primary',
    success:  'bg-emerald-500',
    warning:  'bg-amber-500',
    danger:   'bg-red-500',
    info:     'bg-blue-500',
    purple:   'bg-purple-500',
    outline:  'bg-text-muted',
  };

  return (
    <span className={cn(base, sizes[size], variants[variant], className)}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', dotColors[variant])} />}
      {children}
    </span>
  );
}

const STATUS_BADGES: Record<AppointmentStatus, { variant: BadgeProps['variant']; label: string }> = {
  scheduled: { variant: 'info',    label: 'Scheduled' },
  confirmed: { variant: 'primary', label: 'Confirmed' },
  completed: { variant: 'success', label: 'Completed' },
  cancelled: { variant: 'danger',  label: 'Cancelled' },
  no_show:   { variant: 'purple',  label: 'No-show' },
};

export function StatusBadge({ status }: { status: AppointmentStatus | string }) {
  const { t } = useLanguage();
  const entry = STATUS_BADGES[status as AppointmentStatus];
  if (!entry) return <Badge variant="default" dot>{status}</Badge>;
  return <Badge variant={entry.variant} dot>{t(`status.${status as AppointmentStatus}`)}</Badge>;
}
