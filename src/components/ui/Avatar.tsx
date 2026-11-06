import React from 'react';
import { cn, getInitials } from '@/lib/utils';

interface AvatarProps {
  name: string;
  src?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  color?: string;
  className?: string;
  /** Hide the initials from screen readers when the name is shown right next to the avatar. */
  decorative?: boolean;
}

export function Avatar({ name, src, size = 'md', color = '#00BF62', className, decorative = false }: AvatarProps) {
  const sizes = {
    xs: 'w-6 h-6 text-[10px]',
    sm: 'w-8 h-8 text-xs',
    md: 'w-9 h-9 text-sm',
    lg: 'w-11 h-11 text-base',
    xl: 'w-14 h-14 text-lg',
  };

  if (src) {
    return (
      <img
        src={src}
        alt={decorative ? '' : name}
        className={cn('rounded-full object-cover shrink-0', sizes[size], className)}
      />
    );
  }

  const bg = color + '20';
  return (
    <div
      className={cn('rounded-full flex items-center justify-center font-semibold shrink-0', sizes[size], className)}
      style={{ backgroundColor: bg, color }}
      aria-hidden={decorative || undefined}
    >
      {getInitials(name)}
    </div>
  );
}

interface AvatarGroupProps {
  avatars: { name: string; color?: string }[];
  max?: number;
  size?: AvatarProps['size'];
}

export function AvatarGroup({ avatars, max = 3, size = 'sm' }: AvatarGroupProps) {
  const visible = avatars.slice(0, max);
  const rest = avatars.length - max;

  return (
    <div className="flex -space-x-2">
      {visible.map((a, i) => (
        <div key={i} className="ring-2 ring-white rounded-full">
          <Avatar name={a.name} color={a.color} size={size} />
        </div>
      ))}
      {rest > 0 && (
        <div className={cn(
          'ring-2 ring-white rounded-full bg-gray-100 text-text-secondary font-medium flex items-center justify-center shrink-0',
          size === 'sm' ? 'w-8 h-8 text-xs' : 'w-9 h-9 text-sm',
        )}>
          +{rest}
        </div>
      )}
    </div>
  );
}
