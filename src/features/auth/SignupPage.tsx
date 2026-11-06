import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff, AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import AuthLayout from './AuthLayout';
import CheckEmailPanel from './CheckEmailPanel';

interface FieldErrors {
  name?: string;
  email?: string;
  company?: string;
  password?: string;
  confirmPassword?: string;
}

export default function SignupPage() {
  const { signup } = useAuth();

  const [form, setForm] = useState({ name: '', email: '', company: '', password: '', confirmPassword: '' });
  const [showPw, setShowPw] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // After sending: the address the confirmation link went to, and the server's message (the same for every address).
  const [sent, setSent] = useState<{ email: string; message: string } | null>(null);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm(f => ({ ...f, [key]: e.target.value }));
      setFieldErrors(fe => ({ ...fe, [key]: undefined }));
    };
  }

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (!form.name.trim()) errors.name = 'Full name is required.';
    if (!form.email.trim()) {
      errors.email = 'Work email is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      errors.email = 'Enter a valid email address.';
    }
    if (!form.company.trim()) errors.company = 'Company name is required.';
    if (form.password.length < 8) {
      errors.password = 'Password must be at least 8 characters.';
    } else if (!/[A-Z]/.test(form.password)) {
      errors.password = 'Password must contain at least one uppercase letter.';
    } else if (!/[0-9]/.test(form.password)) {
      errors.password = 'Password must contain at least one number.';
    }
    if (!errors.password && form.password !== form.confirmPassword) {
      errors.confirmPassword = 'Passwords do not match.';
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError('');
    if (!validate()) return;
    setLoading(true);
    try {
      // Nobody is signed in here: the account is created when the emailed link is confirmed.
      const message = await signup(form);
      setSent({ email: form.email.trim(), message });
      setForm(f => ({ ...f, password: '', confirmPassword: '' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) return <CheckEmailPanel email={sent.email} message={sent.message} onUseDifferentEmail={() => setSent(null)} />;

  return (
    <AuthLayout title="Create your account" subtitle="Start managing bookings in minutes">
      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2.5" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate className="space-y-3.5">
        <Field id="signup-name" label="Full name" error={fieldErrors.name}>
          <input
            id="signup-name"
            type="text"
            autoComplete="name"
            value={form.name}
            onChange={set('name')}
            placeholder="Jane Smith"
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? 'signup-name-error' : undefined}
            className={inputCls(!!fieldErrors.name)}
          />
        </Field>

        <Field id="signup-email" label="Work email" error={fieldErrors.email}>
          <input
            id="signup-email"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={set('email')}
            placeholder="jane@company.com"
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? 'signup-email-error' : undefined}
            className={inputCls(!!fieldErrors.email)}
          />
        </Field>

        <Field id="signup-company" label="Company / workspace name" error={fieldErrors.company}>
          <input
            id="signup-company"
            type="text"
            autoComplete="organization"
            value={form.company}
            onChange={set('company')}
            placeholder="Acme Wellness"
            aria-invalid={fieldErrors.company ? true : undefined}
            aria-describedby={fieldErrors.company ? 'signup-company-error' : undefined}
            className={inputCls(!!fieldErrors.company)}
          />
        </Field>

        <Field id="signup-password" label="Password" error={fieldErrors.password}
          hint="Min. 8 characters, one uppercase, one number">
          <div className="relative">
            <input
              id="signup-password"
              type={showPw ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              placeholder="••••••••"
              aria-invalid={fieldErrors.password ? true : undefined}
              aria-describedby={fieldErrors.password ? 'signup-password-error' : 'signup-password-hint'}
              className={inputCls(!!fieldErrors.password) + ' pr-10'}
            />
            <TogglePw show={showPw} onToggle={() => setShowPw(v => !v)} />
          </div>
        </Field>

        <Field id="signup-confirm" label="Confirm password" error={fieldErrors.confirmPassword}>
          <div className="relative">
            <input
              id="signup-confirm"
              type={showConfirm ? 'text' : 'password'}
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={set('confirmPassword')}
              placeholder="••••••••"
              aria-invalid={fieldErrors.confirmPassword ? true : undefined}
              aria-describedby={fieldErrors.confirmPassword ? 'signup-confirm-error' : undefined}
              className={inputCls(!!fieldErrors.confirmPassword) + ' pr-10'}
            />
            <TogglePw show={showConfirm} onToggle={() => setShowConfirm(v => !v)} />
          </div>
        </Field>

        <button
          type="submit"
          disabled={loading}
          className="w-full mt-1 py-2.5 rounded-lg bg-[#00BF62] hover:bg-[#008F49] text-white text-sm font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:ring-offset-2"
        >
          {loading ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-5 text-center text-sm text-gray-500">
        Already have an account?{' '}
        <Link to="/login" className="text-[#00BF62] hover:text-[#008F49] font-medium focus:outline-none focus:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inputCls(invalid: boolean) {
  return `w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:border-transparent transition-colors ${
    invalid ? 'border-red-400 bg-red-50' : 'border-gray-300'
  }`;
}

function Field({
  id, label, error, hint, children,
}: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1.5">
        {label}
      </label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs text-gray-400">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600" role="alert">{error}</p>
      )}
    </div>
  );
}

function TogglePw({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={show ? 'Hide password' : 'Show password'}
      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none focus:text-gray-600"
      tabIndex={-1}
    >
      {show ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
    </button>
  );
}
