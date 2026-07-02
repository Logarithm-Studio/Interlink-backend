/** /api/v1/pm — Product Manager Agent (Trello + GitHub + Gemini) */

import { Router, Request, Response, NextFunction } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth";
import { AuthenticatedRequest } from "../types";
import { BadRequestError } from "../utils/errors";
import { oauthRateLimit } from "../middleware/rateLimit";
import { createOAuthState, consumeOAuthState } from "../services/oauth-state.service";
import { appRedirect } from "../services/integrations/oauthAppRedirect";
import { buildAuthUrl as buildTrelloUrl, storeToken, getBoards, getListsForBoard, createCard, updateCard, getCardsForBoard } from "../services/pm/trello.service";
import { buildAuthUrl as buildGitHubUrl, exchangeCode as ghExchangeCode, getRepos, getPullRequests, getIssues, createIssue } from "../services/pm/github.service";
import { generateStandupSummary, planSprint, getTrelloBoardSummary } from "../services/pm/pm-workflows.service";
import { getProjects as getJiraProjects } from "../services/jira/jira.service";
import { searchPages as searchNotionPages } from "../services/notion/notion.service";
import { getChannels as getSlackChannels } from "../services/slack/slack.service";
import { pmConnections } from "../services/professional/pm/pm-integrations";
import { pmVertical } from "../services/professional/pm/pm.vertical";

const router = Router();

// ─── Public GitHub OAuth callback (NO authMiddleware) ──────────────────────────
// GitHub redirects the browser here after consent — there is no JWT on this
// request, so the user is resolved from the single-use `state` token. Must be
// registered before router.use(authMiddleware) so it stays unauthenticated.
router.get("/github/callback", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const error = req.query.error ? String(req.query.error) : undefined;
    if (error) return res.redirect(302, appRedirect("github", "error", error));

    const code = req.query.code ? String(req.query.code) : "";
    const state = req.query.state ? String(req.query.state) : "";
    if (!code || !state) return res.redirect(302, appRedirect("github", "error", "missing_code_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("github", "error", "invalid_state"));

    await ghExchangeCode(payload.userId, code);
    return res.redirect(302, appRedirect("github", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "exchange_failed";
    return res.redirect(302, appRedirect("github", "error", detail));
  }
});

// ─── Public Trello OAuth bridge + store (NO authMiddleware) ────────────────────
// Trello's token flow returns the token in the URL fragment, which never reaches
// the server. This page runs a tiny inline script (allowed via a per-response
// CSP nonce, since helmet's default CSP blocks inline scripts) that reads the
// fragment token and forwards it to /trello/store with the state from the query.
router.get("/trello/callback", oauthRateLimit, (req: Request, res: Response) => {
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const nonce = randomBytes(16).toString("base64");
  res.set(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  );
  res.set("Content-Type", "text/html; charset=utf-8").send(
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Connecting Trello…</title></head>` +
      `<body style="font-family:sans-serif;text-align:center;padding-top:48px;color:#555">` +
      `<p>Finishing Trello connection…</p>` +
      `<script nonce="${nonce}">(function(){` +
      `var err="interlinkapp://oauth/trello?provider=trello&status=error&detail=";` +
      `try{` +
      `var m=(window.location.hash||"").match(/token=([^&]+)/);` +
      `var token=m?decodeURIComponent(m[1]):"";` +
      `var state=${JSON.stringify(state)};` +
      `if(!token){window.location.replace(err+"missing_token");return;}` +
      `window.location.replace("/api/v1/pm/trello/store?state="+encodeURIComponent(state)+"&token="+encodeURIComponent(token));` +
      `}catch(e){window.location.replace(err+"bridge_error");}` +
      `})();</script></body></html>`,
  );
});

router.get("/trello/store", oauthRateLimit, async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    if (!token || !state) return res.redirect(302, appRedirect("trello", "error", "missing_token_or_state"));

    const payload = await consumeOAuthState(state);
    if (!payload) return res.redirect(302, appRedirect("trello", "error", "invalid_state"));

    await storeToken(payload.userId, token);
    return res.redirect(302, appRedirect("trello", "success"));
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 80) : "store_failed";
    return res.redirect(302, appRedirect("trello", "error", detail));
  }
});

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

// ─── Dashboard (bespoke PM workspace) ──────────────────────────────────────────

// Connection status + light data to populate the dashboard + workflow pickers.
router.get("/overview", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as AuthenticatedRequest).user.id;
    const connections = await pmConnections(userId);
    const [repos, jiraProjects] = await Promise.all([
      connections.github ? getRepos(userId).catch(() => []) : Promise.resolve([]),
      connections.jira ? getJiraProjects(userId).catch(() => []) : Promise.resolve([]),
    ]);
    res.json({
      connections,
      repos: repos.map((r) => ({ fullName: r.fullName, openIssues: r.openIssues })),
      jiraProjects: jiraProjects.map((p) => ({ key: p.key, name: p.name })),
    });
  } catch (err) { next(err); }
});

router.get("/jira/projects", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ projects: await getJiraProjects((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

router.get("/notion/prd-pages", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    res.json({ pages: await searchNotionPages((req as AuthenticatedRequest).user.id, q) });
  } catch (err) { next(err); }
});

router.get("/slack/channels", async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ channels: await getSlackChannels((req as AuthenticatedRequest).user.id) });
  } catch (err) { next(err); }
});

// Run one of the PM PRD workflows. Delegates to the vertical so logic lives in one place.
const PM_WORKFLOWS = new Set(["prd_to_tickets", "sprint_interruption", "release_notes", "status_sync", "scope_creep_check"]);
const WorkflowBody = z.record(z.unknown());
router.post("/workflows/:name", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = (req as AuthenticatedRequest).user;
    const name = req.params.name;
    if (!PM_WORKFLOWS.has(name)) throw new BadRequestError("Unknown PM workflow.");
    const args = WorkflowBody.parse(req.body ?? {});
    res.json(await pmVertical.executeTool(user, name, args as Record<string, unknown>));
  } catch (err) { next(err); }
});

export default router;
