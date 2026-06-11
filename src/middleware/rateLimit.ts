/**
 * Redis-backed rate limiting middleware.
 *
 * Strategy: **fixed-window counter** per (bucket, identifier, window-index).
 *   key = `rl:<prefix>:<identifier>:<windowIndex>`  where
 *   windowIndex = Math.floor(now / windowMs)
 *
 * The INCR + EXPIRE is issued as a Lua script so it is atomic — no race
 * condition between setting the counter and setting its TTL.
 *
 * Three pre-built limiters are exported for the three exposed route groups:
 *
 *   oauthRateLimit      — 10 req / 15 min per IP  (OAuth connect/callback)
 *   webhookRateLimit    — 120 req / 60 s  per IP  (Google webhook bursts)
 *   workflowActionRateLimit — 30 req / 60 s per authenticated userId
 *
 * Webhook allowlisting
 *   Set RATE_LIMIT_WEBHOOK_ALLOWLIST_IPS as a comma-separated list of IPs
 *   (or CIDR prefixes) that should bypass the webhook rate limit entirely.
 *   By default this is empty; in production add Google's publish IP ranges.
 *   This is intentionally opt-in so deployments without allowlisting still
 *   have protection.
 *
 * Response on limit exceeded
 *   HTTP 429  Too Many Requests
 *   Headers: Retry-After (seconds), X-RateLimit-Limit, X-RateLimit-Remaining
 *
 * Security note: never include secrets, tokens, or passwords in rate-limit
 * keys or log output.
 */

import { Request, Response, NextFunction } from "express";
import { getRedis } from "../config/redis";
import { logger } from "../observability/logger";
import { AuthenticatedRequest } from "../types";

// ─── Lua script (atomic INCR + EXPIRE) ───────────────────────────────────────

/**
 * Atomically increment a counter and set its TTL on first use.
 *
 * KEYS[1]  — the Redis key
 * ARGV[1]  — TTL in seconds
 * Returns the new counter value.
 */
const INCR_SCRIPT = `
local current = redis.call('incr', KEYS[1])
if current == 1 then
  redis.call('expire', KEYS[1], ARGV[1])
end
return current
`;

// ─── IP extraction helpers ────────────────────────────────────────────────────

/**
 * Extracts the real client IP, respecting X-Forwarded-For when behind a
 * trusted reverse proxy.  Falls back to `req.ip`.
 *
 * Do NOT use X-Forwarded-For blindly in untrusted environments — only trust
 * it when the app is deployed behind a known proxy.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    // The first entry is the originating client.
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(",")[0]
      .trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

// ─── Allowlist helpers ────────────────────────────────────────────────────────

/**
 * Parse a comma-separated IP list from an env var into a Set.
 * Entries may be exact IPs or CIDR-prefix strings (e.g. "66.249.").
 */
function parseAllowlist(envVar: string): string[] {
  const raw = process.env[envVar] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Returns true if `ip` matches any entry in the allowlist.
 * Supports:
 *   - Exact match:   "34.64.4.1"
 *   - Prefix match:  "66.249." (matches any IP starting with that prefix)
 */
function isAllowlisted(ip: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => ip === entry || ip.startsWith(entry));
}

// ─── Core factory ─────────────────────────────────────────────────────────────

export interface RateLimitOptions {
  /**
   * Short name used in the Redis key prefix and log messages.
   * Must not contain colons.
   */
  bucketName: string;
  /** Window duration in milliseconds. */
  windowMs: number;
  /** Maximum number of requests allowed within a window. */
  maxRequests: number;
  /**
   * Extract an identifier from the request.
   * Defaults to the client IP address.
   */
  identifierFn?: (req: Request) => string | null;
  /**
   * List of IPs / prefixes that bypass this limiter.
   * Checked before the Redis counter — no Redis call is made for allowlisted IPs.
   */
  allowlist?: string[];
}

/**
 * Create an Express middleware that enforces a fixed-window rate limit.
 */
