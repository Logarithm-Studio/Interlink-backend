/**
 * User preferences routes.
 *
 * Endpoints for managing per-user scheduling preferences such as buffer
 * minutes for conflict detection, notification preferences, and AI email
 * tone preference.
 *
 * Routes:
 *   GET  /api/v1/preferences     — Read current preferences
 *   PUT  /api/v1/preferences     — Update preferences (partial merge)
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { query } from "../config/db";
import { BadRequestError } from "../utils/errors";

const router = Router();

// All routes require authentication
router.use(authMiddleware as never);

// ─── Schemas ────────────────────────────────────────────────────────

const UpdatePreferencesSchema = z.object({
  defaultBufferMinutes: z.number().int().min(0).max(120).optional(),
  tonePreference: z
    .enum(["professional", "friendly", "concise", "formal"])
    .optional(),
  notifyVia: z.enum(["push", "email", "both"]).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

// ─── GET /api/v1/preferences ────────────────────────────────────────
// Returns current user preferences. Creates a default row if none exists.
router.get("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;

    // Upsert a default row so we always return valid preferences.
    const result = await query<{
      user_id: string;
      default_buffer_minutes: number;
      tone_preference: string;
      notify_via: string;
      timezone: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `INSERT INTO user_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING *;`,
      [user.id],
    );

    // If DO NOTHING fired (row existed), fetch it.
    let row = result.rows[0];
    if (!row) {
      const existing = await query<typeof row>(
        `SELECT * FROM user_preferences WHERE user_id = $1`,
        [user.id],
      );
      row = existing.rows[0];
    }

    res.json({
      preferences: {
        defaultBufferMinutes: row.default_buffer_minutes,
        tonePreference: row.tone_preference,
        notifyVia: row.notify_via,
        timezone: row.timezone,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PUT /api/v1/preferences ────────────────────────────────────────
// Partial update — only provided fields are changed.
router.put("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parseResult = UpdatePreferencesSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(
        parseResult.error.issues.map((i) => i.message).join(", "),
      );
    }

    const data = parseResult.data;
    if (Object.keys(data).length === 0) {
      throw new BadRequestError("No fields to update");
    }

    // Build dynamic SET clause for provided fields only.
    const setClauses: string[] = [];
    const params: unknown[] = [user.id];
    let idx = 2;

    if (data.defaultBufferMinutes !== undefined) {
      setClauses.push(`default_buffer_minutes = $${idx++}`);
      params.push(data.defaultBufferMinutes);
    }
    if (data.tonePreference !== undefined) {
      setClauses.push(`tone_preference = $${idx++}`);
      params.push(data.tonePreference);
    }
    if (data.notifyVia !== undefined) {
      setClauses.push(`notify_via = $${idx++}`);
      params.push(data.notifyVia);
    }
    if (data.timezone !== undefined) {
      setClauses.push(`timezone = $${idx++}`);
      params.push(data.timezone);
    }

    setClauses.push("updated_at = now()");

    const result = await query<{
      default_buffer_minutes: number;
      tone_preference: string;
      notify_via: string;
      timezone: string | null;
      updated_at: Date;
    }>(
      `INSERT INTO user_preferences (user_id)
       VALUES ($1)
       ON CONFLICT (user_id)
       DO UPDATE SET ${setClauses.join(", ")}
       RETURNING default_buffer_minutes, tone_preference, notify_via, timezone, updated_at`,
      params,
    );

    const row = result.rows[0];

    res.json({
      message: "Preferences updated",
      preferences: {
        defaultBufferMinutes: row.default_buffer_minutes,
        tonePreference: row.tone_preference,
        notifyVia: row.notify_via,
        timezone: row.timezone,
        updatedAt: row.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
