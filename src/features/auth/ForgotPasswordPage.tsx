import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { authApi } from '@/api/client';
import AuthLayout from './AuthLayout';
import { INPUT, Notice, PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_LINK } from './authUi';
import { EMAIL_PATTERN } from './authRules';

// Business owners, managers and staff all reset their password here. The answer is the same whether or not the
// address has an account; only the mailbox owner learns more.
export default function ForgotPasswordPage() {
  const location = useLocation();
  const [email, setEmail] = useState(() => (location.state as { email?: string } | null)?.email ?? '');
  const [error, setError] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sentRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (sent) sentRef.current?.focus(); }, [sent]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError('');
    const value = email.trim();
    if (!value) { setError('Enter the email address you sign in with.'); emailRef.current?.focus(); return; }
    if (!EMAIL_PATTERN.test(value)) { setError('Enter a valid email address.'); emailRef.current?.focus(); return; }
    setLoading(true);
    try {
      const { message } = await authApi.forgotPassword(value);
      setSent(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The request could not be sent. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title="Reset your password" subtitle="We’ll email you a link to choose a new one" documentTitle="Forgot password">
      {sent ? (
        <>
          <Notice ref={sentRef} tone="success">{sent}</Notice>
          <p className="text-sm text-gray-700 mb-5">
            The link in the email works once and expires after 60 minutes. If nothing arrives within a few minutes,
            check your spam folder.
          </p>
          <Link to="/login" className={PRIMARY_BUTTON}>Back to sign in</Link>
          <button type="button" onClick={() => setSent(null)} className={`${SECONDARY_BUTTON} mt-3`}>Use a different email</button>
        </>
      ) : (
        <>
          {error && <Notice tone="error" id="forgot-error">{error}</Notice>}
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label htmlFor="forgot-email" className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
              <input ref={emailRef} id="forgot-email" type="email" autoComplete="email" value={email}
                onChange={e => setEmail(e.target.value)} placeholder="you@company.com"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'forgot-error forgot-email-hint' : 'forgot-email-hint'} className={INPUT} />
              <p id="forgot-email-hint" className="text-xs text-gray-500 mt-1">The email address you use to sign in.</p>
            </div>
            <button type="submit" disabled={loading} className={PRIMARY_BUTTON}>
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
          <p className="mt-5 text-center text-sm text-gray-500">
            Remembered it? <Link to="/login" className={TEXT_LINK}>Sign in</Link>
          </p>
        </>
      )}
    </AuthLayout>
  );
}
