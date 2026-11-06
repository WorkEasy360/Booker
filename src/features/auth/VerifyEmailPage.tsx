import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, authApi, type VerificationPreview } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import AuthLayout from './AuthLayout';
import { Notice, PRIMARY_BUTTON, SECONDARY_BUTTON } from './authUi';
import { useEmailLinkToken } from './useEmailLinkToken';
import ResendLink from './ResendLink';

type View =
  | { kind: 'checking' }
  | { kind: 'offline'; message: string }
  | { kind: 'ready'; preview: VerificationPreview }
  | { kind: 'failed'; message: string; code?: string }
  | { kind: 'done'; message: string };

// Confirms a sign-up from the emailed link (#token=…, never sent to servers). The account is created by the click on
// "Confirm my email", not by opening the page, and the person then signs in normally.
export default function VerifyEmailPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [view, setView] = useState<View>({ kind: 'checking' });
  const [saving, setSaving] = useState(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const token = useEmailLinkToken(
    check,
    () => setView({ kind: 'failed', message: 'This confirmation link is incomplete. Open the link from your email again, or request a new one below.', code: 'VERIFY_INVALID' }),
  );

  function check(t: string) {
    setView({ kind: 'checking' });
    authApi.inspectVerification(t)
      .then(preview => setView({ kind: 'ready', preview }))
      .catch((e: Error) => setView(e instanceof ApiError
        ? { kind: 'failed', message: e.message, code: e.code }
        : { kind: 'offline', message: 'The server could not be reached to check this link. Check your connection and try again.' }));
  }

  useEffect(() => { if (view.kind === 'done' || view.kind === 'failed') noticeRef.current?.focus(); }, [view.kind]);

  async function confirm() {
    if (saving) return;
    setSaving(true);
    try {
      const { message } = await authApi.verifyEmail(token);
      setView({ kind: 'done', message });
    } catch (err) {
      if (err instanceof ApiError && err.status !== 429) setView({ kind: 'failed', message: err.message, code: err.code });
      else setView({ kind: 'offline', message: err instanceof Error ? err.message : 'Your email could not be confirmed. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  async function signOutThenSignIn() {
    await logout();
    navigate('/login');
  }

  const frame = (subtitle: string, children: React.ReactNode) => (
    <AuthLayout title="Confirm your email" subtitle={subtitle} redirectIfSignedIn={false}>
      {children}
    </AuthLayout>
  );

  // Someone signed in to another account in this browser must sign out before using the new one.
  const signIn = user
    ? <>
        <p className="text-sm text-gray-700 mb-4">You are signed in as <strong className="break-words">{user.email}</strong> in this browser. Sign out first to sign in to the new account.</p>
        <button type="button" onClick={signOutThenSignIn} className={PRIMARY_BUTTON}>Sign out and go to sign in</button>
      </>
    : <Link to="/login" className={PRIMARY_BUTTON}>Sign in</Link>;

  if (view.kind === 'checking') {
    return frame('Checking your link…', <p role="status" className="text-sm text-gray-600 text-center">Checking your link…</p>);
  }

  if (view.kind === 'offline') {
    return frame('Your link could not be checked', <>
      <Notice tone="error">{view.message}</Notice>
      <button type="button" onClick={() => check(token)} className={PRIMARY_BUTTON}>Try again</button>
    </>);
  }

  if (view.kind === 'done') {
    return frame('Your account is ready', <>
      <Notice ref={noticeRef} tone="success">{view.message}</Notice>
      {signIn}
    </>);
  }

  if (view.kind === 'failed') {
    const confirmedAlready = view.code === 'VERIFY_USED' || view.code === 'VERIFY_ACCOUNT_EXISTS';
    return frame(confirmedAlready ? 'Sign in to continue' : 'This link can’t be used', <>
      <Notice ref={noticeRef} tone="error">{view.message}</Notice>
      {confirmedAlready
        ? <>{signIn}<Link to="/forgot-password" className={`${SECONDARY_BUTTON} mt-3`}>Forgot password?</Link></>
        : <ResendLink />}
    </>);
  }

  const { preview } = view;
  return frame('One more step to create your account', <>
    <p className="text-sm text-gray-700 mb-5">
      Confirm <strong className="break-words">{preview.email}</strong> to finish creating the account for <strong>{preview.businessName}</strong>.
    </p>
    <button type="button" onClick={confirm} disabled={saving} className={PRIMARY_BUTTON}>
      {saving ? 'Confirming…' : 'Confirm my email'}
    </button>
    <p className="text-xs text-gray-500 text-center mt-3">
      This link works once and expires {new Date(preview.expiresAt).toLocaleString()}.
    </p>
  </>);
}
