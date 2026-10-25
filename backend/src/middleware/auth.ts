import type { Request, Response, NextFunction } from 'express';
import { unauthorized } from '../lib/errors.js';
import { authenticateToken, type AuthContext } from '../services/auth.js';
import { queryOne } from '../db/pool.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext & { deviceIdentifier: string | null };
    }
  }
}

/** Requires a valid bearer session token. Every private route derives the user from this, never from input. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const ctx = token ? await authenticateToken(token) : null;
  if (!ctx) throw unauthorized('Your session has expired. Please log in again.');
  const device = ctx.deviceId
    ? await queryOne<{ device_identifier: string }>('SELECT device_identifier FROM devices WHERE id = $1', [ctx.deviceId])
    : undefined;
  req.auth = { ...ctx, deviceIdentifier: device?.device_identifier ?? null };
  next();
}
