import NetInfo from '@react-native-community/netinfo';
import { addContactsChangeListener, requestPermissionsAsync } from 'expo-contacts';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { ApiError, errorMessage } from '../api';
import { useAuth } from '../auth';
import { AUTO_SYNC_MIN_INTERVAL_MS } from '../config';
import type { Contact } from '../types';
import { enableBackgroundSync } from './background';
import { deviceAccess, loadState, runSync, saveState, visibleContacts, type DeviceAccess, type LocalSyncState, type SyncProgress } from './engine';

interface SyncContextValue {
  contacts: Contact[];
  state: LocalSyncState | null;
  syncing: boolean;
  progress: SyncProgress | null;
  access: DeviceAccess;
  online: boolean;
  backgroundEnabled: boolean;
  /** Runs a sync now. Resolves with an error message, or null on success. */
  syncNow(opts?: { confirmMassDelete?: boolean }): Promise<string | null>;
  requestAccess(): Promise<DeviceAccess>;
  /** Applies a contact returned by the API (edit/create) to the local cache without a full sync. */
  upsertLocal(c: Contact): Promise<void>;
  removeLocal(id: string): Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth();
  const [state, setState] = useState<LocalSyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [access, setAccess] = useState<DeviceAccess>('undetermined');
  const [online, setOnline] = useState(true);
  const [backgroundEnabled, setBackgroundEnabled] = useState(false);
  const running = useRef<Promise<string | null> | null>(null);
  const lastAuto = useRef(0);
  const userId = user?.id;
  const consented = Boolean(user?.contactsConsentAt);

  useEffect(() => NetInfo.addEventListener((s) => setOnline(s.isConnected !== false)), []);

  useEffect(() => {
    setState(null);
    if (userId) loadState(userId).then(setState);
    deviceAccess().then(setAccess);
  }, [userId]);

  const syncNow = useCallback(async (opts: { confirmMassDelete?: boolean } = {}) => {
    if (!userId || !token) return 'Not logged in.';
    if (running.current) return running.current;
    const job = (async () => {
      setSyncing(true);
      try {
        const currentAccess = await deviceAccess();
        setAccess(currentAccess);
        const next = await runSync(userId, {
          includeDevice: consented && currentAccess === 'granted',
          confirmMassDelete: opts.confirmMassDelete,
          onProgress: setProgress,
        });
        setState(next);
        setOnline(true);
        return null;
      } catch (err) {
        setState(await loadState(userId));
        if (err instanceof ApiError && err.isNetwork) setOnline(false);
        return errorMessage(err);
      } finally {
        setSyncing(false);
        setProgress(null);
        running.current = null;
      }
    })();
    running.current = job;
    return job;
  }, [userId, token, consented]);

  // Automatic sync: on login, whenever the app becomes active (throttled), and when the
  // phonebook changes while the app is open.
  const autoSync = useCallback(() => {
    if (Date.now() - lastAuto.current < AUTO_SYNC_MIN_INTERVAL_MS) return;
    lastAuto.current = Date.now();
    void syncNow();
  }, [syncNow]);

  useEffect(() => {
    if (!userId || !token) return;
    lastAuto.current = 0;
    autoSync();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && autoSync());
    return () => sub.remove();
  }, [userId, token, autoSync]);

  useEffect(() => {
    if (!userId || access !== 'granted' || !consented || Platform.OS === 'web') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = addContactsChangeListener(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void syncNow(), 10_000);
    });
    enableBackgroundSync().then(setBackgroundEnabled);
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, [userId, access, consented, syncNow]);

  const requestAccess = useCallback(async () => {
    if (Platform.OS === 'web') return 'unavailable' as const;
    const res = await requestPermissionsAsync();
    const next: DeviceAccess = res.granted ? 'granted' : res.canAskAgain ? 'undetermined' : 'denied';
    setAccess(next);
    return next;
  }, []);

  const mutateLocal = useCallback(async (fn: (s: LocalSyncState) => void) => {
    if (!userId) return;
    const s = await loadState(userId);
    fn(s);
    await saveState(userId, s);
    setState({ ...s });
  }, [userId]);

  const value = useMemo<SyncContextValue>(() => ({
    contacts: state ? visibleContacts(state) : [],
    state,
    syncing,
    progress,
    access,
    online,
    backgroundEnabled,
    syncNow,
    requestAccess,
    upsertLocal: (c) => mutateLocal((s) => { s.contacts[c.id] = c; }),
    removeLocal: (id) => mutateLocal((s) => { delete s.contacts[id]; }),
  }), [state, syncing, progress, access, online, backgroundEnabled, syncNow, requestAccess, mutateLocal]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync outside SyncProvider');
  return ctx;
}
