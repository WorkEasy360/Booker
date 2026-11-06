import React from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hover?: boolean;
  onClick?: () => void;
}

export function Card({ children, className, padding = 'md', hover, onClick }: CardProps) {
  const paddings = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-6' };
  return (
    <div
      className={cn(
        'card',
        paddings[padding],
        hover && 'hover:shadow-md transition-shadow cursor-pointer',
        onClick && 'cursor-pointer',
        className,
      )}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, action, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between mb-4', className)}>
      <div>
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {subtitle && <p className="text-xs text-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {action && <div className="ml-4 shrink-0">{action}</div>}
    </div>
  );
}

interface StatCardProps {
  label: string;
  value: string | number;
  change?: { value: number; positive: boolean };
  icon?: React.ReactNode;
  iconBg?: string;
  description?: string;
  className?: string;
}

export function StatCard({ label, value, change, icon, iconBg = 'bg-primary-light', description, className }: StatCardProps) {
  return (
    <Card className={cn('', className)}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-text-secondary mb-1">{label}</p>
          <p className="text-2xl font-bold text-text-primary">{value}</p>
          {change !== undefined && (
            <p className={cn('text-xs mt-1', change.positive ? 'text-emerald-600' : 'text-red-600')}>
              {change.positive ? '+' : ''}{change.value}% vs last week
            </p>
          )}
          {description && <p className="text-xs text-text-muted mt-1">{description}</p>}
        </div>
        {icon && (
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ml-3', iconBg)}>
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}
