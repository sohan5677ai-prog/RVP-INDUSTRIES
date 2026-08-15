import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, setToken, clearToken, getToken } from './api';
import { getDeviceId } from './device';
import { startIdleWatch, markActivity } from './idle';
import type { User } from './types';

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On mount, if we have a token, fetch the current user.
  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api<{ user: User }>('/auth/me')
      .then((res) => setUser(res.user))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string) {
    const res = await api<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: { username, password, deviceId: getDeviceId() },
    });
    setToken(res.token);
    markActivity();
    setUser(res.user);
  }

  const logout = useCallback(() => {
    // Fire-and-forget: releasing the device slot server-side is best effort,
    // an idle session is pruned anyway.
    if (getToken()) {
      api('/auth/logout', { method: 'POST' }).catch(() => {});
    }
    clearToken();
    setUser(null);
  }, []);

  // The server can end a session out from under us (signed out elsewhere, or
  // the idle window lapsed). api() broadcasts that as an event.
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
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
