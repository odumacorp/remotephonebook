import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { seedDemo } from '../src/data/seed.js';
import { api, addContacts, bearer, createUser, lastCode, option, resetDb, restoreEnv, setEnv, uniquePhone, UssdSession, type TestUser } from './helpers.js';

beforeEach(async () => {
  await resetDb();
  await seedDemo();
});
afterEach(restoreEnv);

const STRANGER = '+254799000001';

async function loginWithPassword(s: UssdSession, user: TestUser) {
  await s.start();
  await s.send('1');
  await s.send(user.email);
  return s.send(user.password);
}

describe('protocol', () => {
  it('replies with text/plain CON/END bodies', async () => {
    const res = await api().post('/api/ussd').type('form')
      .send({ sessionId: 'P1', serviceCode: '*123#', phoneNumber: STRANGER, networkCode: '63902', text: '' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toMatch(/^CON RemotePhonebook\n1\. Login\n2\. Demo Contacts\n3\. Help\n4\. Exit$/);
  });

  it('rejects malformed callbacks and wrong service codes', async () => {
    const bad = await api().post('/api/ussd').type('form').send({ text: '' });
    expect(bad.text).toMatch(/^END /);
    const wrong = await new UssdSession(STRANGER, '*999#').start();
    expect(wrong).toMatch(/^END /);
    // Extensions of the configured code are accepted.
    const ext = await new UssdSession(STRANGER, '*123*1#').start();
    expect(ext).toMatch(/^CON RemotePhonebook/);
  });

  it('enforces the callback token when configured', async () => {
    setEnv({ USSD_CALLBACK_TOKEN: 'cb-secret-123' });
    const s = new UssdSession(STRANGER);
    await expect(s.start()).rejects.toThrow(/403/);
    const ok = new UssdSession(STRANGER, '*123#', '/api/ussd?token=cb-secret-123');
    expect(await ok.start()).toMatch(/^CON /);
  });

  it('answers a retried request with the same response and does not double-apply it', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    await s.send('2');
    const first = await s.send(option(await s.post(), 'View Contacts'));
    const retry = await s.post();
    expect(retry).toBe(first);
    expect(first).toContain('Page 1');
  });

  it('refuses a session id reused from another phone', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    const hijack = new UssdSession('+254799000002');
    hijack.sessionId = s.sessionId;
    expect(await hijack.start()).toMatch(/^END Session error/);
  });

  it('expires idle sessions', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    await query("UPDATE ussd_sessions SET expires_at = now() - interval '1 second' WHERE provider_session_id = $1", [s.sessionId]);
    expect(await s.send('2')).toMatch(/^END Your session expired/);
    expect(await s.send('1')).toMatch(/^END /);
  });

  it('handles invalid menu choices', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    expect(await s.send('9')).toMatch(/^CON Invalid choice\.\nRemotePhonebook/);
    expect(await s.send('abc')).toMatch(/^CON Invalid choice\./);
  });
});

