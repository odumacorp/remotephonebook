import pg from 'pg';
import { config } from '../config.js';

// Return bigint columns (e.g. contacts.version) as JS numbers. The contact version sequence
// stays far below Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => Number(v));

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: config().DATABASE_URL, max: 10 });
  return pool;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  client: Queryable = db(),
): Promise<T[]> {
  const res = await client.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  client: Queryable = db(),
): Promise<T | undefined> {
  const rows = await query<T>(text, params, client);
  return rows[0];
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
