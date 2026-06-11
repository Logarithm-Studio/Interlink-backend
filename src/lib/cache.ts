/**
 * Redis-based caching layer for backend performance optimization.
 *
 * Provides:
 * - Response caching for frequently accessed data
 * - Cache invalidation utilities
 * - Stale-while-revalidate pattern support
 * - Cache warming for critical paths
 */

import { getRedis } from "../config/redis";

// ─── Cache Configuration ────────────────────────────────────────────────

export interface CacheConfig {
  /** TTL in seconds (default: 300 = 5 minutes) */
  ttl?: number;
  /** Cache key prefix for namespacing */
  prefix?: string;
  /** Enable serialization (default: true) */
  serialize?: boolean;
}

const DEFAULT_TTL = 300; // 5 minutes
const CACHE_PREFIX = "interlink:cache:";

// ─── Core Cache Functions ───────────────────────────────────────────────

export function cacheKey(key: string, prefix?: string): string {
  return `${CACHE_PREFIX}${prefix ? `${prefix}:` : ""}${key}`;
}

export async function getFromCache<T>(
  key: string,
  config?: CacheConfig,
): Promise<T | null> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);

  try {
    const raw = await redis.get<string>(fullKey);
    if (!raw) return null;

    if (config?.serialize !== false) {
      return JSON.parse(raw) as T;
    }

    return raw as unknown as T;
  } catch (error) {
    console.warn(`[Cache] Failed to read key ${fullKey}:`, error);
    return null;
  }
}

export async function setInCache<T>(
  key: string,
  value: T,
  config?: CacheConfig,
): Promise<void> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);
  const ttl = config?.ttl ?? DEFAULT_TTL;

  try {
    const serialized =
      config?.serialize !== false ? JSON.stringify(value) : (value as string);
    await redis.set(fullKey, serialized, { ex: ttl });
  } catch (error) {
    console.warn(`[Cache] Failed to write key ${fullKey}:`, error);
  }
}

export async function deleteFromCache(
  key: string,
  config?: CacheConfig,
): Promise<void> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);

  try {
    await redis.del(fullKey);
  } catch (error) {
    console.warn(`[Cache] Failed to delete key ${fullKey}:`, error);
  }
}

export async function deleteFromCacheByPattern(
  pattern: string,
  prefix?: string,
): Promise<void> {
  const redis = getRedis();
  const fullPattern = cacheKey(pattern, prefix);

  try {
    const keys: string[] = [];
    let cursor = 0;

    do {
      const [nextCursor, batch] = await redis.scan(cursor, {
        match: fullPattern,
        count: 100,
      });
      cursor = Number(nextCursor);
      keys.push(...batch);
    } while (cursor !== 0);

    // Delete in chunks to avoid oversized commands
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      if (chunk.length > 0) {
        await redis.del(...(chunk as [string, ...string[]]));
      }
    }
  } catch (error) {
    console.warn(`[Cache] Failed to delete pattern ${fullPattern}:`, error);
  }
}

export async function hasInCache(
  key: string,
  config?: CacheConfig,
): Promise<boolean> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);

  try {
    const exists = await redis.exists(fullKey);
    return exists === 1;
  } catch {
    return false;
  }
}

export async function getCacheTTL(
  key: string,
  config?: CacheConfig,
): Promise<number> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);

  try {
    return await redis.ttl(fullKey);
  } catch {
    return -2;
  }
}

// ─── Stale-While-Revalidate Pattern ─────────────────────────────────────

export interface StaleWhileRevalidateOptions<T> {
  freshTTL: number;
  staleTTL: number;
  fetchFn: () => Promise<T>;
}