describe('demo mode', () => {
  it('lists, pages, opens contacts, views numbers, searches and returns to the menu', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    let screen = await s.send('2');
    expect(screen).toContain('Demo Contacts (test data)');

    screen = await s.send(option(screen, 'View Contacts'));
    expect(screen).toBe('CON Demo Contacts - Page 1\n1. Alice Wanjiku\n2. Brian Otieno\n3. Carol Njeri\n4. David Kamau\n5. Esther Achieng\n6. Next Page\n7. Search\n8. Back');

    screen = await s.send('6');
    expect(screen).toContain('Page 2');
    expect(screen).toContain('1. Felix Mwangi');
    expect(screen).toContain('5. James Ouma');
    expect(screen).not.toContain('Next Page');

    screen = await s.send(option(screen, 'Previous Page'));
    expect(screen).toContain('1. Alice Wanjiku');

    screen = await s.send('1');
    expect(screen).toBe('CON Contact: Alice Wanjiku\nPhone: +254700000101 (mobile)\n1. View Number\n2. Send SMS\n3. Return to Contacts\n4. Main Menu');

    screen = await s.send(option(screen, 'View Number'));
    expect(screen).toContain('+254700000101');
    expect(screen).toContain('USSD cannot copy it');

    screen = await s.send(option(screen, 'Back to Contact'));
    screen = await s.send(option(screen, 'Return to Contacts'));
    expect(screen).toContain('Demo Contacts - Page 1');

    screen = await s.send(option(screen, 'Search'));
    expect(screen).toContain('Enter a name or number');
    screen = await s.send('ach');
    expect(screen).toContain('1. Esther Achieng');

    screen = await s.send(option(screen, 'Back'));
    expect(screen).toContain('Demo Contacts (test data)');
  });

  it('shows a clear no-results message and validates search input', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    await s.send('2');
    let screen = await s.send('2');
    screen = await s.send('zzzz');
    expect(screen).toContain('No contacts match "zzzz"');
    screen = await s.send(option(screen, 'Search again'));
    screen = await s.send('%;--');
    expect(screen).toContain('Invalid search');
  });

  it('searches demo contacts by number', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    await s.send('2');
    await s.send('2');
    const screen = await s.send('0700000108');
    expect(screen).toContain('Henry Kiptoo');
  });

  it('simulates sync and never sends real SMS', async () => {
    const s = new UssdSession(STRANGER);
    await s.start();
    let screen = await s.send('2');
    screen = await s.send(option(screen, 'Sync Status'));
    expect(screen).toContain('Sync Status (demo)');
    expect(screen).toContain('Contacts: 10');
    screen = await s.send(option(screen, 'Simulate Sync'));
    expect(screen).toContain('Demo sync simulated.');

    screen = await s.send(option(screen, 'Main Menu'));
    screen = await s.send('1');
    screen = await s.send('1');
    screen = await s.send(option(screen, 'Send SMS'));
    screen = await s.send(option(screen, 'Send'));
    expect(screen).toContain('Demo: SMS simulated');
    const sent = await query('SELECT 1 FROM outbound_messages WHERE destination = $1', [STRANGER]);
    expect(sent).toHaveLength(0);
  });

  it('is unavailable when demo mode is disabled', async () => {
    setEnv({ DEMO_MODE_ENABLED: 'false' });
    const s = new UssdSession(STRANGER);
    const screen = await s.start();
    expect(screen).not.toContain('Demo');
    expect(await s.send('2')).toContain('Help'); // option 2 is now Help
  });
});

