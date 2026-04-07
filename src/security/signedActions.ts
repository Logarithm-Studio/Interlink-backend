/**
 * Signed action tokens for workflow resume deep links.
 *
 * Token format: `<base64url-payload>.<hmac-sha256-hex>`
 *
 * Payload (JSON):
 * ```json
 * { "executionId": "uuid", "stepId": "string", "actionKey": "string",
 *   "exp": 1234567890, "nonce": "hex-16-bytes" }
 * ```
 *
 * Security properties:
 * - HMAC-SHA256 with `ACTION_SIGNING_SECRET` — forged tokens are rejected.
 * - Expiry (`exp`) — stale tokens are rejected.
 * - Single-use nonce stored in Redis via `SET NX` — replay attacks are blocked.
 *
 * Signing secret: `ACTION_SIGNING_SECRET` env var (64 hex chars / 32 bytes).
 * Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { isDuplicate } from "./idempotency";

// ─── Payload type ─────────────────────────────────────────────────────────────

export interface ActionTokenPayload {
  executionId: string;
  stepId: string;
  actionKey: string;
  /** Unix timestamp (seconds) after which the token is invalid. */
  exp: number;
  /** Random hex string consumed as a single-use nonce. */
  nonce: string;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function getSecret(): string {
  const s = process.env.ACTION_SIGNING_SECRET;
  if (!s) {
    throw new Error(
      "ACTION_SIGNING_SECRET environment variable is not set. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return s;
}

function computeHmac(data: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(data)
    .digest("hex");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Sign an action token.
 *
 * @param input      The logical payload fields (without `exp` and `nonce`).
 * @param ttlSeconds How long until the token expires (default: 24 h).
 * @returns Opaque token string safe to embed in deep links or notification payloads.
 */
export function signActionToken(
  input: Pick<ActionTokenPayload, "executionId" | "stepId" | "actionKey">,
  ttlSeconds = 86_400,
): string {
  const nonce = randomBytes(16).toString("hex");
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;

  const payload: ActionTokenPayload = { ...input, exp, nonce };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = computeHmac(encoded, getSecret());

  return `${encoded}.${sig}`;
}

/**
 * Verify an action token.
 *
 * Throws `TokenError` if:
 * - The token is malformed.
 * - The HMAC signature does not match.
 * - The token has expired.
 * - The nonce has already been consumed (replay attack).
 *
 * On success, marks the nonce as consumed in Redis and returns the payload.
 */
export async function verifyActionToken(
  token: string,
): Promise<ActionTokenPayload> {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex < 1) {
    throw new TokenError("Malformed action token");
  }

  const encoded = token.slice(0, dotIndex);
  const providedSig = token.slice(dotIndex + 1);

  // ── 1. Signature verification (constant-time) ────────────────────────────
  const expectedSig = computeHmac(encoded, getSecret());
  const expectedBuf = Buffer.from(expectedSig, "hex");
  const providedBuf = Buffer.from(providedSig, "hex");

  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new TokenError("Invalid action token signature");
  }

  // ── 2. Decode payload ────────────────────────────────────────────────────
  let payload: ActionTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf-8"),
    ) as ActionTokenPayload;
  } catch {
    throw new TokenError("Action token payload is not valid JSON");
  }

  // ── 3. Expiry check ───────────────────────────────────────────────────────
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    throw new TokenError("Action token has expired");
  }

  // ── 4. Single-use nonce (replay protection) ───────────────────────────────
  const remaining = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
  const ttlSeconds = remaining + 300; // 5-minute grace after expiry for clock skew
  const nonceKey = `action:nonce:${payload.nonce}`;

  const alreadyUsed = await isDuplicate(nonceKey, ttlSeconds);
  if (alreadyUsed) {
    throw new TokenError("Action token has already been used");
  }

  return payload;
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class TokenError extends Error {
  readonly isTokenError = true as const;
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}
