import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { loadConfig } from '../config.js';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool === null) {
    pool = new Pool({ connectionString: loadConfig().databaseUrl, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends QueryResultRow>(
  sql: string, params: readonly unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  sql: string, params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/**
 * Run work inside a single transaction. Event appends and the state changes
 * they describe must share a transaction: an event the client can see for a
 * change that later rolled back is a lie the timeline cannot recover from.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* the original error matters more */ }
    throw error;
  } finally {
    client.release();
  }
}
