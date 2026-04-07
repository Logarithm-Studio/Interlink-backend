import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getPool, query } from '../../config/db';

dotenv.config();

const MIGRATIONS_DIR = path.resolve(__dirname);

/**
 * Lightweight migration runner.
 * - Reads .sql files from this directory in alphabetical order
 * - Tracks applied migrations in a `_migrations` table
 * - Runs each unapplied migration inside a transaction
 */
async function runMigrations(): Promise<void> {
  console.log('🔄 Running database migrations...\n');

  // Ensure the _migrations tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Get already-applied migrations
  const applied = await query<{ name: string }>('SELECT name FROM _migrations ORDER BY id');
  const appliedSet = new Set(applied.rows.map((r) => r.name));

  // Find all .sql files, sorted alphabetically
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ranCount = 0;

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  ⏭  ${file} (already applied)`);
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✅ ${file}`);
      ranCount++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ❌ ${file} failed:`, err);
      throw err;
    } finally {
      client.release();
    }
  }

  if (ranCount === 0) {
    console.log('\n✅ All migrations already applied.');
  } else {
    console.log(`\n✅ Applied ${ranCount} migration(s).`);
  }
}

// Run when executed directly: npm run migrate
runMigrations()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
