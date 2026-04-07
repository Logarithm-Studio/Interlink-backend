import type { ConnectionOptions } from "bullmq";

/**
 * Shared BullMQ Redis connection options.
 * Supports plain redis:// and TLS rediss:// (Upstash).
 * maxRetriesPerRequest: null is required by BullMQ.
 */
let _connection: ConnectionOptions | null = null;

/**
 * Lazily evaluated on first call so dotenv has time to load before this runs.
 */
export function getConnection(): ConnectionOptions {
  if (_connection) return _connection;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL environment variable is not set");

  const parsed = new URL(url);

  _connection = {
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 6379,
    username: parsed.username || undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    tls:
      parsed.protocol === "rediss:" ? { rejectUnauthorized: false } : undefined,
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false, // required for Upstash
    // Keep the TCP socket alive so Upstash doesn't drop idle connections.
    // The ping is sent every 10 s, which is well under Upstash's 30 s idle timeout.
    keepAlive: 10_000,
    // Reconnect with exponential back-off capped at 10 s.
    // Returning null on the first call would disable retries entirely, so we
    // always return a positive delay.
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  };

  return _connection;
}
