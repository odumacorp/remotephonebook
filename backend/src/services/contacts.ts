import type pg from 'pg';
import { config } from '../config.js';
import { query, queryOne, transaction, type Queryable, db } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { cleanDisplayName, dedupeKey, escapeLike, formatPhone, normalizeName, normalizePhone } from '../lib/normalize.js';
import { audit } from './audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface NumberInput {
  number: string;
  label?: string | null;
  isPrimary?: boolean;
}

export interface ContactInput {
  displayName: string;
  numbers: NumberInput[];
}

interface ContactRow {
  id: string;
  user_id: string;
  device_id: string | null;
  source_contact_id: string | null;
  display_name: string;
  normalized_display_name: string;
  dedupe_key: string;
  is_demo: boolean;
  version: number;
  last_accessed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface NumberRow {
  id: string;
  contact_id: string;
  phone_number: string;
  normalized_phone_number: string;
  label: string | null;
  is_primary: boolean;
  position: number;
}

export interface ContactDto {
  id: string;
  displayName: string;
  numbers: { id: string; number: string; normalized: string; formatted: string; label: string | null; isPrimary: boolean }[];
  /** The device-local contact id, only included for contacts that came from the requesting device. */
  sourceContactId: string | null;
  fromThisDevice: boolean;
  isDemo: boolean;
  dedupeKey: string;
  version: number;
  updatedAt: Date;
  deletedAt: Date | null;
}

const MAX_NUMBERS = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Serialises contact writes per user so sync cursors (sequence values) become visible in order. */
async function lockUserContacts(client: pg.PoolClient, userId: string, shared = false) {
  await client.query(shared ? 'SELECT pg_advisory_xact_lock_shared(hashtext($1))' : 'SELECT pg_advisory_xact_lock(hashtext($1))', [
    `contacts:${userId}`,
  ]);
}

function sourceKey(deviceIdentifier: string, nativeId: string) {
  return `${deviceIdentifier}:${nativeId}`;
}

interface PreparedContact {
  displayName: string;
  normalizedName: string;
  dedupeKey: string;
  numbers: { number: string; normalized: string; label: string | null; isPrimary: boolean; position: number }[];
}

/** Validates and normalises contact input. Throws a 400 with a readable message on bad input. */
export function prepareContact(input: ContactInput): PreparedContact {
  const displayName = cleanDisplayName(input.displayName ?? '');
  if (!displayName) throw badRequest('Contact name is required.');
  if (displayName.length > 200) throw badRequest('Contact name is too long.');
  if (!Array.isArray(input.numbers)) throw badRequest('numbers must be a list.');

  const seen = new Set<string>();
  const numbers: PreparedContact['numbers'] = [];
  for (const n of input.numbers) {
    const raw = String(n.number ?? '').trim();
    if (!raw) continue;
    if (raw.length > 40 || !/^[+\d\s().\-#*/pw,;x]+$/i.test(raw)) throw badRequest(`"${raw.slice(0, 40)}" is not a phone number.`);
    const normalized = normalizePhone(raw);
    if (normalized.replace(/\D/g, '').length < 3 || seen.has(normalized)) continue;
    seen.add(normalized);
    numbers.push({
      number: raw,
      normalized,
      label: n.label ? String(n.label).slice(0, 40) : null,
      isPrimary: Boolean(n.isPrimary),
      position: numbers.length,
    });
  }
  if (numbers.length > MAX_NUMBERS) numbers.length = MAX_NUMBERS;
  // Exactly one primary number.
  const primaryIdx = Math.max(numbers.findIndex((n) => n.isPrimary), 0);
  numbers.forEach((n, i) => (n.isPrimary = i === primaryIdx));

  const normalizedName = normalizeName(displayName);
  return {
    displayName,
    normalizedName,
    dedupeKey: dedupeKey(normalizedName, numbers.map((n) => n.normalized)),
    numbers,
  };
}

async function loadNumbers(contactIds: string[], client: Queryable = db()): Promise<Map<string, NumberRow[]>> {
  const map = new Map<string, NumberRow[]>();
  if (!contactIds.length) return map;
  const rows = await query<NumberRow>(
    'SELECT * FROM contact_numbers WHERE contact_id = ANY($1) ORDER BY contact_id, position',
    [contactIds],
    client,
  );
  for (const r of rows) {
    if (!map.has(r.contact_id)) map.set(r.contact_id, []);
    map.get(r.contact_id)!.push(r);
  }
  return map;
}

async function toDtos(rows: ContactRow[], deviceIdentifier?: string | null, client: Queryable = db()): Promise<ContactDto[]> {
  const numbers = await loadNumbers(rows.map((r) => r.id), client);
  const prefix = deviceIdentifier ? `${deviceIdentifier}:` : null;
  return rows.map((r) => {
    const fromThisDevice = Boolean(prefix && r.source_contact_id?.startsWith(prefix));
    return {
      id: r.id,
      displayName: r.display_name,
      numbers: (numbers.get(r.id) ?? []).map((n) => ({
        id: n.id,
        number: n.phone_number,
        normalized: n.normalized_phone_number,
        formatted: formatPhone(n.normalized_phone_number),
        label: n.label,
        isPrimary: n.is_primary,
      })),
      sourceContactId: fromThisDevice ? r.source_contact_id!.slice(prefix!.length) : null,
      fromThisDevice,
      isDemo: r.is_demo,
      dedupeKey: r.dedupe_key,
      version: r.version,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    };
  });
}

function sameContent(prepared: PreparedContact, row: ContactRow, numbers: NumberRow[]) {
  if (row.display_name !== prepared.displayName || row.deleted_at) return false;
  if (numbers.length !== prepared.numbers.length) return false;
  return prepared.numbers.every((n, i) => {
    const existing = numbers[i];
    return existing.normalized_phone_number === n.normalized && existing.phone_number === n.number &&
      (existing.label ?? null) === n.label && existing.is_primary === n.isPrimary;
  });
}

async function writeNumbers(client: pg.PoolClient, contactId: string, prepared: PreparedContact) {
  await client.query('DELETE FROM contact_numbers WHERE contact_id = $1', [contactId]);
  for (const n of prepared.numbers) {
    await client.query(
      `INSERT INTO contact_numbers (contact_id, phone_number, normalized_phone_number, label, is_primary, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [contactId, n.number, n.normalized, n.label, n.isPrimary, n.position],
    );
  }
}

async function insertContact(
  client: pg.PoolClient,
  userId: string,
  prepared: PreparedContact,
  opts: { deviceId?: string | null; sourceKey?: string | null; isDemo?: boolean } = {},
): Promise<ContactRow> {
  const count = await queryOne<{ n: number }>(
    'SELECT count(*)::int AS n FROM contacts WHERE user_id = $1 AND deleted_at IS NULL',
    [userId],
    client,
  );
  if (count!.n >= config().sync.maxContactsPerUser) throw conflict('Contact limit reached for this account.');
  const row = await queryOne<ContactRow>(
    `INSERT INTO contacts (user_id, device_id, source_contact_id, display_name, normalized_display_name, dedupe_key, is_demo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, opts.deviceId ?? null, opts.sourceKey ?? null, prepared.displayName, prepared.normalizedName, prepared.dedupeKey, opts.isDemo ?? false],
    client,
  );
  await writeNumbers(client, row!.id, prepared);
  return row!;
}

async function updateContactRow(client: pg.PoolClient, id: string, prepared: PreparedContact): Promise<ContactRow> {
  const row = await queryOne<ContactRow>(
    `UPDATE contacts SET display_name = $2, normalized_display_name = $3, dedupe_key = $4,
       deleted_at = NULL, updated_at = now(), version = nextval('contact_version_seq')
     WHERE id = $1 RETURNING *`,
    [id, prepared.displayName, prepared.normalizedName, prepared.dedupeKey],
    client,
  );
  await writeNumbers(client, id, prepared);
  return row!;
}

async function tombstone(client: pg.PoolClient, id: string): Promise<ContactRow> {
  const row = await queryOne<ContactRow>(
    `UPDATE contacts SET deleted_at = now(), updated_at = now(), version = nextval('contact_version_seq')
     WHERE id = $1 RETURNING *`,
    [id],
    client,
  );
  return row!;
}

// Shows each distinct contact once: among active contacts sharing a dedupe key, only the oldest is listed.
const DEDUPED = `c.user_id = $1 AND c.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM contacts d WHERE d.user_id = c.user_id AND d.dedupe_key = c.dedupe_key
    AND d.deleted_at IS NULL AND (d.created_at, d.id) < (c.created_at, c.id))`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export async function listContacts(userId: string, opts: { offset?: number; limit?: number; deviceIdentifier?: string | null } = {}): Promise<Page<ContactDto>> {
  const limit = clamp(opts.limit ?? 50, 1, 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const [rows, total] = await Promise.all([
    query<ContactRow>(
      `SELECT c.* FROM contacts c WHERE ${DEDUPED} ORDER BY c.normalized_display_name, c.id LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    ),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${DEDUPED}`, [userId]),
  ]);
  return { items: await toDtos(rows, opts.deviceIdentifier), total: total!.n, offset, limit, hasMore: offset + rows.length < total!.n };
}

/**
 * Searches the user's own contacts by name fragment or phone-number fragment.
 * Input is matched literally (LIKE wildcards escaped) and always parameterised.
 */
export async function searchContacts(
  userId: string,
  rawQuery: string,
  opts: { offset?: number; limit?: number; deviceIdentifier?: string | null } = {},
): Promise<Page<ContactDto>> {
  const q = cleanDisplayName(rawQuery ?? '').slice(0, 50);
  if (!q) throw badRequest('Enter a name or number to search for.');
  const limit = clamp(opts.limit ?? 50, 1, 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const name = normalizeName(q);
  const digits = q.replace(/\D/g, '');
  const looksNumeric = digits.length >= 3 && /^[+\d\s()\-.]+$/.test(q);
  // "0712..." locally is "+254712..." normalised, so also match without the trunk prefix.
  const numberPatterns = looksNumeric ? [...new Set([digits, digits.replace(/^0+/, '')])].filter((d) => d.length >= 3).map((d) => `%${escapeLike(d)}%`) : [];

  const where = `${DEDUPED} AND (
      c.normalized_display_name LIKE $2
      OR (cardinality($3::text[]) > 0 AND EXISTS (
        SELECT 1 FROM contact_numbers n WHERE n.contact_id = c.id AND n.normalized_phone_number LIKE ANY($3::text[]))))`;
  const params = [userId, `%${escapeLike(name)}%`, numberPatterns];
  const [rows, total] = await Promise.all([
    query<ContactRow>(
      `SELECT c.* FROM contacts c WHERE ${where}
       ORDER BY (c.normalized_display_name LIKE $4) DESC, (c.normalized_display_name LIKE $5) DESC, c.normalized_display_name, c.id
       LIMIT $6 OFFSET $7`,
      [...params, `${escapeLike(name)}%`, `% ${escapeLike(name)}%`, limit, offset],
    ),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params),
  ]);
  return { items: await toDtos(rows, opts.deviceIdentifier), total: total!.n, offset, limit, hasMore: offset + rows.length < total!.n };
}

export async function recentContacts(userId: string, opts: { offset?: number; limit?: number } = {}): Promise<Page<ContactDto>> {
  const limit = clamp(opts.limit ?? 20, 1, 50);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = `${DEDUPED} AND c.last_accessed_at IS NOT NULL`;
  const [rows, total] = await Promise.all([
    query<ContactRow>(`SELECT c.* FROM contacts c WHERE ${where} ORDER BY c.last_accessed_at DESC, c.id LIMIT $2 OFFSET $3`, [userId, limit, offset]),
    queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, [userId]),
  ]);
  return { items: await toDtos(rows), total: total!.n, offset, limit, hasMore: offset + rows.length < total!.n };
}

/** Fetches one contact. Ownership is part of the query, so another user's id is simply "not found". */
export async function getContact(userId: string, contactId: string, deviceIdentifier?: string | null): Promise<ContactDto> {
  if (!isUuid(contactId)) throw notFound('Contact not found');
  const row = await queryOne<ContactRow>('SELECT * FROM contacts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL', [contactId, userId]);
  if (!row) throw notFound('Contact not found');
  return (await toDtos([row], deviceIdentifier))[0];
}

export async function touchContact(userId: string, contactId: string) {
  // Does not bump the sync version: access time is not synced data.
  await query('UPDATE contacts SET last_accessed_at = now() WHERE id = $1 AND user_id = $2', [contactId, userId]);
}

export async function countContacts(userId: string): Promise<number> {
  const row = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${DEDUPED}`, [userId]);
  return row!.n;
}

// ---------------------------------------------------------------------------
// Writes from the app (manual contacts and edits)
// ---------------------------------------------------------------------------
export async function createContact(userId: string, input: ContactInput, opts: { isDemo?: boolean; deviceIdentifier?: string | null } = {}): Promise<ContactDto> {
  const prepared = prepareContact(input);
  if (!prepared.numbers.length) throw badRequest('Add at least one phone number.');
  return transaction(async (client) => {
    await lockUserContacts(client, userId);
    const row = await insertContact(client, userId, prepared, { isDemo: opts.isDemo });
    return (await toDtos([row], opts.deviceIdentifier, client))[0];
  });
}

export async function updateContact(
  userId: string,
  contactId: string,
  patch: { displayName?: string; numbers?: NumberInput[]; baseVersion?: number },
  deviceIdentifier?: string | null,
): Promise<ContactDto> {
  if (!isUuid(contactId)) throw notFound('Contact not found');
  return transaction(async (client) => {
    await lockUserContacts(client, userId);
    const row = await queryOne<ContactRow>('SELECT * FROM contacts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [contactId, userId], client);
    if (!row) throw notFound('Contact not found');
    if (patch.baseVersion !== undefined && row.version !== patch.baseVersion) {
      throw conflict('This contact changed on another device. Refresh and try again.');
    }
    const currentNumbers = (await loadNumbers([row.id], client)).get(row.id) ?? [];
    const prepared = prepareContact({
      displayName: patch.displayName ?? row.display_name,
      numbers: patch.numbers ?? currentNumbers.map((n) => ({ number: n.phone_number, label: n.label, isPrimary: n.is_primary })),
    });
    if (!prepared.numbers.length) throw badRequest('A contact needs at least one phone number.');
    const updated = sameContent(prepared, row, currentNumbers) ? row : await updateContactRow(client, row.id, prepared);
    return (await toDtos([updated], deviceIdentifier, client))[0];
  });
}

export async function deleteContact(userId: string, contactId: string): Promise<void> {
  if (!isUuid(contactId)) throw notFound('Contact not found');
  await transaction(async (client) => {
    await lockUserContacts(client, userId);
    const row = await queryOne<ContactRow>('SELECT * FROM contacts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE', [contactId, userId], client);
    if (!row) throw notFound('Contact not found');
    await tombstone(client, row.id);
  });
  await audit(userId, 'contact_deleted', { source: 'app' });
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
export interface SyncUpsert extends ContactInput {
  sourceContactId: string;
  /** Server version the client last saw for this contact. Omit if the client has never seen it. */
  baseVersion?: number | null;
}
export interface SyncDelete {
  sourceContactId: string;
  baseVersion?: number | null;
}
export interface SyncRequest {
  upserts: SyncUpsert[];
  deletes: SyncDelete[];
  /** Marks the end of a sync run: records success and the last-sync timestamp. */
  final?: boolean;
  /** Required when a single request would delete most of the contacts this device synced. */
  confirmMassDelete?: boolean;
  stats?: Record<string, number>;
}
export type SyncResultStatus = 'created' | 'updated' | 'unchanged' | 'deleted' | 'conflict' | 'kept' | 'not_found' | 'invalid';
export interface SyncResult {
  sourceContactId: string;
  status: SyncResultStatus;
  contactId?: string;
  version?: number;
  error?: string;
  /** For conflicts: the server copy that won. */
  server?: ContactDto;
}

/**
 * Applies a batch of device changes.
 *
 * Conflict strategy (documented in docs/SYNC.md): the server version is authoritative. A device change
 * whose baseVersion is older than the server's current version (because the contact was edited or
 * deleted elsewhere since the device last pulled) is rejected as a "conflict" and the server copy is
 * returned for the device to adopt. Changes without a baseVersion are treated as device-wins.
 */
export async function applySync(
  user: { id: string; deletion_policy: 'mirror' | 'keep' },
  device: { id: string; identifier: string },
  req: SyncRequest,
): Promise<{ results: SyncResult[]; summary: Record<SyncResultStatus, number>; syncedAt: Date | null }> {
  const { maxBatchSize } = config().sync;
  if (req.upserts.length + req.deletes.length > maxBatchSize) {
    throw badRequest(`Send at most ${maxBatchSize} changes per request.`);
  }
  await markSync(user.id, device.id, 'in_progress');
  try {
    const results = await transaction(async (client) => {
      await lockUserContacts(client, user.id);
      const out: SyncResult[] = [];

      if (user.deletion_policy === 'mirror' && req.deletes.length > 20 && !req.confirmMassDelete) {
        const fromDevice = await queryOne<{ n: number }>(
          `SELECT count(*)::int AS n FROM contacts WHERE user_id = $1 AND deleted_at IS NULL AND source_contact_id LIKE $2`,
          [user.id, `${escapeLike(device.identifier)}:%`],
          client,
        );
        if (req.deletes.length > fromDevice!.n / 2) {
          throw conflict('This sync would delete most of your synced contacts. Confirm the mass deletion to continue.');
        }
      }

      const keys = [...req.upserts, ...req.deletes].map((c) => sourceKey(device.identifier, String(c.sourceContactId)));
      const existingRows = keys.length
        ? await query<ContactRow>('SELECT * FROM contacts WHERE user_id = $1 AND source_contact_id = ANY($2) FOR UPDATE', [user.id, keys], client)
        : [];
      const existing = new Map(existingRows.map((r) => [r.source_contact_id!, r]));
      const existingNumbers = await loadNumbers(existingRows.map((r) => r.id), client);
      const conflicts: ContactRow[] = [];

      for (const up of req.upserts) {
        const sid = String(up.sourceContactId ?? '');
        if (!sid || sid.length > 200) {
          out.push({ sourceContactId: sid, status: 'invalid', error: 'sourceContactId is required' });
          continue;
        }
        let prepared: PreparedContact;
        try {
          prepared = prepareContact(up);
        } catch (err) {
          out.push({ sourceContactId: sid, status: 'invalid', error: (err as Error).message });
          continue;
        }
        if (!prepared.numbers.length) {
          // Phonebook entries without a phone number are not useful over USSD.
          out.push({ sourceContactId: sid, status: 'invalid', error: 'no phone numbers' });
          continue;
        }
        const key = sourceKey(device.identifier, sid);
        const row = existing.get(key);
        if (!row) {
          const created = await insertContact(client, user.id, prepared, { deviceId: device.id, sourceKey: key });
          existing.set(key, created);
          out.push({ sourceContactId: sid, status: 'created', contactId: created.id, version: created.version });
          continue;
        }
        const stale = up.baseVersion != null && row.version > up.baseVersion;
        if (stale) {
          out.push({ sourceContactId: sid, status: 'conflict', contactId: row.id, version: row.version });
          conflicts.push(row);
          continue;
        }
        if (sameContent(prepared, row, existingNumbers.get(row.id) ?? [])) {
          out.push({ sourceContactId: sid, status: 'unchanged', contactId: row.id, version: row.version });
          continue;
        }
        const updated = await updateContactRow(client, row.id, prepared);
        existing.set(key, updated);
        out.push({ sourceContactId: sid, status: row.deleted_at ? 'created' : 'updated', contactId: updated.id, version: updated.version });
      }

      for (const del of req.deletes) {
        const sid = String(del.sourceContactId ?? '');
        const row = existing.get(sourceKey(device.identifier, sid));
        if (!row || row.deleted_at) {
          out.push({ sourceContactId: sid, status: 'not_found' });
          continue;
        }
        if (user.deletion_policy === 'keep') {
          out.push({ sourceContactId: sid, status: 'kept', contactId: row.id, version: row.version });
          continue;
        }
        if (del.baseVersion != null && row.version > del.baseVersion) {
          out.push({ sourceContactId: sid, status: 'conflict', contactId: row.id, version: row.version });
          conflicts.push(row);
          continue;
        }
        const gone = await tombstone(client, row.id);
        out.push({ sourceContactId: sid, status: 'deleted', contactId: gone.id, version: gone.version });
      }

      if (conflicts.length) {
        const dtos = new Map((await toDtos(conflicts, device.identifier, client)).map((d) => [d.id, d]));
        for (const r of out) if (r.status === 'conflict' && r.contactId) r.server = dtos.get(r.contactId);
      }
      return out;
    });

    const summary = Object.fromEntries(
      (['created', 'updated', 'unchanged', 'deleted', 'conflict', 'kept', 'not_found', 'invalid'] as SyncResultStatus[]).map((s) => [s, 0]),
    ) as Record<SyncResultStatus, number>;
    for (const r of results) summary[r.status]++;

    let syncedAt: Date | null = null;
    if (req.final !== false) {
      syncedAt = await markSync(user.id, device.id, 'success', null, { ...summary, ...(req.stats ?? {}) });
      await audit(user.id, 'sync_completed', { created: summary.created, updated: summary.updated, deleted: summary.deleted, conflicts: summary.conflict });
    } else {
      await markSync(user.id, device.id, 'in_progress');
    }
    return { results, summary, syncedAt };
  } catch (err) {
    await markSync(user.id, device.id, 'error', (err as Error).message.slice(0, 300));
    await audit(user.id, 'sync_failed', { reason: (err as Error).message.slice(0, 100) });
    throw err;
  }
}

/**
 * Returns contact changes (including tombstones) with version > cursor, oldest first.
 * If the cursor predates purged tombstones, returns reset=true and the full active set instead.
 */
export async function pullChanges(userId: string, cursor: number, limit: number, deviceIdentifier?: string | null) {
  const pageSize = clamp(limit, 1, config().sync.maxPullPageSize);
  return transaction(async (client) => {
    // Waits for in-flight writes for this user, so no lower version can commit after we read.
    await lockUserContacts(client, userId, true);
    const purged = Number((await queryOne<{ value: string }>("SELECT value FROM system_meta WHERE key = 'tombstones_purged_through_version'", [], client))?.value ?? 0);
    const reset = cursor > 0 && cursor < purged;
    const from = reset ? 0 : cursor;
    const rows = await query<ContactRow>(
      `SELECT * FROM contacts WHERE user_id = $1 AND version > $2 ${from === 0 ? 'AND deleted_at IS NULL' : ''}
       ORDER BY version LIMIT $3`,
      [userId, from, pageSize + 1],
      client,
    );
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const nextCursor = page.length ? page[page.length - 1].version : from;
    return { contacts: await toDtos(page, deviceIdentifier, client), cursor: nextCursor, hasMore, reset };
  });
}

export async function markSync(
  userId: string,
  deviceId: string,
  status: 'in_progress' | 'success' | 'error',
  error: string | null = null,
  stats?: Record<string, number>,
): Promise<Date | null> {
  const row = await queryOne<{ last_sync_at: Date | null }>(
    `INSERT INTO sync_states (user_id, device_id, sync_status, last_error, last_sync_at, last_stats)
     VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'success' THEN now() END, $5)
     ON CONFLICT (user_id, device_id) DO UPDATE SET
       sync_status = EXCLUDED.sync_status,
       last_error = CASE WHEN EXCLUDED.sync_status = 'in_progress' THEN sync_states.last_error ELSE EXCLUDED.last_error END,
       last_sync_at = CASE WHEN EXCLUDED.sync_status = 'success' THEN now() ELSE sync_states.last_sync_at END,
       last_stats = COALESCE(EXCLUDED.last_stats, sync_states.last_stats),
       updated_at = now()
     RETURNING last_sync_at`,
    [userId, deviceId, status, error, stats ?? null],
  );
  return row?.last_sync_at ?? null;
}

export async function syncStatus(userId: string) {
  const devices = await query<{
    device_id: string; name: string | null; platform: string; last_sync_at: Date | null; sync_status: string;
    last_error: string | null; last_stats: Record<string, number> | null; updated_at: Date;
  }>(
    `SELECT s.device_id, d.name, d.platform, s.last_sync_at, s.sync_status, s.last_error, s.last_stats, s.updated_at
     FROM sync_states s JOIN devices d ON d.id = s.device_id WHERE s.user_id = $1 ORDER BY s.updated_at DESC`,
    [userId],
  );
  const lastSuccess = devices.reduce<Date | null>((acc, d) => (d.last_sync_at && (!acc || d.last_sync_at > acc) ? d.last_sync_at : acc), null);
  const latest = devices[0];
  return {
    totalContacts: await countContacts(userId),
    lastSuccessfulSyncAt: lastSuccess,
    status: (latest?.sync_status ?? 'never') as 'never' | 'in_progress' | 'success' | 'error',
    lastError: latest?.sync_status === 'error' ? latest.last_error : null,
    devices: devices.map((d) => ({
      deviceId: d.device_id,
      name: d.name,
      platform: d.platform,
      lastSuccessfulSyncAt: d.last_sync_at,
      status: d.sync_status,
      lastError: d.last_error,
      lastStats: d.last_stats,
      updatedAt: d.updated_at,
    })),
  };
}

// ---------------------------------------------------------------------------
export function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : min, min), max);
}
