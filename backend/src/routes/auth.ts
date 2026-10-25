import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../services/rateLimit.js';
import * as auth from '../services/auth.js';
import { audit } from '../services/audit.js';
import { loginSchema, recoveryConfirmSchema, recoverySchema, registerSchema, resendSchema, verifySchema } from './schemas.js';

export const authRouter = Router();

const idKey = (body: any) => (typeof body?.identifier === 'string' ? body.identifier.trim() : undefined);

authRouter.post(
  '/register',
  rateLimit({ name: 'register', limit: 10, windowSeconds: 3600 }),
  async (req, res) => {
    const body = registerSchema.parse(req.body);
    const result = await auth.register(body);
    res.status(result.status === 'active' ? 201 : 202).json(result);
  },
);

authRouter.post(
  '/login',
  rateLimit({ name: 'login', limit: 20, windowSeconds: 900, keyFromBody: idKey }),
  async (req, res) => {
    const body = loginSchema.parse(req.body);
    res.json(await auth.login(body.identifier, body.password, body.device));
  },
);

authRouter.post(
  '/verify',
  rateLimit({ name: 'verify', limit: 10, windowSeconds: 900, keyFromBody: idKey }),
  async (req, res) => {
    const body = verifySchema.parse(req.body);
    res.json(await auth.verify(body.identifier, body.code, body.device));
  },
);

authRouter.post(
  '/verify/resend',
  rateLimit({ name: 'verify_resend', limit: 3, windowSeconds: 900, keyFromBody: idKey }),
  async (req, res) => {
    const body = resendSchema.parse(req.body);
    await auth.resendVerification(body.identifier);
    res.status(202).json({ message: 'If the account needs verification, a new code has been sent.' });
  },
);

authRouter.post('/logout', requireAuth, async (req, res) => {
  await auth.revokeSession(req.auth!.sessionId);
  await audit(req.auth!.user.id, 'logout', { channel: 'app' });
  res.status(204).end();
});

authRouter.post(
  '/recovery',
  rateLimit({ name: 'recovery', limit: 5, windowSeconds: 3600, keyFromBody: idKey }),
  async (req, res) => {
    const body = recoverySchema.parse(req.body);
    await auth.requestRecovery(body.identifier);
    // Identical response whether or not the account exists.
    res.status(202).json({ message: 'If an account matches, a recovery code has been sent.' });
  },
);

authRouter.post(
  '/recovery/confirm',
  rateLimit({ name: 'recovery_confirm', limit: 10, windowSeconds: 3600, keyFromBody: idKey }),
  async (req, res) => {
    const body = recoveryConfirmSchema.parse(req.body);
    await auth.confirmRecovery(body.identifier, body.code, body.newPassword);
    res.json({ message: 'Password updated. Please log in again.' });
  },
);
