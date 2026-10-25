import { config } from '../config.js';

// Keys whose values must never reach logs.
const SENSITIVE = /pass(word)?|pin|secret|token|code|otp|authorization|api[-_]?key|text/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function write(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  if (config().isTest && level === 'info') return;
  const line = JSON.stringify({ level, time: new Date().toISOString(), msg, ...(redact(meta) as object) });
  (level === 'error' ? console.error : console.log)(line);
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => write('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => write('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => write('error', msg, meta),
};
