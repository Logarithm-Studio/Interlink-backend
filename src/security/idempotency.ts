/**
 * Idempotency primitives for replay protection and durable side-effect dedupe.
 *
 * Two-layer strategy (per plan §9):
 *   1. Redis short-window dedupe  — coalesces webhook bursts and rapid retries
 *      within a rolling TTL window (key expires, allow again).
 *   2. DB durable dedupe         — audit_log UNIQUE (action, idempotency_key)
 *      prevents the same side effect from being recorded twice, permanently.
 */

import { Request, Response, NextFunction } from "express";
import { getRedis } from "../config/redis";
import { query } from "../config/db";

// ─── Redis short-window dedupe ────────────────────────────────────────────────

/**
 * Attempt to claim `key` in Redis using SET NX (set if not exists).
 *
 * Returns `true` if the key already existed (i.e. this is a duplicate).
 * Returns `false` if the key was newly set (i.e. this is the first time we've
 * seen it within the TTL window).
 *
 * @param key       Unique string identifying the operation.
 * @param ttlSeconds  How long to hold the key.  Must be ≥ max retry window.
 *                    Webhook: 48 h (172_800 s) covers Google's 24 h retry window.
 */
export async function isDuplicate(
  key: string,
  ttlSeconds: number,
): Promise<boolean> {
  // SET key 1 NX EX ttl — returns "OK" if set, null if key existed
  const result = await getRedis().set(key, "1", { ex: ttlSeconds, nx: true });
  return result === null; // null → key already existed → duplicate
}

// ─── Webhook dedupe key helpers ───────────────────────────────────────────────

/**
 * Builds a deterministic Redis dedupe key for a Google Calendar webhook
 * notification.  Includes channelId + resourceId + messageNumber so that
 * Google retries (identical headers) produce the same key and are rejected,
 * while genuinely new notifications (new messageNumber) get through.
 */
export function buildWebhookDedupeKey(
  channelId: string,
  resourceId: string,
  messageNumber: string,
): string {
  return `webhook:google:${channelId}:${resourceId}:${messageNumber}`;
}

/**
 * Builds a deterministic idempotency key for a worker effect.
 * e.g. "effect:google.sync:channelId:syncTokenHash"
 */
export function buildEffectKey(...parts: string[]): string {
  return `effect:${parts.join(":")}`;
}

// ─── DB durable dedupe (audit_log) ───────────────────────────────────────────

export interface AuditLogEntry {
  userId?: string | null;
  actorType: "api" | "worker" | "system";
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  idempotencyKey?: string | null;
  requestId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Insert a row into `audit_log`.
 *
 * If `idempotencyKey` is provided the row is written under the table's
 * UNIQUE (action, idempotency_key) constraint.  A conflict means the same
 * side effect was already recorded; the insert is silently skipped via
 * ON CONFLICT DO NOTHING, returning `false`.
 *
 * Returns `true` if the row was inserted (first time), `false` if it
 * was a duplicate (already recorded).
 */
export async function recordAuditLog(entry: AuditLogEntry): Promise<boolean> {
  const result = await query(
    `INSERT INTO audit_log
       (user_id, actor_type, action, entity_type, entity_id,
        idempotency_key, request_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (action, idempotency_key)
       WHERE idempotency_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      entry.userId ?? null,
      entry.actorType,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      entry.idempotencyKey ?? null,
      entry.requestId ?? null,
      JSON.stringify(entry.payload ?? {}),
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─── Express middleware: require Idempotency-Key header ───────────────────────

/**
 * Express middleware that rejects mutating requests lacking an
 * `Idempotency-Key` header.  Attach this to routes as they are introduced.
 *
 * Usage:
 *   router.post("/some-mutation", requireIdempotencyKey, authMiddleware, handler)
 *
 * The parsed key is available on `req.idempotencyKey` after this middleware.
 */
export function requireIdempotencyKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = req.headers["idempotency-key"] as string | undefined;
  if (!key || key.trim() === "") {
    res.status(400).json({
      error: "Missing required header: Idempotency-Key",
    });
    return;
  }
  // Attach for downstream use (cast via type augmentation below)
  (req as Request & { idempotencyKey: string }).idempotencyKey = key.trim();
  next();
}
