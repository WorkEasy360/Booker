import React, { useEffect, useId, useRef, useState } from 'react';
import { Search, UserPlus, X, Phone, Mail, Check } from 'lucide-react';
import { Avatar, Spinner } from '@/components/ui';
import { customersApi } from '@/api/client';
import { cn } from '@/lib/utils';
import { PHONE_PLACEHOLDER } from '@/lib/validation';
import { useAuth } from '@/contexts/AuthContext';
import {
  validateContact, contactBody, conflictFrom, normalizeCustomer,
  type ContactInput, type ContactErrors, type SaveConflict,
} from './customerData';
import { ConflictNotice } from './ConflictNotice';

export interface PickedCustomer { id: string; name: string; phone: string | null; email: string | null }

interface CustomerPickerProps {
  value: PickedCustomer | null;
  onChange: (customer: PickedCustomer | null) => void;
  disabled?: boolean;
}

const toPicked = (raw: unknown): PickedCustomer => {
  const c = normalizeCustomer(raw);
  return { id: c.id, name: c.name, phone: c.phone, email: c.email };
};

/**
 * Find an existing customer by name, phone or email, or add a new one inline (name + phone or email) without leaving
 * the form. When the contact details already belong to a customer, offers that customer instead of creating a copy.
 */
export function CustomerPicker({ value, onChange, disabled }: CustomerPickerProps) {
  const { can } = useAuth();
  const canAdd = can('customers:write');
  const listId = useId();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [adding, setAdding] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) { setResults([]); setSearching(false); return; }
    setSearching(true);
    timer.current = setTimeout(() => {
      customersApi.list(q)
        .then(rows => { setResults(rows.map(toPicked).slice(0, 8)); setSearchError(null); })
        .catch((e: Error) => { setResults([]); setSearchError(e.message || 'Search failed.'); })
        .finally(() => setSearching(false));
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  function pick(c: PickedCustomer) {
    onChange(c);
    setQuery('');
    setOpen(false);
    setAdding(false);
  }

  if (value) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-primary/40 bg-primary-light/50 px-4 py-3">
        <Avatar name={value.name} size="md" color="#16A34A" decorative />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-text-primary truncate">{value.name}</p>
          <p className="text-sm text-text-secondary truncate">{[value.phone, value.email].filter(Boolean).join(' · ') || 'No contact details'}</p>
        </div>
        {!disabled && (
          <button type="button" onClick={() => onChange(null)} aria-label={`Change customer (${value.name})`}
            className="inline-flex items-center gap-1 min-h-[40px] px-3 rounded-lg text-sm font-medium text-text-secondary hover:bg-white hover:text-text-primary">
            <X className="w-4 h-4" aria-hidden="true" />Change
          </button>
        )}
      </div>
    );
  }

  if (adding) {
    return <InlineAdd initialQuery={query} onCancel={() => setAdding(false)} onSaved={pick} disabled={disabled} />;
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" aria-hidden="true" />
        <input
          type="search"
          role="combobox"
          aria-expanded={open && !!query.trim()}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Find customer by name, phone or email"
          placeholder="Search customer by name, phone or email"
          disabled={disabled}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, results.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, -1)); }
            else if (e.key === 'Enter' && active >= 0 && results[active]) { e.preventDefault(); pick(results[active]); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          className="w-full h-12 rounded-xl border border-border bg-white pl-11 pr-4 text-[15px] placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary disabled:bg-gray-50"
        />
      </div>

      {open && query.trim() && (
        <div id={listId} role="listbox" className="absolute z-30 left-0 right-0 mt-1.5 max-h-80 overflow-y-auto rounded-xl border border-border bg-white shadow-dropdown py-1.5">
          {searching && <div className="flex items-center gap-2 px-4 py-3 text-sm text-text-secondary"><Spinner />Searching…</div>}
          {!searching && searchError && <p className="px-4 py-3 text-sm text-red-600">{searchError}</p>}
          {!searching && !searchError && results.length === 0 && <p className="px-4 py-3 text-sm text-text-secondary">No customer found for “{query.trim()}”.</p>}
          {!searching && results.map((c, i) => (
            <button key={c.id} type="button" role="option" aria-selected={i === active} onClick={() => pick(c)}
              className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left min-h-[52px] hover:bg-gray-50', i === active && 'bg-gray-50')}>
              <Avatar name={c.name} size="sm" color="#16A34A" decorative />
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-text-primary truncate">{c.name}</p>
                <p className="text-sm text-text-secondary truncate">{[c.phone, c.email].filter(Boolean).join(' · ')}</p>
              </div>
            </button>
          ))}
          {canAdd && (
            <button type="button" onClick={() => { setAdding(true); setOpen(false); }}
              className="flex w-full items-center gap-2 border-t border-border mt-1 px-4 py-3 text-[15px] font-medium text-primary hover:bg-primary-light/60 min-h-[48px]">
              <UserPlus className="w-4 h-4" aria-hidden="true" />Add new customer{query.trim() ? ` “${query.trim()}”` : ''}
            </button>
          )}
        </div>
      )}

      {canAdd && !open && (
        <button type="button" disabled={disabled} onClick={() => setAdding(true)}
          className="mt-2 inline-flex items-center gap-1.5 min-h-[40px] text-sm font-medium text-primary hover:text-primary-dark disabled:opacity-50">
          <UserPlus className="w-4 h-4" aria-hidden="true" />Add new customer
        </button>
      )}
    </div>
  );
}

