/**
 * Request ID middleware.
 *
 * For every incoming request:
 * 1. Reads `X-Request-ID` header (set by load balancer / gateway) or generates
 *    a new UUID v4.
 * 2. Attaches `requestId` to `req` for downstream handlers.
 * 3. Creates a child logger with `{ requestId, method, path }` bound and
 *    attaches it as `req.log`.
 * 4. Sets `X-Request-ID` on the response so clients can correlate logs.
 * 5. Logs every request and its final status/duration at INFO level.
 *
 * This middleware must be registered BEFORE any route handlers.
 *
 * Type augmentation:
 *   `req.requestId` and `req.log` are available on every Express Request after
 *   this middleware runs.  The global Express namespace is augmented below so
 *   TypeScript knows about these properties without extra imports.
 */

import { randomUUID } from "crypto";
import { Request, Response, NextFunction } from "express";
import { logger, Logger } from "../observability/logger";

// ─── Global type augmentation ─────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** UUID identifying this request; propagated to workers via job payloads. */
      requestId: string;
      /** Child logger pre-bound with requestId, method, and path. */
      log: Logger;
    }
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Attaches `req.requestId` and `req.log`, echoes the request ID in the
 * response, and logs each request + response pair.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId =
    (req.headers["x-request-id"] as string | undefined)?.trim() || randomUUID();

  req.requestId = requestId;
  req.log = logger.child({
    requestId,
    method: req.method,
    path: req.path,
  });

  // Propagate requestId to the response so clients/proxies can correlate.
  res.setHeader("X-Request-ID", requestId);

  const startMs = Date.now();

  req.log.info("Request received");

  res.on("finish", () => {
    const duration = Date.now() - startMs;
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    req.log[level]("Request completed", {
      status: res.statusCode,
      durationMs: duration,
    });
  });

  next();
}
