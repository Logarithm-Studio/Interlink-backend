/**
 * No-op cache layer — Redis removed, caching disabled for MVP.
 * All get operations return null (cache miss); set/delete are silent no-ops.
 * Restore with an actual backend (e.g. Upstash Redis REST, Vercel KV) when
 * performance optimisation becomes a priority.
 */

export interface CacheConfig {
  ttl?: number;
  prefix?: string;
  serialize?: boolean;
}

export function cacheKey(key: string, prefix?: string): string {
  return `${prefix ? `${prefix}:` : ""}${key}`;
}

export async function getFromCache<T>(
  _key: string,
  _config?: CacheConfig,
): Promise<T | null> {
  return null;
}

export async function setInCache<T>(
  _key: string,
  _value: T,
  _config?: CacheConfig,
): Promise<void> {}

export async function deleteFromCache(
  _key: string,
  _config?: CacheConfig,
): Promise<void> {}

export async function deleteFromCacheByPattern(
  _pattern: string,
  _prefix?: string,
): Promise<void> {}

export async function hasInCache(
  _key: string,
  _config?: CacheConfig,
): Promise<boolean> {
  return false;
}

export async function getCacheTTL(
  _key: string,
  _config?: CacheConfig,
): Promise<number> {
  return -2;
}

export interface StaleWhileRevalidateOptions<T> {
  freshTTL: number;
  staleTTL: number;
  fetchFn: () => Promise<T>;
}

export async function staleWhileRevalidate<T>(
  _key: string,
  options: StaleWhileRevalidateOptions<T>,
): Promise<T> {
  return options.fetchFn();
}

export class CacheWarmer {
  constructor(_config: unknown) {}
  async warm(): Promise<void> {}
  start(): void {}
  stop(): void {}
}

interface CacheStats { hits: number; misses: number; errors: number }
let _stats: CacheStats = { hits: 0, misses: 0, errors: 0 };
export function getCacheStats(): CacheStats { return { ..._stats }; }
export function resetCacheStats(): void { _stats = { hits: 0, misses: 0, errors: 0 }; }
export async function getFromCacheWithStats<T>(key: string, config?: CacheConfig): Promise<T | null> {
  _stats.misses++;
  return getFromCache(key, config);
}

export const CacheKeys = {
  eventsList: (userId: string, filters?: Record<string, unknown>) =>
    `events:${userId}:${JSON.stringify(filters || {})}`,
  eventDetail: (userId: string, eventId: string) => `event:${userId}:${eventId}`,
  calendarSync: (userId: string) => `calendar:sync:${userId}`,
  calendarEvents: (userId: string, dateRange: string) => `calendar:events:${userId}:${dateRange}`,
  gmailMessages: (userId: string, mailbox: string, params?: Record<string, unknown>) =>
    `gmail:${userId}:${mailbox}:${JSON.stringify(params || {})}`,
  gmailDetail: (userId: string, messageId: string) => `gmail:message:${userId}:${messageId}`,
  mapsDistance: (origin: string, destination: string, mode: string) =>
    `maps:${origin}:${destination}:${mode}`,
  userProfile: (userId: string) => `user:profile:${userId}`,
  userPreferences: (userId: string) => `user:preferences:${userId}`,
  reminderPlans: (userId: string, hasLocation: boolean) => `reminders:${userId}:${hasLocation}`,
} as const;

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
};
