import { Pool, QueryResult, QueryResultRow } from 'pg';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }, // Required for Supabase-hosted Postgres
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err);
    });
  }

  return pool;
}

/**
 * Execute a parameterized query against the PostgreSQL pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const result = await getPool().query<T>(text, params);
  const duration = Date.now() - start;

  if (duration > 500) {
    console.warn(`Slow query (${duration}ms): ${text.substring(0, 80)}...`);
  }

  return result;
}

/**
 * Test the database connection.
 */
export async function testConnection(): Promise<void> {
  const result = await query('SELECT NOW() AS now');
  console.log(`✅ PostgreSQL connected at ${result.rows[0].now}`);
}
