import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, getToken } from './api';
import { clearSession, setSession } from './apiBase';
import { clearMediaToken } from './mediaToken';
import { getDeviceId } from './device';
import { startIdleWatch, markActivity } from './idle';
import type { User } from './types';

/** What the server returns from a successful sign-in or refresh. */
interface SessionResponse {
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  user: User;
}

/** What it returns instead when the account has two-factor enabled. */
interface MfaChallengeResponse {
  mfaRequired: true;
  challenge: string;
}

type LoginResult = { mfaRequired: false } | { mfaRequired: true; challenge: string };

interface AuthState {
  user: User | null;
  loading: boolean;
  /**
   * Resolves with `mfaRequired: true` when a second factor is needed; the
   * caller then collects a code and calls completeMfa with the challenge.
   */
  login: (username: string, password: string, remember?: boolean) => Promise<LoginResult>;
  completeMfa: (
    challenge: string,
    input: { code?: string; recoveryCode?: string },
    remember?: boolean
  ) => Promise<void>;
  logout: () => void;
  /** Re-read /auth/me, e.g. after enrolling in MFA or changing a password. */
  refreshUser: () => Promise<void>;
  /** Replace the stored session after an endpoint hands back a new pair. */
  adoptSession: (res: SessionResponse) => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount, if we have a token, fetch the current user. api() will quietly
  // refresh the access token first if it has expired, so a browser left closed
  // overnight comes back signed in rather than being bounced to the login page.
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => {
        clearSession();
        clearMediaToken();
      })
      .finally(() => setLoading(false));
  }, []);

  const adoptSession = useCallback((res: SessionResponse) => {
    setSession(res.token, res.refreshToken);
    markActivity();
    setUser(res.user);
  }, []);

  const login = useCallback(
    async (username: string, password: string, remember?: boolean): Promise<LoginResult> => {
      const res = await api<SessionResponse | MfaChallengeResponse>('/auth/login', {
        method: 'POST',
        body: { username, password, deviceId: getDeviceId(), remember },
      });
      if ('mfaRequired' in res && res.mfaRequired) {
        // No session yet: the password is proven, the second factor is not.
        return { mfaRequired: true, challenge: res.challenge };
      }
      adoptSession(res as SessionResponse);
      return { mfaRequired: false };
    },
    [adoptSession]
  );

  const completeMfa = useCallback(
    async (
      challenge: string,
      input: { code?: string; recoveryCode?: string },
      remember?: boolean
    ) => {
      const res = await api<SessionResponse>('/auth/mfa/verify', {
        method: 'POST',
        body: { challenge, deviceId: getDeviceId(), remember, ...input },
      });
      adoptSession(res);
    },
    [adoptSession]
  );

  const refreshUser = useCallback(async () => {
    const res = await api<{ user: User }>('/auth/me');
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    // Fire-and-forget: releasing the device slot server-side is best effort,
    // an idle session is pruned anyway.
    if (getToken()) {
      api('/auth/logout', { method: 'POST' }).catch(() => {});
    }
    clearSession();
    // The media capability token is only re-mintable while signed in, and it
    // must not outlive the session in localStorage.
    clearMediaToken();
    setUser(null);
  }, []);

  // The server can end a session out from under us (signed out elsewhere, the
  // idle window lapsed, the password changed, the account was disabled). api()
  // broadcasts that as an event once a token refresh has also failed.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  // Idle sign-out, armed only while someone is signed in.
  useEffect(() => {
    if (!user) return;
    return startIdleWatch({
      onIdle: () => {
        logout();
        toast.info('Signed out after 20 minutes of inactivity.');
      },
      heartbeat: () => {
        api('/auth/heartbeat', { method: 'POST' }).catch(() => {});
      },
    });
  }, [user, logout]);

  return (
    <AuthContext.Provider
      value={{ user, loading, login, completeMfa, logout, refreshUser, adoptSession }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
