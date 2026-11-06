import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { authApi } from '@/api/client';
import { INPUT, Notice, PRIMARY_BUTTON, SECONDARY_BUTTON, TEXT_LINK } from './authUi';
import { EMAIL_PATTERN } from './authRules';

/** Asks for a new confirmation link. The answer is the same for every address. */
export default function ResendLink({ email: knownEmail }: { email?: string }) {
  const [email, setEmail] = useState(knownEmail ?? '');
  const [error, setError] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sending) return;
    setError('');
    setSent(null);
    const value = email.trim();
    if (!EMAIL_PATTERN.test(value)) { setError('Enter the email address you signed up with.'); return; }
    setSending(true);
    try {
      setSent((await authApi.resendVerification(value)).message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A new link could not be requested. Please try again.');
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-3">
      {sent && <Notice tone="success">{sent}</Notice>}
      {error && <Notice tone="error" id="resend-error">{error}</Notice>}
      {knownEmail === undefined && (
        <div>
          <label htmlFor="resend-email" className="block text-sm font-medium text-gray-700 mb-1.5">Email you signed up with</label>
          <input id="resend-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com" aria-invalid={error ? true : undefined} aria-describedby={error ? 'resend-error' : undefined}
            className={INPUT} />
        </div>
      )}
      <button type="submit" disabled={sending} className={knownEmail === undefined ? PRIMARY_BUTTON : SECONDARY_BUTTON}>
        {sending ? 'Sending…' : 'Send a new link'}
      </button>
      {knownEmail === undefined && (
        <p className="text-center text-sm text-gray-500 pt-2"><Link to="/login" className={TEXT_LINK}>Back to sign in</Link></p>
      )}
    </form>
  );
}
