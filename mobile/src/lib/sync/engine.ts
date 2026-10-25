import { Contact as DeviceContacts, ContactField, getPermissionsAsync } from 'expo-contacts';
import { Platform } from 'react-native';
import { api, ApiError } from '../api';
import { SYNC_CHUNK_SIZE } from '../config';
import { getJson, setJson } from '../storage';
import type { Contact } from '../types';
import { chunk, contactHash, planSync, type DeviceContact, type ServerCopy, type SyncedEntry } from './plan';

export interface LocalSyncState {
  cursor: number;
  contacts: Record<string, Contact>;
  synced: Record<string, SyncedEntry>;
  /** Last successful phonebook -> cloud sync from this device. Never set by a cloud-only refresh. */
  lastSyncAt: string | null;
  /** Last time the local copy was refreshed from the cloud. */
  lastRefreshAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastStats: Record<string, number> | null;
  needsMassDeleteConfirm: boolean;
}

export interface SyncProgress {
  phase: 'pulling' | 'reading' | 'uploading' | 'finishing';
  done: number;
  total: number;
}

export type DeviceAccess = 'granted' | 'denied' | 'undetermined' | 'unavailable';

const emptyState = (): LocalSyncState => ({
  cursor: 0, contacts: {}, synced: {}, lastSyncAt: null, lastRefreshAt: null, lastAttemptAt: null, lastError: null, lastStats: null, needsMassDeleteConfirm: false,
});

const stateKey = (userId: string) => `rpb.sync.${userId}`;

export async function loadState(userId: string): Promise<LocalSyncState> {
  return { ...emptyState(), ...((await getJson<LocalSyncState>(stateKey(userId))) ?? {}) };
}

export async function saveState(userId: string, state: LocalSyncState) {
  await setJson(stateKey(userId), state);
}

