import type { ConnectionOptions } from "bullmq";

let _connection: ConnectionOptions | null = null;

/**
 * Shared BullMQ Redis connection options.
 * Derives the ioredis TCP connection from Upstash REST credentials:
 *   UPSTASH_REDIS_REST_URL  → host  (strips https://)
 *   UPSTASH_REDIS_REST_TOKEN → password
 * Lazily evaluated so dotenv has time to load first.
 */
export function getConnection(): ConnectionOptions {
  if (_connection) return _connection;

  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!restUrl || !restToken) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
    );
  }

  const host = restUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  _connection = {
    host,
    port: 6379,
    username: "default",
    password: restToken,
    tls: { rejectUnauthorized: false },
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false, // required for Upstash
    keepAlive: 10_000,
    retryStrategy: (times: number) => Math.min(times * 500, 10_000),
  };

  return _connection;
}
