import { closePool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

const ran = await migrate();
console.log(ran.length === 0 ? 'Schema already up to date.' : `Applied ${ran.length} migration(s).`);
await closePool();
