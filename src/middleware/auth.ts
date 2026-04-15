import { Response, NextFunction } from "express";
import { query } from "../config/db";
import { getSupabase } from "../config/supabase";
import { AuthenticatedRequest } from "../types";
import { UnauthorizedError } from "../utils/errors";

// ─── In-process user cache ────────────────────────────────────────────────────
// Avoids a DB upsert on every authenticated request. Once a user's local row
// has been confirmed/created we cache { localUserId, email } for TTL_MS. The
// cache is keyed by the Supabase user ID (stable for the lifetime of the user).
//
// We use Supabase's `getUser(token)` on every request (that round-trip is
// unavoidable for JWT verification), but the subsequent DB write is skipped for
// requests arriving within TTL_MS of the last successful write.

const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedUser {
  localUserId: string;
  email: string;
  cachedAt: number;
}

const _userCache = new Map<string, CachedUser>();

function getCachedUser(supabaseId: string): CachedUser | null {
  const entry = _userCache.get(supabaseId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > USER_CACHE_TTL_MS) {
    _userCache.delete(supabaseId);
    return null;
  }
  return entry;
}

function setCachedUser(supabaseId: string, data: Omit<CachedUser, "cachedAt">): void {
  _userCache.set(supabaseId, { ...data, cachedAt: Date.now() });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isUsersEmailUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const pgErr = err as { code?: string; constraint?: string };
  return pgErr.code === "23505" && pgErr.constraint === "users_email_key";
}

async function ensureLocalUser(
  supabaseId: string,
  normalizedEmail: string,
  log: AuthenticatedRequest["log"],
): Promise<string> {
  // Cache hit: skip the DB write entirely.
  const cached = getCachedUser(supabaseId);
  if (cached && cached.email === normalizedEmail) {
    return cached.localUserId;
  }

  // Fast path: existing local user by Supabase ID (read-only, no write lock).
  const byId = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE id = $1 LIMIT 1`,
    [supabaseId],
  );

  if (byId.rows[0]?.id) {
    const localUserId = byId.rows[0].id;

    // Only update when email actually changed.
    if (byId.rows[0].email !== normalizedEmail) {
      try {
        await query(
          `UPDATE users
              SET email = $2,
                  updated_at = NOW()
            WHERE id = $1
              AND email IS DISTINCT FROM $2`,
          [localUserId, normalizedEmail],
        );
      } catch (err) {
        if (!isUsersEmailUniqueViolation(err)) throw err;

        const existing = await query<{ id: string }>(
          `SELECT id FROM users WHERE email = $1 LIMIT 1`,
          [normalizedEmail],
        );
        if (existing.rows[0]?.id) {
          const resolvedId = existing.rows[0].id;
          if (resolvedId !== supabaseId) {
            log?.warn("Resolved local user mismatch by existing email record", {
              supabaseUserId: supabaseId,
              localUserId: resolvedId,
              email: normalizedEmail,
            });
          }
          setCachedUser(supabaseId, { localUserId: resolvedId, email: normalizedEmail });
          return resolvedId;
        }
        throw err;
      }
    }

    setCachedUser(supabaseId, { localUserId, email: normalizedEmail });
    return localUserId;
  }

  // Fallback path: row may exist under a different local UUID keyed by email.
  const byEmail = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [normalizedEmail],
  );
  if (byEmail.rows[0]?.id) {
    const localUserId = byEmail.rows[0].id;
    if (localUserId !== supabaseId) {
      log?.warn("Resolved local user mismatch by existing email record", {
        supabaseUserId: supabaseId,
        localUserId,
        email: normalizedEmail,
      });
    }
    setCachedUser(supabaseId, { localUserId, email: normalizedEmail });
    return localUserId;
  }

  // First-seen user: insert once without forcing an UPDATE on every request.
  try {
    await query(
      `INSERT INTO users (id, email)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
      [supabaseId, normalizedEmail],
    );
  } catch (err) {
    if (!isUsersEmailUniqueViolation(err)) throw err;

    const existing = await query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 LIMIT 1`,
      [normalizedEmail],
    );
    if (!existing.rows[0]?.id) throw err;

    const resolvedId = existing.rows[0].id;
    if (resolvedId !== supabaseId) {
      log?.warn("Resolved local user mismatch by existing email record", {
        supabaseUserId: supabaseId,
        localUserId: resolvedId,
        email: normalizedEmail,
      });
    }
    setCachedUser(supabaseId, { localUserId: resolvedId, email: normalizedEmail });
    return resolvedId;
  }

  const localUserId = supabaseId;

  setCachedUser(supabaseId, { localUserId, email: normalizedEmail });
  return localUserId;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Express middleware that validates Supabase JWT access tokens using
 * `supabase.auth.getUser(token)` and attaches `req.user` on success.
 *
 * Local user resolution uses a read-first path with conditional writes only
 * when the row is missing or the email changed; plus a short in-process cache.
 * This avoids write-lock contention on every authenticated request.
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedError("Missing or malformed Authorization header");
    }

    const token = authHeader.split(" ")[1];
    const { data: { user }, error } = await getSupabase().auth.getUser(token);

    if (error || !user?.id || !user.email) {
      req.log?.warn("Supabase JWT verification failed", {
        errorMessage: error?.message ?? "No user returned",
      });
      throw new UnauthorizedError("Invalid or expired token");
    }

    const normalizedEmail = user.email.trim().toLowerCase();
    const localUserId = await ensureLocalUser(user.id, normalizedEmail, req.log);

    req.user = { id: localUserId, email: normalizedEmail };
    next();
  } catch (err) {
    next(err);
  }
}