export async function staleWhileRevalidate<T>(
  key: string,
  options: StaleWhileRevalidateOptions<T>,
): Promise<T> {
  const { freshTTL, staleTTL, fetchFn } = options;

  const cached = await getFromCache<T>(key, { ttl: freshTTL + staleTTL });

  if (cached !== null) {
    const remainingTTL = await getCacheTTL(key);

    if (remainingTTL <= staleTTL) {
      void fetchFn()
        .then(async (freshData) => {
          await setInCache(key, freshData, { ttl: freshTTL + staleTTL });
        })
        .catch((error) => {
          console.warn(`[SWR] Background refresh failed for ${key}:`, error);
        });
    }

    return cached;
  }

  const freshData = await fetchFn();
  await setInCache(key, freshData, { ttl: freshTTL + staleTTL });
  return freshData;
}

// ─── Cache Warming ──────────────────────────────────────────────────────

export interface CacheWarmerConfig {
  keys: Array<{
    key: string;
    fetchFn: () => Promise<unknown>;
    ttl: number;
  }>;
  intervalSeconds?: number;
}

export class CacheWarmer {
  private config: CacheWarmerConfig;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: CacheWarmerConfig) {
    this.config = config;
  }

  async warm(): Promise<void> {
    const promises = this.config.keys.map(async ({ key, fetchFn, ttl }) => {
      try {
        const data = await fetchFn();
        await setInCache(key, data, { ttl });
        console.log(`[CacheWarmer] Warmed cache for ${key}`);
      } catch (error) {
        console.warn(`[CacheWarmer] Failed to warm cache for ${key}:`, error);
      }
    });

    await Promise.all(promises);
  }

  start(): void {
    const intervalSeconds = this.config.intervalSeconds ?? 0;

    if (intervalSeconds <= 0) {
      void this.warm();
      return;
    }

    void this.warm();

    this.intervalId = setInterval(() => {
      void this.warm();
    }, intervalSeconds * 1000);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// ─── Cache Statistics ───────────────────────────────────────────────────

interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
}

let _stats: CacheStats = { hits: 0, misses: 0, errors: 0 };

export function getCacheStats(): CacheStats {
  return { ..._stats };
}

export function resetCacheStats(): void {
  _stats = { hits: 0, misses: 0, errors: 0 };
}

export async function getFromCacheWithStats<T>(
  key: string,
  config?: CacheConfig,
): Promise<T | null> {
  try {
    const result = await getFromCache<T>(key, config);
    if (result !== null) {
      _stats.hits++;
    } else {
      _stats.misses++;
    }
    return result;
  } catch (error) {
    _stats.errors++;
    throw error;
  }
}

// ─── Cache Keys for Common Operations ───────────────────────────────────

export const CacheKeys = {
  eventsList: (userId: string, filters?: Record<string, unknown>) =>
    `events:${userId}:${JSON.stringify(filters || {})}`,
  eventDetail: (userId: string, eventId: string) =>
    `event:${userId}:${eventId}`,
  calendarSync: (userId: string) => `calendar:sync:${userId}`,
  calendarEvents: (userId: string, dateRange: string) =>
    `calendar:events:${userId}:${dateRange}`,
  gmailMessages: (
    userId: string,
    mailbox: string,
    params?: Record<string, unknown>,
  ) => `gmail:${userId}:${mailbox}:${JSON.stringify(params || {})}`,
  gmailDetail: (userId: string, messageId: string) =>
    `gmail:message:${userId}:${messageId}`,
  mapsDistance: (origin: string, destination: string, mode: string) =>
    `maps:${origin}:${destination}:${mode}`,
  userProfile: (userId: string) => `user:profile:${userId}`,
  userPreferences: (userId: string) => `user:preferences:${userId}`,
  reminderPlans: (userId: string, hasLocation: boolean) =>
    `reminders:${userId}:${hasLocation}`,
} as const;

export { getRedis };

export default {
  getFromCache,
  setInCache,
  deleteFromCache,
  deleteFromCacheByPattern,
  hasInCache,
  getCacheTTL,
  staleWhileRevalidate,
  CacheWarmer,
  getFromCacheWithStats,
  getCacheStats,
  resetCacheStats,
  CacheKeys,
  getRedis,
};
