import React, { useEffect, useState } from 'react';
import { UserRound, CreditCard, Wallet, ExternalLink } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Button, Input, PageTitle, Select, useToast } from '@/components/ui';
import { ACCOUNT_PORTAL_URL, api, authApi, mediaApi, type SessionInfo } from '@/api/client';
import { ImageUpload } from '@/components/ImageUpload';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate } from '@/lib/utils';
import { roleLabel } from '@/lib/permissions';
import { useLanguage } from '@/i18n/LanguageContext';
import { LANGUAGES, isLanguage } from '@/i18n/messages';
import { Section, SaveButton } from '../settings/ui';
import { TwoFactorSection } from './TwoFactorSection';

/**
 * My Account (account menu): the signed-in person's profile and security, using the shared WorkEasy360 account.
 * Plan & Billing and Wallets & Usage open the shared account portal in the current organization.
 */
export default function MyAccountPage() {
  usePageTitle('My Account');
  const { user, updateUser } = useAuth();
  return (
    <div className="page-container">
      <PageTitle icon={UserRound} title="My Account" description="Your profile, password and sign-in security." />
      <div className="mt-6 grid xl:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <Section id="profile" title="Profile" description="Shared across WorkEasy360 products.">
            <div className="mb-5">
              <ImageUpload
                label="Profile photo"
                value={user?.photoUrl ?? null}
                upload={file => mediaApi.uploadMyPhoto(file)}
                remove={() => mediaApi.removeMyPhoto()}
                onChange={url => updateUser({ photoUrl: url })}
                shape="round"
              />
            </div>
            <dl className="grid sm:grid-cols-3 gap-4">
              <div><dt className="text-xs font-medium text-text-muted uppercase tracking-wide">Name</dt><dd className="text-sm font-semibold text-text-primary mt-1">{user?.name ?? '—'}</dd></div>
              <div className="min-w-0"><dt className="text-xs font-medium text-text-muted uppercase tracking-wide">Email</dt><dd className="text-sm font-semibold text-text-primary mt-1 break-all">{user?.email ?? '—'}</dd></div>
              <div><dt className="text-xs font-medium text-text-muted uppercase tracking-wide">Role</dt><dd className="text-sm font-semibold text-text-primary mt-1">{roleLabel(user?.role) || '—'}</dd></div>
            </dl>
          </Section>
          <ChangePassword />
          <TwoFactorSection />
          <ActiveSessions />
        </div>
        <div className="space-y-6">
          <LanguageCard />
          <Section id="account-links" title="Plan & Wallets" description="Managed in your WorkEasy360 account.">
            <div className="space-y-2">
              <PortalLink href={`${ACCOUNT_PORTAL_URL}/billing`} icon={CreditCard} label="Plan & Billing" />
              <PortalLink href={`${ACCOUNT_PORTAL_URL}/wallets`} icon={Wallet} label="Wallets & Usage" />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

function PortalLink({ href, icon: Icon, label }: { href: string; icon: React.ElementType; label: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer"
      className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border hover:bg-muted transition-colors min-h-[48px]">
      <Icon className="w-5 h-5 text-primary" aria-hidden="true" />
      <span className="flex-1 text-sm font-semibold text-text-primary">{label}</span>
      <ExternalLink className="w-4 h-4 text-text-muted" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function LanguageCard() {
  const language = useLanguage();
  return (
    <Section id="language" title="Language">
      <Select aria-label={language.t('language.label')} value={language.lang}
        onChange={e => { if (isLanguage(e.target.value)) language.setLang(e.target.value); }}
        options={LANGUAGES.map(l => ({ value: l.code, label: l.label }))}
        hint="Applies right away in this browser." />
    </Section>
  );
}

function ChangePassword() {
  const toast = useToast();
  const { user } = useAuth();
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof pw, v: string) => { setPw(p => ({ ...p, [k]: v })); setErrors(e => ({ ...e, [k]: '' })); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!pw.current) errs.current = 'Enter your current password.';
    if (!pw.next) errs.next = 'Enter a new password.';
    else if (pw.next.length < 8) errs.next = 'Use at least 8 characters.';
    else if (!/[A-Z]/.test(pw.next)) errs.next = 'Include an uppercase letter.';
    else if (!/[0-9]/.test(pw.next)) errs.next = 'Include a number.';
    if (pw.next && pw.confirm !== pw.next) errs.confirm = 'Passwords do not match.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      await api.put('/auth/password', { currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      toast.success('Password updated', 'Your other sessions were signed out.');
    } catch (err) {
      toast.error('Password was not changed', (err as Error).message);
    } finally { setSaving(false); }
  }

  return (
    <Section id="password" title="Change Password">
      <form onSubmit={submit} noValidate className="space-y-3 max-w-md">
        {/* Tells password managers which account the new password belongs to. */}
        <input type="email" name="username" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
        <Input label="Current password" type="password" autoComplete="current-password" value={pw.current} onChange={e => set('current', e.target.value)} error={errors.current} />
        <Input label="New password" type="password" autoComplete="new-password" value={pw.next} onChange={e => set('next', e.target.value)} error={errors.next}
          hint="At least 8 characters, one uppercase letter and one number." />
        <Input label="Confirm new password" type="password" autoComplete="new-password" value={pw.confirm} onChange={e => set('confirm', e.target.value)} error={errors.confirm} />
        <div className="flex justify-end pt-1"><SaveButton busy={saving}>Update Password</SaveButton></div>
      </form>
    </Section>
  );
}

/** Sign-ins of this account that are still valid. Ending them signs those browsers out on their next request. */
function ActiveSessions() {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const load = () => authApi.sessions().then(list => { setSessions(list); setError(null); }).catch((e: Error) => setError(e.message || 'Could not load sessions'));
  useEffect(() => { void load(); }, []);

  async function endOthers() {
    setEnding(true);
    try {
      const { ended } = await authApi.endOtherSessions();
      toast.success(ended ? `Signed out ${ended} other session${ended === 1 ? '' : 's'}` : 'No other sessions were signed in');
      await load();
    } catch (e) {
      toast.error('Could not sign out other sessions', (e as Error).message);
    } finally { setEnding(false); }
  }

  const others = sessions?.filter(x => !x.current).length ?? 0;
  return (
    <Section id="sessions" title="Active Sessions" description="Browsers and devices signed in to your account.">
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : !sessions ? <p className="text-sm text-text-muted">Loading…</p> : (
        <>
          <ul className="divide-y divide-border mb-4">
            {sessions.map(x => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <span className="text-text-primary">
                  Signed in {formatDate(x.createdAt, 'MMM d, yyyy h:mm a')}
                  {x.current && <span className="ml-2 text-xs font-semibold text-primary">This browser</span>}
                </span>
                <span className="text-xs text-text-muted">Expires {formatDate(x.expiresAt, 'MMM d')}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" disabled={ending || others === 0} onClick={endOthers}>
              {ending ? 'Signing out…' : `Sign out other sessions${others ? ` (${others})` : ''}`}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}
