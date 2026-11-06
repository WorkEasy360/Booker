import React, { useEffect, useState } from 'react';
import { ShieldCheck, Copy, Download } from 'lucide-react';
import { Button, Input, useToast } from '@/components/ui';
import { authApi, type SecondFactor, type TwoFactorSetup, type TwoFactorStatus } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { formatDate } from '@/lib/utils';
import { COMPANY_NAME } from '@/lib/brand';
import { Section } from './SettingsSectionsA';
import { QrCode } from './QrCode';

// Two-factor sign-in for the signed-in user. Setup: current password → scan the QR code (or type the key) → confirm
// with a code → save the recovery codes, which are shown only once. Turning it off or replacing the codes needs the
// password and a current code. The server enforces all of it; this page only guides.

type Step =
  | { kind: 'idle' }
  | { kind: 'password' }
  | { kind: 'scan'; setup: TwoFactorSetup }
  | { kind: 'codes'; codes: string[] }
  | { kind: 'confirm'; action: 'disable' | 'regenerate' };

const groups = (key: string) => key.match(/.{1,4}/g)?.join(' ') ?? key;

export function TwoFactorSection() {
  const toast = useToast();
  const { user } = useAuth();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => authApi.twoFactorStatus().then(s => { setStatus(s); setLoadError(null); })
    .catch((e: Error) => setLoadError(e.message || 'Could not load two-factor sign-in'));
  useEffect(() => { load(); }, []);

  function reset(next: Step = { kind: 'idle' }) {
    setStep(next); setPassword(''); setCode(''); setError(''); setUseRecovery(false);
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong. Please try again.'); } finally { setBusy(false); }
  }

  const startSetup = () => act(async () => {
    if (!password) { setError('Enter your current password.'); return; }
    const setup = await authApi.twoFactorSetup(password);
    setPassword('');
    setStep({ kind: 'scan', setup });
  });

  const confirmSetup = () => act(async () => {
    if (!/^\d{3}\s?\d{3}$/.test(code.trim())) { setError('Enter the 6-digit code shown in your authenticator app.'); return; }
    const { recoveryCodes, otherSessionsEnded } = await authApi.twoFactorEnable(code.replace(/\s/g, ''));
    reset({ kind: 'codes', codes: recoveryCodes });
    toast.success('Two-factor sign-in is on', otherSessionsEnded ? `Signed out ${otherSessionsEnded} other session${otherSessionsEnded === 1 ? '' : 's'}.` : undefined);
    await load();
  });

  const confirmAction = (action: 'disable' | 'regenerate') => act(async () => {
    if (!password) { setError('Enter your current password.'); return; }
    if (!code.trim()) { setError(useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'); return; }
    const factor: SecondFactor = useRecovery ? { recoveryCode: code.trim() } : { code: code.replace(/\s/g, '') };
    if (action === 'disable') {
      await authApi.twoFactorDisable(password, factor);
      reset();
      toast.success('Two-factor sign-in is off');
    } else {
      const { recoveryCodes } = await authApi.twoFactorRecoveryCodes(password, factor);
      reset({ kind: 'codes', codes: recoveryCodes });
      toast.success('New recovery codes created', 'Your old recovery codes no longer work.');
    }
    await load();
  });

  function download(codes: string[]) {
    const text = `${COMPANY_NAME} recovery codes for ${user?.email ?? 'your account'}\nEach code can be used once.\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workeasy360-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copy(codes: string[]) {
    try { await navigator.clipboard.writeText(codes.join('\n')); toast.success('Recovery codes copied'); }
    catch { toast.error('Could not copy', 'Select the codes and copy them, or download them instead.'); }
  }

  const errorLine = error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null;

  return (
    <Section title="Two-Factor Authentication" description="Ask for a code from an authenticator app each time you sign in, as well as your password">
      {loadError ? (
        <p role="alert" className="text-sm text-red-600">{loadError}</p>
      ) : !status ? (
        <p className="text-sm text-text-muted">Loading…</p>
      ) : step.kind === 'codes' ? (
        <div className="space-y-3 max-w-md">
          <p className="text-sm text-text-primary font-medium">Save your recovery codes</p>
          <p className="text-sm text-text-secondary">
            If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe; they are not shown again.
          </p>
          <ol className="grid grid-cols-2 gap-2 font-mono text-sm bg-muted rounded-lg p-3" aria-label="Recovery codes" data-recovery-codes>
            {step.codes.map(c => <li key={c}>{c}</li>)}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" icon={<Copy className="w-3.5 h-3.5" />} onClick={() => copy(step.codes)}>Copy</Button>
            <Button variant="secondary" size="sm" icon={<Download className="w-3.5 h-3.5" />} onClick={() => download(step.codes)}>Download</Button>
            <Button size="sm" onClick={() => reset()}>I have saved them</Button>
          </div>
        </div>
      ) : step.kind === 'password' ? (
        <form className="space-y-3 max-w-md" noValidate onSubmit={e => { e.preventDefault(); startSetup(); }}>
          <input type="email" name="username" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
          <Input id="two-factor-password" label="Current password" type="password" autoComplete="current-password" value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }} autoFocus />
          {errorLine}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</Button>
            <Button type="button" variant="secondary" onClick={() => reset()}>Cancel</Button>
          </div>
        </form>
      ) : step.kind === 'scan' ? (
        <form className="space-y-4" noValidate onSubmit={e => { e.preventDefault(); confirmSetup(); }}>
          <ol className="list-decimal pl-5 space-y-1 text-sm text-text-secondary">
            <li>Open an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or 1Password).</li>
            <li>Scan this QR code, or enter the key below by hand.</li>
            <li>Type the 6-digit code the app shows.</li>
          </ol>
          <div className="flex flex-col sm:flex-row gap-4 sm:items-center">
            <QrCode value={step.setup.otpauthUrl} label={`QR code to add ${user?.email ?? 'your account'} to an authenticator app`} />
            <div className="min-w-0">
              <p className="text-xs text-text-muted mb-1">Key (time-based)</p>
              <p className="font-mono text-sm text-text-primary break-all select-all" data-setup-key>{groups(step.setup.secret)}</p>
              <p className="text-xs text-text-muted mt-2">This setup expires {formatDate(step.setup.expiresAt, 'h:mm a')}.</p>
            </div>
          </div>
          <div className="max-w-xs">
            <Input id="two-factor-setup-code" label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code}
              onChange={e => { setCode(e.target.value); setError(''); }} placeholder="123456" />
          </div>
          {errorLine}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Checking…' : 'Turn on'}</Button>
            <Button type="button" variant="secondary" onClick={() => reset()}>Cancel</Button>
          </div>
        </form>
      ) : step.kind === 'confirm' ? (
        <form className="space-y-3 max-w-md" noValidate onSubmit={e => { e.preventDefault(); confirmAction(step.action); }}>
          <p className="text-sm text-text-secondary">
            {step.action === 'disable'
              ? 'To turn off two-factor sign-in, confirm your password and a current code.'
              : 'To create new recovery codes, confirm your password and a current code. Your old recovery codes will stop working.'}
          </p>
          <input type="email" name="username" autoComplete="username" value={user?.email ?? ''} readOnly hidden />
          <Input id="two-factor-confirm-password" label="Current password" type="password" autoComplete="current-password" value={password}
            onChange={e => { setPassword(e.target.value); setError(''); }} autoFocus />
          <Input id="two-factor-confirm-code" label={useRecovery ? 'Recovery code' : '6-digit code'} inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete={useRecovery ? 'off' : 'one-time-code'} maxLength={useRecovery ? 40 : 7} value={code}
            onChange={e => { setCode(e.target.value); setError(''); }} />
          <button type="button" className="text-sm text-primary font-medium hover:underline" onClick={() => { setUseRecovery(v => !v); setCode(''); setError(''); }}>
            {useRecovery ? 'Use the authenticator app instead' : 'Use a recovery code instead'}
          </button>
          {errorLine}
          <div className="flex gap-2">
            <Button type="submit" variant={step.action === 'disable' ? 'danger' : 'primary'} disabled={busy}>
              {busy ? 'Checking…' : step.action === 'disable' ? 'Turn off' : 'Create new codes'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => reset()}>Cancel</Button>
          </div>
        </form>
      ) : status.enabled ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2" data-two-factor="on">
            <ShieldCheck className="w-5 h-5 text-primary shrink-0" aria-hidden="true" />
            <div>
              <p className="text-sm font-medium text-primary">On{status.enabledAt ? ` since ${formatDate(status.enabledAt)}` : ''}</p>
              <p className={status.recoveryCodesLeft <= 3 ? 'text-xs text-amber-700 mt-0.5' : 'text-xs text-text-secondary mt-0.5'}>
                {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left
                {status.recoveryCodesLeft <= 3 ? ': create new ones soon.' : '.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => reset({ kind: 'confirm', action: 'regenerate' })}>New recovery codes</Button>
            <Button variant="secondary" size="sm" onClick={() => reset({ kind: 'confirm', action: 'disable' })}>Turn off</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3" data-two-factor="off">
          <div>
            <p className="text-sm font-medium text-text-primary">Off</p>
            <p className="text-xs text-text-secondary mt-0.5">Signing in needs only your password.</p>
          </div>
          <Button size="sm" onClick={() => reset({ kind: 'password' })}>Set up two-factor sign-in</Button>
        </div>
      )}
    </Section>
  );
}
