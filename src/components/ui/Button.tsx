import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
}

export function Button({
  children, variant = 'primary', size = 'md', loading, icon, iconPosition = 'left',
  className, disabled, ...props
}: ButtonProps) {
  const base = 'inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

  const variants = {
    primary:   'bg-primary text-white hover:bg-primary-dark focus:ring-primary',
    secondary: 'bg-white text-text-primary border border-border hover:bg-gray-50 focus:ring-primary',
    ghost:     'text-text-secondary hover:bg-gray-100 hover:text-text-primary focus:ring-primary',
    danger:    'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
    outline:   'border border-primary text-primary hover:bg-primary-light focus:ring-primary',
  };

  const sizes = {
    sm:  'px-3 py-1.5 text-xs',
    md:  'px-4 py-2 text-sm',
    lg:  'px-5 py-2.5 text-base',
  };

  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        icon && iconPosition === 'left' && <span className="shrink-0">{icon}</span>
      )}
      {children}
      {!loading && icon && iconPosition === 'right' && <span className="shrink-0">{icon}</span>}
    </button>
  );
}
