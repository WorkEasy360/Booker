import React, { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { Badge, Button, useToast } from '@/components/ui';
import { notificationPlatformApi, type ConsentState } from '@/api/client';
import { formatDate } from '@/lib/utils';

// Whether this customer agreed to booking messages by SMS and WhatsApp, where that came from, and when. Staff can
// record a customer's spoken or written agreement or withdrawal; a STOP reply withdraws it automatically.

const SOURCE: Record<string, string> = { booking_page: 'on the booking page', staff: 'recorded by staff', reply_stop: 'replied STOP', manage_link: 'on the manage-booking page' };

export function CustomerConsentCard({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const toast = useToast();
  const [consent, setConsent] = useState<Record<'sms' | 'whatsapp', ConsentState> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { notificationPlatformApi.consent(customerId).then(setConsent).catch((e: Error) => setError(e.message)); }, [customerId]);

  async function set(channel: 'sms' | 'whatsapp', status: 'granted' | 'revoked') {
    setBusy(true);
    try {
      setConsent(await notificationPlatformApi.saveConsent(customerId, { [channel]: status }));
      toast.success(status === 'granted' ? 'Agreement recorded' : 'Withdrawal recorded');
    } catch (e) { toast.error('Not saved', (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="card p-5 mb-5" data-customer-consent>
      <div className="flex items-center gap-2 mb-1">
        <MessageSquare className="w-4 h-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-text-primary">Text and WhatsApp messages</h3>
      </div>
      <p className="text-xs text-text-secondary mb-3">Booking messages by SMS or WhatsApp go to this customer only while they agree. Record a change only when the customer asked for it.</p>
      {error ? <p className="text-sm text-red-600">{error}</p> : !consent ? <p className="text-sm text-text-muted">Loading…</p> : (
        <ul className="divide-y divide-border">
          {(['sms', 'whatsapp'] as const).map(ch => {
            const c = consent[ch];
            return (
              <li key={ch} className="py-2 flex flex-wrap items-center justify-between gap-2" data-consent-channel={ch}>
                <div>
                  <p className="text-sm text-text-primary">{ch === 'sms' ? 'SMS' : 'WhatsApp'}</p>
                  <p className="text-xs text-text-muted">
                    {c.status === 'none' ? 'Not asked yet' : `${c.status === 'granted' ? 'Agreed' : 'Withdrawn'} ${SOURCE[c.source ?? ''] ?? ''}${c.recordedAt ? `, ${formatDate(c.recordedAt, 'MMM d, yyyy')}` : ''}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant={c.status === 'granted' ? 'success' : c.status === 'revoked' ? 'warning' : 'default'}>
                    {c.status === 'granted' ? 'Agreed' : c.status === 'revoked' ? 'Withdrawn' : 'No'}
                  </Badge>
                  {canEdit && (c.status === 'granted'
                    ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(ch, 'revoked')}>Record withdrawal</Button>
                    : <Button size="sm" variant="ghost" disabled={busy} onClick={() => set(ch, 'granted')}>Record agreement</Button>)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
