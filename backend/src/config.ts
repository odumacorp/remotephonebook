import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const syncSettingsSchema = z
  .object({
    maxBatchSize: z.number().int().min(1).max(2000).default(500),
    defaultDeletionPolicy: z.enum(['mirror', 'keep']).default('mirror'),
    tombstoneRetentionDays: z.number().int().min(1).max(3650).default(90),
    maxContactsPerUser: z.number().int().min(1).default(20000),
    maxPullPageSize: z.number().int().min(1).max(5000).default(1000),
  })
  .default({});

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  API_BASE_URL: z.string().url().default('http://localhost:4000'),
  AUTH_SECRET: z.string().min(16),
  TRUST_PROXY: bool.default('false'),
  CORS_ORIGINS: z.string().default('*'),

  SESSION_TTL_HOURS: z.coerce.number().positive().default(24 * 30),
  DEFAULT_PHONE_REGION: z.string().length(2).default('KE'),
  DISPLAY_TIMEZONE: z.string().default('Africa/Nairobi'),
  REQUIRE_VERIFICATION: bool.default('true'),

  AFRICASTALKING_USERNAME: z.string().default('sandbox'),
  AFRICASTALKING_API_KEY: z.string().default(''),
  AFRICASTALKING_USSD_SERVICE_CODE: z.string().default('*123#'),
  // "mock": never calls Africa's Talking (messages are written to the dev outbox).
  // "sandbox": calls api.sandbox.africastalking.com. "live": calls the production API.
  AFRICASTALKING_ENV: z.enum(['mock', 'sandbox', 'live']).default('mock'),
  AFRICASTALKING_SMS_FROM: z.string().default(''),
  // Optional shared secret appended to the callback URL (?token=...). Africa's Talking does not
  // sign USSD callbacks, so this is the practical way to reject requests that did not come via your AT URL.
  USSD_CALLBACK_TOKEN: z.string().default(''),
  // Optional comma-separated IP allowlist for the USSD callback. Verify the current ranges with Africa's
  // Talking support before enabling; leave empty to disable.
  USSD_ALLOWED_IPS: z.string().default(''),
  USSD_PAGE_SIZE: z.coerce.number().int().min(1).max(9).default(5),
  USSD_MAX_CHARS: z.coerce.number().int().min(80).max(500).default(182),
  USSD_SESSION_TTL_SECONDS: z.coerce.number().int().min(30).default(180),
  USSD_MAX_LOGIN_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  // Require a one-time SMS/email code after the password when dialing from a phone that is not trusted.
  USSD_REQUIRE_OTP_FOR_UNTRUSTED: bool.default('false'),
  USSD_SMS_DAILY_LIMIT: z.coerce.number().int().min(0).default(20),

  DEMO_MODE_ENABLED: bool.optional(),
  DEV_TOOLS_ENABLED: bool.optional(),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).default(365),

  CONTACT_SYNC_SETTINGS: z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (!raw) return {};
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CONTACT_SYNC_SETTINGS must be valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(syncSettingsSchema),
});

export type SyncSettings = z.infer<typeof syncSettingsSchema>;

function load() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const isProd = env.NODE_ENV === 'production';
  return {
    ...env,
    isProd,
    isTest: env.NODE_ENV === 'test',
    // Demo mode and dev tools default to on outside production and off in production.
    demoModeEnabled: env.DEMO_MODE_ENABLED ?? !isProd,
    devToolsEnabled: isProd ? false : (env.DEV_TOOLS_ENABLED ?? true),
    sync: env.CONTACT_SYNC_SETTINGS,
    ussdAllowedIps: env.USSD_ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean),
    corsOrigins: env.CORS_ORIGINS === '*' ? '*' : env.CORS_ORIGINS.split(',').map((s) => s.trim()),
  };
}

export type Config = ReturnType<typeof load>;

let current: Config | undefined;

export function config(): Config {
  current ??= load();
  return current;
}

/** Tests use this to apply env overrides. */
export function reloadConfig(): Config {
  current = load();
  return current;
}
