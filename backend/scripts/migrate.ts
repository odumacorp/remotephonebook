import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/pool.js';

const applied = await migrate();
console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
await closeDb();
