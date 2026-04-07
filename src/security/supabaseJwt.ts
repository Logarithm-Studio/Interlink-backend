/**
 * Local Supabase JWT verification using cached JWKS.
 *
 * Replaces per-request `supabase.auth.getUser()` with local RS256 signature
 * verification, eliminating the Supabase availability dependency on every
 * authenticated request.
 *
 * Strategy:
 *  - Fetch JWKS from `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
 *  - Cache the key set in memory (default TTL: 1 hour via jose)
 *  - jose's createRemoteJWKSet automatically re-fetches on `kid` mismatch
 *    (key rotation is handled transparently with one retry)
 */

import type { JWTPayload } from "jose";
import { logger } from "../observability/logger";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface VerifiedUser {
  userId: string;
  email: string;
}

interface JwtValidationConfig {
  issuers: string[];
  audiences: string[];
  clockToleranceSeconds: number;
}

/** Supabase-specific JWT claim extensions on top of the standard payload. */
interface SupabaseJwtPayload extends JWTPayload {
  email?: string;
  role?: string;
}

type JoseModule = typeof import("jose");
type RemoteJwks = ReturnType<JoseModule["createRemoteJWKSet"]>;

let _joseModulePromise: Promise<JoseModule> | null = null;
let _jwtValidationConfigLogged = false;

// Hint for serverless file tracing: include jose in runtime bundle even though
// it is loaded lazily via native dynamic import.
try {
  require.resolve("jose");
} catch {
  // Ignore here; missing module is surfaced later with a clearer auth log.
}

/**
 * Loads jose lazily at runtime using native dynamic import.
 *
 * We intentionally avoid static imports here because this project compiles to
 * CommonJS and jose is ESM-only.
 */
async function getJoseModule(): Promise<JoseModule> {
  if (_joseModulePromise) return _joseModulePromise;

  const dynamicImport = new Function(
    "specifier",
    "return import(specifier);"
  ) as (specifier: string) => Promise<JoseModule>;

  _joseModulePromise = dynamicImport("jose");
  return _joseModulePromise;
}

// ─── JWKS singleton ─────────────────────────────────────────────────────────

let _jwks: RemoteJwks | null = null;

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1).trim()
      : trimmed;
  return unquoted.replace(/\/+$/, "");
}

/**
 * Returns the JWKS key set, constructing and caching it on first call.
 * `createRemoteJWKSet` from `jose` handles:
 *   - In-memory caching with the specified `cacheMaxAge`
 *   - Automatic cache refresh on `kid` mismatch (key rotation)
 */
async function getJwks(): Promise<RemoteJwks> {
  if (_jwks) return _jwks;

  const { createRemoteJWKSet } = await getJoseModule();

  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL environment variable is not set");
  }

  const normalizedSupabaseUrl = normalizeUrl(supabaseUrl);
  const baseUrl = normalizedSupabaseUrl.endsWith("/auth/v1")
    ? normalizedSupabaseUrl.slice(0, -"/auth/v1".length)
    : normalizedSupabaseUrl;

  if (normalizedSupabaseUrl !== baseUrl) {
    logger.warn(
      "SUPABASE_URL should not include /auth/v1; trimming suffix for JWKS lookup",
      {
        configuredSupabaseUrl: normalizedSupabaseUrl,
        normalizedSupabaseUrl: baseUrl,
      },
    );
  }

  // Supabase exposes its JWKS at /auth/v1/.well-known/jwks.json
  const jwksUrl = new URL(`${baseUrl}/auth/v1/.well-known/jwks.json`);

  _jwks = createRemoteJWKSet(jwksUrl, {
    // Cache keys for 1 hour; jose will re-fetch on kid mismatch regardless
    cacheMaxAge: 60 * 60 * 1000, // 1 hour in ms
    // Retry once on kid mismatch (key rotation handling)
    cooldownDuration: 30_000, // min 30s between background re-fetches
  });

  logger.info("JWKS endpoint configured", { jwksUrl: jwksUrl.toString() });

  return _jwks;
}

/**
 * Force-invalidates the in-memory JWKS cache.
 * The next call to `verifyJwt` will trigger a fresh JWKS fetch.
 *
 * Exposed for testing and emergency key rotation scenarios.
 */
export function invalidateJwksCache(): void {
  _jwks = null;
  logger.warn("JWKS cache invalidated — next request will re-fetch");
}

function parseCsvEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getJwtValidationConfig(): JwtValidationConfig {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL environment variable is not set");
  }

  const normalizedSupabaseUrl = normalizeUrl(supabaseUrl);
  const baseUrl = normalizedSupabaseUrl.endsWith("/auth/v1")
    ? normalizedSupabaseUrl.slice(0, -"/auth/v1".length)
    : normalizedSupabaseUrl;
  const defaultIssuer = `${baseUrl}/auth/v1`;

  const issuers = new Set<string>([defaultIssuer]);
  for (const issuer of parseCsvEnv("SUPABASE_ALLOWED_ISSUERS")) {
    issuers.add(normalizeUrl(issuer));
  }

  const audiences = parseCsvEnv("SUPABASE_JWT_AUDIENCES");
  if (audiences.length === 0) {
    audiences.push("authenticated");
  }

  const rawTolerance = process.env.SUPABASE_JWT_CLOCK_TOLERANCE_SECONDS;
  const parsedTolerance = rawTolerance ? Number(rawTolerance) : 30;
  const clockToleranceSeconds =
    Number.isFinite(parsedTolerance) && parsedTolerance >= 0
      ? parsedTolerance
      : 30;

  const config: JwtValidationConfig = {
    issuers: Array.from(issuers),
    audiences,
    clockToleranceSeconds,
  };

  if (!_jwtValidationConfigLogged) {
    logger.info("Supabase JWT validation config", {
      issuers: config.issuers,
      audiences: config.audiences,
      clockToleranceSeconds: config.clockToleranceSeconds,
      configuredSupabaseUrl: normalizedSupabaseUrl,
      normalizedSupabaseUrl: baseUrl,
    });
    _jwtValidationConfigLogged = true;
  }

  return config;
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Verifies a Supabase JWT locally using the cached JWKS.
 *
 * @param token - Raw Bearer token string (without "Bearer " prefix)
 * @returns `{ userId, email }` extracted from verified claims
 * @throws `Error` if the token is invalid, expired, or has an unknown `kid`
 *
 * Key rotation behaviour:
 *   jose's `createRemoteJWKSet` retries once with a fresh JWKS fetch when
 *   the `kid` in the token header is not found in the cached key set.
 *   No additional handling is required here.
 */
export async function verifyJwt(token: string): Promise<VerifiedUser> {
  const jwks = await getJwks();
  const { jwtVerify } = await getJoseModule();
  const config = getJwtValidationConfig();

  const { payload } = await jwtVerify<SupabaseJwtPayload>(token, jwks, {
    // Supabase can issue RS256 or ES256 depending on project config
    algorithms: ["RS256", "ES256"],
    // Validate issuer(s) to prevent cross-tenant token acceptance.
    issuer: config.issuers.length === 1 ? config.issuers[0] : config.issuers,
    // Supabase user tokens typically use aud="authenticated".
    audience:
      config.audiences.length === 1 ? config.audiences[0] : config.audiences,
    // Small skew tolerance helps avoid false "expired" on slight clock drift.
    clockTolerance: config.clockToleranceSeconds,
  });

  const userId = payload.sub;
  const email = payload.email;

  if (!userId) {
    throw new Error("JWT is missing `sub` claim");
  }
  if (!email) {
    throw new Error("JWT is missing `email` claim");
  }

  return { userId, email };
}