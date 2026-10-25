import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { logger } from './lib/logger.js';

const cfg = config();
await migrate((m) => logger.info(m));
createApp().listen(cfg.PORT, () => {
  logger.info('RemotePhonebook API listening', {
    port: cfg.PORT,
    env: cfg.NODE_ENV,
    ussdProvider: cfg.AFRICASTALKING_ENV,
    demoMode: cfg.demoModeEnabled,
    devTools: cfg.devToolsEnabled,
  });
  if (cfg.devToolsEnabled) logger.info(`USSD simulator: ${cfg.API_BASE_URL}/api/dev/ussd-simulator`);
});
