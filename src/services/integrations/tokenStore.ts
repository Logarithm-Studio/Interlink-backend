/**
 * Generic token storage for third-party OAuth integrations (connected_integrations table).
 * Uses the same AES-256-GCM pack/unpack pattern as auth.service.ts for Google tokens.
 */

import { query } from "../../config/db";
import { encrypt, decrypt } from "../../security/crypto";

export type IntegrationProvider =
  | "todoist"
  | "notion"
  | "trello"
  | "github"
  | "jira"
  | "slack"
  | "hubspot"
  | "mailchimp"
  | "microsoft";

export type IntegrationStatus = "active" | "expired" | "revoked" | "reauth_required";

export interface StoredIntegration {
  id: string;
  userId: string;
  provider: IntegrationProvider;
  tokenExpiresAt: Date | null;
  scopes: string[];
  metadata: Record<string, unknown>;
  status: IntegrationStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Pack / unpack (same format as auth.service.ts) ─────────────────────────

function packToken(encrypted: { iv: string; tag: string; kid: string; ciphertext: string }): string {
  return `${encrypted.iv}:${encrypted.tag}:${encrypted.kid}:${encrypted.ciphertext}`;
}

function unpackToken(raw: string): { iv: string; tag: string; kid: string; ciphertext: string } {
  const parts = raw.split(":");
  if (parts.length < 4) throw new Error("invalid packed token format");
  const [iv, tag, kid, ...rest] = parts;
  return { iv, tag, kid, ciphertext: rest.join(":") };
}

export function encryptToken(plaintext: string): string {
  return packToken(encrypt(plaintext));
}

export function decryptToken(packed: string): string {
  const { iv, tag, kid, ciphertext } = unpackToken(packed);
  return decrypt(ciphertext, iv, tag, kid);
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function upsertIntegration(
  userId: string,
  provider: IntegrationProvider,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
    scopes?: string[];
  },
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const accessPacked = encryptToken(tokens.accessToken);
  const refreshPacked = tokens.refreshToken ? encryptToken(tokens.refreshToken) : null;

  await query(
    `INSERT INTO connected_integrations
       (user_id, provider, access_token_packed, refresh_token_packed,
        token_expires_at, scopes, metadata, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', now())
     ON CONFLICT (user_id, provider)
     DO UPDATE SET
       access_token_packed  = EXCLUDED.access_token_packed,
       refresh_token_packed = COALESCE(EXCLUDED.refresh_token_packed, connected_integrations.refresh_token_packed),
       token_expires_at     = EXCLUDED.token_expires_at,
       scopes               = EXCLUDED.scopes,
       metadata             = EXCLUDED.metadata,
       status               = 'active',
       updated_at           = now()`,
    [
      userId,
      provider,
      accessPacked,
      refreshPacked,
      tokens.expiresAt ?? null,
      tokens.scopes ?? [],
      JSON.stringify(metadata),
    ],
  );
}

export async function getIntegration(
  userId: string,
  provider: IntegrationProvider,
): Promise<(StoredIntegration & { accessToken: string; refreshToken: string | null }) | null> {
  const res = await query<{
    id: string;
    user_id: string;
    provider: IntegrationProvider;
    access_token_packed: string;
    refresh_token_packed: string | null;
    token_expires_at: Date | null;
    scopes: string[];
    metadata: Record<string, unknown>;
    status: IntegrationStatus;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT * FROM connected_integrations WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );

  const row = res.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider,
    accessToken: decryptToken(row.access_token_packed),
    refreshToken: row.refresh_token_packed ? decryptToken(row.refresh_token_packed) : null,
    tokenExpiresAt: row.token_expires_at,
    scopes: row.scopes ?? [],
    metadata: row.metadata ?? {},
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listIntegrationsForUser(userId: string): Promise<
  {
    provider: string;
    status: IntegrationStatus;
    scopes: string[];
    metadata: Record<string, unknown>;
    connectedAt: Date;
  }[]
> {
  const res = await query<{
    provider: string;
    status: IntegrationStatus;
    scopes: string[];
    metadata: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT provider, status, scopes, metadata, created_at
     FROM connected_integrations
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId],
  );

  return res.rows.map((r) => ({
    provider: r.provider,
    status: r.status,
    scopes: r.scopes ?? [],
    metadata: r.metadata ?? {},
    connectedAt: r.created_at,
  }));
}

/**
 * Lightweight connection check — true only when the provider is linked and not
 * revoked/expired. Cheaper than getIntegration (no token decryption) and used
 * to give consistent "connect this first" fallbacks before attempting an action.
 */
export async function isConnected(
  userId: string,
  provider: IntegrationProvider,
): Promise<boolean> {
  const res = await query<{ status: IntegrationStatus }>(
    `SELECT status FROM connected_integrations WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
  return res.rows[0]?.status === "active";
}

export async function revokeIntegration(userId: string, provider: string): Promise<void> {
  await query(
    `UPDATE connected_integrations SET status = 'revoked', updated_at = now()
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

export async function updateAccessToken(
  userId: string,
  provider: IntegrationProvider,
  accessToken: string,
  expiresAt?: Date,
): Promise<void> {
  await query(
    `UPDATE connected_integrations
     SET access_token_packed = $3, token_expires_at = $4, updated_at = now(), status = 'active'
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider, encryptToken(accessToken), expiresAt ?? null],
  );
}
