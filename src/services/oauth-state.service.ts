/**
 * OAuth state storage — PostgreSQL replacement for the previous Redis-based
 * implementation.
 *
 * Strategy:
 *  1. `createOAuthState` — generates a 128-bit random opaque token, stores it
 *     in the `oauth_states` table with a 10-minute TTL, and returns the token.
 *  2. `consumeOAuthState` — atomically reads and deletes the row in a single
 *     transaction.  Returns the payload or `null` if expired/invalid/used.
 *
 * Required table (run once in Supabase SQL editor):
 *
 *   CREATE TABLE IF NOT EXISTS oauth_states (
 *     token          text        PRIMARY KEY,
 *     user_id        uuid        NOT NULL,
 *     provider       text        NOT NULL,
 *     success_redirect_uri text,
 *     error_redirect_uri   text,
 *     expires_at     timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
 *   );
 *   CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);
 */

import { randomBytes } from "crypto";
import { query } from "../config/db";
import { logger } from "../observability/logger";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OAuthStatePayload {
  userId: string;
  // Calendar providers ("google" | "microsoft") plus the generic third-party
  // integration providers (spotify, todoist, notion, trello, github, …). The
  // oauth_states.provider column is plain text, so any provider string is valid.
  provider: string;
  successRedirectUri?: string;
  errorRedirectUri?: string;
  /**
   * Intended mode binding for a Google connect: 'personal' | 'professional'.
   * The callback assigns this role to the newly connected account.
   */
  role?: "personal" | "professional";
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createOAuthState(
  userId: string,
  provider: OAuthStatePayload["provider"],
  options?: {
    successRedirectUri?: string;
    errorRedirectUri?: string;
    role?: "personal" | "professional";
  },
): Promise<string> {
  const token = randomBytes(16).toString("hex"); // 128 bits of entropy

  await query(
    `INSERT INTO oauth_states
       (token, user_id, provider, success_redirect_uri, error_redirect_uri, role)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      token,
      userId,
      provider,
      options?.successRedirectUri ?? null,
      options?.errorRedirectUri ?? null,
      options?.role ?? null,
    ],
  );

  logger.debug("[oauth-state] created state token", { userId, provider });
  return token;
}

export async function consumeOAuthState(
  token: string,
): Promise<OAuthStatePayload | null> {
  if (!token || token.length !== 32) {
    return null;
  }

  // Atomically DELETE and return the row; also reject expired tokens.
  const result = await query<{
    user_id: string;
    provider: string;
    success_redirect_uri: string | null;
    error_redirect_uri: string | null;
    role: string | null;
  }>(
    `DELETE FROM oauth_states
     WHERE token = $1 AND expires_at > now()
     RETURNING user_id, provider, success_redirect_uri, error_redirect_uri, role`,
    [token],
  );

  const row = result.rows[0];
  if (!row) {
    logger.warn("[oauth-state] state token not found or expired", {
      token: token.slice(0, 8) + "…",
    });
    return null;
  }

  return {
    userId: row.user_id,
    provider: row.provider as OAuthStatePayload["provider"],
    successRedirectUri: row.success_redirect_uri ?? undefined,
    errorRedirectUri: row.error_redirect_uri ?? undefined,
    role:
      row.role === "personal" || row.role === "professional"
        ? row.role
        : undefined,
  };
}
