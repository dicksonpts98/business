import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, withTransaction } from './pool.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Forward-only migrations applied in filename order, each in its own
 * transaction, recorded so a rerun is a no-op. There is no automatic down
 * migration: reversing a schema change on real business records is a decision,
 * not a command.
 */
export async function migrate(log: (m: string) => void = console.log): Promise<string[]> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Set(
    (await getPool().query<{ filename: string }>('SELECT filename FROM schema_migration'))
      .rows.map((r) => r.filename),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      log(`  = ${file} (already applied)`);
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migration (filename) VALUES ($1)', [file]);
    });
    log(`  + ${file}`);
    ran.push(file);
  }
  return ran;
}
