import { config } from '../config.js';
import { query, queryOne, transaction, type Queryable, db } from '../db/pool.js';
import { dummyPasswordHash, hashSecret, hmac, numericCode, randomToken, safeEqual, verifySecret } from '../lib/crypto.js';
import { HttpError, badRequest, unauthorized } from '../lib/errors.js';
import { maskEmail, maskPhone, normalizeAccountPhone, normalizeEmail, normalizePhone } from '../lib/normalize.js';
import { audit } from './audit.js';
import { sendEmail, sendSms } from './messaging.js';

export interface UserRow {
  id: string;
  full_name: string;
  email: string | null;
  normalized_phone: string | null;
  password_hash: string;
  ussd_pin_hash: string | null;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  account_status: 'pending_verification' | 'active' | 'suspended' | 'demo';
  ussd_enabled: boolean;
  deletion_policy: 'mirror' | 'keep';
  contacts_consent_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface DeviceInfo {
  deviceIdentifier: string;
  platform: 'ios' | 'android' | 'web' | 'other';
  name?: string;
}

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;
const CODE_TTL_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 5;

export const GENERIC_LOGIN_ERROR = 'Invalid credentials';

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------
const COMMON_PASSWORDS = new Set([
  'password123', 'password1234', '1234567890', 'qwertyuiop', 'iloveyou12', 'letmein123', 'welcome123', 'admin12345',
]);

export function passwordProblems(password: string, context: string[] = []): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Password must be at least 10 characters.');
  if (password.length > 128) problems.push('Password must be at most 128 characters.');
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) problems.push('Password must contain letters and numbers.');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) problems.push('Password is too common.');
  for (const c of context) {
    if (c && c.length >= 4 && password.toLowerCase().includes(c.toLowerCase())) {
      problems.push('Password must not contain your name, email or phone number.');
      break;
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
/** Resolves an email address or phone number to a user. Never throws for unknown identifiers. */
export async function findUserByIdentifier(identifier: string, client: Queryable = db()): Promise<UserRow | undefined> {
  const id = identifier.trim();
  if (!id || id.length > 254) return undefined;
  if (id.includes('@')) {
    return queryOne<UserRow>('SELECT * FROM users WHERE email = $1', [normalizeEmail(id)], client);
  }
  const phone = normalizeAccountPhone(id) ?? normalizePhone(id);
  if (!phone) return undefined;
  return queryOne<UserRow>('SELECT * FROM users WHERE normalized_phone = $1', [phone], client);
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    fullName: u.full_name,
    email: u.email,
    phone: u.normalized_phone,
    emailVerified: Boolean(u.email_verified_at),
    phoneVerified: Boolean(u.phone_verified_at),
    status: u.account_status,
    ussdEnabled: u.ussd_enabled,
    ussdPinSet: Boolean(u.ussd_pin_hash),
    deletionPolicy: u.deletion_policy,
    contactsConsentAt: u.contacts_consent_at,
    createdAt: u.created_at,
  };
}

// ---------------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------------
type CodePurpose = 'verify_email' | 'verify_phone' | 'recovery' | 'link_phone' | 'ussd_login';

function codeHash(userId: string, purpose: string, code: string) {
  return hmac(`otp:${userId}:${purpose}:${code}`);
}

export async function issueCode(
  userId: string,
  purpose: CodePurpose,
  channel: 'email' | 'sms',
  destination: string,
  client: Queryable = db(),
): Promise<string> {
  const code = numericCode(6);
  // Only the newest code for a purpose is valid.
  await query(
    `UPDATE verification_codes SET consumed_at = now()
     WHERE user_id = $1 AND purpose = $2 AND channel = $3 AND consumed_at IS NULL`,
    [userId, purpose, channel],
    client,
  );
  await query(
    `INSERT INTO verification_codes (user_id, purpose, channel, destination, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [userId, purpose, channel, destination, codeHash(userId, purpose, code), CODE_TTL_MINUTES],
    client,
  );
  return code;
}

async function deliverCode(userId: string, purpose: CodePurpose, channel: 'email' | 'sms', destination: string) {
  const code = await issueCode(userId, purpose, channel, destination);
  const what =
    purpose === 'recovery' ? 'account recovery' : purpose === 'ussd_login' ? 'USSD login' : 'verification';
  const text = `Your RemotePhonebook ${what} code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Never share this code.`;
  if (channel === 'sms') return sendSms(destination, text, { userId, sensitive: true });
  return sendEmail(destination, `RemotePhonebook ${what} code`, text, { userId, sensitive: true });
}

/** Checks a code against the active codes for any of the given purposes; consumes it on success. */
export async function consumeCode(userId: string, purposes: CodePurpose[], code: string): Promise<{ purpose: CodePurpose; channel: string; destination: string } | null> {
  const rows = await query<{ id: string; purpose: CodePurpose; channel: string; destination: string; code_hash: string; attempts: number }>(
    `SELECT id, purpose, channel, destination, code_hash, attempts FROM verification_codes
     WHERE user_id = $1 AND purpose = ANY($2) AND consumed_at IS NULL AND expires_at > now()`,
    [userId, purposes],
  );
  const cleaned = code.replace(/\s/g, '');
  for (const row of rows) {
    if (row.attempts >= MAX_CODE_ATTEMPTS) continue;
    if (safeEqual(row.code_hash, codeHash(userId, row.purpose, cleaned))) {
      await query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
      return { purpose: row.purpose, channel: row.channel, destination: row.destination };
    }
  }
  if (rows.length) {
    await query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ANY($1)', [rows.map((r) => r.id)]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export async function upsertDevice(userId: string, device: DeviceInfo, client: Queryable = db()): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO devices (user_id, device_identifier, platform, name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, device_identifier) DO UPDATE
       SET last_seen_at = now(), platform = EXCLUDED.platform, name = COALESCE(EXCLUDED.name, devices.name)
     RETURNING id`,
    [userId, device.deviceIdentifier, device.platform, device.name ?? null],
    client,
  );
  return row!.id;
}

export async function createSession(userId: string, device?: DeviceInfo) {
  const token = randomToken(32);
  const ttlHours = config().SESSION_TTL_HOURS;
  return transaction(async (client) => {
    const deviceId = device ? await upsertDevice(userId, device, client) : null;
    const row = await queryOne<{ id: string; expires_at: Date }>(
      `INSERT INTO auth_sessions (user_id, device_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING id, expires_at`,
      [userId, deviceId, hmac(`session:${token}`), ttlHours],
      client,
    );
    return { token, sessionId: row!.id, deviceId, expiresAt: row!.expires_at };
  });
}

export interface AuthContext {
  user: UserRow;
  sessionId: string;
  deviceId: string | null;
}

export async function authenticateToken(token: string): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const row = await queryOne<{ session_id: string; device_id: string | null; user_id: string }>(
    `UPDATE auth_sessions SET last_used_at = now()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
     RETURNING id AS session_id, device_id, user_id`,
    [hmac(`session:${token}`)],
  );
  if (!row) return null;
  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1', [row.user_id]);
  if (!user || user.account_status === 'suspended') return null;
  if (row.device_id) await query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [row.device_id]);
  return { user, sessionId: row.session_id, deviceId: row.device_id };
}

