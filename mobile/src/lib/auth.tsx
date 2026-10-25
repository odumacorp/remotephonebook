import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, configureApi } from './api';
import { deviceInfo } from './device';
import { removeKeys, secure } from './storage';
import type { User } from './types';

const TOKEN_KEY = 'rpb.session';

interface AuthState {
  ready: boolean;
  token: string | null;
  user: User | null;
  login(identifier: string, password: string): Promise<void>;
  register(input: { fullName: string; email?: string; phone?: string; password: string }): Promise<{ status: string; channels?: { channel: string; destination: string }[] }>;
  verify(identifier: string, code: string): Promise<void>;
  logout(): Promise<void>;
  refreshUser(): Promise<void>;
  updateAccount(patch: Partial<{ fullName: string; ussdEnabled: boolean; deletionPolicy: 'mirror' | 'keep'; contactsConsent: boolean }>): Promise<User>;
  /** Called after account deletion or when the server rejects the session. */
  clearSession(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const tokenRef = useRef<string | null>(null);

  const clearSession = useCallback(async () => {
    const uid = user?.id;
    tokenRef.current = null;
    setToken(null);
    setUser(null);
    await secure.remove(TOKEN_KEY);
    if (uid) await removeKeys(`rpb.sync.${uid}`);
  }, [user?.id]);

  useEffect(() => {
    configureApi({ getToken: () => tokenRef.current, onUnauthorized: () => void clearSession() });
  }, [clearSession]);

  const adopt = useCallback(async (t: string, u: User) => {
    tokenRef.current = t;
    await secure.set(TOKEN_KEY, t);
    setToken(t);
    setUser(u);
  }, []);

  // Restore the session on launch.
  useEffect(() => {
    (async () => {
      const saved = await secure.get(TOKEN_KEY);
      if (saved) {
        tokenRef.current = saved;
        try {
          const me = await api<User>('/api/account', { token: saved, retries: 1 });
          setToken(saved);
          setUser(me);
        } catch (err: any) {
          if (err?.status === 401) {
            tokenRef.current = null;
            await secure.remove(TOKEN_KEY);
          } else {
            // Offline: keep the session; cached contacts are still shown.
            setToken(saved);
          }
        }
      }
      setReady(true);
    })();
  }, []);

  const value = useMemo<AuthState>(() => ({
    ready,
    token,
    user,
    async login(identifier, password) {
      const res = await api<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST', body: { identifier, password, device: await deviceInfo() }, token: null,
      });
      await adopt(res.token, res.user);
      await value.refreshUser();
    },
    async register(input) {
      return api('/api/auth/register', {
        method: 'POST', token: null,
        body: { ...input, acceptTerms: true, device: await deviceInfo() },
      });
    },
    async verify(identifier, code) {
      const res = await api<{ token: string; user: User }>('/api/auth/verify', {
        method: 'POST', body: { identifier, code, device: await deviceInfo() }, token: null,
      });
      await adopt(res.token, res.user);
    },
    async logout() {
      try {
        await api('/api/auth/logout', { method: 'POST', retries: 0 });
      } catch {
        // Session is cleared locally regardless.
      }
      await clearSession();
    },
    async refreshUser() {
      const me = await api<User>('/api/account');
      setUser(me);
    },
    async updateAccount(patch) {
      const me = await api<User>('/api/account', { method: 'PATCH', body: patch });
      setUser(me);
      return me;
    },
    clearSession,
  }), [ready, token, user, adopt, clearSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export { TOKEN_KEY };
