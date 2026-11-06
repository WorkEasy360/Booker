import React, { useState } from 'react';
import { cn } from '@/lib/utils';

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
  count?: number;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  onChange?: (id: string) => void;
  variant?: 'underline' | 'pill';
  className?: string;
}

export function Tabs({ tabs, defaultTab, onChange, variant = 'underline', className }: TabsProps) {
  const [active, setActive] = useState(defaultTab || tabs[0]?.id);

  const handleChange = (id: string) => {
    setActive(id);
    onChange?.(id);
  };

  const currentTab = tabs.find(t => t.id === active);

  return (
    <div className={cn('', className)}>
      <div className={cn('flex items-center', variant === 'underline' ? 'border-b border-border gap-1' : 'gap-1.5')}>
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => handleChange(t.id)}
            className={cn(
              'flex items-center gap-1.5 text-sm font-medium transition-colors',
              variant === 'underline'
                ? cn(
                    'px-4 py-2.5 border-b-2',
                    active === t.id ? 'border-primary text-primary' : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300',
                  )
                : cn(
                    'px-3.5 py-1.5 rounded-lg',
                    active === t.id ? 'bg-primary text-white' : 'text-text-secondary hover:bg-gray-100',
                  ),
            )}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded-full',
                active === t.id && variant === 'underline' ? 'bg-primary-light text-primary' : 'bg-gray-100 text-text-muted',
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="mt-4">{currentTab?.content}</div>
    </div>
  );
}
