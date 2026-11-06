import React, { useState } from 'react';
import { Calendar, Download } from 'lucide-react';
import { publicApi } from '@/api/client';
import { useLanguage } from '@/i18n/LanguageContext';
import { googleCalendarUrl, outlookCalendarUrl, type CalendarEventInput } from '@/lib/calendarLinks';

// The customer adds the booking to their own calendar: Google and Outlook open with the event filled in, and the .ics
// file (Apple Calendar and others) comes from the server with the manage token. Nothing here says the booking "was
// added": only the customer can save it in their calendar.

const BUTTON = 'flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border text-sm text-text-secondary hover:text-text-primary hover:bg-muted transition-colors';

export function AddToCalendar({ event, manageToken }: { event: CalendarEventInput; manageToken?: string }) {
  const { t } = useLanguage();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function download() {
    if (!manageToken) { setNote(t('cal.fileUnavailable')); return; }
    setBusy(true);
    setNote(null);
    try {
      const file = await publicApi.calendarFile(manageToken);
      const url = URL.createObjectURL(new Blob([file.content], { type: 'text/calendar' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setNote(t('cal.fileFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5" data-add-to-calendar>
      <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-3">{t('cal.title')}</p>
      <div className="flex flex-wrap gap-2">
        <a className={BUTTON} href={googleCalendarUrl(event)} target="_blank" rel="noopener noreferrer" data-calendar="google">
          <Calendar className="w-3.5 h-3.5" aria-hidden="true" />{t('cal.google')}
        </a>
        <a className={BUTTON} href={outlookCalendarUrl(event)} target="_blank" rel="noopener noreferrer" data-calendar="outlook">
          <Calendar className="w-3.5 h-3.5" aria-hidden="true" />{t('cal.outlook')}
        </a>
        <button type="button" className={BUTTON} onClick={download} disabled={busy} data-calendar="ics">
          <Download className="w-3.5 h-3.5" aria-hidden="true" />{t('cal.file')}
        </button>
      </div>
      <p className="text-xs text-text-muted mt-2">{t('cal.hint')}</p>
      {note && <p role="status" className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2 mt-2">{note}</p>}
    </div>
  );
}
