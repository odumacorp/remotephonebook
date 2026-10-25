import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { config } from '../config.js';

/**
 * Normalises a phone number to E.164 (+254712345678) when it can be parsed for the given
 * region; otherwise falls back to its digits (keeping a leading +) so it can still be matched.
 */
export function normalizePhone(raw: string, region?: string): string {
  const trimmed = raw.trim();
  const parsed = parsePhoneNumberFromString(trimmed, (region ?? config().DEFAULT_PHONE_REGION) as CountryCode);
  if (parsed && parsed.isPossible()) return parsed.number;
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/** Strict variant for account phone numbers: returns null unless the number is valid. */
export function normalizeAccountPhone(raw: string, region?: string): string | null {
  const parsed = parsePhoneNumberFromString(raw.trim(), (region ?? config().DEFAULT_PHONE_REGION) as CountryCode);
  return parsed && parsed.isValid() ? parsed.number : null;
}

/** Human-friendly international format, e.g. "+254 712 345 678". */
export function formatPhone(normalized: string): string {
  const parsed = parsePhoneNumberFromString(normalized);
  return parsed?.isPossible() ? parsed.formatInternational() : normalized;
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cleans a display name for storage: collapses whitespace and strips control characters. */
export function cleanDisplayName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function dedupeKey(normalizedName: string, normalizedNumbers: string[]): string {
  return `${normalizedName}|${[...new Set(normalizedNumbers)].sort().join(',')}`;
}

/** Escapes LIKE/ILIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  return phone.length <= 4 ? '****' : `***${phone.slice(-4)}`;
}
