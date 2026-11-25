import { useEffect, useState } from 'react';
import { settingsApi } from '@/api/client';
import { setDateDisplayFormat } from '@/lib/regional';

/** The selected organization's business details that every screen shows (name, timezone, contact). */
export interface BusinessInfo {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  timezone: string;
  dateFormat?: string;
  timeFormat?: '12h' | '24h';
  appointmentLocation?: string;
}

let cached: Promise<BusinessInfo> | null = null;
const listeners = new Set<(b: BusinessInfo) => void>();

function load(): Promise<BusinessInfo> {
  if (!cached) {
    cached = (settingsApi.get() as Promise<BusinessInfo>).then(b => {
      setDateDisplayFormat(b.dateFormat);
      return b;
    });
    cached.catch(() => { cached = null; });
  }
  return cached;
}

/** Call after Business Details are saved so the header and screens show the new values. */
export function refreshBusiness(): void {
  cached = null;
  load().then(b => listeners.forEach(fn => fn(b))).catch(() => {});
}

/** Loaded once per session and shared by the header and screens. */
export function useBusiness(): { business: BusinessInfo | null; error: string | null } {
  const [business, setBusiness] = useState<BusinessInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const update = (b: BusinessInfo) => { if (live) setBusiness(b); };
    listeners.add(update);
    load().then(update).catch((e: Error) => { if (live) setError(e.message || 'Could not load business details'); });
    return () => { live = false; listeners.delete(update); };
  }, []);
  return { business, error };
}

/** Clears the cache on sign-out so the next account starts fresh. */
export function forgetBusiness(): void {
  cached = null;
}
