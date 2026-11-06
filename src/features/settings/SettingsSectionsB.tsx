import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { timeZoneOptions } from '@/lib/utils';
import { Button, Input, Select, Textarea, useToast } from '@/components/ui';
import { Toggle, Section } from './SettingsSectionsA';
import { settingsApi, api, authApi, type RoleDescription, type SessionInfo } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate } from '@/lib/utils';
import { CURRENCY_OPTIONS } from '@/lib/currency';
import { DEFAULT_TIMEZONE, DEFAULT_DATE_FORMAT, DEFAULT_CURRENCY, setDateDisplayFormat } from '@/lib/regional';
import { TwoFactorSection } from './TwoFactorSection';
import { useLanguage } from '@/i18n/LanguageContext';
import { LANGUAGES, isLanguage } from '@/i18n/messages';

interface OrgSettings {
  timezone?: string;
  currency?: string;
  dateFormat?: string;
  timeFormat?: string;
  cancellationPolicy?: string;
}

// ─── Cancellation Policy ─────────────────────────────────────────────────────

const DEADLINE_OPTS = [
  { value: '1', label: '1 hour before' }, { value: '2', label: '2 hours before' },
  { value: '4', label: '4 hours before' }, { value: '12', label: '12 hours before' },
  { value: '24', label: '24 hours before' }, { value: '48', label: '48 hours before' },
];

