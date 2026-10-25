import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { accountRouter, devicesRouter } from './routes/account.js';
import { authRouter } from './routes/auth.js';
import { contactsRouter } from './routes/contacts.js';
import { devRouter } from './routes/dev.js';
import { ussdRouter } from './routes/ussd.js';
import { db } from './db/pool.js';

export function createApp() {
  const cfg = config();
  const app = express();
  app.disable('x-powered-by');
  // Behind a TLS-terminating proxy (Render, Fly, nginx, ngrok) this makes req.ip and req.secure correct.
  if (cfg.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: cfg.devToolsEnabled ? false : undefined }));
  app.use(cors({ origin: cfg.corsOrigins, methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] }));

  if (cfg.isProd) {
    // Refuse plain HTTP for the API in production (the proxy must forward X-Forwarded-Proto).
    app.use((req, res, next) => {
      if (req.secure) return next();
      res.status(403).json({ error: { code: 'https_required', message: 'HTTPS is required' } });
    });
  }

  app.get('/health', async (_req, res) => {
    await db().query('SELECT 1');
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // USSD has its own (form-encoded) body parser.
  app.use('/api/ussd', ussdRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/contacts', contactsRouter);
  app.use('/api/account', accountRouter);
  app.use('/api/devices', devicesRouter);
  if (cfg.devToolsEnabled) app.use('/api/dev', devRouter);

  app.get('/legal/privacy', (_req, res) => res.type('text/plain').send(PRIVACY_PLACEHOLDER));
  app.get('/legal/terms', (_req, res) => res.type('text/plain').send(TERMS_PLACEHOLDER));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const PRIVACY_PLACEHOLDER = `RemotePhonebook Privacy Policy (PLACEHOLDER - replace before launch)

- Contacts are uploaded only after you give consent in the app.
- Uploaded contacts are available to you, after login, through the app and the RemotePhonebook USSD service.
- We store contact names and phone numbers, your account details, device details and security logs.
- Passwords and PINs are stored only as one-way hashes.
- You can export your data or delete your account at any time from the app.`;

const TERMS_PLACEHOLDER = `RemotePhonebook Terms of Service (PLACEHOLDER - replace before launch)

Have these reviewed by counsel for each market you operate in (e.g. Kenya Data Protection Act 2019).`;