describe('login', () => {
  it('logs in with password and walks the full contact menu', async () => {
    const u = await createUser({ name: 'Wanjiru Kariuki' });
    await addContacts(u, [
      { displayName: 'Zawadi Multi', numbers: [{ number: '0711000301', label: 'mobile' }, { number: '0711000302', label: 'work' }] },
      ...Array.from({ length: 6 }, (_, i) => ({ displayName: `Friend ${i}`, numbers: [{ number: `07110004${i}0` }] })),
    ]);
    const s = new UssdSession(STRANGER);
    await s.start();
    let screen = await s.send('1');
    expect(screen).toBe('CON Enter phone number or email:\n0. Back');
    screen = await s.send(u.email);
    expect(screen).toContain('Enter password:');
    expect(screen).toContain('not hidden');
    screen = await s.send(u.password);
    expect(screen).toContain('Login successful.\nWelcome to RemotePhonebook\n1. View Contacts\n2. Search Contacts\n3. Recent Contacts\n4. My Account\n5. Sync Status\n6. Logout');

    screen = await s.send('1');
    expect(screen).toContain('My Contacts - Page 1');
    expect(screen).toContain('Next Page');
    screen = await s.send(option(screen, 'Next Page'));
    expect(screen).toContain('2. Zawadi Multi');

    screen = await s.send(option(screen, 'Zawadi Multi'));
    expect(screen).toContain('Phone: +254711000301 (mobile)');
    expect(screen).toContain('Number 1 of 2');
    screen = await s.send(option(screen, 'Next Number'));
    expect(screen).toContain('Phone: +254711000302 (work)');
    screen = await s.send(option(screen, 'View Number'));
    expect(screen).toContain('+254711000302');

    screen = await s.send(option(screen, 'Main Menu'));
    screen = await s.send(option(screen, 'Recent Contacts'));
    expect(screen).toContain('1. Zawadi Multi');

    screen = await s.send(option(screen, 'Back'));
    screen = await s.send(option(screen, 'My Account'));
    expect(screen).toContain('Name: Wanjiru Kariuki');
    expect(screen).toContain('Contacts: 7');
    expect(screen).not.toContain(u.phone); // masked

    screen = await s.send(option(screen, 'Main Menu'));
    screen = await s.send(option(screen, 'Sync Status'));
    expect(screen).toContain('Status: Never synced');

    screen = await s.send(option(screen, 'Main Menu'));
    screen = await s.send(option(screen, 'Logout'));
    expect(screen).toBe('END You have been logged out. Goodbye.');
    const row = (await query('SELECT authenticated_user_id FROM ussd_sessions WHERE provider_session_id = $1', [s.sessionId]))[0];
    expect(row.authenticated_user_id).toBeNull();
  });

  it('accepts a password containing "*" (USSD separator)', async () => {
    const phone = uniquePhone();
    await api().post('/api/auth/register').send({ fullName: 'Star User', phone, password: 'pass*word*123', acceptTerms: true }).expect(202);
    await api().post('/api/auth/verify').send({ identifier: phone, code: await lastCode(phone) }).expect(200);
    const s = new UssdSession(STRANGER);
    await s.start();
    await s.send('1');
    await s.send(phone);
    expect(await s.send('pass*word*123')).toContain('Login successful');
  });

  it('shows the same generic failure for wrong passwords and unknown accounts, then ends after max attempts', async () => {
    const u = await createUser();
    const s = new UssdSession(STRANGER);
    await s.start();
    await s.send('1');
    await s.send(u.email);
    const wrong = await s.send('Wrong-Password-1');
    expect(wrong).toBe('CON Login failed. Check your details and try again.\nEnter phone number or email:\n0. Back');

    const unknownPrompt = await s.send('nobody@example.test');
    expect(unknownPrompt).toContain('Enter password:'); // same flow as a real account
    const unknown = await s.send('Whatever-123');
    expect(unknown).toBe(wrong);

    await s.send(u.email);
    expect(await s.send('Still-Wrong-1')).toBe('END Login failed. Too many attempts. Please try again later.');
  });

  it('cannot access an account just by knowing its phone number or email', async () => {
    const victim = await createUser({ pin: '4826' });
    // Attacker dials from their own phone, types the victim's number, and tries a PIN.
    const s = new UssdSession(STRANGER);
    await s.start();
    await s.send('1');
    const screen = await s.send(victim.phone);
    expect(screen).toContain('Enter password:'); // PIN login is only offered on the victim's own phone
    expect(await s.send('4826')).toContain('Login failed');
  });

  it('offers PIN login from the account\'s own verified phone', async () => {
    const u = await createUser({ pin: '4826' });
    const s = new UssdSession(u.phone);
    await s.start();
    let screen = await s.send('1');
    expect(screen).toBe('CON Enter your USSD PIN:\n0. Use another account');
    screen = await s.send('9999');
    expect(screen).toContain('Login failed');
    expect(screen).toContain('Enter your USSD PIN');
    screen = await s.send('4826');
    expect(screen).toContain('Login successful');
  });

  it('requires a one-time code from untrusted phones when configured', async () => {
    setEnv({ USSD_REQUIRE_OTP_FOR_UNTRUSTED: 'true' });
    const u = await createUser();
    const s = new UssdSession(STRANGER);
    const screen = await loginWithPassword(s, u);
    expect(screen).toMatch(/Enter the 6-digit code sent to \*\*\*\d{4}/);
    expect(await s.send('000000')).toContain('Login failed');
    await s.send(u.email);
    await s.send(u.password);
    expect(await s.send(await lastCode(u.phone))).toContain('Login successful');
  });

  it('respects USSD being disabled for the account', async () => {
    const u = await createUser();
    await api().patch('/api/account').set(bearer(u)).send({ ussdEnabled: false }).expect(200);
    expect(await loginWithPassword(new UssdSession(STRANGER), u)).toMatch(/^END USSD access is turned off/);
  });

  it('never stores or logs what the user typed', async () => {
    const u = await createUser();
    const s = new UssdSession(STRANGER);
    await loginWithPassword(s, u);
    const sessions = await query('SELECT * FROM ussd_sessions');
    const audits = await query('SELECT * FROM audit_events');
    const dump = JSON.stringify({ sessions, audits });
    expect(dump).not.toContain(u.password);
    expect(dump).not.toContain(u.email);
  });

  it('rate limits login attempts per calling phone', async () => {
    const u = await createUser();
    for (let i = 0; i < 4; i++) {
      const s = new UssdSession(STRANGER);
      await s.start(); await s.send('1');
      for (let j = 0; j < 3; j++) {
        await s.send(u.email);
        await s.send('Wrong-Password-1');
      }
    }
    const s = new UssdSession(STRANGER);
    await s.start(); await s.send('1'); await s.send(u.email);
    expect(await s.send(u.password)).toMatch(/^END Too many login attempts from this phone/);
  });
});

