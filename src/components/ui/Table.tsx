import React from 'react';
import { cn } from '@/lib/utils';
import { EmptyState } from './Empty';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
  headerClassName?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor: (row: T) => string;
  onRowClick?: (row: T) => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: React.ReactNode;
  className?: string;
}

export function Table<T>({
  columns, data, keyExtractor, onRowClick,
  emptyTitle = 'No records', emptyDescription, emptyIcon, className,
}: TableProps<T>) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {columns.map(col => (
              <th
                key={col.key}
                className={cn('px-4 py-3 text-left text-xs font-medium text-text-muted uppercase tracking-wide', col.headerClassName)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>
                <EmptyState icon={emptyIcon} title={emptyTitle} description={emptyDescription} />
              </td>
            </tr>
          ) : (
            data.map(row => (
              <tr
                key={keyExtractor(row)}
                className={cn(
                  'border-b border-border last:border-0 transition-colors',
                  onRowClick && 'cursor-pointer hover:bg-gray-50/70',
                )}
                onClick={() => onRowClick?.(row)}
              >
                {columns.map(col => (
                  <td key={col.key} className={cn('px-4 py-3 text-sm', col.className)}>
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, totalPages, totalItems, pageSize, onPageChange }: PaginationProps) {
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t border-border">
      <p className="text-xs text-text-muted">
        Showing {start}–{end} of {totalItems} results
      </p>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
          disabled={page === 1}
          className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed text-text-secondary"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
          <button
            key={p}
            onClick={() => onPageChange(p)}
            className={cn(
              'w-7 h-7 rounded text-xs font-medium transition-colors',
              p === page ? 'bg-primary text-white' : 'text-text-secondary hover:bg-gray-100',
            )}
          >
            {p}
          </button>
        ))}
        <button
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
          disabled={page === totalPages}
          className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed text-text-secondary"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
