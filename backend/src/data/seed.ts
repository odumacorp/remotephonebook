import { query, queryOne } from '../db/pool.js';
import { hashSecret } from '../lib/crypto.js';
import { createContact, markSync } from '../services/contacts.js';
import { DEMO_ACCOUNT_EMAIL, DEMO_CONTACTS } from './demoContacts.js';

export const DEMO_PASSWORD = 'DemoPass2026';
export const TEST_USER = {
  fullName: 'Test User',
  email: 'test@remotephonebook.test',
  phone: '+254700000999',
  password: 'TestPass2026!',
  pin: '2468',
};

/** Creates (or resets) the demo account and its ten fictional contacts. Idempotent. */
export async function seedDemo(): Promise<string> {
  let demo = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [DEMO_ACCOUNT_EMAIL]);
  if (!demo) {
    demo = await queryOne<{ id: string }>(
      `INSERT INTO users (full_name, email, password_hash, account_status, email_verified_at, contacts_consent_at, ussd_enabled)
       VALUES ('Demo Account (test data)', $1, $2, 'demo', now(), now(), true) RETURNING id`,
      [DEMO_ACCOUNT_EMAIL, await hashSecret(DEMO_PASSWORD)],
    );
  }
  await query('DELETE FROM contacts WHERE user_id = $1', [demo!.id]);
  for (const c of DEMO_CONTACTS) {
    await createContact(demo!.id, { displayName: c.displayName, numbers: [{ number: c.number, label: 'mobile', isPrimary: true }] }, { isDemo: true });
  }
  const device = await queryOne<{ id: string }>(
    `INSERT INTO devices (user_id, device_identifier, platform, name) VALUES ($1, 'demo-device-0001', 'other', 'Demo phone')
     ON CONFLICT (user_id, device_identifier) DO UPDATE SET last_seen_at = now() RETURNING id`,
    [demo!.id],
  );
  await markSync(demo!.id, device!.id, 'success', null, { created: DEMO_CONTACTS.length });
  return demo!.id;
}

/** A verified, active development user with a few contacts (two with several numbers) and a USSD PIN. */
export async function seedTestUser(): Promise<string> {
  let user = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [TEST_USER.email]);
  if (!user) {
    user = await queryOne<{ id: string }>(
      `INSERT INTO users (full_name, email, normalized_phone, password_hash, ussd_pin_hash, account_status,
                          email_verified_at, phone_verified_at, contacts_consent_at)
       VALUES ($1, $2, $3, $4, $5, 'active', now(), now(), now()) RETURNING id`,
      [TEST_USER.fullName, TEST_USER.email, TEST_USER.phone, await hashSecret(TEST_USER.password), await hashSecret(TEST_USER.pin)],
    );
  }
  await query('DELETE FROM contacts WHERE user_id = $1', [user!.id]);
  const contacts = [
    { displayName: 'Mama (test)', numbers: [{ number: '+254700000201', label: 'mobile' }, { number: '+254700000202', label: 'work' }] },
    { displayName: 'Office Reception (test)', numbers: [{ number: '+254700000203', label: 'work' }] },
    { displayName: 'Peter Ochieng (test)', numbers: [{ number: '0700000204', label: 'mobile' }, { number: '+254700000205', label: 'home' }, { number: '+254700000206', label: 'other' }] },
    ...DEMO_CONTACTS.slice(0, 7).map((c) => ({ displayName: `${c.displayName} (test)`, numbers: [{ number: c.number, label: 'mobile' }] })),
  ];
  for (const c of contacts) await createContact(user!.id, c);
  return user!.id;
}
