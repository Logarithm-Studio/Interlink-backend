// Redis removed — replaced with QStash (jobs) and PostgreSQL (state/dedup).
// This stub keeps any stale imports from breaking the build during migration.

export function getRedis(): never {
  throw new Error("Redis has been removed. Use PostgreSQL or QStash instead.");
}

export async function testRedisConnection(): Promise<void> {
  console.log("Redis removed — skipping Redis connection test.");
}
