import { query, queryOne, transaction } from '../db/pool.js';
import { hashSecret, verifySecret } from '../lib/crypto.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { normalizeAccountPhone } from '../lib/normalize.js';
import { audit } from './audit.js';
import { consumeCode, deliverCode, publicUser, type UserRow } from './auth.js';
import { isUuid, listContacts } from './contacts.js';

export async function getAccount(user: UserRow) {
  const phones = await query(
    `SELECT id, normalized_phone AS phone, label, verified_at AS "verifiedAt", ussd_trusted AS "ussdTrusted", created_at AS "createdAt"
     FROM linked_phones WHERE user_id = $1 ORDER BY created_at`,
    [user.id],
  );
  return { ...publicUser(user), linkedPhones: phones };
}

export async function updateAccount(
  userId: string,
  patch: { fullName?: string; ussdEnabled?: boolean; deletionPolicy?: 'mirror' | 'keep'; contactsConsent?: boolean },
) {
  const row = await queryOne<UserRow>(
    `UPDATE users SET
       full_name = COALESCE($2, full_name),
       ussd_enabled = COALESCE($3, ussd_enabled),
       deletion_policy = COALESCE($4, deletion_policy),
       contacts_consent_at = CASE WHEN $5::boolean IS NULL THEN contacts_consent_at
                                  WHEN $5 THEN COALESCE(contacts_consent_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE id = $1 RETURNING *`,
    [userId, patch.fullName?.trim() || null, patch.ussdEnabled ?? null, patch.deletionPolicy ?? null, patch.contactsConsent ?? null],
  );
  return getAccount(row!);
}

async function requirePassword(user: UserRow, password: string) {
  if (!(await verifySecret(user.password_hash, password))) {
    throw new HttpError(403, 'invalid_password', 'Your current password is incorrect.');
  }
}

/** Sets the short PIN used for USSD login from the user's own verified phone(s). */
export async function setUssdPin(user: UserRow, password: string, pin: string | null) {
  await requirePassword(user, password);
  if (pin !== null) {
    if (!/^\d{4,6}$/.test(pin)) throw badRequest('PIN must be 4 to 6 digits.');
    if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
      throw badRequest('Choose a PIN that is not a repeated or sequential number.');
    }
  }
  await query('UPDATE users SET ussd_pin_hash = $2, updated_at = now() WHERE id = $1', [user.id, pin ? await hashSecret(pin) : null]);
  await audit(user.id, 'ussd_pin_set', { cleared: pin === null });
}

export async function changePassword(user: UserRow, currentPassword: string, newHash: string, keepSessionId: string) {
  await requirePassword(user, currentPassword);
  await transaction(async (client) => {
    await client.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [user.id, newHash]);
    await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [user.id, keepSessionId]);
  });
  await audit(user.id, 'password_reset', { channel: 'app_change' });
}

// ---------------------------------------------------------------------------
// Linked phones
// ---------------------------------------------------------------------------
export async function addLinkedPhone(user: UserRow, rawPhone: string, label?: string) {
  const phone = normalizeAccountPhone(rawPhone);
  if (!phone) throw badRequest('Enter a valid phone number including the country code.');
  if (phone === user.normalized_phone) throw conflict('This is already your primary number.');
  const count = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM linked_phones WHERE user_id = $1', [user.id]);
  if (count!.n >= 5) throw conflict('You can link up to 5 phone numbers.');
  const row = await queryOne<{ id: string }>(
    `INSERT INTO linked_phones (user_id, normalized_phone, label) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, normalized_phone) DO UPDATE SET label = COALESCE(EXCLUDED.label, linked_phones.label)
     RETURNING id`,
    [user.id, phone, label?.slice(0, 40) ?? null],
  );
  await deliverCode(user.id, 'link_phone', 'sms', phone);
  return { id: row!.id, phone, verificationSent: true };
}

export async function verifyLinkedPhone(user: UserRow, phoneId: string, code: string) {
  if (!isUuid(phoneId)) throw notFound('Phone not found');
  const phone = await queryOne<{ id: string; normalized_phone: string }>(
    'SELECT id, normalized_phone FROM linked_phones WHERE id = $1 AND user_id = $2',
    [phoneId, user.id],
  );
  if (!phone) throw notFound('Phone not found');
  const used = await consumeCode(user.id, ['link_phone'], code);
  if (!used || used.destination !== phone.normalized_phone) {
    throw new HttpError(400, 'invalid_code', 'The code is invalid or has expired.');
  }
  await query('UPDATE linked_phones SET verified_at = now() WHERE id = $1', [phone.id]);
  await audit(user.id, 'phone_linked', {});
}

export async function removeLinkedPhone(userId: string, phoneId: string) {
  if (!isUuid(phoneId)) throw notFound('Phone not found');
  const rows = await query('DELETE FROM linked_phones WHERE id = $1 AND user_id = $2 RETURNING id', [phoneId, userId]);
  if (!rows.length) throw notFound('Phone not found');
  await audit(userId, 'phone_unlinked', {});
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
export async function listDevices(userId: string, currentDeviceId: string | null) {
  const rows = await query(
    `SELECT d.id, d.platform, d.name, d.last_seen_at AS "lastSeenAt", d.created_at AS "createdAt",
            s.last_sync_at AS "lastSyncAt", s.sync_status AS "syncStatus"
     FROM devices d LEFT JOIN sync_states s ON s.device_id = d.id
     WHERE d.user_id = $1 ORDER BY d.last_seen_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, current: r.id === currentDeviceId }));
}

/** Removes a device: signs it out and stops its sync. Contacts it uploaded stay in the account. */
export async function removeDevice(userId: string, deviceId: string) {
  if (!isUuid(deviceId)) throw notFound('Device not found');
  const rows = await query('DELETE FROM devices WHERE id = $1 AND user_id = $2 RETURNING id', [deviceId, userId]);
  if (!rows.length) throw notFound('Device not found');
  await audit(userId, 'device_removed', {});
}

// ---------------------------------------------------------------------------
// Export & deletion
// ---------------------------------------------------------------------------
export async function exportAccount(user: UserRow) {
  const contacts = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listContacts(user.id, { offset, limit: 200 });
    contacts.push(...page.items.map((c) => ({ name: c.displayName, numbers: c.numbers.map((n) => ({ number: n.normalized, label: n.label, primary: n.isPrimary })), demo: c.isDemo })));
    if (!page.hasMore) break;
  }
  await audit(user.id, 'contacts_exported', { count: contacts.length });
  return { exportedAt: new Date().toISOString(), account: await getAccount(user), contacts };
}

/** Permanently deletes the account and everything in it (contacts, devices, sessions cascade). */
export async function deleteAccount(user: UserRow, password: string) {
  await requirePassword(user, password);
  await audit(user.id, 'account_deleted', {});
  await query('DELETE FROM users WHERE id = $1', [user.id]);
}
