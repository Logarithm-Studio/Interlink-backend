import { Response, NextFunction } from "express";
import { query } from "../config/db";
import { getSupabase } from "../config/supabase";
import { AuthenticatedRequest } from "../types";
import { UnauthorizedError } from "../utils/errors";

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

    // Ensure the user exists in our local users table (upsert on first login).
    await query(
      `INSERT INTO users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [user.id, user.email],
    );

    req.user = { id: user.id, email: user.email };

    next();
  } catch (err) {
    next(err);
  }
}
