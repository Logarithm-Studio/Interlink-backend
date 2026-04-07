import { Response, NextFunction } from "express";
import { query } from "../config/db";
import { getSupabase } from "../config/supabase";
import { AuthenticatedRequest } from "../types";
import { UnauthorizedError } from "../utils/errors";
import { verifyJwt } from "../security/supabaseJwt";

function classifyJwtVerificationError(err: unknown): string {
  if (!(err instanceof Error)) {
    return "unknown_error";
  }

  switch (err.name) {
    case "JWTExpired":
      return "token_expired";
    case "JWTClaimValidationFailed":
      return "claim_validation_failed";
    case "JWKSNoMatchingKey":
      return "jwks_no_matching_key";
    case "JOSENotSupported":
      return "algorithm_not_supported";
    case "JWSSignatureVerificationFailed":
    case "JWSInvalid":
      return "signature_invalid";
    default:
      break;
  }

  if (err.message.includes("SUPABASE_URL")) {
    return "supabase_url_misconfigured";
  }
  if (err.message.includes("JWKS")) {
    return "jwks_error";
  }
  if (err.message.includes("audience") || err.message.includes("issuer")) {
    return "issuer_or_audience_mismatch";
  }

  return "jwt_verification_failed";
}

function isJoseMissingError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.message.includes("Cannot find package 'jose'");
}

async function verifyJwtViaSupabase(token: string): Promise<{
  userId: string;
  email: string;
}> {
  const {
    data: { user },
    error,
  } = await getSupabase().auth.getUser(token);

  if (error || !user?.id || !user.email) {
    throw new Error(error?.message ?? "Supabase token validation failed");
  }

  return {
    userId: user.id,
    email: user.email,
  };
}

/**
 * Express middleware that verifies Supabase JWT tokens locally using JWKS.
 *
 * Verification is done via cached RS256 public keys fetched from
 * `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` — no per-request network
 * call to Supabase is made after the initial JWKS fetch.
 *
 * Key rotation is handled transparently: jose re-fetches the JWKS once when
 * a `kid` is not found in the local cache.
 *
 * Attaches `req.user` with `{ id, email }` on success.
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

    // Verify signature, expiry, issuer, and audience locally — no Supabase call.
    let userId: string;
    let email: string;
    try {
      ({ userId, email } = await verifyJwt(token));
    } catch (jwtErr) {
      const reason = classifyJwtVerificationError(jwtErr);

      if (isJoseMissingError(jwtErr)) {
        req.log?.warn(
          "Local JWT verifier unavailable; falling back to Supabase auth.getUser",
          {
            reason,
            errorName: jwtErr instanceof Error ? jwtErr.name : "Unknown",
            errorMessage:
              jwtErr instanceof Error ? jwtErr.message : String(jwtErr),
          },
        );

        try {
          ({ userId, email } = await verifyJwtViaSupabase(token));
        } catch (fallbackErr) {
          req.log?.warn("Supabase fallback JWT verification failed", {
            errorName:
              fallbackErr instanceof Error ? fallbackErr.name : "Unknown",
            errorMessage:
              fallbackErr instanceof Error
                ? fallbackErr.message
                : String(fallbackErr),
          });
          throw new UnauthorizedError("Invalid or expired token");
        }
      } else {
        req.log?.warn("JWT verification failed", {
          reason,
          errorName: jwtErr instanceof Error ? jwtErr.name : "Unknown",
          errorMessage:
            jwtErr instanceof Error ? jwtErr.message : String(jwtErr),
        });
        throw new UnauthorizedError("Invalid or expired token");
      }
    }

    // Ensure the user exists in our local users table (upsert on first login).
    await query(
      `INSERT INTO users (id, email)
       VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
      [userId, email],
    );

    req.user = { id: userId, email };

    next();
  } catch (err) {
    next(err);
  }
}
