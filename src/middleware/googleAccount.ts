import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest, GoogleAccountRole } from "../types";
import { resolveGoogleAccountId } from "../services/auth.service";

/**
 * Resolve the Google account this request should act on, based on the app mode
 * carried in the `X-Interlink-Mode` header (personal | professional), and attach
 * it as `req.googleAccountId`.
 *
 * The app binds Personal Mode to one connected Google account and Professional
 * (Work) Mode to another; the resolver falls back to the primary account when a
 * mode has no dedicated account (or the header is absent — e.g. older app
 * builds), so behaviour is unchanged for single-account users.
 *
 * Must run after `authMiddleware` (needs `req.user`). Never fails the request —
 * a missing/invalid header just yields the primary/most-recent account.
 */
export function parseAppMode(headerValue: unknown): GoogleAccountRole | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw === "professional") return "professional";
  if (raw === "personal") return "personal";
  return null;
}

export async function resolveGoogleAccountForRequest(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = (req as AuthenticatedRequest).user;
    if (user?.id) {
      const mode = parseAppMode(req.headers["x-interlink-mode"]);
      const accountId = await resolveGoogleAccountId(user.id, mode);
      (req as AuthenticatedRequest).googleAccountId = accountId ?? undefined;
    }
  } catch {
    // Non-fatal: fall through with no resolved account (services default to primary).
  }
  next();
}
