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
  getDevices,
  search,
} from "../services/spotify/spotify.service";
import { oauthRateLimit } from "../middleware/rateLimit";
import { appRedirect } from "../services/integrations/oauthAppRedirect";

const router = Router();

// ─── Public Spotify OAuth callback (NO authMiddleware) ─────────────────────────
// Spotify redirects the browser here after consent — there is no JWT on this
// request, so the user is resolved from the single-use `state` token. Must be
// registered before router.use(authMiddleware) so it stays unauthenticated.
router.get("/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("spotify", "error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("spotify", "error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("spotify", "error", "invalid_state"));

    await exchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("spotify", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("spotify", "error", detail));
  }
});

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

router.get("/devices", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    res.json({ devices: await getDevices(user.id) });
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
    const type = String(req.query.type ?? "track,album,playlist");
    res.json(await search(user.id, q, type));
  } catch (err) {
    next(err);
  }
});

export default router;
