import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll } from 'vitest';
import { createApp } from '../src/app.js';
import { reloadConfig } from '../src/config.js';
import { closeDb, query, queryOne } from '../src/db/pool.js';
import { TEST_ENV } from './testEnv.js';

export const app = createApp();
export const api = () => request(app);

afterAll(async () => {
  await closeDb();
});

/** Empties every data table (keeps migrations and system_meta). */
export async function resetDb() {
  await query(`TRUNCATE users, devices, auth_sessions, verification_codes, linked_phones, contacts, contact_numbers,
    sync_states, ussd_sessions, audit_events, rate_limits, outbound_messages RESTART IDENTITY CASCADE`);
  await query("UPDATE system_meta SET value = '0' WHERE key = 'tombstones_purged_through_version'");
}

/** Applies env overrides for the rest of the test (call restoreEnv() afterwards). */
export function setEnv(overrides: Record<string, string>) {
  Object.assign(process.env, overrides);
  reloadConfig();
}
export function restoreEnv() {
  Object.assign(process.env, TEST_ENV);
  reloadConfig();
}

let counter = 0;
export function uniquePhone() {
  counter += 1;
  // +25471xxxxxxx is a valid Kenyan mobile range; random + counter keeps numbers unique per run.
  return `+25471${String((Math.floor(Math.random() * 9_000_000) + counter) % 9_000_000 + 1_000_000)}`;
}

export function device(name = 'test') {
  return { deviceIdentifier: `dev-${name}-${crypto.randomUUID()}`, platform: 'android' as const, name };
}

/** Latest one-time code delivered (mock outbox) to a destination. */
export async function lastCode(destination: string): Promise<string> {
  const row = await queryOne<{ body: string }>(
    'SELECT body FROM outbound_messages WHERE destination = $1 ORDER BY created_at DESC LIMIT 1',
    [destination],
  );
  const match = row?.body.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no code sent to ${destination}`);
  return match[1];
}

export interface TestUser {
  id: string;
  token: string;
  email: string;
  phone: string;
  password: string;
  device: ReturnType<typeof device>;
}

/** Registers, verifies (through the real code flow) and logs in a user with a device. */
export async function createUser(opts: { name?: string; consent?: boolean; pin?: string } = {}): Promise<TestUser> {
  const name = opts.name ?? 'Jane Tester';
  const email = `user-${crypto.randomUUID()}@example.test`;
  const phone = uniquePhone();
  const password = 'Correct-Horse-42';
  const dev = device(name.split(' ')[0]);
  const reg = await api().post('/api/auth/register').send({ fullName: name, email, phone, password, acceptTerms: true });
  if (reg.status !== 202) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
  const code = await lastCode(phone);
  const ver = await api().post('/api/auth/verify').send({ identifier: phone, code, device: dev });
  if (ver.status !== 200) throw new Error(`verify failed ${ver.status} ${JSON.stringify(ver.body)}`);
  const token = ver.body.token as string;
  if (opts.consent !== false) {
    await api().patch('/api/account').set('Authorization', `Bearer ${token}`).send({ contactsConsent: true }).expect(200);
  }
  if (opts.pin) {
    await api().put('/api/account/ussd-pin').set('Authorization', `Bearer ${token}`).send({ password, pin: opts.pin }).expect(204);
  }
  return { id: ver.body.user.id, token, email, phone, password, device: dev };
}

export const bearer = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });

/** Drives a USSD session like Africa's Talking: each step posts the cumulative text. */
export class UssdSession {
  inputs: string[] = [];
  sessionId = `TEST-${crypto.randomUUID()}`;
  constructor(public phone: string, public serviceCode = '*123#', public path = '/api/ussd') {}

  async start(): Promise<string> {
    return this.post();
  }
  async send(input: string): Promise<string> {
    this.inputs.push(input);
    return this.post();
  }
  async post(): Promise<string> {
    const res = await api()
      .post(this.path)
      .type('form')
      .send({ sessionId: this.sessionId, serviceCode: this.serviceCode, phoneNumber: this.phone, networkCode: '63902', text: this.inputs.join('*') });
    if (res.status !== 200) throw new Error(`ussd status ${res.status}: ${res.text}`);
    return res.text;
  }
}

/** Finds the option number for a label on a USSD screen ("3. Search" -> "3"). */
export function option(screen: string, label: string): string {
  const line = screen.split('\n').find((l) => new RegExp(`^\\d+\\. ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(l));
  if (!line) throw new Error(`option "${label}" not found in:\n${screen}`);
  return line.split('.')[0];
}

export async function addContacts(user: TestUser, items: { displayName: string; numbers: { number: string; label?: string }[] }[]) {
  const ids: string[] = [];
  for (const c of items) {
    const res = await api().post('/api/contacts').set(bearer(user)).send(c).expect(201);
    ids.push(res.body.id);
  }
  return ids;
}
