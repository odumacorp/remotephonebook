import crypto from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { config } from '../config.js';

// OWASP-recommended argon2id baseline (19 MiB, 2 iterations).
const ARGON_OPTS = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON_OPTS);
}

export async function verifySecret(hashed: string, secret: string): Promise<boolean> {
  try {
    return await verify(hashed, secret);
  } catch {
    return false;
  }
}

// A real argon2 hash of a random value: verifying against it when the account does not exist
// costs the same time as a real check, so response timing does not reveal whether an account exists.
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashSecret(crypto.randomBytes(16).toString('hex'));
  return dummyHash;
}

export function hmac(value: string): string {
  return crypto.createHmac('sha256', config().AUTH_SECRET).update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function numericCode(length = 6): string {
  let out = '';
  for (let i = 0; i < length; i++) out += crypto.randomInt(0, 10).toString();
  return out;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
