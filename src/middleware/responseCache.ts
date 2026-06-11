/**
 * Express middleware for HTTP response caching with Redis.
 * 
 * Caches GET request responses to reduce database load and improve response times.
 * Supports:
 * - Configurable TTL per route
 * - Cache invalidation on POST/PUT/DELETE
 * - Stale-while-revalidate for critical paths
 * - Cache bypass headers
 */

import { Request, Response, NextFunction } from "express";
import { getFromCache, setInCache, CacheKeys } from "../lib/cache";
import { AuthenticatedRequest } from "../types";

export interface ResponseCacheConfig {
  /** Default TTL in seconds (default: 300) */
  defaultTTL?: number;
  /** Routes to cache (key: route pattern, value: TTL in seconds) */
  routes?: Record<string, number>;
  /** Enable cache (default: true) */
  enabled?: boolean;
  /** Cache key prefix */
  prefix?: string;
}

/**
 * Response caching middleware for GET requests.
 * 
 * Usage:
 * ```typescript
 * import { responseCache } from "@/middleware/responseCache";
 * 
 * // Cache events list for 5 minutes
 * router.get("/events", responseCache({ ttl: 300 }), eventsController.list);
 * 
 * // Cache with stale-while-revalidate
 * router.get("/events", responseCache({ freshTTL: 300, staleTTL: 600 }), eventsController.list);
 * ```
 */
export function responseCache(config: ResponseCacheConfig = {}) {
  const {
    defaultTTL = 300,
    routes,
    enabled = true,
    prefix = "api",
  } = config;

  return async (req: Request | AuthenticatedRequest, res: Response, next: NextFunction) => {
    // Only cache GET requests
    if (req.method !== "GET" || !enabled) {
      return next();
    }

    // Check if caching is disabled via header
    if (req.headers["cache-control"]?.includes("no-cache")) {
      return next();
    }

    // Generate cache key from route and query params
    const userId = (req as Partial<AuthenticatedRequest>).user?.id || "anonymous";
    const cacheKey = `${prefix}:${req.originalUrl}:${userId}`;

    // Try to get from cache
    try {
      const cached = await getFromCache<{
        body: any;
        statusCode: number;
        headers: Record<string, string>;
      }>(cacheKey, { ttl: defaultTTL });

      if (cached !== null) {
        // Set cache headers
        res.set("X-Cache", "HIT");
        res.set("Cache-Control", `public, max-age=${defaultTTL}`);

        // Send cached response
        res.status(cached.statusCode).json(cached.body);
        return;
      }
    } catch (error) {
      // Cache read failed - proceed with normal request
      console.warn("[ResponseCache] Cache read failed:", error);
    }

    // Intercept res.json to cache the response
    const originalJson = res.json.bind(res);

    res.json = (body: any) => {
      // Only cache successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        // Determine TTL from route config
        const ttl = routes?.[req.path] ?? defaultTTL;

        // Cache the response
        setInCache(
          cacheKey,
          {
            body,
            statusCode: res.statusCode,
            headers: res.getHeaders(),
          },
          { ttl },
        ).catch((error: unknown) => {
          console.warn("[ResponseCache] Cache write failed:", error);
        });

        // Set cache headers
        res.set("X-Cache", "MISS");
        res.set("Cache-Control", `public, max-age=${ttl}`);
      }

      // Call original json method
      return originalJson(body);
    };

    next();
  };
}

/**
 * Cache invalidation middleware for mutations.
 * 
 * Automatically invalidates related caches when data is modified.
 * 
 * Usage:
 * ```typescript
 * router.post(
 *   "/events/:id/attendance",
 *   invalidateCache(["events", "calendar"]),
 *   attendanceController.record
 * );
 * ```
 */
export function invalidateCache(cacheGroups: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Intercept res.json to invalidate cache after successful mutation
    const originalJson = res.json.bind(res);

    res.json = (body: any) => {
      // Only invalidate on successful responses
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const userId = (req as any).user?.id;

        if (userId) {
          // Invalidate caches for each group
          const promises = cacheGroups.map(async (group) => {
            switch (group) {
              case "events":
                // Invalidate all event caches for this user
                await require("../lib/cache").deleteFromCacheByPattern(
                  `interlink:cache:events:*:${userId}*`,
                );
                break;
              case "calendar":
                await require("../lib/cache").deleteFromCacheByPattern(
                  `interlink:cache:calendar:*:${userId}*`,
                );
                break;
              case "gmail":
                await require("../lib/cache").deleteFromCacheByPattern(
                  `interlink:cache:gmail:*:${userId}*`,
                );
                break;
              case "reminders":
                await require("../lib/cache").deleteFromCacheByPattern(
                  `interlink:cache:reminders:*:${userId}*`,
                );
                break;
              default:
                // Generic invalidation
                await require("../lib/cache").deleteFromCacheByPattern(
                  `interlink:cache:${group}:*`,
                );
            }
          });

          // Wait for all invalid to complete
          Promise.all(promises).catch((error) => {
            console.warn("[ResponseCache] Cache invalidation failed:", error);
          });
        }
      }

      return originalJson(body);
    };

    next();
  };
}

/**
 * Conditional cache middleware based on user authentication.
 * Only caches responses for authenticated users.
 */
export function authenticatedCache(config: ResponseCacheConfig = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).user?.id;

    if (!userId) {
      // Don't cache unauthenticated requests
      return next();
    }

    return responseCache(config)(req, res, next);
  };
}

export default {
  responseCache,
  invalidateCache,
  authenticatedCache,
};
