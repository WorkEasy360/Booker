import { useCallback, useEffect, useState } from 'react';
import { settingsApi } from '@/api/client';

/** The business record as returned by GET /settings (only the fields the simplified app uses). */
export interface OrgSettings {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  timezone: string;
  /** Single appointment location or online instructions, shown before customers confirm. Optional. */
  appointmentLocation?: string | null;
  bookingRules: Record<string, unknown> & { customerChangeCutoffHours?: number };
}

export type LoadState = 'loading' | 'ready' | { error: string };

/** Loads the business settings once; `reload` fetches them again after a save. */
export function useOrgSettings() {
  const [org, setOrg] = useState<OrgSettings | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const reload = useCallback(() => {
    return (settingsApi.get() as Promise<OrgSettings>)
      .then(o => { setOrg({ ...o, bookingRules: o.bookingRules ?? {} }); setState('ready'); })
      .catch((e: Error) => setState({ error: e.message || 'Request failed' }));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { org, state, reload, setOrg };
}
