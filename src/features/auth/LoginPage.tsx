import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle, ShieldCheck, Mail, Lock, LogIn, UserPlus, CalendarDays, CalendarClock, Link2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError, type AuthUser } from '@/api/client';
import { useLanguage } from '@/i18n/LanguageContext';
import { canOpen, homePath } from '@/lib/permissions';
import { PRODUCT_NAME } from '@/lib/brand';
import AuthLayout from './AuthLayout';

const LABEL = 'block text-[16px] sm:text-[18px] lg:text-[19px] lg:leading-[24px] font-semibold lg:font-bold text-[#0F172A] mb-2 lg:mb-[6px]';
const FIELD = 'w-full h-[52px] sm:h-[54px] lg:h-[47px] pl-14 lg:pl-[62px] pr-4 text-[16px] sm:text-[17px] lg:text-[19px] text-[#0F172A] placeholder-[#475569] lg:placeholder-[#3D5470] bg-white border border-[#D5DDE7] lg:border-[1.5px] lg:border-[#D3DCE8] rounded-xl lg:rounded-[12px] focus:outline-none focus:ring-2 focus:ring-[#16A34A] focus:border-transparent transition-colors';
const FIELD_ICON = 'absolute left-4 lg:left-[19px] top-1/2 -translate-y-1/2 w-6 h-6 lg:w-[26px] lg:h-[26px] text-[#334155] pointer-events-none';