export async function deviceAccess(): Promise<DeviceAccess> {
  if (Platform.OS === 'web') return 'unavailable';
  try {
    const p = await getPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Reads names and phone numbers from the device phonebook, in pages. */
export async function readPhonebook(onProgress?: (n: number) => void): Promise<DeviceContact[]> {
  const fields = [ContactField.FULL_NAME, ContactField.GIVEN_NAME, ContactField.FAMILY_NAME, ContactField.PHONES] as const;
  const out: DeviceContact[] = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await DeviceContacts.getAllDetails(fields, { limit: pageSize, offset });
    for (const c of page) {
      const phones = (c.phones ?? []).filter((p) => p.number);
      const name = (c.fullName || [c.givenName, c.familyName].filter(Boolean).join(' ') || phones[0]?.number || '').trim();
      if (!name) continue;
      out.push({ nativeId: String(c.id), displayName: name, numbers: phones.map((p) => ({ number: p.number!, label: p.label ?? null })) });
    }
    onProgress?.(out.length);
    if (page.length < pageSize) break;
  }
  return out;
}

/** Pulls server changes since the cursor into the local cache. */
async function pull(state: LocalSyncState) {
  for (;;) {
    const res = await api<{ contacts: Contact[]; cursor: number; hasMore: boolean; reset: boolean }>(
      `/api/contacts/changes?cursor=${state.cursor}&limit=1000`,
    );
    if (res.reset) {
      state.contacts = {};
    }
    for (const c of res.contacts) {
      if (c.deletedAt) delete state.contacts[c.id];
      else state.contacts[c.id] = c;
    }
    // A contact from this device that was deleted elsewhere (e.g. in the app) stays deleted until
    // it changes on the device: keep its hash, move its base version to the tombstone.
    for (const c of res.contacts) {
      const mine = c.deletedAt && c.fromThisDevice && c.sourceContactId ? state.synced[c.sourceContactId] : undefined;
      if (mine) mine.version = c.version;
    }
    state.cursor = res.cursor;
    if (!res.hasMore) break;
  }
}

function serverCopies(state: LocalSyncState): Map<string, ServerCopy> {
  const map = new Map<string, ServerCopy>();
  for (const c of Object.values(state.contacts)) {
    if (c.fromThisDevice && c.sourceContactId) {
      map.set(c.sourceContactId, {
        version: c.version,
        contactId: c.id,
        deleted: Boolean(c.deletedAt),
        hash: contactHash({ displayName: c.displayName, numbers: c.numbers.map((n) => ({ number: n.number, label: n.label })) }),
      });
    }
  }
  return map;
}

/**
 * One full sync run: pull -> read phonebook -> plan -> upload in chunks -> pull.
 * With `includeDevice: false` (no permission, web, or user choice) it only refreshes the cloud copy.
 */
export async function runSync(
  userId: string,
  opts: { includeDevice: boolean; confirmMassDelete?: boolean; onProgress?: (p: SyncProgress) => void },
): Promise<LocalSyncState> {
  const state = await loadState(userId);
  state.lastAttemptAt = new Date().toISOString();
  try {
    opts.onProgress?.({ phase: 'pulling', done: 0, total: 0 });
    await pull(state);

    if (opts.includeDevice) {
      opts.onProgress?.({ phase: 'reading', done: 0, total: 0 });
      let phonebook: DeviceContact[];
      try {
        phonebook = await readPhonebook((n) => opts.onProgress?.({ phase: 'reading', done: n, total: 0 }));
      } catch (err) {
        const message = 'Could not read your phonebook. Check the contacts permission.';
        await api('/api/contacts/sync/report', { method: 'POST', body: { status: 'error', error: message }, retries: 0 }).catch(() => {});
        throw new Error(message);
      }

      const plan = planSync(phonebook, state.synced, serverCopies(state));
      Object.assign(state.synced, plan.adopt);
      for (const id of plan.forget) delete state.synced[id];

      const deletes = plan.suspiciousEmptyRead ? [] : plan.deletes;
      const ops: ({ kind: 'u'; v: (typeof plan.upserts)[number] } | { kind: 'd'; v: (typeof deletes)[number] })[] = [
        ...plan.upserts.map((v) => ({ kind: 'u' as const, v })),
        ...deletes.map((v) => ({ kind: 'd' as const, v })),
      ];
      const batches = ops.length ? chunk(ops, SYNC_CHUNK_SIZE) : [[]];
      const stats: Record<string, number> = { deviceContacts: phonebook.length, skippedNoNumber: plan.skippedNoNumber };
      const hashes = new Map(plan.upserts.map((u) => [u.sourceContactId, contactHash(u)]));
      let done = 0;

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        opts.onProgress?.({ phase: 'uploading', done, total: ops.length });
        let res: { results: { sourceContactId: string; status: string; contactId?: string; version?: number; server?: Contact }[]; summary: Record<string, number> };
        try {
          res = await api('/api/contacts/sync', {
            method: 'POST',
            retries: 3, // idempotent: replaying a batch yields "unchanged"
            body: {
              upserts: batch.filter((o) => o.kind === 'u').map((o) => o.v),
              deletes: batch.filter((o) => o.kind === 'd').map((o) => o.v),
              final: i === batches.length - 1,
              confirmMassDelete: opts.confirmMassDelete,
              stats: i === batches.length - 1 ? stats : undefined,
            },
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && /mass deletion/i.test(err.message)) {
            state.needsMassDeleteConfirm = true;
          }
          throw err;
        }
        for (const r of res.results) {
          const sid = r.sourceContactId;
          switch (r.status) {
            case 'created':
            case 'updated':
            case 'unchanged':
              state.synced[sid] = { hash: hashes.get(sid) ?? state.synced[sid]?.hash ?? '', version: r.version!, contactId: r.contactId! };
              break;
            case 'conflict':
              // Server copy wins; remember the device content so it is not re-sent until it changes again.
              if (hashes.has(sid)) state.synced[sid] = { hash: hashes.get(sid)!, version: r.version!, contactId: r.contactId! };
              else if (state.synced[sid]) state.synced[sid].version = r.version!;
              if (r.server) state.contacts[r.server.id] = r.server;
              break;
            case 'invalid':
              state.synced[sid] = { hash: hashes.get(sid) ?? '', version: 0, contactId: '' };
              break;
            default: // deleted, kept, not_found
              delete state.synced[sid];
          }
        }
        for (const [k, v] of Object.entries(res.summary)) stats[k] = (stats[k] ?? 0) + v;
        done += batch.length;
      }
      state.needsMassDeleteConfirm = false;
      state.lastStats = { ...stats, suspiciousEmptyRead: plan.suspiciousEmptyRead ? 1 : 0 };
      opts.onProgress?.({ phase: 'finishing', done, total: ops.length });
      await pull(state);
    }

    const now = new Date().toISOString();
    state.lastRefreshAt = now;
    if (opts.includeDevice) state.lastSyncAt = now;
    state.lastError = null;
  } catch (err) {
    state.lastError = (err as Error).message;
    await saveState(userId, state);
    throw err;
  }
  await saveState(userId, state);
  return state;
}

/** Sorted, de-duplicated list for display (identical name+numbers shown once). */
export function visibleContacts(state: LocalSyncState): Contact[] {
  const seen = new Set<string>();
  return Object.values(state.contacts)
    .filter((c) => !c.deletedAt)
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .filter((c) => (seen.has(c.dedupeKey) ? false : (seen.add(c.dedupeKey), true)));
}