export function createRateLimiter(opts: RateLimitOptions) {
  const {
    bucketName,
    windowMs,
    maxRequests,
    identifierFn,
    allowlist = [],
  } = opts;

  const windowSeconds = Math.ceil(windowMs / 1000);

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    // Resolve a stable identifier for this request.
    const identifier = identifierFn ? identifierFn(req) : getClientIp(req);

    if (!identifier) {
      // Cannot identify the caller — let the request through rather than
      // blocking legitimate traffic with a misconfigured identifier function.
      logger.warn("[rateLimit] Could not resolve identifier — skipping check", {
        bucket: bucketName,
        path: req.path,
      });
      return next();
    }

    // Check allowlist before touching Redis.
    if (allowlist.length > 0 && isAllowlisted(identifier, allowlist)) {
      return next();
    }

    const windowIndex = Math.floor(Date.now() / windowMs);
    const key = `rl:${bucketName}:${identifier}:${windowIndex}`;

    let count: number;
    try {
      count = (await getRedis().eval(
        INCR_SCRIPT,
        [key],
        [String(windowSeconds)],
      )) as number;
    } catch (err) {
      // Redis unavailable — fail open (let request through) so that a Redis
      // outage does not take down the API.  Log at error level for alerting.
      logger.error("[rateLimit] Redis eval failed — failing open", {
        bucket: bucketName,
        err: err instanceof Error ? err : new Error(String(err)),
      } as Parameters<typeof logger.error>[1]);
      return next();
    }

    const remaining = Math.max(0, maxRequests - count);
    const retryAfterSeconds = windowSeconds;

    res.setHeader("X-RateLimit-Limit", maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Window", `${windowSeconds}s`);

    if (count > maxRequests) {
      res.setHeader("Retry-After", retryAfterSeconds);
      logger.warn("[rateLimit] Request rate-limited", {
        bucket: bucketName,
        identifier,
        count,
        limit: maxRequests,
      });
      res.status(429).json({
        error: "Too many requests — please try again later.",
        retryAfterSeconds,
      });
      return;
    }

    next();
  };
}

// ─── Programmatic rate-limit check (for workers, no Express req/res) ────────

/**
 * Check a fixed-window rate limit programmatically — for use inside worker
 * processes or services where Express middleware cannot be applied.
 *
 * Uses the same atomic Lua INCR + EXPIRE pattern as `createRateLimiter`.
 *
 * Fails **open** on Redis errors so a Redis outage never silently drops work.
 *
 * @returns `{ allowed: true }` when under the limit,
 *          `{ allowed: false, retryAfterSeconds }` when exceeded.
 */
export async function checkWorkerRateLimit(opts: {
  bucketName: string;
  identifier: string;
  maxRequests: number;
  windowMs: number;
}): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const { bucketName, identifier, maxRequests, windowMs } = opts;
  const windowSeconds = Math.ceil(windowMs / 1000);
  const windowIndex = Math.floor(Date.now() / windowMs);
  const key = `rl:${bucketName}:${identifier}:${windowIndex}`;

  let count: number;
  try {
    count = (await getRedis().eval(
      INCR_SCRIPT,
      [key],
      [String(windowSeconds)],
    )) as number;
  } catch (err) {
    logger.error(
      "[rateLimit] checkWorkerRateLimit Redis eval failed — failing open",
      {
        bucket: bucketName,
        identifier,
        err: err instanceof Error ? err : new Error(String(err)),
      },
    );
    return { allowed: true }; // fail open
  }

  if (count > maxRequests) {
    logger.warn("[rateLimit] worker rate limit exceeded", {
      bucket: bucketName,
      identifier,
      count,
      limit: maxRequests,
    });
    return { allowed: false, retryAfterSeconds: windowSeconds };
  }

  return { allowed: true };
}

// ─── Pre-built limiters ───────────────────────────────────────────────────────

/**
 * OAuth connect + callback — 10 requests per 15 minutes per IP.
 *
 * Absorbs accidental browser reloads and a small amount of automation,
 * while blocking credential-stuffing/CSRF probing at scale.
 */
export const oauthRateLimit = createRateLimiter({
  bucketName: "oauth",
  windowMs: 15 * 60 * 1000, // 15 min
  maxRequests: 10,
});

/**
 * Signup / login / refresh — 20 requests per 15 minutes per IP.
 *
 * Slightly more generous than OAuth since users may retry failed logins,
 * but tight enough to deter credential stuffing and brute-force attacks.
 */
export const authRateLimit = createRateLimiter({
  bucketName: "auth",
  windowMs: 15 * 60 * 1000, // 15 min
  maxRequests: 20,
});

/**
 * Google Calendar webhook endpoint — 120 requests per minute per IP.
 *
 * Google sends burst notifications from a shared set of IPs; a loose limit
 * is enough to shed abuse while allowing legitimate delivery.
 *
 * Set RATE_LIMIT_WEBHOOK_ALLOWLIST_IPS (comma-separated) to skip the check
 * for known Google publisher IPs entirely.
 */
export const webhookRateLimit = createRateLimiter({
  bucketName: "webhook",
  windowMs: 60 * 1000, // 1 min
  maxRequests: 120,
  allowlist: parseAllowlist("RATE_LIMIT_WEBHOOK_ALLOWLIST_IPS"),
});

/**
 * Workflow action endpoint — 30 requests per minute per authenticated user.
 *
 * Identified by `userId` (not IP) because the endpoint requires auth and
 * multiple users may share a corporate NAT.
 *
 * Falls back to IP if `req.user` is not yet attached (e.g. token invalid).
 */
export const workflowActionRateLimit = createRateLimiter({
  bucketName: "workflow-actions",
  windowMs: 60 * 1000, // 1 min
  maxRequests: 30,
  identifierFn: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
});
