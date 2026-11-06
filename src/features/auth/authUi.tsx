import React, { forwardRef } from 'react';
import { AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';

// Shared pieces of the account-email pages (forgot password, reset password, confirm email), in the style of the
// sign-in and sign-up pages.

export const INPUT = 'w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:border-transparent transition-colors';
export const PRIMARY_BUTTON = 'block w-full py-2.5 rounded-lg bg-[#00BF62] hover:bg-[#008F49] text-white text-sm font-semibold text-center transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:ring-offset-2';
export const SECONDARY_BUTTON = 'block w-full py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-center text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:ring-offset-2';
export const TEXT_LINK = 'text-[#00BF62] hover:text-[#008F49] font-medium focus:outline-none focus:underline';

/**
 * A success or problem message. Problems are announced at once, successes politely. It can take focus, so a page
 * that changes state moves keyboard and screen-reader users to the news.
 */
export const Notice = forwardRef<HTMLDivElement, { tone: 'success' | 'error'; id?: string; children: React.ReactNode }>(
  function Notice({ tone, id, children }, ref) {
    const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
    return (
      <div ref={ref} id={id} tabIndex={-1} role={tone === 'success' ? 'status' : 'alert'}
        className={`mb-4 flex items-start gap-2 text-sm rounded-lg px-3 py-2.5 focus:outline-none ${tone === 'success' ? 'text-emerald-700 bg-emerald-50' : 'text-red-600 bg-red-50'}`}>
        <Icon className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
        <span>{children}</span>
      </div>
    );
  },
);

/** A new-password field with a show/hide button, like the sign-up page. */
export function NewPasswordInput({ id, value, onChange, show, onToggle, describedBy, invalid }: {
  id: string; value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void; describedBy?: string; invalid?: boolean;
}) {
  return (
    <div className="relative">
      <input id={id} type={show ? 'text' : 'password'} autoComplete="new-password" value={value}
        onChange={e => onChange(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined}
        className={`${INPUT} pr-10`} />
      <button type="button" onClick={onToggle} aria-label={show ? 'Hide password' : 'Show password'} tabIndex={-1}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none focus:text-gray-600">
        {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
