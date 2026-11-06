import React from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface Breadcrumb {
  label: string;
  href?: string;
}

interface PageHeaderProps {
  title: string;
  description?: string;
  breadcrumbs?: Breadcrumb[];
  actions?: React.ReactNode;
  tabs?: TabItem[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  className?: string;
}

interface TabItem {
  id: string;
  label: string;
  count?: number;
}

export function PageHeader({
  title, description, breadcrumbs, actions, tabs, activeTab, onTabChange, className,
}: PageHeaderProps) {
  return (
    <div className={cn('', className)}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="flex items-center gap-1.5 text-xs text-text-muted mb-2">
          {breadcrumbs.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight className="w-3 h-3" />}
              {b.href ? (
                <Link to={b.href} className="hover:text-text-primary transition-colors">{b.label}</Link>
              ) : (
                <span className={cn(i === breadcrumbs.length - 1 && 'text-text-primary font-medium')}>{b.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-1">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          {description && <p className="text-sm text-text-secondary mt-1">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 max-w-full">{actions}</div>}
      </div>
      {tabs && (
        <div role="tablist" className="flex items-center gap-1 mt-4 border-b border-border -mb-px overflow-x-auto">
          {tabs.map(t => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              onClick={() => onTabChange?.(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0',
                activeTab === t.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary hover:border-gray-300',
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={cn(
                  'inline-flex items-center justify-center w-5 h-5 rounded-full text-xs',
                  activeTab === t.id ? 'bg-primary-light text-primary' : 'bg-gray-100 text-text-muted',
                )}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
