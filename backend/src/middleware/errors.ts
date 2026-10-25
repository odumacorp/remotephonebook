import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: err.issues[0]?.message ?? 'Invalid request',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if ((err as any)?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'Malformed JSON body' } });
    return;
  }
  if ((err as any)?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    return;
  }
  // Never echo internal errors (could include SQL or data) to clients.
  logger.error('unhandled error', { path: req.path, method: req.method, error: (err as Error)?.message });
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
}
