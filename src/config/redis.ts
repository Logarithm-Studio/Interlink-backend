import Redis from 'ioredis';

let redis: Redis;

/**
 * Get or create the Redis client singleton.
 * Supports Upstash Redis (TLS via rediss:// URL).
 */
export function getRedis(): Redis {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }

    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        const delay = Math.min(times * 200, 5000);
        return delay;
      },
      // Upstash requires TLS — ioredis handles this automatically
      // when the URL starts with rediss://
      tls: redisUrl.startsWith('rediss://') ? {} : undefined,
    });

    redis.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redis.on('error', (err) => {
      console.error('Redis connection error:', err.message);
    });
  }

  return redis;
}

/**
 * Test the Redis connection by sending a PING.
 */
export async function testRedisConnection(): Promise<void> {
  const result = await getRedis().ping();
  console.log(`✅ Redis PING → ${result}`);
}
