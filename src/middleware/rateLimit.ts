/**
 * In-memory rate limiting middleware using express-rate-limit.
 *
 * On Vercel serverless each function instance is separate, so in-memory
 * limiting is per-instance rather than global — acceptable for MVP.
 * Upgrade to a shared store (e.g. @upstash/ratelimit) if precise global
 * limits are needed at scale.
 */

import { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { AuthenticatedRequest } from "../types";

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(",")[0]
      .trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}

const rateLimitHandler = (_req: Request, res: Response) => {
  res.status(429).json({
    error: "Too many requests — please try again later.",
  });
};

export const oauthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const webhookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const workflowActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

// checkWorkerRateLimit was only used inside BullMQ workers (no longer needed).
export async function checkWorkerRateLimit(_opts: {
  bucketName: string;
  identifier: string;
  maxRequests: number;
  windowMs: number;
}): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  return { allowed: true };
}