export default function LoginPage() {
  const { login, completeTwoFactor } = useAuth();
  const { t, lang } = useLanguage();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string })?.from;
  const signupSuccess = new URLSearchParams(location.search).get('registered') === '1';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(false);
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
      const outcome = await login(email.trim(), password, remember);
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
          onSubmit={async factor => goOn(await completeTwoFactor(challenge, factor, remember))}
          onRestart={message => { setChallenge(null); setError(message ?? ''); }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t('login.title')} subtitle={lang === 'en' ? <>Sign in to access your booking workspace and<br className="hidden lg:inline" /> manage appointments, availability and customer bookings.</> : t('login.subtitle')} documentTitle="Sign in">
      {signupSuccess && (
        <div className="mb-5 flex items-start gap-2 text-sm text-emerald-700 bg-emerald-50 rounded-xl px-4 py-3" role="status">
          <span className="mt-0.5">✓</span>
          <span>Account created! Sign in below.</span>
        </div>
      )}

      {error && (
        <div id="login-error" className="mb-5 flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-xl px-4 py-3" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <label htmlFor="login-email" className={LABEL}>{t('login.email')}</label>
        <div className="relative">
          <Mail className={FIELD_ICON} strokeWidth={1.7} aria-hidden="true" />
          <input
            id="login-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="Enter your email"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            className={FIELD}
          />
        </div>

        <label htmlFor="login-password" className={`${LABEL} mt-5 lg:mt-[17px]`}>{t('login.password')}</label>
        <div className="relative">
          <Lock className={FIELD_ICON} strokeWidth={1.7} aria-hidden="true" />
          <input
            id="login-password"
            type={showPw ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter your password"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'login-error' : undefined}
            className={`${FIELD} pr-14`}
          />
          <button
            type="button"
            onClick={() => setShowPw(v => !v)}
            aria-label={showPw ? 'Hide password' : 'Show password'}
            className="absolute right-2 lg:right-[6px] top-1/2 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-lg text-[#334155] hover:text-[#0F172A] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {showPw ? <EyeOff className="w-6 h-6 lg:w-[30px] lg:h-[30px]" strokeWidth={1.8} aria-hidden="true" /> : <Eye className="w-6 h-6 lg:w-[30px] lg:h-[30px]" strokeWidth={1.8} aria-hidden="true" />}
          </button>
        </div>

        <div className="mt-4 lg:mt-[21px] lg:h-[24px] flex items-center justify-between gap-3">
          <label className="inline-flex items-center gap-3 lg:gap-[12px] lg:ml-[6px] cursor-pointer select-none text-[15px] sm:text-[17px] lg:text-[19px] text-[#1E293B] lg:text-[#111827] lg:font-medium">
            <input
              type="checkbox"
              checked={remember}
              onChange={e => setRemember(e.target.checked)}
              className="w-[22px] h-[22px] lg:w-[23px] lg:h-[23px] rounded-md border-2 border-[#94A3B8] accent-[#16A34A] cursor-pointer"
            />
            Remember me
          </label>
          <Link to="/forgot-password" state={{ email: email.trim() }} className="text-[15px] sm:text-[17px] lg:text-[19px] font-semibold text-[#16A34A] hover:text-[#15803D] focus:outline-none focus-visible:underline">
            {t('login.forgot')}
          </Link>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="mt-6 lg:mt-[30px] w-full h-[56px] sm:h-[60px] lg:h-[59px] rounded-xl lg:rounded-[13px] bg-brand-button lg:bg-[linear-gradient(90deg,#10A537_0%,#0D9030_55%,#0A6F25_100%)] text-white text-[19px] sm:text-[22px] lg:text-[24px] font-semibold lg:font-bold flex items-center justify-center gap-3 lg:gap-[19px] shadow-[0_8px_18px_rgba(21,128,61,0.3)] lg:shadow-[0_4px_12px_rgba(10,111,37,0.3),inset_0_1px_0_rgba(255,255,255,0.25)] hover:brightness-105 transition disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          <LogIn className="w-6 h-6 lg:w-[30px] lg:h-[30px]" strokeWidth={2} aria-hidden="true" />
          {loading ? t('login.submitting') : t('login.submit')}
        </button>
      </form>

      <div className="relative my-6 lg:mt-[17px] lg:mb-[16px] lg:h-[39px] flex items-center justify-center" aria-hidden="true">
        <span className="absolute inset-x-0 top-1/2 h-px lg:h-[1.5px] bg-[#E2E8F0]" />
        <span className="relative px-4 py-1.5 lg:p-0 lg:w-[60px] lg:h-[39px] lg:flex lg:items-center lg:justify-center rounded-full border border-[#E2E8F0] lg:border-[1.5px] lg:border-[#DCE3EC] bg-white text-[15px] lg:text-[18px] font-semibold lg:font-bold text-[#334155] lg:text-[#33476A]">OR</span>
      </div>

      <Link
        to="/signup"
        className="w-full h-[54px] sm:h-[56px] lg:h-[55.5px] rounded-xl lg:rounded-[13px] border-2 border-[#22A04B] bg-white text-[#0F172A] text-[17px] sm:text-[20px] lg:text-[23px] font-semibold lg:font-bold flex items-center justify-center gap-3 lg:gap-[19px] hover:bg-[#F3FBF6] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <UserPlus className="w-6 h-6 lg:w-[34px] lg:h-[34px] text-[#16A34A]" strokeWidth={1.8} aria-hidden="true" />
        {t('login.create')}
      </Link>

      <ul className="mt-7 lg:mt-[36px] grid grid-cols-3 lg:grid-cols-[168.5px_172px_167px] gap-2.5 sm:gap-4 lg:gap-[19px]" aria-label="What you can do">
        {[
          { icon: CalendarDays, lines: ['Manage', 'Appointments'] },
          { icon: CalendarClock, lines: ['Track', 'Availability'] },
          { icon: Link2, lines: ['Share', 'Booking Link'] },
        ].map(item => (
          <li key={item.lines[1]} className="rounded-xl lg:rounded-[16px] bg-[#ECF8F0] lg:bg-[linear-gradient(180deg,#E3F6EA_0%,#EAF8F0_100%)] px-2 py-3.5 sm:py-4 lg:p-0 lg:pt-[12px] lg:h-[113.5px] flex flex-col items-center text-center">
            <item.icon className="w-8 h-8 sm:w-9 sm:h-9 lg:w-[44px] lg:h-[44px] text-[#16A34A]" strokeWidth={1.7} aria-hidden="true" />
            <span className="mt-2 lg:mt-[5px] text-[13px] sm:text-[16px] lg:text-[19px] lg:leading-[21.5px] font-medium lg:font-semibold text-[#0F172A] leading-tight">{item.lines[0]}<br />{item.lines[1]}</span>
          </li>
        ))}
      </ul>
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
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-[#16A34A]" aria-hidden="true" />
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
          className="w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#16A34A] focus:border-transparent transition-colors font-mono tracking-wider"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="w-full py-2.5 rounded-lg bg-[#16A34A] hover:bg-[#15803D] text-white text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#16A34A] focus:ring-offset-2"
      >
        {busy ? 'Checking…' : 'Verify and sign in'}
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={() => { setUseRecovery(v => !v); setValue(''); setError(''); }}
          className="text-[#16A34A] hover:text-[#15803D] font-medium focus:outline-none focus:underline">
          {useRecovery ? 'Use the authenticator app' : 'Use a recovery code'}
        </button>
        <button type="button" onClick={() => onRestart()} className="text-gray-500 hover:text-gray-700 focus:outline-none focus:underline">
          Start over
        </button>
      </div>
    </form>
  );
}
