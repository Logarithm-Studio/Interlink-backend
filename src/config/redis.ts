import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;

/**
 * Get or create the Upstash Redis REST client singleton.
 * Reads UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from env.
 * Uses HTTP — compatible with Vercel serverless (no persistent TCP needed).
 */
export function getRedis(): Redis {
  if (!_redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) {
      throw new Error(
        "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set",
      );
    }
    _redis = new Redis({ url, token });
  }
  return _redis;
}

/**
 * Test the Redis connection by sending a PING.
 */
export async function testRedisConnection(): Promise<void> {
  const result = await getRedis().ping();
  console.log(`✅ Redis PING → ${result}`);
}
