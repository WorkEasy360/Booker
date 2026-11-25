import React from 'react';
import { cn } from '@/lib/utils';

interface PageTitleProps {
  /** Lucide icon shown in brand green before the title. */
  icon: React.ElementType;
  title: string;
  description?: string;
  /** Buttons and toggles on the right (wrap below the title on small screens). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Screen title in the WorkEasy360 Booking style: a green outlined icon, a large bold title and a one-line description,
 * with the screen's main actions on the right. Used at the top of every main screen.
 */
export function PageTitle({ icon: Icon, title, description, actions, className }: PageTitleProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-6 gap-y-4', className)}>
      <div className="flex items-center gap-3.5 sm:gap-4 min-w-0">
        <Icon className="w-9 h-9 sm:w-11 sm:h-11 text-primary shrink-0" strokeWidth={1.75} aria-hidden="true" />
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-[32px] sm:leading-[38px] font-bold text-text-primary tracking-tight">{title}</h1>
          {description && <p className="text-sm sm:text-base text-text-secondary mt-0.5">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
