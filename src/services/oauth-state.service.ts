/**
 * Server-side OAuth state storage.
 *
 * Replaces the insecure pattern of passing a Supabase JWT as the OAuth `state`
 * query parameter (which leaks to browser history, logs, proxies, referrers).
 *
 * Strategy:
 *  1. `createOAuthState(userId, provider)` — generates a 128-bit random opaque
 *     token, stores `{ userId, provider }` in Redis with a 10-minute TTL, and
 *     returns the token to use as the OAuth `state` parameter.
 *  2. `consumeOAuthState(token)` — atomically reads and deletes the Redis key.
 *     Returns the stored payload or `null` if expired/invalid/already-used.
 *     Single-use: a second call for the same token always returns `null`.
 *
 * Security properties:
 *  - Opaque token: Google can't extract user identity from the `state` param.
 *  - Single-use: replayed callbacks are rejected.
 *  - TTL-closed: expired state tokens fail silently.
 *  - No bearer credential in URL: JWT never touches the OAuth redirect chain.
 */

import { randomBytes } from "crypto";
import { getRedis } from "../config/redis";
import { logger } from "../observability/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthStatePayload {
  userId: string;
  provider: "google" | "microsoft";
  successRedirectUri?: string;
  errorRedirectUri?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** 10 minutes — must exceed the time the user takes to complete the consent screen. */
const STATE_TTL_SECONDS = 10 * 60;

const KEY_PREFIX = "oauth:state:";

function stateKey(token: string): string {
  return `${KEY_PREFIX}${token}`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an opaque OAuth state token and store the associated payload in Redis.
 *
 * @returns The random state token to pass as `state` in the OAuth redirect URL.
 */
export async function createOAuthState(
  userId: string,
  provider: OAuthStatePayload["provider"],
  options?: {
    successRedirectUri?: string;
    errorRedirectUri?: string;
  },
): Promise<string> {
  const token = randomBytes(16).toString("hex"); // 128 bits of entropy
  const payload: OAuthStatePayload = {
    userId,
    provider,
    successRedirectUri: options?.successRedirectUri,
    errorRedirectUri: options?.errorRedirectUri,
  };

  const redis = getRedis();
  // Store as object — @upstash/redis auto-serializes/deserializes JSON, so
  // storing the object directly means get() returns the object, not a string.
  await redis.set(stateKey(token), payload, { ex: STATE_TTL_SECONDS });

  logger.debug("[oauth-state] created state token", { userId, provider });
  return token;
}

/**
 * Consume an OAuth state token atomically (read + delete).
 *
 * Returns the stored payload on success, or `null` if the token is:
 *  - expired
 *  - not found (was never created)
 *  - already consumed (single-use enforcement)
 */
export async function consumeOAuthState(
  token: string,
): Promise<OAuthStatePayload | null> {
  if (!token || token.length !== 32) {
    // Fast-reject clearly malformed tokens without a Redis round-trip.
    return null;
  }

  const redis = getRedis();
  const key = stateKey(token);

  // Atomic GET + DEL via pipeline to prevent TOCTOU races.
  // @upstash/redis auto-deserializes JSON, so the get result is already the
  // payload object — no JSON.parse needed.
  const pipeline = redis.pipeline();
  pipeline.get<OAuthStatePayload>(key);
  pipeline.del(key);
  const results = await pipeline.exec();
  const payload = results[0] as OAuthStatePayload | null;

  if (!payload) {
    logger.warn("[oauth-state] state token not found or expired", {
      token: token.slice(0, 8) + "…",
    });
    return null;
  }

  return payload;
}
