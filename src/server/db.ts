import pg, { type PoolClient, type QueryResultRow } from 'pg';
import { config } from './config';
const globalDb = globalThis as unknown as { communityPool?: pg.Pool };
export const pool = globalDb.communityPool ?? new pg.Pool({ connectionString: config.database, max: Number(process.env.DB_POOL_SIZE || 10), connectionTimeoutMillis: 10000 });
globalDb.communityPool = pool;
pool.on('error', error => console.error('Database connection:', error.message));
export async function query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = [], client?: PoolClient): Promise<T[]> {
  return (await (client || pool).query<T>(text, params)).rows;
}
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
