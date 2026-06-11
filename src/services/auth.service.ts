import { query } from "../config/db";
import { ConnectedAccount } from "../types";
import { google } from "googleapis";
import { encrypt, decrypt } from "../security/crypto";

type Provider = "google" | "microsoft";

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Thrown when a token refresh fails due to an invalid/revoked credential.
 * The caller should mark the connection as reauth_required and surface this
 * to the user so they can reconnect.
 */
export class ReauthRequiredError extends Error {
  public readonly cause?: unknown;
  constructor(
    public readonly userId: string,
    public readonly provider: Provider,
    cause?: unknown,
  ) {
    super(`Reauth required for ${provider} account of user ${userId}`);
    this.name = "ReauthRequiredError";
    this.cause = cause;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function packRefreshToken(encrypted: {
  iv: string;
  tag: string;
  kid: string;
  ciphertext: string;
}): string {
  return `${encrypted.iv}:${encrypted.tag}:${encrypted.kid}:${encrypted.ciphertext}`;
}

function unpackRefreshToken(raw: string): {
  iv: string;
  tag: string;
  kid: string;
  ciphertext: string;
} {
  const parts = raw.split(":");
  if (parts.length < 4) {
    throw new Error("invalid refresh token format");
  }
  const [iv, tag, kid, ...rest] = parts;
  return {
    iv,
    tag,
    kid,
    ciphertext: rest.join(":"),
  };
}

async function upsertConnectedAccount(
  userId: string,
  provider: Provider,
  expiresAt: Date,
  accessTokenCiphertext: string,
  refreshTokenPacked: string,
  encIv: string,
  encTag: string,
  encKid: string,
): Promise<void> {
  await query(
    `INSERT INTO connected_accounts
       (user_id, provider, expires_at,
        access_token_enc, refresh_token_enc, enc_iv, enc_tag, enc_kid,
        reauth_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
     ON CONFLICT (user_id, provider)
     DO UPDATE SET
       expires_at         = EXCLUDED.expires_at,
       access_token_enc   = EXCLUDED.access_token_enc,
       refresh_token_enc  = EXCLUDED.refresh_token_enc,
       enc_iv             = EXCLUDED.enc_iv,
       enc_tag            = EXCLUDED.enc_tag,
       enc_kid            = EXCLUDED.enc_kid,
       reauth_required    = FALSE`,
    [
      userId,
      provider,
      expiresAt,
      accessTokenCiphertext,
      refreshTokenPacked,
      encIv,
      encTag,
      encKid,
    ],
  );
}

async function upsertGoogleAccount(
  userId: string,
  expiresAt: Date,
  accessTokenCiphertext: string,
  refreshTokenPacked: string,
  encIv: string,
  encTag: string,
  encKid: string,
): Promise<void> {
  await query(
    `INSERT INTO google_accounts
       (user_id, access_token, refresh_token, expiry_date,
        enc_iv, enc_tag, enc_kid, reauth_required)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE)
     ON CONFLICT (user_id)
     DO UPDATE SET
       access_token    = EXCLUDED.access_token,
       refresh_token   = EXCLUDED.refresh_token,
       expiry_date     = EXCLUDED.expiry_date,
       enc_iv          = EXCLUDED.enc_iv,
       enc_tag         = EXCLUDED.enc_tag,
       enc_kid         = EXCLUDED.enc_kid,
       reauth_required = FALSE`,
    [
      userId,
      accessTokenCiphertext,
      refreshTokenPacked,
      expiresAt,
      encIv,
      encTag,
      encKid,
    ],
  );
}

// ─── Token storage ────────────────────────────────────────────────────────────

/**
 * Store or update OAuth tokens for a provider.
 * Tokens are encrypted with AES-256-GCM before being written to the DB.
 */
export async function storeTokens(
  userId: string,
  provider: Provider,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  },
): Promise<void> {
  const encAccess = encrypt(tokens.accessToken);
  const encRefresh = encrypt(tokens.refreshToken);
  const refreshTokenPacked = packRefreshToken(encRefresh);

  if (provider === "google") {
    await upsertGoogleAccount(
      userId,
      tokens.expiresAt,
      encAccess.ciphertext,
      refreshTokenPacked,
      encAccess.iv,
      encAccess.tag,
      encAccess.kid,
    );
  }

  // Keep writing to connected_accounts for compatibility with existing services.
  await upsertConnectedAccount(
    userId,
    provider,
    tokens.expiresAt,
    encAccess.ciphertext,
    refreshTokenPacked,
    encAccess.iv,
    encAccess.tag,
    encAccess.kid,
  );
}

// ─── Token retrieval ──────────────────────────────────────────────────────────

/**
 * Retrieve stored tokens for a user + provider, decrypting them.
 * Returns null if no account is found.
 * Throws ReauthRequiredError if reauth_required is true.
 */
export async function getTokens(
  userId: string,
  provider: Provider,
): Promise<ConnectedAccount | null> {
  if (provider === "google") {
    const googleResult = await query<{
      id: string;
      user_id: string;
      access_token: string | null;
      refresh_token: string | null;
      enc_iv: string | null;
      enc_tag: string | null;
      enc_kid: string | null;
      expiry_date: Date;
      created_at: Date;
      reauth_required: boolean;
    }>(
      `SELECT id, user_id, access_token, refresh_token,
              enc_iv, enc_tag, enc_kid, expiry_date, created_at, reauth_required
         FROM google_accounts
        WHERE user_id = $1`,
      [userId],
    );

    if (googleResult.rows.length > 0) {
      const row = googleResult.rows[0];

      if (row.reauth_required) {
        throw new ReauthRequiredError(userId, "google");
      }

      if (!row.access_token || !row.enc_iv || !row.enc_tag || !row.enc_kid) {
        await markReauthRequired(userId, "google");
        throw new ReauthRequiredError(userId, "google");
      }

      let accessToken: string;
      try {
        accessToken = decrypt(
          row.access_token,
          row.enc_iv,
          row.enc_tag,
          row.enc_kid,
        );
      } catch {
        await markReauthRequired(userId, "google");
        throw new ReauthRequiredError(userId, "google");
      }

      let refreshToken: string;
      try {
        const packed = unpackRefreshToken(row.refresh_token ?? "");
        refreshToken = decrypt(
          packed.ciphertext,
          packed.iv,
          packed.tag,
          packed.kid,
        );
      } catch {
        await markReauthRequired(userId, "google");
        throw new ReauthRequiredError(userId, "google");
      }

      return {
        id: row.id,
        userId: row.user_id,
        provider: "google",
        accessToken,
        refreshToken,
        expiresAt: row.expiry_date,
        createdAt: row.created_at,
        reauthRequired: false,
      };
    }
  }

  // Fallback for legacy rows and for non-Google providers.
  const result = await query<{
    id: string;
    user_id: string;
    provider: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    enc_iv: string | null;
    enc_tag: string | null;
    enc_kid: string | null;
    expires_at: Date;
    created_at: Date;
    reauth_required: boolean;
  }>(
    `SELECT id, user_id, provider, access_token_enc, refresh_token_enc,
            enc_iv, enc_tag, enc_kid, expires_at, created_at, reauth_required
       FROM connected_accounts
      WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  if (row.reauth_required) {
    throw new ReauthRequiredError(userId, provider);
  }

  // Decrypt access token.
  if (!row.access_token_enc || !row.enc_iv || !row.enc_tag || !row.enc_kid) {
    // Encrypted columns missing — treat as reauth required.
    await markReauthRequired(userId, provider);
    throw new ReauthRequiredError(userId, provider);
  }

  let accessToken: string;
  try {
    accessToken = decrypt(
      row.access_token_enc,
      row.enc_iv,
      row.enc_tag,
      row.enc_kid,
    );
  } catch {
    await markReauthRequired(userId, provider);
    throw new ReauthRequiredError(userId, provider);
  }

  // Decrypt refresh token (encoded as "iv:tag:kid:ciphertext").
  let refreshToken: string;
  try {
    const packed = unpackRefreshToken(row.refresh_token_enc ?? "");
    refreshToken = decrypt(
      packed.ciphertext,
      packed.iv,
      packed.tag,
      packed.kid,
    );
  } catch {
    await markReauthRequired(userId, provider);
    throw new ReauthRequiredError(userId, provider);
  }

  return {
    id: row.id,
    userId: row.user_id,
    provider: row.provider as "google" | "microsoft",
    accessToken,
    refreshToken,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    reauthRequired: false,
  };
}

// ─── Reauth flag ──────────────────────────────────────────────────────────────

/**
 * Mark a connected account as requiring re-authentication.
 * Nulls the encrypted token columns so no stale credential remains.
 */
export async function markReauthRequired(
  userId: string,
  provider: Provider,
): Promise<void> {
  if (provider === "google") {
    await query(
      `UPDATE google_accounts
          SET reauth_required = TRUE,
              access_token    = NULL,
              refresh_token   = NULL,
              enc_iv          = NULL,
              enc_tag         = NULL,
              enc_kid         = NULL
        WHERE user_id = $1`,
      [userId],
    );
  }

  await query(
    `UPDATE connected_accounts
        SET reauth_required   = TRUE,
            access_token_enc  = NULL,
            refresh_token_enc = NULL,
            enc_iv            = NULL,
            enc_tag           = NULL,
            enc_kid           = NULL
      WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

// ─── Token refresh ────────────────────────────────────────────────────────────

/**
 * Refresh the Google OAuth access token if it has expired.
 * Returns the (potentially refreshed) access token.
 *
 * Throws ReauthRequiredError on permanent auth failure (invalid_grant, etc.)
 * so callers can surface the reconnect prompt to the user.
 */
export async function refreshGoogleTokenIfNeeded(
  userId: string,
): Promise<string> {
  const account = await getTokens(userId, "google");
  if (!account) {
    throw new Error("No Google account connected");
  }

  // If token is still valid (with a 5-minute buffer), return it.
  const bufferMs = 5 * 60 * 1000;
  if (account.expiresAt.getTime() > Date.now() + bufferMs) {
    return account.accessToken;
  }

  // Attempt token refresh.
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2Client.setCredentials({ refresh_token: account.refreshToken });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error("Google refresh call did not return access_token");
    }

    const newExpiry = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : new Date(Date.now() + 3600 * 1000);

    await storeTokens(userId, "google", {
      accessToken: credentials.access_token,
      refreshToken: account.refreshToken,
      expiresAt: newExpiry,
    });

    return credentials.access_token;
  } catch (err) {
    // Permanent auth failures (revoked / expired refresh token) — mark the
    // account so the UI can prompt reconnect.  401/403 and invalid_grant are
    // the canonical indicators.
    const msg = err instanceof Error ? err.message : String(err);
    const isPermanent =
      msg.includes("invalid_grant") ||
      msg.includes("Token has been expired or revoked") ||
      (err as { status?: number }).status === 401 ||
      (err as { status?: number }).status === 403;

    if (isPermanent) {
      await markReauthRequired(userId, "google");
      throw new ReauthRequiredError(userId, "google", err);
    }
    throw err;
  }
}
