import { query } from "../config/db";
import { ConnectedAccount, GoogleAccountRole } from "../types";
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

// ─── Google account rows ────────────────────────────────────────────────────

interface GoogleAccountRow {
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
  email: string | null;
  role: GoogleAccountRole | null;
  is_primary: boolean;
}

const GOOGLE_ACCOUNT_COLUMNS = `id, user_id, access_token, refresh_token,
  enc_iv, enc_tag, enc_kid, expiry_date, created_at, reauth_required,
  email, role, is_primary`;

/** Lightweight (no token) summary of a connected Google account. */
export interface GoogleAccountSummary {
  id: string;
  userId: string;
  email: string | null;
  role: GoogleAccountRole | null;
  isPrimary: boolean;
  reauthRequired: boolean;
  expiresAt: Date;
  createdAt: Date;
}

function rowToSummary(row: GoogleAccountRow): GoogleAccountSummary {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    isPrimary: row.is_primary,
    reauthRequired: row.reauth_required,
    expiresAt: row.expiry_date,
    createdAt: row.created_at,
  };
}

async function fetchGoogleAccountRowById(
  accountId: string,
): Promise<GoogleAccountRow | null> {
  const res = await query<GoogleAccountRow>(
    `SELECT ${GOOGLE_ACCOUNT_COLUMNS} FROM google_accounts WHERE id = $1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

/**
 * Resolve the Google account a request should use for a given mode.
 *
 * Preference order: the account bound to `mode`, then the primary account,
 * then the most-recently connected one. This is the single place the
 * "which account" decision lives.
 */
async function fetchResolvedGoogleAccountRow(
  userId: string,
  mode?: GoogleAccountRole | null,
): Promise<GoogleAccountRow | null> {
  const res = await query<GoogleAccountRow>(
    `SELECT ${GOOGLE_ACCOUNT_COLUMNS}
       FROM google_accounts
      WHERE user_id = $1
      ORDER BY (role = $2) DESC NULLS LAST, is_primary DESC, created_at DESC
      LIMIT 1`,
    [userId, mode ?? null],
  );
  return res.rows[0] ?? null;
}

/** Resolve the account summary for a user + mode (no token decryption). */
export async function resolveGoogleAccount(
  userId: string,
  mode?: GoogleAccountRole | null,
): Promise<GoogleAccountSummary | null> {
  const row = await fetchResolvedGoogleAccountRow(userId, mode);
  return row ? rowToSummary(row) : null;
}

/** Resolve just the account id for a user + mode (null if none connected). */
export async function resolveGoogleAccountId(
  userId: string,
  mode?: GoogleAccountRole | null,
): Promise<string | null> {
  const row = await fetchResolvedGoogleAccountRow(userId, mode);
  return row?.id ?? null;
}

/** Fetch a single Google account summary by its id (no token decryption). */
export async function getGoogleAccountSummaryById(
  accountId: string,
): Promise<GoogleAccountSummary | null> {
  const row = await fetchGoogleAccountRowById(accountId);
  return row ? rowToSummary(row) : null;
}

/** List all Google accounts connected by a user (no token decryption). */
export async function listGoogleAccounts(
  userId: string,
): Promise<GoogleAccountSummary[]> {
  const res = await query<GoogleAccountRow>(
    `SELECT ${GOOGLE_ACCOUNT_COLUMNS}
       FROM google_accounts
      WHERE user_id = $1
      ORDER BY is_primary DESC, created_at ASC`,
    [userId],
  );
  return res.rows.map(rowToSummary);
}

// ─── Token storage ────────────────────────────────────────────────────────────

/**
 * Store or update OAuth tokens for a non-Google provider (Microsoft), or for
 * the primary Google account (legacy callers). New Google connects should use
 * `upsertGoogleAccountOnConnect`, and refresh uses `storeTokensForAccount`.
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
    const primaryId = await resolveGoogleAccountId(userId);
    if (primaryId) {
      await storeTokensForAccount(primaryId, tokens);
      return;
    }
    // No account row yet — fall through to write connected_accounts only.
  }

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

/** Update the encrypted tokens for a specific Google account row. */
export async function storeTokensForAccount(
  accountId: string,
  tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAt: Date;
  },
): Promise<void> {
  const encAccess = encrypt(tokens.accessToken);
  const refreshTokenPacked = packRefreshToken(encrypt(tokens.refreshToken));

  const res = await query<{ user_id: string; is_primary: boolean }>(
    `UPDATE google_accounts
        SET access_token    = $2,
            refresh_token   = $3,
            expiry_date     = $4,
            enc_iv          = $5,
            enc_tag         = $6,
            enc_kid         = $7,
            reauth_required = FALSE
      WHERE id = $1
      RETURNING user_id, is_primary`,
    [
      accountId,
      encAccess.ciphertext,
      refreshTokenPacked,
      tokens.expiresAt,
      encAccess.iv,
      encAccess.tag,
      encAccess.kid,
    ],
  );

  // Keep the legacy connected_accounts row in sync for the primary account.
  const updated = res.rows[0];
  if (updated?.is_primary) {
    await upsertConnectedAccount(
      updated.user_id,
      "google",
      tokens.expiresAt,
      encAccess.ciphertext,
      refreshTokenPacked,
      encAccess.iv,
      encAccess.tag,
      encAccess.kid,
    );
  }
}

/**
 * Ensure exactly one primary Google account exists for a user (the earliest
 * connected one when none is currently flagged). Safety net after mutations.
 */
async function ensurePrimaryAccount(userId: string): Promise<void> {
  await query(
    `UPDATE google_accounts
        SET is_primary = TRUE
      WHERE id = (
        SELECT id FROM google_accounts
         WHERE user_id = $1
         ORDER BY is_primary DESC, created_at ASC
         LIMIT 1
      )
        AND NOT EXISTS (
          SELECT 1 FROM google_accounts
           WHERE user_id = $1 AND is_primary = TRUE
        )`,
    [userId],
  );
}

/**
 * Upsert a Google account on OAuth connect, keyed by the connected mailbox
 * address. Captures the real Gmail email (previously never stored), assigns a
 * role (mode binding), and marks the first-ever account primary.
 *
 * Returns the account id and whether it is the primary account.
 */
export async function upsertGoogleAccountOnConnect(
  userId: string,
  params: {
    email: string;
    role?: GoogleAccountRole | null;
    tokens: { accessToken: string; refreshToken: string; expiresAt: Date };
  },
): Promise<{ accountId: string; isPrimary: boolean; role: GoogleAccountRole | null }> {
  const encAccess = encrypt(params.tokens.accessToken);
  const refreshTokenPacked = packRefreshToken(encrypt(params.tokens.refreshToken));

  const existing = await query<{ id: string }>(
    `SELECT id FROM google_accounts
      WHERE user_id = $1 AND lower(email) = lower($2)`,
    [userId, params.email],
  );

  // Adopt a legacy backfilled row (email IS NULL) rather than inserting a
  // duplicate: pre-multi-account users have exactly one such row for their
  // single connected account. First reconnect stamps it with the real email.
  if (!existing.rows[0]) {
    const legacy = await query<{ id: string }>(
      `SELECT id FROM google_accounts
        WHERE user_id = $1 AND email IS NULL
        ORDER BY is_primary DESC, created_at ASC
        LIMIT 1`,
      [userId],
    );
    if (legacy.rows[0]) {
      existing.rows[0] = legacy.rows[0];
    }
  }

  const countRes = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM google_accounts WHERE user_id = $1`,
    [userId],
  );
  const isFirstAccount = countRes.rows[0].n === 0;

  let accountId: string;
  let isPrimary: boolean;
  let role: GoogleAccountRole | null;

  if (existing.rows[0]) {
    // Reconnect of a known mailbox — refresh tokens, keep/upgrade role.
    accountId = existing.rows[0].id;
    role = params.role ?? null;
    const res = await query<{ is_primary: boolean; role: GoogleAccountRole | null }>(
      `UPDATE google_accounts
          SET access_token    = $2,
              refresh_token   = $3,
              expiry_date     = $4,
              enc_iv          = $5,
              enc_tag         = $6,
              enc_kid         = $7,
              reauth_required = FALSE,
              email           = $8,
              role            = COALESCE($9, role)
        WHERE id = $1
        RETURNING is_primary, role`,
      [
        accountId,
        encAccess.ciphertext,
        refreshTokenPacked,
        params.tokens.expiresAt,
        encAccess.iv,
        encAccess.tag,
        encAccess.kid,
        params.email,
        params.role ?? null,
      ],
    );
    isPrimary = res.rows[0].is_primary;
    role = res.rows[0].role;
  } else {
    role = params.role ?? (isFirstAccount ? "personal" : null);
    isPrimary = isFirstAccount;
    const res = await query<{ id: string }>(
      `INSERT INTO google_accounts
         (user_id, access_token, refresh_token, expiry_date,
          enc_iv, enc_tag, enc_kid, reauth_required,
          email, role, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, $8, $9, $10)
       RETURNING id`,
      [
        userId,
        encAccess.ciphertext,
        refreshTokenPacked,
        params.tokens.expiresAt,
        encAccess.iv,
        encAccess.tag,
        encAccess.kid,
        params.email,
        role,
        isPrimary,
      ],
    );
    accountId = res.rows[0].id;
  }

  // Enforce one account per role: clear the role from any *other* account.
  if (role) {
    await query(
      `UPDATE google_accounts
          SET role = NULL
        WHERE user_id = $1 AND role = $2 AND id <> $3`,
      [userId, role, accountId],
    );
  }

  await ensurePrimaryAccount(userId);

  // Sync legacy connected_accounts for the primary account.
  if (isPrimary) {
    await upsertConnectedAccount(
      userId,
      "google",
      params.tokens.expiresAt,
      encAccess.ciphertext,
      refreshTokenPacked,
      encAccess.iv,
      encAccess.tag,
      encAccess.kid,
    );
  }

  return { accountId, isPrimary, role };
}

