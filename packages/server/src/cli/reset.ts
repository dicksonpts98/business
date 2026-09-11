import { closePool, getPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

/**
 * Drop and recreate the public schema, then migrate. Destructive by design and
 * intended for local development only: it refuses unless the database name
 * looks like a development database, so a production URL cannot be wiped by a
 * mistyped npm script.
 */
const url = new URL(process.env.DATABASE_URL ?? '');
const dbName = url.pathname.replace(/^\//, '');
const allowed = /^(supplyquest|supplyquest_dev|supplyquest_test)$/.test(dbName);
const forced = process.argv.includes('--i-understand-this-deletes-data');

if (!allowed && !forced) {
  console.error(
    `Refusing to reset database "${dbName}".\n` +
    'This command drops every table. It only runs against a database named\n' +
    'supplyquest, supplyquest_dev or supplyquest_test. Pass\n' +
    '--i-understand-this-deletes-data to override.',
  );
  process.exit(1);
}

console.log(`Dropping and recreating schema in "${dbName}"...`);
await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate();
console.log('Reset complete. Run `npm run seed` to load the demo company.');
await closePool();
