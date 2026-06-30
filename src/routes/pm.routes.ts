/** /api/v1/pm — Product Manager Agent (Trello + GitHub + Gemini) */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import { buildAuthUrl as buildTrelloUrl, storeToken, getBoards, getListsForBoard, createCard, updateCard, getCardsForBoard } from "../services/pm/trello.service";
import { buildAuthUrl as buildGitHubUrl, exchangeCode as ghExchangeCode, getRepos, getPullRequests, getIssues, createIssue } from "../services/pm/github.service";
import { generateStandupSummary, planSprint, getTrelloBoardSummary } from "../services/pm/pm-workflows.service";

const router = Router();
router.use(authMiddleware as never);

// ─── Trello OAuth ─────────────────────────────────────────────────────────────

router.get("/trello/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "trello");
    res.json({ url: buildTrelloUrl(state) });
  } catch (err) {
    next(err);
  }
});

const TrelloCallbackBody = z.object({ token: z.string(), state: z.string() });
router.post("/trello/callback", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, state } = TrelloCallbackBody.parse(req.body ?? {});
    const payload = await consumeOAuthState(state);
    if (!payload) throw new BadRequestError("Invalid or expired OAuth state.");
    await storeToken(payload.userId, token);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── GitHub OAuth ─────────────────────────────────────────────────────────────

router.get("/github/auth/url", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const state = await createOAuthState(user.id, "github");
    res.json({ url: buildGitHubUrl(state) });
  } catch (err) {
    next(err);
  }
});

const GHCallbackBody = z.object({ code: z.string(), state: z.string() });
router.post("/github/callback", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code, state } = GHCallbackBody.parse(req.body ?? {});
    const payload = await consumeOAuthState(state);
    if (!payload) throw new BadRequestError("Invalid or expired OAuth state.");
    await ghExchangeCode(payload.userId, code);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Trello ───────────────────────────────────────────────────────────────────

router.get("/boards", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ boards: await getBoards((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

router.get("/boards/:id/lists", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ lists: await getListsForBoard((req as AuthenticatedRequest).user.id, req.params.id) });
  } catch (err) { next(err); }
});

router.get("/boards/:id/cards", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ cards: await getCardsForBoard((req as AuthenticatedRequest).user.id, req.params.id) });
  } catch (err) { next(err); }
});

const CreateCardBody = z.object({ listId: z.string(), name: z.string().min(1), desc: z.string().optional(), due: z.string().optional() });
router.post("/cards", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateCardBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("listId and name are required.");
    res.status(201).json({ card: await createCard(user.id, parsed.data.listId, parsed.data) });
  } catch (err) { next(err); }
});

const UpdateCardBody = z.object({ name: z.string().optional(), desc: z.string().optional(), due: z.string().optional(), dueComplete: z.boolean().optional() });
router.put("/cards/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = UpdateCardBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("Invalid patch body.");
    await updateCard(user.id, req.params.id, parsed.data);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── GitHub ───────────────────────────────────────────────────────────────────

router.get("/repos", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ repos: await getRepos((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

router.get("/repos/:owner/:repo/pulls", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ pulls: await getPullRequests((req as AuthenticatedRequest).user.id, req.params.owner, req.params.repo) });
  } catch (err) { next(err); }
});

router.get("/repos/:owner/:repo/issues", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ issues: await getIssues((req as AuthenticatedRequest).user.id, req.params.owner, req.params.repo) });
  } catch (err) { next(err); }
});

const CreateIssueBody = z.object({ title: z.string().min(1), body: z.string().optional(), labels: z.array(z.string()).optional() });
router.post("/repos/:owner/:repo/issues", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const parsed = CreateIssueBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new BadRequestError("title is required.");
    res.status(201).json({ issue: await createIssue(user.id, req.params.owner, req.params.repo, parsed.data) });
  } catch (err) { next(err); }
});

// ─── Workflows ────────────────────────────────────────────────────────────────

router.get("/standup/:owner/:repo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await generateStandupSummary((req as AuthenticatedRequest).user.id, req.params.owner, req.params.repo));
  } catch (err) { next(err); }
});

router.get("/sprint-plan/:owner/:repo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await planSprint((req as AuthenticatedRequest).user.id, req.params.owner, req.params.repo));
  } catch (err) { next(err); }
});

router.get("/trello-summary", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ boards: await getTrelloBoardSummary((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

export default router;
