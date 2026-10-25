import express, { Router, type Request } from 'express';
import { config } from '../config.js';
import { safeEqual } from '../lib/crypto.js';
import { audit } from '../services/audit.js';
import { hitLimit } from '../services/rateLimit.js';
import { handleUssd } from '../ussd/engine.js';
import { end } from '../ussd/protocol.js';

export const ussdRouter = Router();

// Africa's Talking posts application/x-www-form-urlencoded; JSON is accepted for tooling.
ussdRouter.use(express.urlencoded({ extended: false, limit: '4kb' }));
ussdRouter.use(express.json({ limit: '4kb' }));

function callbackAllowed(req: Request): { ok: boolean; reason?: string } {
  const cfg = config();
  if (cfg.USSD_CALLBACK_TOKEN) {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!safeEqual(token, cfg.USSD_CALLBACK_TOKEN)) return { ok: false, reason: 'bad_token' };
  }
  if (cfg.ussdAllowedIps.length && !cfg.ussdAllowedIps.includes(req.ip ?? '')) return { ok: false, reason: 'ip_not_allowed' };
  return { ok: true };
}

function sendText(res: express.Response, body: string) {
  // AT expects a plain-text body beginning with CON or END, and an HTTP 200.
  res.status(200).type('text/plain').send(body);
}

ussdRouter.post('/', async (req, res) => {
  const allowed = callbackAllowed(req);
  if (!allowed.ok) {
    await audit(null, 'callback_rejected', { reason: allowed.reason });
    res.status(403).type('text/plain').send('END Forbidden');
    return;
  }
  const phone = typeof req.body?.phoneNumber === 'string' ? req.body.phoneNumber : 'unknown';
  const limit = await hitLimit(`ussd_req:${phone}`, 120, 300);
  if (!limit.allowed) {
    sendText(res, end('Too many requests. Please wait a few minutes and dial again.'));
    return;
  }
  sendText(res, await handleUssd(req.body));
});

ussdRouter.get('/health', (_req, res) => {
  const cfg = config();
  res.json({
    status: 'ok',
    serviceCode: cfg.AFRICASTALKING_USSD_SERVICE_CODE,
    provider: cfg.AFRICASTALKING_ENV,
    callbackTokenRequired: Boolean(cfg.USSD_CALLBACK_TOKEN),
    demoMode: cfg.demoModeEnabled,
    pageSize: cfg.USSD_PAGE_SIZE,
    maxChars: cfg.USSD_MAX_CHARS,
  });
});
