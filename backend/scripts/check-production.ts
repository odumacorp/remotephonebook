/** Production readiness check: run with the production environment loaded before going live. */
import { config } from '../src/config.js';
import { closeDb, db } from '../src/db/pool.js';

const cfg = config();
const problems: string[] = [];
const warnings: string[] = [];

if (!cfg.isProd) warnings.push('NODE_ENV is not "production".');
if (cfg.AUTH_SECRET.length < 32 || /change-me|example|secret/i.test(cfg.AUTH_SECRET)) problems.push('AUTH_SECRET must be a random value of at least 32 characters.');
if (!cfg.API_BASE_URL.startsWith('https://')) problems.push('API_BASE_URL must be an https:// URL (Africa\'s Talking needs a public HTTPS callback).');
if (cfg.AFRICASTALKING_ENV !== 'live') problems.push(`AFRICASTALKING_ENV is "${cfg.AFRICASTALKING_ENV}"; set it to "live" for real users.`);
if (cfg.AFRICASTALKING_USERNAME === 'sandbox') problems.push('AFRICASTALKING_USERNAME is still "sandbox".');
if (!cfg.AFRICASTALKING_API_KEY) problems.push('AFRICASTALKING_API_KEY is empty.');
if (cfg.AFRICASTALKING_USSD_SERVICE_CODE === '*123#') warnings.push('AFRICASTALKING_USSD_SERVICE_CODE is the *123# placeholder. Use the code Africa\'s Talking provisioned for you.');
if (!cfg.USSD_CALLBACK_TOKEN) warnings.push('USSD_CALLBACK_TOKEN is empty: anyone who finds the callback URL can call it.');
if (cfg.demoModeEnabled) warnings.push('Demo mode is enabled in production (DEMO_MODE_ENABLED).');
if (!cfg.TRUST_PROXY) warnings.push('TRUST_PROXY is false: behind a TLS proxy, HTTPS detection and rate limiting by IP will be wrong.');
if (!cfg.REQUIRE_VERIFICATION) problems.push('REQUIRE_VERIFICATION must be true in production.');
if (cfg.corsOrigins === '*') warnings.push('CORS_ORIGINS is "*". Mobile apps do not need CORS; restrict it to your web origins.');

try {
  await db().query('SELECT 1 FROM schema_migrations LIMIT 1');
} catch {
  problems.push('Database unreachable or migrations not applied (run npm run migrate).');
}
await closeDb();

for (const w of warnings) console.log(`WARN  ${w}`);
for (const p of problems) console.log(`FAIL  ${p}`);
console.log(problems.length ? `\n${problems.length} problem(s) must be fixed before launch.` : '\nNo blocking problems found.');
process.exit(problems.length ? 1 : 0);
