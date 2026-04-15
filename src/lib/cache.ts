/**
 * Redis-based caching layer for backend performance optimization.
 * 
 * Provides:
 * - Response caching for frequently accessed data
 * - Cache invalidation utilities
 * - Stale-while-revalidate pattern support
 * - Cache warming for critical paths
 */

import { Redis } from "ioredis";
import { getRedis } from "@/config/redis";

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

/**
 * Generate a namespaced cache key
 */
export function cacheKey(key: string, prefix?: string): string {
  return `${CACHE_PREFIX}${prefix ? `${prefix}:` : ""}${key}`;
}

/**
 * Get a value from cache with automatic deserialization
 */
export async function getFromCache<T>(
  key: string,
  config?: CacheConfig,
): Promise<T | null> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);

  try {
    const raw = await redis.get(fullKey);
    if (!raw) return null;

    // Deserialize if enabled
    if (config?.serialize !== false) {
      return JSON.parse(raw) as T;
    }

    return raw as unknown as T;
  } catch (error) {
    // Cache read failed - non-critical, return null
    console.warn(`[Cache] Failed to read key ${fullKey}:`, error);
    return null;
  }
}

/**
 * Set a value in cache with automatic serialization and TTL
 */
export async function setInCache<T>(
  key: string,
  value: T,
  config?: CacheConfig,
): Promise<void> {
  const redis = getRedis();
  const fullKey = cacheKey(key, config?.prefix);
  const ttl = config?.ttl ?? DEFAULT_TTL;

  try {
    const serialized = config?.serialize !== false ? JSON.stringify(value) : (value as string);
    
    // Use pipeline for atomic SET + EXPIRE
    const pipeline = redis.pipeline();
    pipeline.set(fullKey, serialized, "EX", ttl);
    await pipeline.exec();
  } catch (error) {
    // Cache write failed - non-critical
    console.warn(`[Cache] Failed to write key ${fullKey}:`, error);
  }
}

/**
 * Delete a key from cache
 */
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

/**
 * Delete multiple keys matching a pattern
 */
export async function deleteFromCacheByPattern(
  pattern: string,
  prefix?: string,
): Promise<void> {
  const redis = getRedis();
  const fullPattern = cacheKey(pattern, prefix);

  try {
    // Use SCAN instead of KEYS for production safety
    const keys: string[] = [];
    let cursor = 0;

    do {
      const result = await redis.scan(cursor, "MATCH", fullPattern, "COUNT", 100);
      cursor = parseInt(result[0], 10);
      keys.push(...result[1]);
    } while (cursor !== 0);

    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (error) {
    console.warn(`[Cache] Failed to delete pattern ${fullPattern}:`, error);
  }
}

/**
 * Check if a key exists in cache
 */
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

/**
 * Get TTL for a key (returns -1 if no TTL, -2 if key doesn't exist)
 */
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
  /** How long to keep fresh data (seconds) */
  freshTTL: number;
  /** How long to serve stale data (seconds) */
  staleTTL: number;
  /** Function to fetch fresh data */
  fetchFn: () => Promise<T>;
}

/**
 * Implements stale-while-revalidate pattern:
 * 1. Return cached data (even if stale)
 * 2. Trigger background refresh if stale
 * 3. Update cache with fresh data
 * 
 * This ensures fast response times while keeping data reasonably fresh.
 */
export async function staleWhileRevalidate<T>(
  key: string,
  options: StaleWhileRevalidateOptions<T>,
): Promise<T> {
  const { freshTTL, staleTTL, fetchFn } = options;

  // Try to get cached data
  const cached = await getFromCache<T>(key, { ttl: freshTTL + staleTTL });

  if (cached !== null) {
    // Check if we need to refresh in background
    const remainingTTL = await getCacheTTL(key);
    
    if (remainingTTL <= staleTTL) {
      // Data is in stale period - refresh in background
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

  // No cached data - fetch fresh
  const freshData = await fetchFn();
  await setInCache(key, freshData, { ttl: freshTTL + staleTTL });
  return freshData;
}

// ─── Cache Warming ──────────────────────────────────────────────────────

export interface CacheWarmerConfig {
  /** Cache keys to warm */
  keys: Array<{
    key: string;
    fetchFn: () => Promise<any>;
    ttl: number;
  }>;
  /** Warm cache on interval (seconds, 0 = once) */
  intervalSeconds?: number;
}

/**
 * Cache warmer for pre-loading frequently accessed data.
 * Useful for:
 * - User profiles on login
 * - Event lists on app open
 * - Configuration data
 */
export class CacheWarmer {
  private config: CacheWarmerConfig;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: CacheWarmerConfig) {
    this.config = config;
  }

  /**
   * Warm all configured caches
   */
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

  /**
   * Start periodic cache warming
   */
  start(): void {
    const intervalSeconds = this.config.intervalSeconds ?? 0;
    
    if (intervalSeconds <= 0) {
      // One-time warm up
      void this.warm();
      return;
    }

    // Warm immediately and then on interval
    void this.warm();
    
    this.intervalId = setInterval(() => {
      void this.warm();
    }, intervalSeconds * 1000);
  }

  /**
   * Stop periodic cache warming
   */
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

// Instrumented cache functions with stats
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
  // Events
  eventsList: (userId: string, filters?: Record<string, any>) =>
    `events:${userId}:${JSON.stringify(filters || {})}`,
  eventDetail: (userId: string, eventId: string) => `event:${userId}:${eventId}`,
  
  // Calendar
  calendarSync: (userId: string) => `calendar:sync:${userId}`,
  calendarEvents: (userId: string, dateRange: string) => `calendar:events:${userId}:${dateRange}`,
  
  // Gmail
  gmailMessages: (userId: string, mailbox: string, params?: Record<string, any>) =>
    `gmail:${userId}:${mailbox}:${JSON.stringify(params || {})}`,
  gmailDetail: (userId: string, messageId: string) => `gmail:message:${userId}:${messageId}`,
  
  // Maps
  mapsDistance: (origin: string, destination: string, mode: string) =>
    `maps:${origin}:${destination}:${mode}`,
  
  // User
  userProfile: (userId: string) => `user:profile:${userId}`,
  userPreferences: (userId: string) => `user:preferences:${userId}`,
  
  // Reminders
  reminderPlans: (userId: string, hasLocation: boolean) =>
    `reminders:${userId}:${hasLocation}`,
} as const;

// ─── Export Redis Client for Advanced Usage ─────────────────────────────

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
