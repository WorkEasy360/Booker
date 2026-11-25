import React from 'react';
import { cn } from '@/lib/utils';

// Small building blocks shared by the Settings sections and My Account, in the WorkEasy360 Booking style.

export function Toggle({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
  /** Accessible name when no visible label is linked to the switch. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-primary' : 'bg-gray-300',
      )}
    >
      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-6' : 'translate-x-1')} />
    </button>
  );
}

/** One white rounded card with a title, an optional description and an optional action on the right. */
export function Section({ title, description, action, children, id }: {
  title: string; description?: string; action?: React.ReactNode; children: React.ReactNode; id?: string;
}) {
  return (
    <section id={id} className="panel p-5 sm:p-6" aria-labelledby={id ? `${id}-title` : undefined}>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-lg font-semibold text-text-primary">{title}</h2>
          {description && <p className="text-sm text-text-secondary mt-1">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A labelled on/off row: title and hint on the left, the switch on the right. */
export function SwitchRow({ title, hint, checked, onChange, disabled, children }: {
  title: string; hint?: React.ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text-primary">{title}</p>
          {hint && <div className="text-sm text-text-secondary mt-0.5">{hint}</div>}
        </div>
        <Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} />
      </div>
      {children}
    </div>
  );
}

/** Green gradient save button (`btn-primary`). */
export function SaveButton({ busy, disabled, children = 'Save Changes', type = 'submit', onClick }: {
  busy?: boolean; disabled?: boolean; children?: React.ReactNode; type?: 'submit' | 'button'; onClick?: () => void;
}) {
  return (
    <button type={type} onClick={onClick} disabled={busy || disabled} className="btn-primary min-h-[42px] px-5">
      {busy ? 'Saving…' : children}
    </button>
  );
}

export function LoadError({ message }: { message: string }) {
  return <p role="alert" className="text-sm text-red-600">Could not load these settings ({message}). Saving is disabled so nothing is overwritten.</p>;
}

export function Loading() {
  return <p className="text-sm text-text-muted">Loading…</p>;
}

/** Small coloured state label. */
export function Pill({ tone, children }: { tone: 'green' | 'gray' | 'blue' | 'amber' | 'red'; children: React.ReactNode }) {
  const tones = {
    green: 'bg-[#DDF6E5] text-[#15803D]',
    gray: 'bg-gray-100 text-gray-600',
    blue: 'bg-[#E3EEFF] text-[#2563EB]',
    amber: 'bg-amber-50 text-amber-700',
    red: 'bg-[#FDE4E4] text-[#DC2626]',
  };
  return <span className={cn('inline-flex items-center px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap', tones[tone])}>{children}</span>;
}
