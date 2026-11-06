import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, authApi, getMe } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import AuthLayout from './AuthLayout';
import { NewPasswordInput, Notice, PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_LINK } from './authUi';
import { passwordProblem } from './authRules';
import { useEmailLinkToken } from './useEmailLinkToken';

type View =
  | { kind: 'checking' }
  | { kind: 'offline'; message: string }
  | { kind: 'ready'; expiresAt: string }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; message: string };

// The emailed link carries its token after # (never sent to servers, never logged). The page reads it, removes it
// from the address bar, and checks it before asking for a new password. Nobody is signed in afterwards.
export default function ResetPasswordPage() {
  const { user, logout } = useAuth();
  const [view, setView] = useState<View>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const token = useEmailLinkToken(
    t => { setPassword(''); setConfirm(''); setError(''); check(t); },
    () => setView({ kind: 'failed', message: 'This password-reset link is incomplete. Open the link from your email again, or request a new one.' }),
  );

  function check(t: string) {
    setView({ kind: 'checking' });
    authApi.inspectPasswordReset(t)
      .then(d => setView({ kind: 'ready', expiresAt: d.expiresAt }))
      .catch((e: Error) => setView(e instanceof ApiError
        ? { kind: 'failed', message: e.message }
        : { kind: 'offline', message: 'The server could not be reached to check this link. Check your connection and try again.' }));
  }

  useEffect(() => { if (view.kind === 'done' || view.kind === 'failed') noticeRef.current?.focus(); }, [view.kind]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setError('');
    const problem = passwordProblem(password);
    if (problem) { setError(problem); return; }
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setSaving(true);
    try {
      const { message } = await authApi.resetPassword(token, password, confirm);
      setPassword(''); setConfirm('');
      // Every session of the account ended with the reset. If this browser was signed in to it, forget that here too
      // (a different account signed in here is left alone).
      if (user) await getMe().catch(e => (e instanceof ApiError && e.status === 401 ? logout() : undefined));
      setView({ kind: 'done', message });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) setView({ kind: 'failed', message: err.message });
      else setError(err instanceof Error ? err.message : 'The password could not be changed. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const frame = (subtitle: string, children: React.ReactNode) => (
    <AuthLayout title="Choose a new password" subtitle={subtitle} documentTitle="Reset password" redirectIfSignedIn={false}>
      {children}
    </AuthLayout>
  );

  if (view.kind === 'checking') {
    return frame('Checking your link…', <p role="status" className="text-sm text-gray-600 text-center">Checking your link…</p>);
  }

  if (view.kind === 'offline') {
    return frame('Your link could not be checked', <>
      <Notice tone="error">{view.message}</Notice>
      <button type="button" onClick={() => check(token)} className={PRIMARY_BUTTON}>Try again</button>
    </>);
  }

  if (view.kind === 'failed') {
    return frame('This link can’t be used', <>
      <Notice ref={noticeRef} tone="error">{view.message}</Notice>
      <Link to="/forgot-password" className={PRIMARY_BUTTON}>Request a new link</Link>
      <Link to="/login" className={`${SECONDARY_BUTTON} mt-3`}>Back to sign in</Link>
    </>);
  }

  if (view.kind === 'done') {
    return frame('Your password has been changed', <>
      <Notice ref={noticeRef} tone="success">{view.message}</Notice>
      <Link to="/login" className={PRIMARY_BUTTON}>Sign in</Link>
    </>);
  }

  return frame('Reset the password for your account', <>
    {error && <Notice tone="error" id="reset-error">{error}</Notice>}
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div>
        <label htmlFor="reset-password" className="block text-sm font-medium text-gray-700 mb-1.5">New password</label>
        <NewPasswordInput id="reset-password" value={password} onChange={setPassword} show={showPw} onToggle={() => setShowPw(v => !v)}
          describedBy={error ? 'reset-error reset-password-hint' : 'reset-password-hint'} invalid={!!error} />
        <p id="reset-password-hint" className="text-xs text-gray-500 mt-1">At least 8 characters, with an uppercase letter and a number.</p>
      </div>
      <div>
        <label htmlFor="reset-confirm" className="block text-sm font-medium text-gray-700 mb-1.5">Confirm new password</label>
        <NewPasswordInput id="reset-confirm" value={confirm} onChange={setConfirm} show={showPw} onToggle={() => setShowPw(v => !v)}
          describedBy={error ? 'reset-error' : undefined} invalid={!!error} />
      </div>
      <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
        {saving ? 'Saving…' : 'Save new password'}
      </button>
      <p className="text-xs text-gray-500 text-center">
        Saving signs you out on every device. This link works once and expires {new Date(view.expiresAt).toLocaleString()}.
      </p>
    </form>
    <p className="mt-5 text-center text-sm text-gray-500">
      <Link to="/login" className={TEXT_LINK}>Back to sign in</Link>
    </p>
  </>);
}