export async function revokeSession(sessionId: string) {
  await query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

// ---------------------------------------------------------------------------
// Registration & verification
// ---------------------------------------------------------------------------
export interface RegisterInput {
  fullName: string;
  email?: string;
  phone?: string;
  password: string;
  device?: DeviceInfo;
}

export async function register(input: RegisterInput) {
  const cfg = config();
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone ? normalizeAccountPhone(input.phone) : null;
  if (input.phone && !phone) throw badRequest('Enter a valid mobile number, including the country code (e.g. +254712345678).');
  if (!email && !phone) throw badRequest('An email address or mobile number is required.');
  const problems = passwordProblems(input.password, [input.fullName.split(' ')[0], email?.split('@')[0] ?? '', phone?.slice(-6) ?? '']);
  if (problems.length) throw badRequest(problems[0], { password: problems });

  const passwordHash = await hashSecret(input.password);
  const status = cfg.REQUIRE_VERIFICATION ? 'pending_verification' : 'active';

  const existing = await queryOne<UserRow>(
    'SELECT * FROM users WHERE ($1::text IS NOT NULL AND email = $1) OR ($2::text IS NOT NULL AND normalized_phone = $2)',
    [email, phone],
  );
  if (existing) {
    if (!cfg.REQUIRE_VERIFICATION) throw new HttpError(409, 'conflict', 'An account with these details already exists.');
    // Same response as a fresh registration so the endpoint cannot be used to discover accounts.
    // The real owner is told someone tried to register with their details.
    if (existing.email && email === existing.email) {
      await sendEmail(existing.email, 'RemotePhonebook sign-up attempt', 'Someone tried to create a RemotePhonebook account with your email address. If this was you, sign in or reset your password instead.', { userId: existing.id });
    } else if (existing.normalized_phone) {
      await sendSms(existing.normalized_phone, 'Someone tried to register a RemotePhonebook account with your number. If this was you, log in or reset your password.', { userId: existing.id });
    }
    return { status: 'verification_required' as const, channels: channelsFor(email, phone) };
  }

  const user = await queryOne<UserRow>(
    `INSERT INTO users (full_name, email, normalized_phone, password_hash, account_status, deletion_policy)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.fullName.trim(), email, phone, passwordHash, status, cfg.sync.defaultDeletionPolicy],
  );
  await audit(user!.id, 'register', { channels: channelsFor(email, phone) });

  if (!cfg.REQUIRE_VERIFICATION) {
    const session = await createSession(user!.id, input.device);
    return { status: 'active' as const, user: publicUser(user!), ...session };
  }
  if (email) await deliverCode(user!.id, 'verify_email', 'email', email);
  if (phone) await deliverCode(user!.id, 'verify_phone', 'sms', phone);
  return { status: 'verification_required' as const, channels: channelsFor(email, phone) };
}

function channelsFor(email: string | null, phone: string | null) {
  return [...(email ? [{ channel: 'email', destination: maskEmail(email) }] : []), ...(phone ? [{ channel: 'sms', destination: maskPhone(phone) }] : [])];
}

export async function verify(identifier: string, code: string, device?: DeviceInfo) {
  const user = await findUserByIdentifier(identifier);
  const generic = new HttpError(400, 'invalid_code', 'The code is invalid or has expired.');
  if (!user) throw generic;
  const used = await consumeCode(user.id, ['verify_email', 'verify_phone'], code);
  if (!used) {
    await audit(user.id, 'verify_failed', {});
    throw generic;
  }
  const column = used.purpose === 'verify_email' ? 'email_verified_at' : 'phone_verified_at';
  const updated = await queryOne<UserRow>(
    `UPDATE users SET ${column} = now(), updated_at = now(),
       account_status = CASE WHEN account_status = 'pending_verification' THEN 'active' ELSE account_status END
     WHERE id = $1 RETURNING *`,
    [user.id],
  );
  await audit(user.id, 'verify_success', { channel: used.channel });
  const session = await createSession(user.id, device);
  return { user: publicUser(updated!), ...session };
}

export async function resendVerification(identifier: string) {
  const user = await findUserByIdentifier(identifier);
  if (!user || user.account_status !== 'pending_verification') return;
  if (user.email && !user.email_verified_at) await deliverCode(user.id, 'verify_email', 'email', user.email);
  if (user.normalized_phone && !user.phone_verified_at) await deliverCode(user.id, 'verify_phone', 'sms', user.normalized_phone);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
export type CredentialCheck =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'invalid' | 'locked' | 'unverified' | 'suspended'; user?: UserRow };

/**
 * Verifies a password (or USSD PIN) with lockout. Unknown accounts take the same time as known ones.
 * Callers must show the same generic error for every failure reason except 'unverified',
 * which is only revealed after a correct password.
 */
export async function checkCredentials(
  identifier: string,
  secret: string,
  kind: 'password' | 'pin' = 'password',
): Promise<CredentialCheck> {
  return checkUserCredentials(await findUserByIdentifier(identifier), secret, kind);
}

/** Same as checkCredentials for an already-resolved (possibly missing) user. */
export async function checkUserCredentials(
  user: UserRow | undefined,
  secret: string,
  kind: 'password' | 'pin' = 'password',
): Promise<CredentialCheck> {
  const storedHash = kind === 'pin' ? user?.ussd_pin_hash : user?.password_hash;
  if (!user || !storedHash) {
    await verifySecret(await dummyPasswordHash(), secret);
    return { ok: false, reason: 'invalid' };
  }
  if (user.locked_until && user.locked_until > new Date()) {
    await verifySecret(await dummyPasswordHash(), secret);
    return { ok: false, reason: 'locked', user };
  }
  const valid = await verifySecret(storedHash, secret);
  if (!valid) {
    const updated = await queryOne<{ failed_login_count: number }>(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1 RETURNING failed_login_count`,
      [user.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
    );
    if (updated && updated.failed_login_count >= MAX_FAILED_LOGINS) {
      await audit(user.id, 'account_locked', { kind });
      await query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [user.id]);
    }
    return { ok: false, reason: 'invalid', user };
  }
  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [user.id]);
  if (user.account_status === 'suspended') return { ok: false, reason: 'suspended', user };
  if (user.account_status === 'pending_verification') return { ok: false, reason: 'unverified', user };
  return { ok: true, user };
}

