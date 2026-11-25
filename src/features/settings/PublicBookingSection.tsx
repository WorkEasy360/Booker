import React, { useEffect, useState } from 'react';
import { Copy, ExternalLink, Link2 } from 'lucide-react';
import { Select, useToast } from '@/components/ui';
import { bookingLinkApi, settingsApi, type DefaultBookingPage } from '@/api/client';
import { Section, SwitchRow, SaveButton, LoadError, Loading } from './ui';
import { useOrgSettings } from './orgSettings';
import { bookingUrl } from '@/lib/bookingUrl';

const CUTOFF_OPTIONS = [1, 2, 4, 12, 24, 48, 72].map(h => ({ value: String(h), label: `${h} hour${h === 1 ? '' : 's'} before the appointment` }));
const DEFAULT_CUTOFF = 24;

/**
 * 4.4 Public Booking: accept online bookings on/off for the one default booking page, and the cutoff after which
 * customers can no longer reschedule or cancel through their secure link (they see the business contact instead).
 */
export function PublicBookingSection({ canEdit, canEditCutoff }: { canEdit: boolean; canEditCutoff: boolean }) {
  const toast = useToast();
  const [page, setPage] = useState<DefaultBookingPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const { org, state, reload } = useOrgSettings();
  const [cutoff, setCutoff] = useState(String(DEFAULT_CUTOFF));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    bookingLinkApi.get().then(setPage).catch((e: Error) => setPageError(e.message || 'Could not load your booking link'));
  }, []);
  useEffect(() => {
    if (org) setCutoff(String(Number(org.bookingRules.customerChangeCutoffHours) || DEFAULT_CUTOFF));
  }, [org]);

  async function setAccepting(isPublished: boolean) {
    setToggling(true);
    try {
      setPage(await bookingLinkApi.update({ isPublished }));
      toast.success(isPublished ? 'Online bookings are on' : 'Online bookings are off', isPublished ? undefined : 'Your booking link shows that online booking is unavailable. Existing appointments are kept.');
    } catch (e) {
      toast.error('Online bookings were not changed', (e as Error).message);
    } finally { setToggling(false); }
  }

  async function saveCutoff(e: React.FormEvent) {
    e.preventDefault();
    if (!org) return;
    setSaving(true);
    try {
      // Booking rules are saved as a whole: keep the other saved rules.
      await settingsApi.update({ bookingRules: { ...org.bookingRules, customerChangeCutoffHours: Number(cutoff) } });
      await reload();
      toast.success('Cutoff saved');
    } catch (err) {
      toast.error('Cutoff was not saved', (err as Error).message);
    } finally { setSaving(false); }
  }

  const url = page ? bookingUrl(page.slug) : '';

  return (
    <div className="space-y-6">
      <Section id="public-booking" title="Public Booking" description="Customers book through your one booking link — no account or login needed.">
        {pageError ? <p role="alert" className="text-sm text-red-600">{pageError}</p> : !page ? <Loading /> : (
          <div className="space-y-5">
            <SwitchRow title="Accept online bookings" checked={page.isPublished} disabled={!canEdit || toggling} onChange={v => void setAccepting(v)}
              hint={page.isPublished ? 'Customers can book available times through your link.' : 'Your link is off. You can still book appointments yourself.'} />
            <div>
              <p className="text-sm font-semibold text-text-primary mb-2 flex items-center gap-2"><Link2 className="w-4 h-4 text-primary" aria-hidden="true" />Booking link</p>
              <div className="flex items-stretch border border-border rounded-lg overflow-hidden">
                <input readOnly value={url} aria-label="Booking link" className="flex-1 min-w-0 px-3 py-2.5 text-sm text-text-primary bg-white focus:outline-none" onFocus={e => e.currentTarget.select()} />
                <button type="button" aria-label="Copy booking link" title="Copy"
                  onClick={() => navigator.clipboard.writeText(url).then(() => toast.success('Booking link copied')).catch(() => toast.error('Could not copy the link'))}
                  className="px-3 border-l border-border text-text-secondary hover:bg-muted hover:text-primary">
                  <Copy className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
              <a href={url} target="_blank" rel="noreferrer"
                className="mt-3 inline-flex items-center justify-center gap-2 w-full sm:w-auto px-5 py-2.5 rounded-lg bg-primary-light text-primary-dark text-sm font-semibold hover:bg-[#d6f1df]">
                <ExternalLink className="w-4 h-4" aria-hidden="true" />Preview Booking Page
              </a>
            </div>
          </div>
        )}
      </Section>

      <Section id="cutoff" title="Customer Rescheduling / Cancellation" description="Customers manage their own booking through the secure link in their confirmation.">
        {state === 'loading' ? <Loading /> : typeof state === 'object' ? <LoadError message={state.error} /> : (
          <form onSubmit={saveCutoff} className="space-y-4 max-w-md">
            <Select label="Allow changes until" value={cutoff} onChange={e => setCutoff(e.target.value)} options={CUTOFF_OPTIONS} disabled={!canEditCutoff}
              hint="After the cutoff, customers see your business contact details instead." />
            {canEditCutoff && <div className="flex justify-end"><SaveButton busy={saving} /></div>}
          </form>
        )}
      </Section>
    </div>
  );
}
