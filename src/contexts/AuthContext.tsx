import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  login as apiLogin, loginSecondStep, signup as apiSignup, logout as apiLogout, getMe, SESSION_EXPIRED_EVENT, ApiError,
  type AuthUser, type SecondFactor,
} from '@/api/client';

/** Signed in, or the password was right and a second step is needed (two-factor sign-in). */
export type LoginOutcome = { user: AuthUser } | { twoFactor: { challenge: string; expiresAt: string } };
import { hasPermission, type Permission } from '@/lib/permissions';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  /** Set when the session could not be checked for a reason other than being signed out. */
  connectionError: string | null;
  retrySession: () => void;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  /** Finishes a two-factor sign-in with a code from the authenticator app or a recovery code. */
  completeTwoFactor: (challenge: string, factor: SecondFactor) => Promise<AuthUser>;
  /** Asks for a sign-up confirmation email; does not sign in. Resolves to the message to show. */
  signup: (data: { name: string; email: string; company: string; password: string; confirmPassword: string }) => Promise<string>;
  /** For flows that sign the user in themselves (accepting an invitation). */
  signedIn: (user: AuthUser) => void;
  logout: () => Promise<void>;
  /** Whether the signed-in user holds a permission (display only; the server enforces it). */
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Session is managed by an HttpOnly cookie — no localStorage read needed.
    // Just verify the cookie by calling /api/auth/me; the browser sends the
    // cookie automatically via credentials:'include' (set in api/client.ts).
    let cancelled = false;
    setIsLoading(true);
    getMe()
      .then(u => { if (!cancelled) { setUser(u); setConnectionError(null); } })
      .catch(e => {
        if (cancelled) return;
        // 401 means no valid session; anything else (server down, proxy error) must not log the user out.
        if (e instanceof ApiError && e.status === 401) { setUser(null); setConnectionError(null); }
        else setConnectionError(e instanceof Error ? e.message : 'Could not reach the server');
      })
      .finally(() => { if (!cancelled) setIsLoading(false); });

    return () => { cancelled = true; };
  }, [attempt]);

  const retrySession = useCallback(() => setAttempt(a => a + 1), []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<LoginOutcome> => {
    const res = await apiLogin(email, password);
    if (res.twoFactorRequired) return { twoFactor: { challenge: res.challenge, expiresAt: res.expiresAt } };
    // The server sets the HttpOnly we360_session cookie on login.
    // We only store the user profile in React state (never in localStorage).
    setUser(res.user);
    return { user: res.user };
  }, []);

  const completeTwoFactor = useCallback(async (challenge: string, factor: SecondFactor) => {
    const { user: u } = await loginSecondStep(challenge, factor);
    setUser(u);
    return u;
  }, []);

  const signup = useCallback(async (data: Parameters<AuthContextValue['signup']>[0]) => {
    // The account exists only after the emailed link is confirmed, and then the user signs in normally.
    const { message } = await apiSignup(data);
    return message;
  }, []);

  const signedIn = useCallback((u: AuthUser) => { setUser(u); setConnectionError(null); }, []);

  const logout = useCallback(async () => {
    await apiLogout().catch(() => { /* ignore network errors on logout */ });
    // Clear mock data from localStorage (kept here for the mock layer during
    // the transition; remove once all pages are migrated to the real API).
    try {
      ['we360_appointments', 'we360_customers', 'we360_services'].forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
    setUser(null);
  }, []);

  const can = useCallback((permission: Permission) => hasPermission(user?.permissions, permission), [user]);

  return (
    <AuthContext.Provider value={{ user, isLoading, connectionError, retrySession, login, completeTwoFactor, signup, signedIn, logout, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
