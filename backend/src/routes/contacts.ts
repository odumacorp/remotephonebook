import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.js';
import * as contacts from '../services/contacts.js';
import { rateLimit } from '../services/rateLimit.js';
import { contactCreateSchema, contactPatchSchema, pageQuery, syncReportSchema, syncSchema } from './schemas.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

contactsRouter.get('/', async (req, res) => {
  const q = pageQuery.parse(req.query);
  res.json(await contacts.listContacts(req.auth!.user.id, { ...q, deviceIdentifier: req.auth!.deviceIdentifier }));
});

contactsRouter.get('/search', async (req, res) => {
  const q = pageQuery.extend({ q: z.string().max(100).default('') }).parse(req.query);
  res.json(await contacts.searchContacts(req.auth!.user.id, q.q, { ...q, deviceIdentifier: req.auth!.deviceIdentifier }));
});

contactsRouter.get('/recent', async (req, res) => {
  const q = pageQuery.parse(req.query);
  res.json(await contacts.recentContacts(req.auth!.user.id, q));
});

/** Incremental pull: changes (including deletions) since the given cursor. */
contactsRouter.get('/changes', async (req, res) => {
  const q = z.object({ cursor: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(500) }).parse(req.query);
  res.json(await contacts.pullChanges(req.auth!.user.id, q.cursor, q.limit, req.auth!.deviceIdentifier));
});

contactsRouter.get('/sync/status', async (req, res) => {
  res.json(await contacts.syncStatus(req.auth!.user.id));
});

contactsRouter.post(
  '/sync',
  rateLimit({ name: 'sync', limit: 120, windowSeconds: 600 }),
  async (req, res) => {
    const { deviceId, deviceIdentifier, user } = req.auth!;
    if (!deviceId || !deviceIdentifier) throw badRequest('Sync requires a session created with device details. Log in again from the app.');
    if (!user.contacts_consent_at) {
      throw badRequest('Allow RemotePhonebook to store your contacts first (Privacy settings).', { consentRequired: true });
    }
    const body = syncSchema.parse(req.body);
    res.json(await contacts.applySync(user, { id: deviceId, identifier: deviceIdentifier }, body));
  },
);

/** Lets the app record a device-side failure (e.g. contacts permission revoked) so USSD can show it. */
contactsRouter.post('/sync/report', async (req, res) => {
  const { deviceId, user } = req.auth!;
  if (!deviceId) throw badRequest('No device on this session.');
  const body = syncReportSchema.parse(req.body);
  await contacts.markSync(user.id, deviceId, 'error', body.error);
  res.status(204).end();
});

contactsRouter.post('/', async (req, res) => {
  const { isDemo, ...body } = contactCreateSchema.parse(req.body);
  res.status(201).json(await contacts.createContact(req.auth!.user.id, body, { isDemo, deviceIdentifier: req.auth!.deviceIdentifier }));
});

contactsRouter.get('/:id', async (req, res) => {
  res.json(await contacts.getContact(req.auth!.user.id, req.params.id, req.auth!.deviceIdentifier));
});

contactsRouter.patch('/:id', async (req, res) => {
  const body = contactPatchSchema.parse(req.body);
  res.json(await contacts.updateContact(req.auth!.user.id, req.params.id, body, req.auth!.deviceIdentifier));
});

contactsRouter.post('/:id/accessed', async (req, res) => {
  await contacts.getContact(req.auth!.user.id, req.params.id);
  await contacts.touchContact(req.auth!.user.id, req.params.id);
  res.status(204).end();
});

contactsRouter.delete('/:id', async (req, res) => {
  await contacts.deleteContact(req.auth!.user.id, req.params.id);
  res.status(204).end();
});
