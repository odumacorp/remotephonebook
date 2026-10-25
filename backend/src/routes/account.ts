import { Router } from 'express';
import { z } from 'zod';
import { hashSecret } from '../lib/crypto.js';
import { badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import * as account from '../services/account.js';
import { passwordProblems } from '../services/auth.js';
import { rateLimit } from '../services/rateLimit.js';

export const accountRouter = Router();
accountRouter.use(requireAuth);

accountRouter.get('/', async (req, res) => {
  res.json(await account.getAccount(req.auth!.user));
});

accountRouter.patch('/', async (req, res) => {
  const body = z
    .object({
      fullName: z.string().trim().min(1).max(120).optional(),
      ussdEnabled: z.boolean().optional(),
      deletionPolicy: z.enum(['mirror', 'keep']).optional(),
      contactsConsent: z.boolean().optional(),
    })
    .parse(req.body);
  res.json(await account.updateAccount(req.auth!.user.id, body));
});

const sensitive = rateLimit({ name: 'account_sensitive', limit: 10, windowSeconds: 900 });

accountRouter.post('/password', sensitive, async (req, res) => {
  const body = z.object({ currentPassword: z.string().max(128), newPassword: z.string().max(128) }).parse(req.body);
  const u = req.auth!.user;
  const problems = passwordProblems(body.newPassword, [u.full_name.split(' ')[0], u.email?.split('@')[0] ?? '']);
  if (problems.length) throw badRequest(problems[0], { password: problems });
  await account.changePassword(u, body.currentPassword, await hashSecret(body.newPassword), req.auth!.sessionId);
  res.status(204).end();
});

accountRouter.put('/ussd-pin', sensitive, async (req, res) => {
  const body = z.object({ password: z.string().max(128), pin: z.string().max(6).nullable() }).parse(req.body);
  await account.setUssdPin(req.auth!.user, body.password, body.pin);
  res.status(204).end();
});

accountRouter.post('/phones', sensitive, async (req, res) => {
  const body = z.object({ phone: z.string().max(20), label: z.string().max(40).optional() }).parse(req.body);
  res.status(201).json(await account.addLinkedPhone(req.auth!.user, body.phone, body.label));
});

accountRouter.post('/phones/:id/verify', sensitive, async (req, res) => {
  const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  await account.verifyLinkedPhone(req.auth!.user, req.params.id as string, body.code);
  res.status(204).end();
});

accountRouter.delete('/phones/:id', async (req, res) => {
  await account.removeLinkedPhone(req.auth!.user.id, req.params.id as string);
  res.status(204).end();
});

accountRouter.get('/export', rateLimit({ name: 'export', limit: 5, windowSeconds: 3600 }), async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="remotephonebook-export.json"');
  res.json(await account.exportAccount(req.auth!.user));
});

accountRouter.delete('/', sensitive, async (req, res) => {
  const body = z.object({ password: z.string().max(128), confirm: z.literal('DELETE') }).parse(req.body);
  await account.deleteAccount(req.auth!.user, body.password);
  res.status(204).end();
});

export const devicesRouter = Router();
devicesRouter.use(requireAuth);

devicesRouter.get('/', async (req, res) => {
  res.json({ items: await account.listDevices(req.auth!.user.id, req.auth!.deviceId) });
});

devicesRouter.delete('/:id', async (req, res) => {
  await account.removeDevice(req.auth!.user.id, req.params.id as string);
  res.status(204).end();
});
