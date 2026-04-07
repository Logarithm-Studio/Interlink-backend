/**
 * Push token registration routes.
 *
 * Clients must register their FCM / web-push device tokens so that the
 * notification engine can deliver push notifications.
 *
 * Routes:
 *   POST   /api/v1/push-tokens          — Register a device token
 *   GET    /api/v1/push-tokens          — List tokens for the authenticated user
 *   DELETE /api/v1/push-tokens/:id      — Remove a specific device token
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { query } from "../config/db";
import { BadRequestError, NotFoundError } from "../utils/errors";

const router = Router();

// All routes require authentication
router.use(authMiddleware as never);

// ─── Request schemas ────────────────────────────────────────────────

const RegisterTokenSchema = z.object({
  token: z.string().min(1, "token is required"),
  platform: z.enum(["ios", "android", "web"]).default("web"),
});

// ─── POST /api/v1/push-tokens ───────────────────────────────────────
// Register (or refresh) a device push token for the current user.
// Idempotent: if the (user_id, token) pair already exists, update the
// platform and updated_at timestamp.
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parseResult = RegisterTokenSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(
        parseResult.error.issues.map((i) => i.message).join(", "),
      );
    }

    const { token, platform } = parseResult.data;

    const result = await query<{ id: string }>(
      `INSERT INTO push_tokens (user_id, token, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, token)
       DO UPDATE SET platform = EXCLUDED.platform, updated_at = now()
       RETURNING id`,
      [user.id, token, platform],
    );

    res.status(201).json({
      message: "Push token registered",
      id: result.rows[0].id,
      platform,
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/v1/push-tokens ────────────────────────────────────────
// List all registered push tokens for the current user.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;

    const result = await query<{
      id: string;
      token: string;
      platform: string;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, token, platform, created_at, updated_at
       FROM push_tokens
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [user.id],
    );

    res.json({
      tokens: result.rows.map((r) => ({
        id: r.id,
        token: r.token,
        platform: r.platform,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      count: result.rows.length,
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/v1/push-tokens/:id ─────────────────────────────────
// Remove a specific push token. Only the owning user can delete.
router.delete(
  "/:id",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as AuthenticatedRequest).user;

      const result = await query(
        `DELETE FROM push_tokens WHERE id = $1 AND user_id = $2`,
        [req.params.id, user.id],
      );

      if ((result.rowCount ?? 0) === 0) {
        throw new NotFoundError("Push token");
      }

      res.json({ message: "Push token removed" });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