describe('isolation and data accuracy', () => {
  it('shows only the authenticated user\'s contacts', async () => {
    const a = await createUser();
    const b = await createUser();
    await addContacts(a, [{ displayName: 'Only For A', numbers: [{ number: '0711000501' }] }]);
    await addContacts(b, [{ displayName: 'Only For B', numbers: [{ number: '0711000502' }] }]);
    const s = new UssdSession(STRANGER);
    await loginWithPassword(s, b);
    const list = await s.send('1');
    expect(list).toContain('Only For B');
    expect(list).not.toContain('Only For A');
    await s.send(option(list, 'Search'));
    expect(await s.send('Only')).not.toContain('Only For A');
  });

  it('reflects the latest synced data and sync status', async () => {
    const u = await createUser();
    await api().post('/api/contacts/sync').set(bearer(u))
      .send({ upserts: [{ sourceContactId: 'n1', displayName: 'Synced Person', numbers: [{ number: '0711000601' }] }] }).expect(200);
    const s = new UssdSession(STRANGER);
    let screen = await loginWithPassword(s, u);
    screen = await s.send(option(screen, 'Sync Status'));
    expect(screen).toContain('Contacts: 1');
    expect(screen).toContain('Status: Up to date');
    expect(screen).not.toContain('never');

    await api().post('/api/contacts/sync/report').set(bearer(u)).send({ status: 'error', error: 'Permission denied' }).expect(204);
    screen = await s.send(option(screen, 'Main Menu'));
    screen = await s.send(option(screen, 'Sync Status'));
    expect(screen).toContain('Error: Permission denied');
  });

  it('shows an empty state when nothing is synced', async () => {
    const u = await createUser();
    const s = new UssdSession(STRANGER);
    await loginWithPassword(s, u);
    expect(await s.send('1')).toContain('No synced contacts yet');
  });

  it('texts the selected number to the caller (mock provider) with a daily limit', async () => {
    setEnv({ USSD_SMS_DAILY_LIMIT: '1' });
    const u = await createUser();
    await addContacts(u, [{ displayName: 'Text Me', numbers: [{ number: '0711000701' }] }]);
    const s = new UssdSession(STRANGER);
    await loginWithPassword(s, u);
    await s.send('1');
    let screen = await s.send('1');
    screen = await s.send(option(screen, 'Send SMS'));
    screen = await s.send(option(screen, 'Send'));
    expect(screen).toContain('SMS requested');
    const sms = await query('SELECT body FROM outbound_messages WHERE destination = $1', [STRANGER]);
    expect(sms[0].body).toContain('Text Me +254711000701');
    screen = await s.send(option(screen, 'Send SMS'));
    screen = await s.send(option(screen, 'Send'));
    expect(screen).toContain('Daily SMS limit reached');
  });
});

describe('screen size limits', () => {
  it('keeps every screen within USSD_MAX_CHARS, even with long names and a small limit', async () => {
    setEnv({ USSD_MAX_CHARS: '120', USSD_PAGE_SIZE: '7' });
    const u = await createUser();
    await addContacts(u, Array.from({ length: 9 }, (_, i) => ({
      displayName: `${String.fromCharCode(65 + i)} Very Long Contact Name That Goes On And On`,
      numbers: [{ number: `07110008${i}0` }],
    })));
    const s = new UssdSession(STRANGER);
    const screens = [await s.start(), await s.send('1'), await s.send(u.email), await s.send(u.password)];
    let list = await s.send('1');
    screens.push(list);
    const seen = new Set<string>();
    // Walk every page: all contacts must be reachable even though fewer fit per screen.
    for (let i = 0; i < 12; i++) {
      for (const line of list.split('\n')) if (/^\d+\. [A-I] Very/.test(line)) seen.add(line.split('. ')[1][0]);
      if (!list.includes('Next Page')) break;
      list = await s.send(option(list, 'Next Page'));
      screens.push(list);
    }
    expect([...seen].sort().join('')).toBe('ABCDEFGHI');
    screens.push(await s.send('1'));
    for (const sc of screens) expect(sc.length, sc).toBeLessThanOrEqual(120);
  });
});
