import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, Languages, Users, FileText, RotateCcw, Eye } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Button, Input, PageHeader, Select, Textarea, useToast } from '@/components/ui';
import {
  notificationsApi, notificationPlatformApi, type EmailTemplate, type EmailTemplateKind, type NotificationPlatformSettings, type NotificationPreferences,
} from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { BookingEmailsSection } from './BookingEmailsSection';
import { BusinessCalendar, BusinessRecipients, DeliveryChannels, ModeBanner, ReminderTimes, RulesMatrix, Section } from './NotificationPlatformSections';

// What the business sends, to whom, on which channel and in which language: reminders and their times, staff alerts,
// the rules for every event and channel, business recipients, the business calendar, and the business's own email
// texts. The server checks every value; this page only offers and explains them. The on/off switches for reminders and
// staff alerts are the same settings as the matching boxes under "Who gets what", so both always show the same state.

const KIND_LABEL: Record<EmailTemplateKind, string> = {
  confirmation: 'Booking confirmation', reschedule: 'Reschedule notice', cancellation: 'Cancellation notice', reminder: 'Reminder',
};

function TemplateEditor({ template, placeholders, canEdit, onSaved }: {
  template: EmailTemplate; placeholders: string[]; canEdit: boolean; onSaved: () => void;
}) {
  const toast = useToast();
  const [subject, setSubject] = useState(template.subject);
  const [intro, setIntro] = useState(template.intro);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSubject(template.subject); setIntro(template.intro); setPreview(null); setError(null); }, [template]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const id = `tpl-${template.kind}`;
  return (
    <div className="border border-border rounded-lg p-4" data-template={template.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-text-primary">{KIND_LABEL[template.kind]}</h3>
        <span className="text-xs text-text-muted">{template.custom ? 'Your own text' : 'Built-in text'}</span>
      </div>
      <div className="space-y-3">
        <Input id={`${id}-subject`} label="Subject" value={subject} maxLength={150} disabled={!canEdit} onChange={e => { setSubject(e.target.value); setError(null); }} />
        <Textarea id={`${id}-intro`} label="Opening text" rows={3} maxLength={1000} value={intro} disabled={!canEdit} onChange={e => { setIntro(e.target.value); setError(null); }}
          hint="The booking details, the link to manage the booking and the footer are always added below this text." />
        <p className="text-xs text-text-muted">You can use: {placeholders.map(p => <code key={p} className="mr-1">{`{${p}}`}</code>)}</p>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        {preview && (
          <div className="bg-muted rounded-lg p-3 text-xs" aria-label="Preview">
            <p className="font-semibold text-text-primary mb-1">{preview.subject}</p>
            <pre className="whitespace-pre-wrap font-sans text-text-secondary">{preview.text}</pre>
          </div>
        )}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => run(async () => {
              await notificationsApi.saveTemplate(template.kind, subject, intro);
              toast.success(`${KIND_LABEL[template.kind]} saved`);
              onSaved();
            })}>Save</Button>
            <Button size="sm" variant="secondary" icon={<Eye className="w-3.5 h-3.5" />} disabled={busy}
              onClick={() => run(async () => setPreview(await notificationsApi.preview(template.kind, subject, intro)))}>Preview</Button>
            {template.custom && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="w-3.5 h-3.5" />} disabled={busy} onClick={() => run(async () => {
                await notificationsApi.resetTemplate(template.kind);
                toast.success('Back to the built-in text');
                onSaved();
              })}>Use built-in text</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmailTexts({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<{ placeholders: string[]; templates: EmailTemplate[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => notificationsApi.templates().then(setData).catch((e: Error) => setError(e.message || 'Could not load email texts'));
  useEffect(() => { load(); }, []);
  return (
    <Section icon={<FileText className="w-4 h-4 text-primary" aria-hidden="true" />} title="Email texts"
      description="Your own subject and opening text for each booking email, in your own words. Placeholders in braces are filled in for each booking.">
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p>
        : !data ? <p className="text-sm text-text-muted">Loading…</p>
        : <div className="space-y-4">{data.templates.map(t => <TemplateEditor key={t.kind} template={t} placeholders={data.placeholders} canEdit={canEdit} onSaved={load} />)}</div>}
    </Section>
  );
}

export default function NotificationsPage() {
  usePageTitle('Notifications');
  const toast = useToast();
  const { can } = useAuth();
  const canEdit = can('settings:write');
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [platform, setPlatform] = useState<NotificationPlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([notificationsApi.preferences(), notificationPlatformApi.settings()]);
      setPrefs(p);
      setPlatform(s);
      setError(null);
    } catch (e) { setError((e as Error).message || 'Could not load notification settings'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function save(changes: Partial<NotificationPreferences>) {
    setSaving(true);
    try {
      await notificationsApi.savePreferences(changes);
      toast.success('Notification settings saved');
      await load();
    } catch (e) {
      toast.error('Not saved', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const disabled = !canEdit || saving;
  return (
    <div className="page-container">
      <PageHeader title="Notifications" description="Booking emails, text messages, WhatsApp, reminders, staff alerts and the business calendar" breadcrumbs={[{ label: 'Notifications' }]} />
      {platform && <ModeBanner data={platform} />}
      <BookingEmailsSection />
      {error ? <p role="alert" className="mt-6 text-sm text-red-600">{error}</p>
        : !prefs || !platform ? <p className="mt-6 text-sm text-text-muted">Loading notification settings…</p> : (
          <>
            <DeliveryChannels data={platform} />

            <Section icon={<BellRing className="w-4 h-4 text-primary" aria-hidden="true" />} title="Reminders to customers"
              description="An email before each booking that is still scheduled or confirmed, at each reminder time. Text and WhatsApp reminders are switched on under “Who gets what”. Bookings made after a reminder time get none for that time.">
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" className="w-4 h-4 accent-primary" checked={prefs.remindersEnabled} disabled={disabled}
                  onChange={e => save({ remindersEnabled: e.target.checked })} data-setting="reminders" />
                Send reminder emails
              </label>
              <ReminderTimes data={platform} canEdit={canEdit} onSaved={load} />
            </Section>

            <Section icon={<Users className="w-4 h-4 text-primary" aria-hidden="true" />} title="Alerts to staff"
              description="An email to the staff member when a booking with them is made, moved or cancelled (from the booking page, the dashboard or the assistant). It names the customer and links to the appointment; contact details stay in the app. Each staff member can also get text or WhatsApp alerts, set on their profile.">
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input type="checkbox" className="w-4 h-4 accent-primary" checked={prefs.staffAlertsEnabled} disabled={disabled}
                  onChange={e => save({ staffAlertsEnabled: e.target.checked })} data-setting="staff-alerts" />
                Send staff alert emails
              </label>
            </Section>

            <RulesMatrix data={platform} canEdit={canEdit} onSaved={load} />
            <BusinessRecipients canEdit={canEdit} onSaved={load} />
            <BusinessCalendar data={platform} canEdit={canEdit} onSaved={load} />

            <Section icon={<Languages className="w-4 h-4 text-primary" aria-hidden="true" />} title="Language for customers"
              description="The language of booking emails, text messages and WhatsApp messages, and the one your booking pages open in. Visitors can still switch the page to the other language.">
              <div className="w-56">
                <Select label="Language" value={prefs.bookingLanguage} disabled={disabled}
                  onChange={e => save({ bookingLanguage: e.target.value as 'en' | 'hi' })}
                  options={[{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिन्दी (Hindi)' }]} />
              </div>
            </Section>
            {!canEdit && <p className="mt-2 text-xs text-text-muted">Only people who can change business settings can change these.</p>}
          </>
        )}
      <EmailTexts canEdit={canEdit} />
    </div>
  );
}
