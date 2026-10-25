/**
 * Pure sync planning: decides what to upload by comparing the device phonebook with what this
 * device last synced. No React Native imports, so it is unit-testable in Node.
 *
 * Conflict model (matches the server, see docs/SYNC.md):
 * - `synced[nativeId].version` is the server version this device last agreed on for a contact.
 * - An upload carries that as baseVersion. If the contact was changed elsewhere since (server version
 *   is higher), the server rejects it as a conflict and the server copy wins.
 * - Contacts the device has not changed since the last sync are never re-uploaded, so edits made
 *   in the app are not overwritten by the unchanged phonebook entry.
 */

export interface DeviceContact {
  nativeId: string;
  displayName: string;
  numbers: { number: string; label?: string | null }[];
}

export interface SyncedEntry {
  hash: string;
  version: number;
  contactId: string;
}

export interface ServerCopy {
  version: number;
  contactId: string;
  deleted: boolean;
  hash: string;
}

export interface PlannedUpsert {
  sourceContactId: string;
  displayName: string;
  numbers: { number: string; label: string | null; isPrimary: boolean }[];
  baseVersion: number | null;
}

export interface Plan {
  upserts: PlannedUpsert[];
  deletes: { sourceContactId: string; baseVersion: number | null }[];
  /** Entries to record locally without uploading (already identical on the server). */
  adopt: Record<string, SyncedEntry>;
  /** Local bookkeeping to drop (contact gone on both sides). */
  forget: string[];
  /** True when the phonebook read came back empty although contacts were synced before. */
  suspiciousEmptyRead: boolean;
  skippedNoNumber: number;
}

/** Stable content hash (djb2 over a canonical JSON form). */
export function contactHash(c: { displayName: string; numbers: { number: string; label?: string | null }[] }): string {
  const canonical = JSON.stringify([c.displayName.trim(), c.numbers.map((n) => [n.number.trim(), n.label ?? null])]);
  let h = 5381;
  for (let i = 0; i < canonical.length; i++) h = ((h << 5) + h + canonical.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + canonical.length.toString(36);
}

export function planSync(
  device: DeviceContact[],
  synced: Record<string, SyncedEntry>,
  server: Map<string, ServerCopy>,
): Plan {
  const plan: Plan = { upserts: [], deletes: [], adopt: {}, forget: [], suspiciousEmptyRead: false, skippedNoNumber: 0 };
  const present = new Set<string>();

  for (const d of device) {
    const numbers = d.numbers.filter((n) => n.number && n.number.trim());
    if (!numbers.length) {
      plan.skippedNoNumber++;
      continue;
    }
    present.add(d.nativeId);
    const hash = contactHash({ displayName: d.displayName, numbers });
    const mine = synced[d.nativeId];
    const srv = server.get(d.nativeId);
    if (mine && mine.hash === hash) continue; // unchanged on the device since last sync
    if (!mine && srv && !srv.deleted && srv.hash === hash) {
      plan.adopt[d.nativeId] = { hash, version: srv.version, contactId: srv.contactId };
      continue;
    }
    plan.upserts.push({
      sourceContactId: d.nativeId,
      displayName: d.displayName,
      numbers: numbers.map((n, i) => ({ number: n.number.trim(), label: n.label ?? null, isPrimary: i === 0 })),
      baseVersion: mine?.version ?? srv?.version ?? null,
    });
  }

  const known = new Set([...Object.keys(synced), ...[...server.entries()].filter(([, s]) => !s.deleted).map(([id]) => id)]);
  const gone = [...known].filter((id) => !present.has(id));

  if (device.length === 0 && gone.length > 0) {
    // An empty read (permission glitch, OS error) must not wipe the cloud copy.
    plan.suspiciousEmptyRead = true;
    return plan;
  }
  for (const id of gone) {
    const srv = server.get(id);
    if (!srv || srv.deleted) {
      plan.forget.push(id);
      continue;
    }
    plan.deletes.push({ sourceContactId: id, baseVersion: synced[id]?.version ?? srv.version });
  }
  return plan;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
