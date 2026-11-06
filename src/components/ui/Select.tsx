import React from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  hint?: string;
  options: { value: string; label: string; disabled?: boolean }[];
  placeholder?: string;
}

export function Select({ label, error, hint, options, placeholder, className, id, ...props }: SelectProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
  const descId = inputId ? `${inputId}-desc` : undefined;
  const hasDesc = !!(error || hint);
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="block text-sm font-medium text-text-primary mb-1.5">
          {label}
          {props.required && <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={hasDesc && descId ? descId : undefined}
          className={cn(
            'input-field appearance-none pr-9',
            error && 'border-red-400 focus:ring-red-400',
            className,
          )}
          {...props}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map(o => (
            <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted pointer-events-none" aria-hidden="true" />
      </div>
      {error && <p id={descId} className="mt-1.5 text-xs text-red-600" role="alert">{error}</p>}
      {hint && !error && <p id={descId} className="mt-1.5 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
