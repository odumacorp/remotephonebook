import express, { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { handleUssd } from '../ussd/engine.js';

/**
 * Development-only tools. Mounted only when DEV_TOOLS_ENABLED (always off in production):
 * the mock SMS/email outbox (where one-time codes appear in mock mode) and a USSD simulator.
 */
export const devRouter = Router();
devRouter.use(express.json({ limit: '8kb' }));

devRouter.get('/outbox', async (req, res) => {
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const rows = await query(
    `SELECT id, channel, destination, body, provider, status, created_at AS "createdAt"
     FROM outbound_messages WHERE ($1::text IS NULL OR destination = $1) ORDER BY created_at DESC LIMIT 50`,
    [to],
  );
  res.json({ items: rows });
});

/** Same handler as /api/ussd, minus the callback guard, for the simulator UIs. */
devRouter.post('/ussd', async (req, res) => {
  const body = { serviceCode: config().AFRICASTALKING_USSD_SERVICE_CODE, networkCode: '99999', ...req.body };
  res.type('text/plain').send(await handleUssd(body));
});

const simulatorHtml = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/ussd-simulator.html');
devRouter.get('/ussd-simulator', (_req, res) => {
  res.type('html').send(fs.readFileSync(simulatorHtml, 'utf8').replaceAll('{{SERVICE_CODE}}', config().AFRICASTALKING_USSD_SERVICE_CODE).replaceAll('{{MAX}}', String(config().USSD_MAX_CHARS - 4)));
});
