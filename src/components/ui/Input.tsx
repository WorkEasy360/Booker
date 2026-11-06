import React from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string;
  error?: string;
  hint?: string;
  prefix?: React.ReactNode;
  suffix?: React.ReactNode;
}

export function Input({ label, error, hint, prefix, suffix, className, id, ...props }: InputProps) {
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
      <div className="relative flex items-center">
        {prefix && <span className="absolute left-3 text-text-muted" aria-hidden="true">{prefix}</span>}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={hasDesc && descId ? descId : undefined}
          className={cn(
            'input-field',
            prefix && 'pl-10',
            suffix && 'pr-10',
            error && 'border-red-400 focus:ring-red-400 focus:border-red-400',
            className,
          )}
          {...props}
        />
        {suffix && <span className="absolute right-3 text-text-muted" aria-hidden="true">{suffix}</span>}
      </div>
      {error && <p id={descId} className="mt-1.5 text-xs text-red-600" role="alert">{error}</p>}
      {hint && !error && <p id={descId} className="mt-1.5 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Textarea({ label, error, hint, className, id, ...props }: TextareaProps) {
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
      <textarea
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={hasDesc && descId ? descId : undefined}
        className={cn(
          'input-field resize-none',
          error && 'border-red-400 focus:ring-red-400',
          className,
        )}
        {...props}
      />
      {error && <p id={descId} className="mt-1.5 text-xs text-red-600" role="alert">{error}</p>}
      {hint && !error && <p id={descId} className="mt-1.5 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
