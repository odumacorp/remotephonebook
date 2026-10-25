import { TEST_ENV } from './testEnv.js';

export default async function setup() {
  Object.assign(process.env, TEST_ENV);
  const { db, closeDb } = await import('../src/db/pool.js');
  const { migrate } = await import('../src/db/migrate.js');
  // Fresh schema for every test run.
  await db().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(() => {});
  await closeDb();
}