/** Set (or clear) the mode binding for one of a user's Google accounts. */
export async function setGoogleAccountRole(
  userId: string,
  accountId: string,
  role: GoogleAccountRole | null,
): Promise<GoogleAccountSummary | null> {
  // Guard ownership.
  const owned = await query<{ id: string }>(
    `SELECT id FROM google_accounts WHERE id = $1 AND user_id = $2`,
    [accountId, userId],
  );
  if (!owned.rows[0]) return null;

  // Free the role from any other account first (one account per role).
  if (role) {
    await query(
      `UPDATE google_accounts SET role = NULL
        WHERE user_id = $1 AND role = $2 AND id <> $3`,
      [userId, role, accountId],
    );
  }

  await query(`UPDATE google_accounts SET role = $2 WHERE id = $1`, [
    accountId,
    role,
  ]);

  const row = await fetchGoogleAccountRowById(accountId);
  return row ? rowToSummary(row) : null;
}

// ─── Token retrieval ──────────────────────────────────────────────────────────

function decryptGoogleRow(row: GoogleAccountRow): ConnectedAccount {
  const accessToken = decrypt(
    row.access_token!,
    row.enc_iv!,
    row.enc_tag!,
    row.enc_kid!,
  );
  const packed = unpackRefreshToken(row.refresh_token ?? "");
  const refreshToken = decrypt(
    packed.ciphertext,
    packed.iv,
    packed.tag,
    packed.kid,
  );
  return {
    id: row.id,
    userId: row.user_id,
    provider: "google",
    accessToken,
    refreshToken,
    expiresAt: row.expiry_date,
    createdAt: row.created_at,
    reauthRequired: false,
    email: row.email,
    role: row.role,
    isPrimary: row.is_primary,
  };
}

