import { query, type Queryable, db } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export type AuditEvent =
  | 'register'
  | 'verify_success'
  | 'verify_failed'
  | 'login_success'
  | 'login_failed'
  | 'account_locked'
  | 'logout'
  | 'recovery_requested'
  | 'password_reset'
  | 'ussd_login_success'
  | 'ussd_login_failed'
  | 'ussd_logout'
  | 'ussd_sms_sent'
  | 'ussd_pin_set'
  | 'sync_completed'
  | 'sync_failed'
  | 'contact_deleted'
  | 'contacts_exported'
  | 'device_removed'
  | 'phone_linked'
  | 'phone_unlinked'
  | 'account_deleted'
  | 'callback_rejected';

/**
 * Records a security-relevant event. Metadata must not contain passwords, PINs, codes, tokens or
 * contact data; callers pass coarse facts only (channel, reason, counts).
 */
export async function audit(
  userId: string | null,
  eventType: AuditEvent,
  metadata: Record<string, unknown> = {},
  client: Queryable = db(),
): Promise<void> {
  try {
    await query('INSERT INTO audit_events (user_id, event_type, metadata) VALUES ($1, $2, $3)', [
      userId,
      eventType,
      metadata,
    ], client);
  } catch (err) {
    // Auditing must not break the user-facing request, but failures are surfaced in logs.
    logger.error('audit write failed', { eventType, error: (err as Error).message });
  }
}
