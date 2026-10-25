/**
 * Retention jobs. Run daily (cron, a scheduled container, or your platform's scheduler):
 *   - purge expired USSD sessions, API sessions, verification codes and rate-limit buckets
 *   - purge contact tombstones older than tombstoneRetentionDays (clients older than that do a full resync)
 *   - purge audit events and outbound messages past retention
 */
import { config } from '../src/config.js';
import { closeDb, query, transaction } from '../src/db/pool.js';

const cfg = config();
const results: Record<string, number> = {};
const run = async (name: string, sql: string, params: unknown[] = []) => {
  results[name] = (await query(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`, params))[0].n;
};

await run('ussd_sessions', `DELETE FROM ussd_sessions WHERE expires_at < now() - interval '1 day'`);
await run('auth_sessions', `DELETE FROM auth_sessions WHERE expires_at < now() OR revoked_at < now() - interval '7 days'`);
await run('verification_codes', `DELETE FROM verification_codes WHERE expires_at < now() - interval '1 day'`);
await run('rate_limits', `DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`);
await run('audit_events', `DELETE FROM audit_events WHERE timestamp < now() - make_interval(days => $1)`, [cfg.AUDIT_RETENTION_DAYS]);
await run('outbound_messages', `DELETE FROM outbound_messages WHERE created_at < now() - interval '30 days'`);

await transaction(async (client) => {
  const rows = await client.query<{ v: number | null; n: number }>(
    `WITH d AS (DELETE FROM contacts WHERE deleted_at < now() - make_interval(days => $1) RETURNING version)
     SELECT max(version) AS v, count(*)::int AS n FROM d`,
    [cfg.sync.tombstoneRetentionDays],
  );
  results.contact_tombstones = rows.rows[0].n;
  if (rows.rows[0].v) {
    await client.query(
      `UPDATE system_meta SET value = GREATEST(value::bigint, $1)::text WHERE key = 'tombstones_purged_through_version'`,
      [rows.rows[0].v],
    );
  }
});

console.log(JSON.stringify({ purged: results }));
await closeDb();
