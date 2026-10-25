import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { api, bearer, createUser, device, lastCode, resetDb, uniquePhone } from './helpers.js';

beforeEach(resetDb);

describe('registration and verification', () => {
  it('registers, requires verification, verifies via SMS code and returns a session', async () => {
    const phone = uniquePhone();
    const reg = await api().post('/api/auth/register')
      .send({ fullName: 'Amina Hassan', phone, password: 'Kilimanjaro-2026', acceptTerms: true });
    expect(reg.status).toBe(202);
    expect(reg.body.status).toBe('verification_required');
    expect(JSON.stringify(reg.body)).not.toContain(phone); // destination is masked

    // Cannot log in before verifying (revealed only with the correct password).
    const early = await api().post('/api/auth/login').send({ identifier: phone, password: 'Kilimanjaro-2026' });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe('verification_required');

    const bad = await api().post('/api/auth/verify').send({ identifier: phone, code: '000000' });
    expect(bad.status).toBe(400);

    const code = await lastCode(phone);
    const ok = await api().post('/api/auth/verify').send({ identifier: phone, code, device: device() });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.user.phoneVerified).toBe(true);
    expect(ok.body.user.status).toBe('active');

    // Code is single-use.
    const reuse = await api().post('/api/auth/verify').send({ identifier: phone, code });
    expect(reuse.status).toBe(400);
  });

  it('accepts email-only registration', async () => {
    const res = await api().post('/api/auth/register')
      .send({ fullName: 'Email Only', email: 'Only@Example.test', password: 'Kilimanjaro-2026', acceptTerms: true });
    expect(res.status).toBe(202);
    const code = await lastCode('only@example.test');
    const ok = await api().post('/api/auth/verify').send({ identifier: 'only@example.test', code });
    expect(ok.status).toBe(200);
  });

  it('gives the same response for an existing account (no enumeration)', async () => {
    const u = await createUser();
    const res = await api().post('/api/auth/register')
      .send({ fullName: 'Someone Else', email: u.email, password: 'Another-Pass-77', acceptTerms: true });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('verification_required');
    const users = await query('SELECT id FROM users WHERE email = $1', [u.email]);
    expect(users).toHaveLength(1);
  });

  it('validates input', async () => {
    const weak = await api().post('/api/auth/register').send({ fullName: 'A', email: 'a@b.test', password: 'short', acceptTerms: true });
    expect(weak.status).toBe(400);
    const noTerms = await api().post('/api/auth/register').send({ fullName: 'A', email: 'a@b.test', password: 'Kilimanjaro-2026' });
    expect(noTerms.status).toBe(400);
    const noId = await api().post('/api/auth/register').send({ fullName: 'A', password: 'Kilimanjaro-2026', acceptTerms: true });
    expect(noId.status).toBe(400);
    const badPhone = await api().post('/api/auth/register').send({ fullName: 'A', phone: '12', password: 'Kilimanjaro-2026', acceptTerms: true });
    expect(badPhone.status).toBe(400);
    const badJson = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"identifier":');
    expect(badJson.status).toBe(400);
  });

  it('never stores the password in clear', async () => {
    const u = await createUser();
    const row = (await query('SELECT password_hash FROM users WHERE id = $1', [u.id]))[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.password_hash).not.toContain(u.password);
  });
});

