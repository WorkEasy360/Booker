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

/** Status pills as in the Appointments screen: soft tinted background, coloured text, slightly rounded. */
const STATUS_STYLE: Record<AppointmentStatus, string> = {
  scheduled: 'bg-[#E3EEFF] text-[#2563EB]',
  completed: 'bg-[#DDF6E5] text-[#15803D]',
  cancelled: 'bg-[#FDE4E4] text-[#DC2626]',
  no_show:   'bg-[#F1E8FE] text-[#7C3AED]',
};

export function StatusBadge({ status, className }: { status: AppointmentStatus | string; className?: string }) {
  const { t } = useLanguage();
  // Earlier records may still say "confirmed": shown as Scheduled (V4 has no separate confirmation stage).
  const s = status === 'confirmed' ? 'scheduled' : status;
  const style = STATUS_STYLE[s as AppointmentStatus];
  return (
    <span className={cn('inline-flex items-center justify-center px-3 py-1.5 rounded-md text-[13px] sm:text-sm font-medium whitespace-nowrap', style ?? 'bg-gray-100 text-gray-700', className)}>
      {style ? t(`status.${s as AppointmentStatus}`) : s}
    </span>
  );
}
