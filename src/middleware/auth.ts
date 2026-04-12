import { Response, NextFunction } from "express";
import { query } from "../config/db";
import { getSupabase } from "../config/supabase";
import { AuthenticatedRequest } from "../types";
import { UnauthorizedError } from "../utils/errors";

function isUsersEmailUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  const pgErr = err as { code?: string; constraint?: string };
  return (
    pgErr.code === "23505" && pgErr.constraint === "users_email_key"
  );
}

/**
 * Express middleware that validates Supabase JWT access tokens using
 * `supabase.auth.getUser(token)` and attaches `req.user` on success.
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

    const {
      data: { user },
      error,
    } = await getSupabase().auth.getUser(token);

    if (error || !user?.id || !user.email) {
      req.log?.warn("Supabase JWT verification failed", {
        errorMessage: error?.message ?? "No user returned",
      });
      throw new UnauthorizedError("Invalid or expired token");
    }

    const normalizedEmail = user.email.trim().toLowerCase();
    let localUserId = user.id;

    // Ensure the user exists in our local users table (upsert on first login).
    // If the same email already exists under a different local UUID, reuse that
    // row to avoid failing every authenticated request.
    try {
      await query(
        `INSERT INTO users (id, email)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
        [user.id, normalizedEmail],
      );
    } catch (err) {
      if (!isUsersEmailUniqueViolation(err)) {
        throw err;
      }

      const existing = await query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1 LIMIT 1`,
        [normalizedEmail],
      );

      if (!existing.rows[0]?.id) {
        throw err;
      }

      localUserId = existing.rows[0].id;

      if (localUserId !== user.id) {
        req.log?.warn(
          "Resolved local user mismatch by existing email record",
          {
            supabaseUserId: user.id,
            localUserId,
            email: normalizedEmail,
          },
        );
      }
    }

    req.user = { id: localUserId, email: normalizedEmail };

    next();
  } catch (err) {
    next(err);
  }
}
