import { config } from '../config.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export interface SendOptions {
  userId?: string | null;
  /** Sensitive bodies (one-time codes) are only stored in clear in mock mode. */
  sensitive?: boolean;
}

export interface DeliveryResult {
  ok: boolean;
  provider: string;
  status: string;
  providerRef?: string;
}

async function record(channel: 'sms' | 'email', to: string, body: string, opts: SendOptions, result: DeliveryResult) {
  const storedBody = opts.sensitive && result.provider !== 'mock' ? '[redacted sensitive message]' : body;
  await query(
    `INSERT INTO outbound_messages (user_id, channel, destination, body, provider, status, provider_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [opts.userId ?? null, channel, to, storedBody, result.provider, result.status, result.providerRef ?? null],
  );
}

function atBaseUrl(): string {
  return config().AFRICASTALKING_ENV === 'live'
    ? 'https://api.africastalking.com'
    : 'https://api.sandbox.africastalking.com';
}

/**
 * Sends an SMS through the Africa's Talking Messaging API
 * (POST /version1/messaging, form-encoded, `apiKey` header).
 * In mock mode nothing leaves the server; the message is visible in the dev outbox.
 */
export async function sendSms(to: string, body: string, opts: SendOptions = {}): Promise<DeliveryResult> {
  const cfg = config();
  let result: DeliveryResult;
  if (cfg.AFRICASTALKING_ENV === 'mock') {
    result = { ok: true, provider: 'mock', status: 'queued_mock' };
    if (!cfg.isTest) logger.info('mock sms queued (see /api/dev/outbox)', { to });
  } else {
    try {
      const form = new URLSearchParams({ username: cfg.AFRICASTALKING_USERNAME, to, message: body });
      if (cfg.AFRICASTALKING_SMS_FROM) form.set('from', cfg.AFRICASTALKING_SMS_FROM);
      const res = await fetch(`${atBaseUrl()}/version1/messaging`, {
        method: 'POST',
        headers: {
          apiKey: cfg.AFRICASTALKING_API_KEY,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      const recipient = json?.SMSMessageData?.Recipients?.[0];
      const ok = res.ok && recipient && (recipient.statusCode === 100 || recipient.statusCode === 101 || recipient.statusCode === 102);
      result = {
        ok: Boolean(ok),
        provider: `africastalking_${cfg.AFRICASTALKING_ENV}`,
        status: recipient?.status ?? `http_${res.status}`,
        providerRef: recipient?.messageId,
      };
      if (!ok) logger.warn('africastalking sms not accepted', { status: result.status });
    } catch (err) {
      result = { ok: false, provider: `africastalking_${cfg.AFRICASTALKING_ENV}`, status: 'network_error' };
      logger.error('africastalking sms failed', { error: (err as Error).message });
    }
  }
  await record('sms', to, body, opts, result);
  return result;
}

/**
 * Email delivery. No email provider ships with the project: in mock mode messages go to the dev outbox;
 * otherwise plug an SMTP/API provider in here. Until then, emails are recorded as "not_configured".
 */
export async function sendEmail(to: string, subject: string, body: string, opts: SendOptions = {}): Promise<DeliveryResult> {
  const cfg = config();
  const result: DeliveryResult =
    cfg.AFRICASTALKING_ENV === 'mock' || !cfg.isProd
      ? { ok: true, provider: 'mock', status: 'queued_mock' }
      : { ok: false, provider: 'none', status: 'not_configured' };
  if (!result.ok) logger.warn('email provider not configured; email not sent');
  await record('email', to, `${subject}\n\n${body}`, opts, result);
  return result;
}