export function CancellationSection() {
  const toast = useToast();
  const [policy, setPolicy] = useState({
    allowCancellation: true, cancelDeadline: '24',
    allowRescheduling: true, rescheduleDeadline: '12',
    hasFee: false, feeAmount: '25',
    policyText: 'Free cancellation up to 24 hours before the appointment. Cancellations within 24 hours may incur a fee.',
  });
  const [saving, setSaving] = useState(false);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    settingsApi.get().then(raw => {
      setLoadState('ready');
      const d = raw as OrgSettings;
      if (d.cancellationPolicy) {
        try {
          const saved = JSON.parse(d.cancellationPolicy);
          setPolicy(p => ({ ...p, ...saved }));
        } catch { /* non-JSON — legacy text field */ }
      }
    }).catch((e: Error) => setLoadState({ error: e.message || 'Failed to load settings' }));
  }, []);

  const set = (key: string, value: string | boolean) => setPolicy(p => ({ ...p, [key]: value }));

  async function handleSave() {
    setSaving(true);
    try {
      await settingsApi.update({ cancellationPolicy: JSON.stringify(policy) });
      toast.success('Cancellation policy saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Cancellation Policy" description="Define how cancellations and rescheduling are handled">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-text-primary">Allow cancellation</p>
            <p className="text-xs text-text-secondary mt-0.5">Customers can cancel their bookings</p>
          </div>
          <Toggle checked={policy.allowCancellation} onChange={v => set('allowCancellation', v)} />
        </div>
        {policy.allowCancellation && (
          <Select label="Cancellation deadline" options={DEADLINE_OPTS} value={policy.cancelDeadline} onChange={e => set('cancelDeadline', e.target.value)} />
        )}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div>
            <p className="text-sm font-medium text-text-primary">Allow rescheduling</p>
            <p className="text-xs text-text-secondary mt-0.5">Customers can move their appointments</p>
          </div>
          <Toggle checked={policy.allowRescheduling} onChange={v => set('allowRescheduling', v)} />
        </div>
        {policy.allowRescheduling && (
          <Select label="Rescheduling deadline" options={DEADLINE_OPTS} value={policy.rescheduleDeadline} onChange={e => set('rescheduleDeadline', e.target.value)} />
        )}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div>
            <p className="text-sm font-medium text-text-primary">Cancellation fee</p>
            <p className="text-xs text-text-secondary mt-0.5">Charge a fee for late cancellations</p>
          </div>
          <Toggle checked={policy.hasFee} onChange={v => set('hasFee', v)} />
        </div>
        {policy.hasFee && (
          <Input label="Fee amount (USD)" type="number" min="0" value={policy.feeAmount} onChange={e => set('feeAmount', e.target.value)} prefix="$" />
        )}
        <Textarea label="Policy text" value={policy.policyText} onChange={e => set('policyText', e.target.value)} rows={3} hint="Displayed to customers during the booking process" />
        <div className="flex justify-end">
          {typeof loadState === 'object' && <p className="text-sm text-red-600">Could not load current settings ({loadState.error}). Saving is disabled.</p>}
          <Button onClick={handleSave} disabled={saving || loadState !== 'ready'}>{saving ? 'Saving…' : 'Save Changes'}</Button>
        </div>
      </div>
    </Section>
  );
}

// ─── Notifications redirect ───────────────────────────────────────────────────

export function NotificationsSection() {
  return (
    <Section title="Notifications" description="Manage notification templates for customers and staff">
      <div className="flex flex-col items-center text-center py-10 gap-4">
        <div className="w-14 h-14 rounded-xl bg-primary-light flex items-center justify-center">
          <ExternalLink className="w-7 h-7 text-primary" />
        </div>
        <div>
          <p className="font-semibold text-text-primary">Notification Templates</p>
          <p className="text-sm text-text-secondary mt-1 max-w-sm">
            Configure email and SMS templates — including confirmation, reminder and cancellation messages — from the dedicated Notifications page.
          </p>
        </div>
        <Link to="/notifications">
          <Button icon={<ExternalLink className="w-4 h-4" />}>Go to Notifications</Button>
        </Link>
      </div>
    </Section>
  );
}

// ─── Roles & Permissions ─────────────────────────────────────────────────────

// Plain-language names for the permissions the server enforces.
const PERMISSION_LABELS: Record<string, string> = {
  'catalog:read': 'See services, staff, workspaces and business settings',
  'customers:read': 'See customers',
  'customers:write': 'Add and edit customers',
  'appointments:read': "See everyone's appointments",
  'appointments:read_own': 'See their own appointments',
  'appointments:write': 'Book, change and cancel appointments',
  'emails:send': 'Resend booking emails',
  'reports:read': 'See reports and the dashboard',
  'services:write': 'Add and edit services',
  'resources:write': 'Add and edit resources',
  'booking_pages:write': 'Create and publish booking pages',
  'workspaces:write': 'Add and edit workspaces',
  'staff:manage': 'Manage staff and their sign-in access',
  'settings:write': 'Change business settings',
  'ai:use': 'Use the assistant',
  'ai:admin': 'Rebuild the assistant knowledge index',
};

/** Read-only view of the roles the server enforces. Roles are fixed; choose one when inviting a staff member. */
export function RolesSection() {
  const { user } = useAuth();
  const [data, setData] = useState<{ permissions: string[]; roles: RoleDescription[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authApi.roles().then(setData).catch((e: Error) => setError(e.message || 'Could not load roles'));
  }, []);

  return (
    <Section title="Roles & Permissions" description="What each role can do. These rules are enforced by the server for every request.">
      {error ? (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      ) : !data ? (
        <p className="text-sm text-text-muted">Loading roles…</p>
      ) : (
        <>
          <p className="text-sm text-text-secondary mb-4">
            You are signed in as <strong className="text-text-primary">{data.roles.find(r => r.role === user?.role)?.label ?? user?.role}</strong>.
            The person who created the business is an administrator. Staff members get a sign-in (as Staff or Manager) when an administrator invites them from their staff profile.
          </p>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="text-left py-2 pr-4 text-text-secondary font-medium">Permission</th>
                  {data.roles.map(r => <th key={r.role} scope="col" className="text-center py-2 px-3 text-text-secondary font-medium">{r.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.permissions.map(p => (
                  <tr key={p} className="border-b border-border last:border-0">
                    <th scope="row" className="py-2.5 pr-4 text-left font-normal text-text-primary">{PERMISSION_LABELS[p] ?? p}</th>
                    {data.roles.map(r => {
                      const has = r.permissions.includes(p);
                      return (
                        <td key={r.role} className="py-2.5 px-3 text-center">
                          <span aria-label={has ? 'Allowed' : 'Not allowed'} className={has ? 'text-primary font-semibold' : 'text-text-muted'}>{has ? '✓' : '—'}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

// ─── Security ────────────────────────────────────────────────────────────────

export function SecuritySection() {
  const toast = useToast();
  const { user } = useAuth();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function changePassword() {
    const errs: Record<string, string> = {};
    if (!pw.current) errs.current = 'Current password is required.';
    if (!pw.next) errs.next = 'New password is required.';
    else if (pw.next.length < 8) errs.next = 'Must be at least 8 characters.';
    else if (!/[A-Z]/.test(pw.next)) errs.next = 'Must contain an uppercase letter.';
    else if (!/[0-9]/.test(pw.next)) errs.next = 'Must contain a number.';
    if (!pw.confirm) errs.confirm = 'Please confirm your new password.';
    else if (pw.next !== pw.confirm) errs.confirm = 'Passwords do not match.';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      await api.put('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      setFieldErrors({});
      toast.success('Password updated successfully');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <Section title="Change Password">
        <form className="space-y-3 max-w-md" noValidate onSubmit={e => { e.preventDefault(); changePassword(); }}>
          {/* Tells password managers which account the new password belongs to. */}
          <input type="email" name="username" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
          <Input label="Current password" type="password" autoComplete="current-password" value={pw.current}
            onChange={e => { setPw(p => ({ ...p, current: e.target.value })); setFieldErrors(f => ({ ...f, current: '' })); }}
            error={fieldErrors.current} />
          <Input label="New password" type="password" autoComplete="new-password" value={pw.next}
            onChange={e => { setPw(p => ({ ...p, next: e.target.value })); setFieldErrors(f => ({ ...f, next: '' })); }}
            hint="Min. 8 characters, one uppercase, one number"
            error={fieldErrors.next} />
          <Input label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirm}
            onChange={e => { setPw(p => ({ ...p, confirm: e.target.value })); setFieldErrors(f => ({ ...f, confirm: '' })); }}
            error={fieldErrors.confirm} />
          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={saving}>{saving ? 'Updating…' : 'Update Password'}</Button>
          </div>
        </form>
      </Section>

      <TwoFactorSection />

      <ActiveSessions />
    </div>
  );
}

// ─── Active sessions ─────────────────────────────────────────────────────────

/** Sign-ins of this account that are still valid. Ending them signs those browsers out on their next request. */
function ActiveSessions() {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const load = () => authApi.sessions().then(list => { setSessions(list); setError(null); }).catch((e: Error) => setError(e.message || 'Could not load sessions'));
  useEffect(() => { load(); }, []);

  async function endOthers() {
    setEnding(true);
    try {
      const { ended } = await authApi.endOtherSessions();
      toast.success(ended ? `Signed out ${ended} other session${ended === 1 ? '' : 's'}` : 'No other sessions were signed in');
      await load();
    } catch (e) {
      toast.error('Could not sign out other sessions', (e as Error).message);
    } finally {
      setEnding(false);
    }
  }

  const others = sessions?.filter(x => !x.current).length ?? 0;
  return (
    <Section title="Active Sessions" description="Browsers and devices currently signed in to your account">
      {error ? (
        <p role="alert" className="text-sm text-red-600">{error}</p>
      ) : !sessions ? (
        <p className="text-sm text-text-muted">Loading sessions…</p>
      ) : (
        <>
          <ul className="divide-y divide-border mb-4">
            {sessions.map(x => (
              <li key={x.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span className="text-text-primary">
                  Signed in {formatDate(x.createdAt, 'MMM d, yyyy h:mm a')}
                  {x.current && <span className="ml-2 text-xs font-semibold text-primary">This browser</span>}
                </span>
                <span className="text-xs text-text-muted">Expires {formatDate(x.expiresAt, 'MMM d')}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-text-muted">Changing your password also signs out every other session.</p>
            <Button variant="secondary" size="sm" disabled={ending || others === 0} onClick={endOthers}>
              {ending ? 'Signing out…' : `Sign out other sessions${others ? ` (${others})` : ''}`}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

// ─── Language & Region ───────────────────────────────────────────────────────

export function LanguageSection() {
  const toast = useToast();
  const language = useLanguage();
  const [lang, setLang] = useState({ timezone: DEFAULT_TIMEZONE, dateFormat: DEFAULT_DATE_FORMAT, timeFormat: '12h', currency: DEFAULT_CURRENCY });
  const [saving, setSaving] = useState(false);

  const [loadState, setLoadState] = useState<'loading' | 'ready' | { error: string }>('loading');

  useEffect(() => {
    settingsApi.get().then(raw => {
      setLoadState('ready');
      const d = raw as OrgSettings;
      setLang(l => ({
        ...l,
        timezone:   d.timezone   ?? l.timezone,
        currency:   d.currency   ?? l.currency,
        dateFormat: d.dateFormat ?? l.dateFormat,
        timeFormat: d.timeFormat ?? l.timeFormat,
      }));
    }).catch((e: Error) => setLoadState({ error: e.message || 'Failed to load settings' }));
  }, []);

  const set = (key: string, value: string) => setLang(l => ({ ...l, [key]: value }));

  async function handleSave() {
    setSaving(true);
    try {
      await settingsApi.update({ timezone: lang.timezone, currency: lang.currency, dateFormat: lang.dateFormat, timeFormat: lang.timeFormat });
      setDateDisplayFormat(lang.dateFormat);
      toast.success('Language & region settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Language & Region" description="Set your preferred language, timezone and display formats">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Select label={language.t('language.label')} value={language.lang}
            onChange={e => { if (isLanguage(e.target.value)) language.setLang(e.target.value); }}
            options={LANGUAGES.map(l => ({ value: l.code, label: l.label }))}
            hint="Applies right away in this browser: menus, statuses and the customer booking pages. Other screens are in English for now." />
        </div>
        <div className="col-span-2">
          <Select label="Timezone" value={lang.timezone} onChange={e => set('timezone', e.target.value)}
            options={timeZoneOptions(lang.timezone)} />
        </div>
        <Select label="Date format" value={lang.dateFormat} onChange={e => set('dateFormat', e.target.value)}
          options={[{ value: 'MM/DD/YYYY', label: 'MM/DD/YYYY' }, { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY' }, { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD' }]} />
        <Select label="Currency" value={lang.currency} onChange={e => set('currency', e.target.value)}
          options={CURRENCY_OPTIONS}
          hint="Used for new services and for report totals. Existing services keep their own currency until you edit them." />
        <div className="col-span-2">
          <p className="text-sm font-medium text-text-primary mb-2">Time format</p>
          <div className="flex items-center gap-6">
            {[{ value: '12h', label: '12-hour (1:00 PM)' }, { value: '24h', label: '24-hour (13:00)' }].map(opt => (
              <label key={opt.value} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="radio" name="timeFormat" value={opt.value} checked={lang.timeFormat === opt.value} onChange={() => set('timeFormat', opt.value)} className="accent-primary w-4 h-4" />
                <span className="text-sm text-text-primary">{opt.label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-5 flex items-center justify-end gap-3">
        {typeof loadState === 'object' && (
          <p className="text-sm text-red-600 mr-auto">Could not load current settings ({loadState.error}). Saving is disabled so existing settings are not overwritten.</p>
        )}
        <Button onClick={handleSave} disabled={saving || loadState !== 'ready'}>{saving ? 'Saving…' : 'Save Changes'}</Button>
      </div>
    </Section>
  );
}