/**
 * Retrieve + decrypt the tokens for a specific Google account.
 * Returns null if the account row does not exist.
 * Throws ReauthRequiredError if the credential is missing/invalid.
 */
export async function getTokensByAccountId(
  accountId: string,
): Promise<ConnectedAccount | null> {
  const row = await fetchGoogleAccountRowById(accountId);
  if (!row) return null;

  if (row.reauth_required) {
    throw new ReauthRequiredError(row.user_id, "google");
  }
  if (!row.access_token || !row.enc_iv || !row.enc_tag || !row.enc_kid) {
    await markReauthRequiredForAccount(accountId);
    throw new ReauthRequiredError(row.user_id, "google");
  }

  try {
    return decryptGoogleRow(row);
  } catch {
    await markReauthRequiredForAccount(accountId);
    throw new ReauthRequiredError(row.user_id, "google");
  }
}

/**
 * Retrieve stored tokens for a user + provider, decrypting them.
 * For Google this resolves the user's primary account (legacy callers).
 * Returns null if no account is found.
 * Throws ReauthRequiredError if reauth_required is true.
 */
export async function getTokens(
  userId: string,
  provider: Provider,
): Promise<ConnectedAccount | null> {
  if (provider === "google") {
    const row = await fetchResolvedGoogleAccountRow(userId);
    if (!row) return null;

    if (row.reauth_required) {
      throw new ReauthRequiredError(userId, "google");
    }
    if (!row.access_token || !row.enc_iv || !row.enc_tag || !row.enc_kid) {
      await markReauthRequiredForAccount(row.id);
      throw new ReauthRequiredError(userId, "google");
    }
    try {
      return decryptGoogleRow(row);
    } catch {
      await markReauthRequiredForAccount(row.id);
      throw new ReauthRequiredError(userId, "google");
    }
  }

  // Non-Google providers (Microsoft) live in connected_accounts.
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

  if (!row.access_token_enc || !row.enc_iv || !row.enc_tag || !row.enc_kid) {
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

/** Mark a specific Google account as requiring re-authentication. */
export async function markReauthRequiredForAccount(
  accountId: string,
): Promise<void> {
  const res = await query<{ user_id: string; is_primary: boolean }>(
    `UPDATE google_accounts
        SET reauth_required = TRUE,
            access_token    = NULL,
            refresh_token   = NULL,
            enc_iv          = NULL,
            enc_tag         = NULL,
            enc_kid         = NULL
      WHERE id = $1
      RETURNING user_id, is_primary`,
    [accountId],
  );

  const row = res.rows[0];
  if (row?.is_primary) {
    await query(
      `UPDATE connected_accounts
          SET reauth_required   = TRUE,
              access_token_enc  = NULL,
              refresh_token_enc = NULL,
              enc_iv            = NULL,
              enc_tag           = NULL,
              enc_kid           = NULL
        WHERE user_id = $1 AND provider = 'google'`,
      [row.user_id],
    );
  }
}

/**
 * Mark a connected account as requiring re-authentication.
 * For Google this targets the user's primary account (legacy callers).
 */
export async function markReauthRequired(
  userId: string,
  provider: Provider,
): Promise<void> {
  if (provider === "google") {
    const primaryId = await resolveGoogleAccountId(userId);
    if (primaryId) {
      await markReauthRequiredForAccount(primaryId);
    }
    return;
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

// ─── Disconnect ────────────────────────────────────────────────────────────────

/**
 * Remove stored OAuth credentials for a provider.
 * For Google this removes ALL of the user's Google accounts (full disconnect);
 * use `deleteGoogleAccount` to remove a single account. Events and watch
 * channels cascade via their google_account_id FK.
 */
export async function deleteTokens(
  userId: string,
  provider: Provider,
): Promise<void> {
  if (provider === "google") {
    await query(`DELETE FROM google_accounts WHERE user_id = $1`, [userId]);
  }

  await query(
    `DELETE FROM connected_accounts WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
}

/**
 * Disconnect a single Google account. Its events and watch channels cascade
 * away via FK. Re-elects a primary if the removed account was primary.
 * Returns false if the account is not owned by the user.
 */
export async function deleteGoogleAccount(
  userId: string,
  accountId: string,
): Promise<boolean> {
  const res = await query<{ is_primary: boolean }>(
    `DELETE FROM google_accounts
      WHERE id = $1 AND user_id = $2
      RETURNING is_primary`,
    [accountId, userId],
  );
  if (!res.rows[0]) return false;

  await ensurePrimaryAccount(userId);

  // If no Google accounts remain, drop the legacy connected_accounts row too.
  const remaining = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM google_accounts WHERE user_id = $1`,
    [userId],
  );
  if (remaining.rows[0].n === 0) {
    await query(
      `DELETE FROM connected_accounts WHERE user_id = $1 AND provider = 'google'`,
      [userId],
    );
  }
  return true;
}

// ─── Token refresh ────────────────────────────────────────────────────────────

async function refreshRow(account: ConnectedAccount): Promise<string> {
  // If token is still valid (with a 5-minute buffer), return it.
  const bufferMs = 5 * 60 * 1000;
  if (account.expiresAt.getTime() > Date.now() + bufferMs) {
    return account.accessToken;
  }

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

    await storeTokensForAccount(account.id, {
      accessToken: credentials.access_token,
      refreshToken: account.refreshToken,
      expiresAt: newExpiry,
    });

    return credentials.access_token;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isPermanent =
      msg.includes("invalid_grant") ||
      msg.includes("Token has been expired or revoked") ||
      (err as { status?: number }).status === 401 ||
      (err as { status?: number }).status === 403;

    if (isPermanent) {
      await markReauthRequiredForAccount(account.id);
      throw new ReauthRequiredError(account.userId, "google", err);
    }
    throw err;
  }
}

/**
 * Refresh the access token for a specific Google account if it has expired.
 * Returns the (potentially refreshed) access token.
 */
export async function refreshGoogleTokenForAccount(
  accountId: string,
): Promise<string> {
  const account = await getTokensByAccountId(accountId);
  if (!account) {
    throw new Error("No Google account connected");
  }
  return refreshRow(account);
}

/**
 * Refresh the primary Google account's access token if it has expired.
 * Legacy entry point used by the many single-account Google services.
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
  return refreshRow(account);
}
