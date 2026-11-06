import React from 'react';
import { cn } from '@/lib/utils';

interface Props {
  name: string;
  /**
   * The business's own "show logo" choice for its booking page (shown as its initial, like the booking page header).
   * Pages that cannot know the choice leave it off and show the name alone.
   */
  showInitial?: boolean;
  className?: string;
}

/**
 * The business the customer booked with, at the top of the confirmation and manage pages. This is the business's own
 * identity (tenant data); the platform appears only in the "Powered by" footer.
 */
export function BusinessIdentity({ name, showInitial = false, className }: Props) {
  return (
    <div data-business-identity className={cn('flex items-center gap-3', className)}>
      {showInitial && (
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bold text-lg shrink-0 bg-primary" aria-hidden="true">
          {name.trim().charAt(0).toUpperCase()}
        </div>
      )}
      <p data-business-name className="font-bold text-text-primary min-w-0 break-words">{name}</p>
    </div>
  );
}
