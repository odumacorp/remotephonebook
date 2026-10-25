import type { Request, Response, NextFunction } from 'express';
import { queryOne } from '../db/pool.js';
import { tooManyRequests } from '../lib/errors.js';
import { hmac } from '../lib/crypto.js';

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter stored in Postgres so limits hold across API instances.
 * Keys are HMAC'd so identifiers (emails, phone numbers, IPs) are not stored in clear.
 */
export async function hitLimit(key: string, limit: number, windowSeconds: number): Promise<LimitResult> {
  const row = await queryOne<{ hits: number; window_start: Date }>(
    `INSERT INTO rate_limits (bucket_key, window_start, hits) VALUES ($1, now(), 1)
     ON CONFLICT (bucket_key) DO UPDATE SET
       hits = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.hits + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING hits, window_start`,
    [hmac(`rl:${key}`), windowSeconds],
  );
  const hits = row!.hits;
  const elapsed = (Date.now() - new Date(row!.window_start).getTime()) / 1000;
  return {
    allowed: hits <= limit,
    remaining: Math.max(limit - hits, 0),
    retryAfterSeconds: Math.max(Math.ceil(windowSeconds - elapsed), 1),
  };
}

export async function enforceLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  const result = await hitLimit(key, limit, windowSeconds);
  if (!result.allowed) throw tooManyRequests(result.retryAfterSeconds);
}

/** Express middleware: limits by client IP plus an optional key derived from the request body. */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowSeconds: number;
  keyFromBody?: (body: any) => string | undefined;
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const keys = [`${opts.name}:ip:${req.ip}`];
    const extra = opts.keyFromBody?.(req.body);
    if (extra) keys.push(`${opts.name}:id:${extra.toLowerCase()}`);
    for (const key of keys) {
      const result = await hitLimit(key, opts.limit, opts.windowSeconds);
      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        throw tooManyRequests(result.retryAfterSeconds);
      }
    }
    next();
  };
}
