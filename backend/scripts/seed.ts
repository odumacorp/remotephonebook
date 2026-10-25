import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/pool.js';
import { DEMO_PASSWORD, TEST_USER, seedDemo, seedTestUser } from '../src/data/seed.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/data/demoContacts.js';

const args = new Set(process.argv.slice(2));
const cfg = config();

if (cfg.isProd && !args.has('--allow-production-demo')) {
  console.error('Refusing to seed demo data in production. Pass --allow-production-demo to seed only the read-only demo dataset.');
  process.exit(1);
}

await migrate(() => {});
await seedDemo();
console.log(`Demo dataset ready: 10 fictional contacts (account ${DEMO_ACCOUNT_EMAIL}${cfg.isProd ? '' : `, password ${DEMO_PASSWORD}`}).`);

if (args.has('--with-test-user')) {
  if (cfg.isProd) {
    console.error('The test user is never created in production.');
  } else {
    await seedTestUser();
    console.log(`Test user ready: ${TEST_USER.email} / ${TEST_USER.phone}, password ${TEST_USER.password}, USSD PIN ${TEST_USER.pin}.`);
  }
}
await closeDb();
