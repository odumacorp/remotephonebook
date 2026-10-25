import { z } from 'zod';
import { hmac } from '../lib/crypto.js';

/**
 * Africa's Talking USSD callback: an application/x-www-form-urlencoded POST with
 * sessionId, serviceCode, phoneNumber, networkCode and text. `text` is every input of the
 * session so far joined by "*" ("" on the first request). The response body is plain text
 * starting with "CON " (expect more input) or "END " (close the session).
 */
export const ussdRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  serviceCode: z.string().trim().min(1).max(40),
  phoneNumber: z.string().trim().min(5).max(20),
  networkCode: z.string().trim().max(20).optional(),
  text: z.string().max(1000).default(''),
});

export type UssdRequest = z.infer<typeof ussdRequestSchema>;

export interface PreviousInput {
  digest: string | null;
  length: number;
}

export function digestText(sessionId: string, text: string): string {
  return hmac(`ussd:${sessionId}:${text}`);
}

/**
 * Works out what the user typed on this step. Compares against a digest of the previous cumulative
 * text so that inputs containing "*" are handled and the raw text (which can include a password)
 * never has to be stored.
 *
 * Returns { duplicate: true } when the gateway re-sent the previous request (e.g. a retry).
 */
export function latestInput(sessionId: string, text: string, prev: PreviousInput): { input: string | null; duplicate: boolean } {
  if (prev.digest === null) {
    // First request of the session. Some networks deliver the initial dial string's extra
    // segments (e.g. *123*1#) as the first text; treat it as the first input.
    return { input: text === '' ? null : text, duplicate: false };
  }
  if (digestText(sessionId, text) === prev.digest) return { input: null, duplicate: true };
  if (prev.length === 0) return { input: text, duplicate: false };
  const head = text.slice(0, prev.length);
  if (text.length > prev.length && text[prev.length] === '*' && digestText(sessionId, head) === prev.digest) {
    return { input: text.slice(prev.length + 1), duplicate: false };
  }
  // Gateway sent something that does not extend the previous text (non-cumulative gateway).
  return { input: text, duplicate: false };
}

export function con(body: string): string {
  return `CON ${body}`;
}

export function end(body: string): string {
  return `END ${body}`;
}