export async function login(identifier: string, password: string, device?: DeviceInfo) {
  const result = await checkCredentials(identifier, password);
  if (!result.ok) {
    await audit(result.user?.id ?? null, 'login_failed', { channel: 'app', reason: result.reason });
    if (result.reason === 'unverified') {
      throw new HttpError(403, 'verification_required', 'Verify your email or phone number to continue.');
    }
    throw unauthorized(GENERIC_LOGIN_ERROR);
  }
  if (result.user.account_status === 'demo' && config().isProd) throw unauthorized(GENERIC_LOGIN_ERROR);
  const session = await createSession(result.user.id, device);
  await audit(result.user.id, 'login_success', { channel: 'app' });
  return { user: publicUser(result.user), ...session };
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------
export async function requestRecovery(identifier: string) {
  const user = await findUserByIdentifier(identifier);
  if (!user || user.account_status === 'demo') return; // response is identical either way
  // Send to the channel the user asked about, falling back to any other channel on file.
  const viaEmail = identifier.includes('@') ? user.email : null;
  if (viaEmail || (!user.normalized_phone && user.email)) {
    await deliverCode(user.id, 'recovery', 'email', user.email!);
  } else if (user.normalized_phone) {
    await deliverCode(user.id, 'recovery', 'sms', user.normalized_phone);
  }
  await audit(user.id, 'recovery_requested', {});
}

export async function confirmRecovery(identifier: string, code: string, newPassword: string) {
  const user = await findUserByIdentifier(identifier);
  const generic = new HttpError(400, 'invalid_code', 'The code is invalid or has expired.');
  if (!user) throw generic;
  const problems = passwordProblems(newPassword, [user.full_name.split(' ')[0], user.email?.split('@')[0] ?? '']);
  if (problems.length) throw badRequest(problems[0], { password: problems });
  const used = await consumeCode(user.id, ['recovery'], code);
  if (!used) throw generic;
  const hash = await hashSecret(newPassword);
  const verifiedColumn = used.channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
  await transaction(async (client) => {
    await query(
      `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now(),
         ${verifiedColumn} = COALESCE(${verifiedColumn}, now()),
         account_status = CASE WHEN account_status = 'pending_verification' THEN 'active' ELSE account_status END
       WHERE id = $1`,
      [user.id, hash],
      client,
    );
    // A password reset signs out every device.
    await query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [user.id], client);
    await audit(user.id, 'password_reset', { channel: used.channel }, client);
  });
}

export { deliverCode };
