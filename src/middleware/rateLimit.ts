/**
 * Most rate limits use in-memory express-rate-limit state.
 *
 * On Vercel each function instance is separate. The public marketing form is
 * the exception: its IP throttle uses shared PostgreSQL state and keyed hashes.
 */

import { createHmac } from "node:crypto";
import { Request, Response, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { AuthenticatedRequest } from "../types";
import { query } from "../config/db";
import { normalizeClientIp } from "./client-ip";

function getClientIp(req: Request): string {
  // Vercel overwrites these headers with the platform-observed client address.
  // On other deployments ignore forwarded headers unless a trusted-proxy policy is configured.
  if (process.env.VERCEL === "1") {
    const forwarded = req.headers["x-vercel-forwarded-for"] ?? req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    const trusted = normalizeClientIp(first);
    if (trusted) return trusted;
  }
  return normalizeClientIp(req.ip ?? req.socket.remoteAddress) ?? "unknown";
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

const MARKETING_FORM_RATE_LIMIT = 12;
const MARKETING_FORM_WINDOW_SECONDS = 5 * 60;

export function marketingFormRateLimitWindowExpiresAt(startedAtSeconds: number): number {
  return startedAtSeconds + MARKETING_FORM_WINDOW_SECONDS;
}

function marketingFormRateLimitFingerprint(ip: string): string {
  const secret = process.env.ACTION_SIGNING_SECRET ?? process.env.EMAIL_VERIFICATION_TOKEN_SECRET;
  if (!secret) throw new Error("A configured signing secret is required for public form rate limiting.");
  return createHmac("sha256", secret).update(`marketing-form-ip:${ip}`).digest("hex");
}

/** Shared, privacy-preserving public intake limit; the raw client IP is never stored. */
export const marketingInboundFormRateLimit: RequestHandler = async (req, res, next) => {
  try {
    const result = await query<{ request_count: number; window_started_epoch: number | string }>(
      `WITH stale_rows AS (
         DELETE FROM sales_marketing_form_rate_limits
          WHERE updated_at < now() - interval '24 hours'
         RETURNING ip_fingerprint
       )
       INSERT INTO sales_marketing_form_rate_limits (ip_fingerprint,bucket_started_at,request_count,updated_at)
       VALUES ($1,now(),1,now())
       ON CONFLICT (ip_fingerprint) DO UPDATE SET
         request_count=CASE
           WHEN sales_marketing_form_rate_limits.bucket_started_at <= now() - interval '5 minutes' THEN 1
           ELSE LEAST(sales_marketing_form_rate_limits.request_count + 1, $2)
         END,
         bucket_started_at=CASE
           WHEN sales_marketing_form_rate_limits.bucket_started_at <= now() - interval '5 minutes' THEN now()
           ELSE sales_marketing_form_rate_limits.bucket_started_at
         END,
         updated_at=now()
       RETURNING request_count,EXTRACT(EPOCH FROM bucket_started_at)::bigint AS window_started_epoch`,
      [marketingFormRateLimitFingerprint(getClientIp(req)), MARKETING_FORM_RATE_LIMIT + 1],
    );
    const count = Number(result.rows[0]?.request_count ?? MARKETING_FORM_RATE_LIMIT + 1);
    const windowStartedAt = Number(result.rows[0]?.window_started_epoch ?? Math.floor(Date.now() / 1000));
    const resetAt = marketingFormRateLimitWindowExpiresAt(windowStartedAt);
    res.setHeader("RateLimit-Limit", String(MARKETING_FORM_RATE_LIMIT));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, MARKETING_FORM_RATE_LIMIT - count)));
    res.setHeader("RateLimit-Reset", String(Math.max(0, resetAt - Math.floor(Date.now() / 1000))));
    if (count > MARKETING_FORM_RATE_LIMIT) {
      res.status(429).json({ error: "Too many requests — please try again later." });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};

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

export const marketingResearchRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

export const marketingAnalyticsRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

export const marketingAnalyticsTargetsRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

export const marketingPublishRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

export const marketingPostStatusRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

export const marketingTodoistSyncRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const authed = req as AuthenticatedRequest;
    return authed.user?.id ?? getClientIp(req);
  },
  handler: rateLimitHandler,
});

export const marketingCrmSyncRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many CRM sync requests. Wait before checking HubSpot again." },
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
