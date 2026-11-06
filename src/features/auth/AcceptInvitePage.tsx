import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { authApi, type InvitationPreview } from '@/api/client';
import { homePath } from '@/lib/permissions';
import AuthLayout from './AuthLayout';

const INPUT = 'w-full px-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00BF62] focus:border-transparent transition-colors';

// The invitation link carries its token in the fragment (#token=…), which browsers never send to servers.
// The token is the proof that this person controls the invited email address.
export default function AcceptInvitePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, signedIn, logout } = useAuth();
  const [token] = useState(() => new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '');
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Keep the token out of the address bar and browser history once it has been read.
    if (location.hash) navigate(location.pathname, { replace: true });
    if (!token) { setLoadError('This invitation link is incomplete. Open the link from your invitation email again.'); return; }
    authApi.inspectInvitation(token)
      .then(setPreview)
      .catch((e: Error) => setLoadError(e.message || 'This invitation could not be loaded.'));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      setError('Use at least 8 characters, including an uppercase letter and a number.');
      return;
    }
    if (password !== confirm) { setError('The passwords do not match.'); return; }
    setSaving(true);
    try {
      const { user: created } = await authApi.acceptInvitation(token, password, confirm);
      signedIn(created);
      navigate(homePath(created.permissions), { replace: true });
    } catch (err) {
      setError((err as Error).message || 'The invitation could not be accepted.');
      setSaving(false);
    }
  }

  if (user) {
    return (
      <AuthLayout title="Accept invitation" subtitle="You are already signed in" redirectIfSignedIn={false}>
        <p className="text-sm text-gray-700 mb-4">
          You are signed in as <strong>{user.email}</strong>. Sign out first, then open the invitation link again to create the new sign-in.
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => logout()} className="flex-1 py-2.5 rounded-lg bg-[#00BF62] text-white text-sm font-semibold">Sign out</button>
          <Link to={homePath(user.permissions)} className="flex-1 py-2.5 rounded-lg border border-gray-300 text-sm font-medium text-center text-gray-700">Back to my account</Link>
        </div>
      </AuthLayout>
    );
  }

  if (loadError) {
    return (
      <AuthLayout title="Invitation" subtitle="Staff sign-in" redirectIfSignedIn={false}>
        <div role="alert" className="flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2.5 mb-4">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{loadError}</span>
        </div>
        <Link to="/login" className="block text-center text-sm font-medium text-[#00BF62]">Go to sign in</Link>
      </AuthLayout>
    );
  }

  if (!preview) {
    return (
      <AuthLayout title="Invitation" subtitle="Checking your invitation…" redirectIfSignedIn={false}>
        <p role="status" className="text-sm text-gray-600 text-center">Checking your invitation…</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={`Join ${preview.businessName}`} subtitle={`Create your ${preview.role === 'manager' ? 'manager' : 'staff'} sign-in`} redirectIfSignedIn={false}>
      <p className="text-sm text-gray-700 mb-4">
        Hi {preview.staffName}, choose a password for <strong>{preview.email}</strong>.
        {preview.role === 'manager'
          ? ' As a manager you can run appointments, customers, services, booking pages and reports.'
          : ' As staff you can see your own schedule and appointments.'}
      </p>
      {error && (
        <div id="invite-error" role="alert" className="mb-4 flex items-start gap-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2.5">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <input type="email" value={preview.email} autoComplete="username" readOnly hidden />
        <div>
          <label htmlFor="invite-password" className="block text-sm font-medium text-gray-700 mb-1.5">Password</label>
          <input id="invite-password" type="password" autoComplete="new-password" value={password}
            onChange={e => setPassword(e.target.value)} className={INPUT} aria-describedby="invite-password-hint" />
          <p id="invite-password-hint" className="text-xs text-gray-500 mt-1">At least 8 characters, with an uppercase letter and a number.</p>
        </div>
        <div>
          <label htmlFor="invite-confirm" className="block text-sm font-medium text-gray-700 mb-1.5">Confirm password</label>
          <input id="invite-confirm" type="password" autoComplete="new-password" value={confirm}
            onChange={e => setConfirm(e.target.value)} className={INPUT} />
        </div>
        <button type="submit" disabled={saving}
          className="w-full py-2.5 rounded-lg bg-[#00BF62] hover:bg-[#00a855] text-white text-sm font-semibold transition-colors disabled:opacity-60">
          {saving ? 'Creating your sign-in…' : 'Create my sign-in'}
        </button>
        <p className="text-xs text-gray-500 text-center">
          This link works once and expires {new Date(preview.expiresAt).toLocaleString()}.
        </p>
      </form>
    </AuthLayout>
  );
}