/** Prefill the right field from what was typed in the search box. */
function prefill(q: string): ContactInput {
  const v = q.trim();
  if (v.includes('@')) return { name: '', phone: '', email: v };
  if (/^\+?[\d\s\-()]{6,}$/.test(v)) return { name: '', phone: v, email: '' };
  return { name: v, phone: '', email: '' };
}

function InlineAdd({ initialQuery, onCancel, onSaved, disabled }: {
  initialQuery: string; onCancel: () => void; onSaved: (c: PickedCustomer) => void; disabled?: boolean;
}) {
  const [values, setValues] = useState<ContactInput>(() => prefill(initialQuery));
  const [errors, setErrors] = useState<ContactErrors>({});
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof ContactInput>(key: K, v: string) {
    const next = { ...values, [key]: v };
    setValues(next);
    setConflict(null);
    setError(null);
    if (Object.keys(errors).length) setErrors(validateContact(next));
  }

  async function save() {
    const found = validateContact(values);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    try {
      onSaved(toPicked(await customersApi.create(contactBody(values))));
    } catch (err) {
      const c = await conflictFrom(err, values);
      if (c) setConflict(c);
      else setError(err instanceof Error ? err.message : 'Could not add the customer.');
    } finally {
      setSaving(false);
    }
  }

  async function chooseExisting(id: string) {
    const match = conflict?.matches.find(m => m.id === id);
    if (match) onSaved({ id: match.id, name: match.name, phone: match.phone, email: match.email });
    else onSaved(toPicked(await customersApi.get(id)));
  }

  const input = 'w-full h-11 rounded-lg border bg-white px-3 text-[15px] placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary';
  const border = (bad?: string) => (bad ? 'border-red-400' : 'border-border');

  // Not a <form>: this sits inside the appointment form, and nested forms are invalid HTML.
  return (
    <div className="rounded-xl border border-border bg-gray-50/70 p-4 space-y-3" role="group" aria-label="New customer">
      <div className="flex items-center justify-between">
        <p className="text-[15px] font-semibold text-text-primary flex items-center gap-2"><UserPlus className="w-4 h-4 text-primary" aria-hidden="true" />New customer</p>
        <button type="button" onClick={onCancel} className="text-sm font-medium text-text-secondary hover:text-text-primary min-h-[36px] px-2">Cancel</button>
      </div>
      <div>
        <label htmlFor="picker-name" className="block text-sm font-medium text-text-primary mb-1">Name <span className="text-red-500" aria-hidden="true">*</span></label>
        <input id="picker-name" className={`${input} ${border(errors.name)}`} value={values.name} maxLength={100} disabled={disabled}
          onChange={e => set('name', e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
        {errors.name && <p className="mt-1 text-sm text-red-600">{errors.name}</p>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="picker-phone" className="block text-sm font-medium text-text-primary mb-1"><Phone className="inline w-3.5 h-3.5 mr-1" aria-hidden="true" />Phone</label>
          <input id="picker-phone" type="tel" inputMode="tel" className={`${input} ${border(errors.phone || errors.contact)}`} value={values.phone}
            placeholder={PHONE_PLACEHOLDER} disabled={disabled} onChange={e => set('phone', e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          {errors.phone && <p className="mt-1 text-sm text-red-600">{errors.phone}</p>}
        </div>
        <div>
          <label htmlFor="picker-email" className="block text-sm font-medium text-text-primary mb-1"><Mail className="inline w-3.5 h-3.5 mr-1" aria-hidden="true" />Email</label>
          <input id="picker-email" type="email" inputMode="email" className={`${input} ${border(errors.email || errors.contact)}`} value={values.email}
            placeholder="name@example.com" disabled={disabled} onChange={e => set('email', e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          {errors.email && <p className="mt-1 text-sm text-red-600">{errors.email}</p>}
        </div>
      </div>
      <p className={errors.contact ? 'text-sm text-red-600' : 'text-xs text-text-secondary'}>{errors.contact ?? 'A phone number or an email address is required (at least one).'}</p>
      {conflict && <ConflictNotice conflict={conflict} onUse={id => void chooseExisting(id)} />}
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="flex justify-end">
        <button type="button" className="btn-primary min-h-[44px]" disabled={saving || disabled} onClick={() => void save()}>
          <Check className="w-4 h-4" aria-hidden="true" />{saving ? 'Adding…' : 'Add Customer'}
        </button>
      </div>
    </div>
  );
}

