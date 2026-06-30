/** /api/v1/spotify — Spotify Web API proxy */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import {
  buildAuthUrl,
  exchangeCode,
  getNowPlaying,
  resumePlayback,
  pausePlayback,
  skipToNext,
  skipToPrevious,
  playContext,
  playTrack,
  getUserPlaylists,
  search,
} from "../services/spotify/spotify.service";

const router = Router();
router.use(authMiddleware as never);

// ─── OAuth ────────────────────────────────────────────────────────────────────

router.get("/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "spotify");
    res.json({ url: buildAuthUrl(state) });
  } catch (err) {
    next(err);
  }
});

router.post("/auth/callback", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.body ?? {});
    const payload = await consumeOAuthState(state);
    if (!payload) throw new BadRequestError("Invalid or expired OAuth state.");
    await exchangeCode(payload.userId, code);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Player ───────────────────────────────────────────────────────────────────

router.get("/now-playing", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const nowPlaying = await getNowPlaying(user.id);
    res.json({ nowPlaying });
  } catch (err) {
    next(err);
  }
});

router.post("/play", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const { contextUri, trackUri } = z.object({
      contextUri: z.string().optional(),
      trackUri: z.string().optional(),
    }).parse(req.body ?? {});
    if (contextUri) await playContext(user.id, contextUri);
    else if (trackUri) await playTrack(user.id, trackUri);
    else await resumePlayback(user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/pause", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await pausePlayback((req as AuthenticatedRequest).user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/skip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await skipToNext((req as AuthenticatedRequest).user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post("/previous", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await skipToPrevious((req as AuthenticatedRequest).user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Library ─────────────────────────────────────────────────────────────────

router.get("/playlists", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ playlists: await getUserPlaylists(user.id) });
  } catch (err) {
    next(err);
  }
});

router.get("/search", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const q = String(req.query.q ?? "").trim();
    if (!q) throw new BadRequestError("q is required.");
    const type = String(req.query.type ?? "track,playlist");
    res.json(await search(user.id, q, type));
  } catch (err) {
    next(err);
  }
});

export default router;
