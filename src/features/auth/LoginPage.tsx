import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, type AuthUser } from '@/api/client';
import { useLanguage } from '@/i18n/LanguageContext';
import { canOpen, homePath } from '@/lib/permissions';
import { PRODUCT_NAME } from '@/lib/brand';
import AuthLayout from './AuthLayout';

export default function LoginPage() {
  const { login, completeTwoFactor } = useAuth();
  const { t } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string })?.from;
  const signupSuccess = new URLSearchParams(location.search).get('registered') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);

  /** Return to the page they came from when their role can open it; otherwise their role's home page. */
  function goOn(u: AuthUser) {
    navigate(from && canOpen(u.permissions, from) ? from : homePath(u.permissions), { replace: true });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!email.trim() || !password) { setError(t('login.required')); return; }
    setLoading(true);
    try {
      const outcome = await login(email.trim(), password);
      if ('twoFactor' in outcome) {
        setPassword('');
        setChallenge(outcome.twoFactor.challenge);
        return;
      }
      goOn(outcome.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (challenge) {
    return (
      <AuthLayout title="Two-factor sign-in" subtitle={`Sign in to ${PRODUCT_NAME}`} documentTitle="Sign in">
        <SecondStep
          email={email.trim()}
          onSubmit={async factor => goOn(await completeTwoFactor(challenge, factor))}
          onRestart={message => { setChallenge(null); setError(message ?? ''); }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('login.title')} subtitle={t('login.subtitle', { product: PRODUCT_NAME })} documentTitle="Sign in">
      {signupSuccess && (
        <div className="mb-4 flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2.5">
          <span className="mt-0.5">✓</span>
          <span>Account created! Sign in below.</span>
        </div>
      )}

      {error && (
        <div id="login-error" className="mb-4 flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2.5" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 mb-1.5">
            {t('login.email')}
          </label>
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:border-transparent transition-colors"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label htmlFor="login-password" className="block text-sm font-medium text-gray-700">
              {t('login.password')}
            </label>
          </div>
          <div className="relative">
            <input
              id="login-password"
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              className="w-full px-3 py-2.5 pr-10 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:border-transparent transition-colors"
            />
            <button
              type="button"
              onClick={() => setShowPw(v => !v)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none focus:text-gray-600"
              tabIndex={-1}
            >
              {showPw ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
            </button>
          </div>
          {/* After the field, so Tab still goes from email straight to password. */}
          <div className="mt-1.5 text-right">
            <Link to="/forgot-password" state={{ email: email.trim() }} className="text-xs text-[#00BF62] hover:text-[#008F49] font-medium focus:outline-none focus:underline">
              {t('login.forgot')}
            </Link>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 rounded-lg bg-[#00BF62] hover:bg-[#008F49] text-white text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:ring-offset-2"
        >
          {loading ? t('login.submitting') : t('login.submit')}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-gray-500">
        {t('login.noAccount')}{' '}
        <Link to="/signup" className="text-[#00BF62] hover:text-[#008F49] font-medium focus:outline-none focus:underline">
          {t('login.create')}
        </Link>
      </p>
    </AuthLayout>
  );
}

/** The second sign-in step: a 6-digit code from the authenticator app, or a recovery code. */
function SecondStep({ email, onSubmit, onRestart }: {
  email: string;
  onSubmit: (factor: { code: string } | { recoveryCode: string }) => Promise<void>;
  onRestart: (message?: string) => void;
}) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, [useRecovery]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!useRecovery && !/^\d{3}\s?\d{3}$/.test(v)) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    if (useRecovery && v.replace(/[^a-z2-7]/gi, '').length !== 16) { setError('Enter one of your recovery codes, for example abcd-efgh-ijkl-mnop.'); return; }
    setBusy(true);
    setError('');
    try {
      await onSubmit(useRecovery ? { recoveryCode: v } : { code: v.replace(/\s/g, '') });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TWO_FACTOR_CHALLENGE_INVALID') {
        onRestart(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      setValue('');
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const id = useRecovery ? 'login-recovery-code' : 'login-code';
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <p className="flex items-start gap-2 text-sm text-gray-600">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-[#00BF62]" aria-hidden="true" />
        <span>
          {useRecovery
            ? <>Enter one of the recovery codes you saved for <strong>{email}</strong>. Each code works once.</>
            : <>Open your authenticator app and enter the 6-digit code for <strong>{email}</strong>.</>}
        </span>
      </p>
      {error && (
        <div id="login-code-error" className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2.5" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1.5">
          {useRecovery ? 'Recovery code' : 'Authentication code'}
        </label>
        <input
          ref={input}
          id={id}
          type="text"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete={useRecovery ? 'off' : 'one-time-code'}
          spellCheck={false}
          maxLength={useRecovery ? 40 : 7}
          value={value}
          onChange={e => { setValue(e.target.value); setError(''); }}
          placeholder={useRecovery ? 'abcd-efgh-ijkl-mnop' : '123456'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'login-code-error' : undefined}
          className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:border-transparent transition-colors font-mono tracking-wider"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="w-full py-2.5 rounded-lg bg-[#00BF62] hover:bg-[#008F49] text-white text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:ring-offset-2"
      >
        {busy ? 'Checking…' : 'Verify and sign in'}
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={() => { setUseRecovery(v => !v); setValue(''); setError(''); }}
          className="text-[#00BF62] hover:text-[#008F49] font-medium focus:outline-none focus:underline">
          {useRecovery ? 'Use the authenticator app' : 'Use a recovery code'}
        </button>
        <button type="button" onClick={() => onRestart()} className="text-gray-500 hover:text-gray-700 focus:outline-none focus:underline">
          Start over
        </button>
      </div>
    </form>
  );
}