describe('login and sessions', () => {
  it('logs in by phone (any format) or email', async () => {
    const u = await createUser();
    const local = '0' + u.phone.slice(4);
    for (const identifier of [u.email.toUpperCase(), u.phone, local]) {
      const res = await api().post('/api/auth/login').send({ identifier, password: u.password, device: device() });
      expect(res.status, identifier).toBe(200);
    }
  });

  it('returns the same generic error for a wrong password and an unknown account', async () => {
    const u = await createUser();
    const wrong = await api().post('/api/auth/login').send({ identifier: u.email, password: 'Wrong-Password-1' });
    const unknown = await api().post('/api/auth/login').send({ identifier: 'nobody@example.test', password: 'Wrong-Password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('locks the account after repeated failures', async () => {
    const u = await createUser();
    for (let i = 0; i < 5; i++) {
      await api().post('/api/auth/login').send({ identifier: u.email, password: 'Wrong-Password-1' }).expect(401);
    }
    // Correct password is refused while locked, with the same generic error.
    const locked = await api().post('/api/auth/login').send({ identifier: u.email, password: u.password });
    expect(locked.status).toBe(401);
    const events = await query("SELECT 1 FROM audit_events WHERE user_id = $1 AND event_type = 'account_locked'", [u.id]);
    expect(events).toHaveLength(1);
  });

  it('protects private endpoints and honours logout and expiry', async () => {
    await api().get('/api/account').expect(401);
    await api().get('/api/account').set('Authorization', 'Bearer not-a-token').expect(401);
    const u = await createUser();
    await api().get('/api/account').set(bearer(u)).expect(200);
    await api().post('/api/auth/logout').set(bearer(u)).expect(204);
    await api().get('/api/account').set(bearer(u)).expect(401);

    const login = await api().post('/api/auth/login').send({ identifier: u.email, password: u.password, device: device() });
    const token = login.body.token;
    await query("UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1", [u.id]);
    const expired = await api().get('/api/account').set('Authorization', `Bearer ${token}`);
    expect(expired.status).toBe(401);
  });

  it('does not store session tokens in clear', async () => {
    const u = await createUser();
    const rows = await query('SELECT token_hash FROM auth_sessions WHERE user_id = $1', [u.id]);
    expect(rows.every((r) => r.token_hash !== u.token)).toBe(true);
  });
});

describe('account recovery', () => {
  it('responds identically for unknown accounts', async () => {
    const res = await api().post('/api/auth/recovery').send({ identifier: 'ghost@example.test' });
    expect(res.status).toBe(202);
    const u = await createUser();
    const real = await api().post('/api/auth/recovery').send({ identifier: u.email });
    expect(real.status).toBe(202);
    expect(real.body).toEqual(res.body);
  });

  it('resets the password with a code and signs out every device', async () => {
    const u = await createUser();
    await api().post('/api/auth/recovery').send({ identifier: u.email }).expect(202);
    const code = await lastCode(u.email);
    await api().post('/api/auth/recovery/confirm').send({ identifier: u.email, code, newPassword: 'weak' }).expect(400);
    await api().post('/api/auth/recovery/confirm').send({ identifier: u.email, code, newPassword: 'Brand-New-Pass-9' }).expect(200);
    await api().get('/api/account').set(bearer(u)).expect(401);
    await api().post('/api/auth/login').send({ identifier: u.email, password: u.password }).expect(401);
    await api().post('/api/auth/login').send({ identifier: u.email, password: 'Brand-New-Pass-9' }).expect(200);
  });

  it('rejects a wrong recovery code', async () => {
    const u = await createUser();
    await api().post('/api/auth/recovery').send({ identifier: u.phone }).expect(202);
    await api().post('/api/auth/recovery/confirm').send({ identifier: u.phone, code: '123456', newPassword: 'Brand-New-Pass-9' }).expect(400);
  });
});

describe('account management', () => {
  it('exports data and deletes the account', async () => {
    const u = await createUser();
    await api().post('/api/contacts').set(bearer(u)).send({ displayName: 'Export Me', numbers: [{ number: '0711000111' }] }).expect(201);
    const exp = await api().get('/api/account/export').set(bearer(u)).expect(200);
    expect(exp.body.contacts).toHaveLength(1);
    expect(JSON.stringify(exp.body)).not.toContain('password');

    await api().delete('/api/account').set(bearer(u)).send({ password: 'wrong', confirm: 'DELETE' }).expect(403);
    await api().delete('/api/account').set(bearer(u)).send({ password: u.password, confirm: 'DELETE' }).expect(204);
    expect(await query('SELECT 1 FROM users WHERE id = $1', [u.id])).toHaveLength(0);
    expect(await query('SELECT 1 FROM contacts WHERE user_id = $1', [u.id])).toHaveLength(0);
  });

  it('lists and removes devices, revoking their sessions', async () => {
    const u = await createUser();
    const other = await api().post('/api/auth/login').send({ identifier: u.email, password: u.password, device: device('tablet') });
    const list = await api().get('/api/devices').set(bearer(u)).expect(200);
    expect(list.body.items).toHaveLength(2);
    const tablet = list.body.items.find((d: any) => d.name === 'tablet');
    await api().delete(`/api/devices/${tablet.id}`).set(bearer(u)).expect(204);
    await api().get('/api/account').set('Authorization', `Bearer ${other.body.token}`).expect(401);
    await api().get('/api/account').set(bearer(u)).expect(200);
  });

  it('cannot remove another user\'s device', async () => {
    const a = await createUser();
    const b = await createUser();
    const bDevices = await api().get('/api/devices').set(bearer(b)).expect(200);
    await api().delete(`/api/devices/${bDevices.body.items[0].id}`).set(bearer(a)).expect(404);
  });

  it('links and verifies an extra phone number', async () => {
    const u = await createUser();
    const extra = uniquePhone();
    const add = await api().post('/api/account/phones').set(bearer(u)).send({ phone: extra, label: 'Work SIM' }).expect(201);
    await api().post(`/api/account/phones/${add.body.id}/verify`).set(bearer(u)).send({ code: '000000' }).expect(400);
    const code = await lastCode(extra);
    await api().post(`/api/account/phones/${add.body.id}/verify`).set(bearer(u)).send({ code }).expect(204);
    const acct = await api().get('/api/account').set(bearer(u)).expect(200);
    expect(acct.body.linkedPhones[0].verifiedAt).toBeTruthy();
  });

  it('validates USSD PINs', async () => {
    const u = await createUser();
    await api().put('/api/account/ussd-pin').set(bearer(u)).send({ password: u.password, pin: '1111' }).expect(400);
    await api().put('/api/account/ussd-pin').set(bearer(u)).send({ password: u.password, pin: '1234' }).expect(400);
    await api().put('/api/account/ussd-pin').set(bearer(u)).send({ password: 'nope', pin: '4826' }).expect(403);
    await api().put('/api/account/ussd-pin').set(bearer(u)).send({ password: u.password, pin: '4826' }).expect(204);
    const acct = await api().get('/api/account').set(bearer(u)).expect(200);
    expect(acct.body.ussdPinSet).toBe(true);
  });
});
