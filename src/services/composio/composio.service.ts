/**
 * Composio — brokered access to the long tail of third-party apps.
 *
 * WHY THIS EXISTS. Every native integration in this repo (Google, Slack, Notion, Jira,
 * GitHub, Trello, Todoist, Spotify, Microsoft) costs an OAuth app registration, a
 * client id/secret, a review process, and a bespoke service module. That per-vendor
 * setup tax is why the PRD's remaining ~25 vendors (HubSpot, Salesforce, Stripe,
 * Zendesk, Zoom, Linear, Asana, Calendly, Greenhouse, DocuSign…) were never wired.
 * Composio owns the OAuth apps, so `toolkits.authorize(userId, slug)` returns a ready
 * consent URL with no credentials of ours involved.
 *
 * SCOPE — this is ADDITIVE. The native integrations above are untouched: they are
 * deeper than a generic connector (Slack DM name-resolution, per-mode Gmail accounts,
 * event-scoped decline sends) and they cost zero metered Composio calls. Composio is a
 * second tool source layered onto the same agent loop, never a replacement.
 *
 * DEGRADATION — with no COMPOSIO_API_KEY every function here returns empty/not-connected
 * and the assistant behaves exactly as it did before. Same contract as rentcast.service.ts.
 *
 * COST — Composio meters tool executions (20k/mo free, then paid). Only `executeTool`
 * and the connection/tool-schema reads hit their API; native tools stay free.
 */

import type { Composio } from "@composio/core";
import { query } from "../../config/db";
import { AppError } from "../../utils/errors";
import { logger } from "../../observability/logger";
import type { GeminiToolFunction } from "../ai/geminiClient";
import type { ExecuteResult } from "../personal-assistant/personal-assistant.service";

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * `@composio/core` is ESM-only ("type": "module", and its only export is
 * dist/index.mjs — there is no CommonJS build). Under our `module: commonjs`
 * tsconfig a static `import { Composio }` compiles down to `require()`, which
 * throws ERR_REQUIRE_ESM on Vercel's Node runtime and kills the entire
 * serverless function at cold start — every route 500s, not just Composio ones.
 *
 * So: import the type only (erased at compile time, emits no require) and pull
 * the runtime value in through a real dynamic `import()`. The `new Function`
 * wrapper is load-bearing — TypeScript would otherwise downlevel a plain
 * `await import()` back into the same `require()` we are trying to avoid.
 */
const importESM = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

/**
 * DEPENDENCY-TRACE ANCHOR (do not delete).
 *
 * Vercel bundles the serverless function by statically tracing dependencies with
 * `@vercel/nft`. The `new Function("import(...)")` above is opaque to that tracer, so nft
 * never sees `@composio/core` and OMITS it from the deployment — the runtime then throws
 * `Cannot find package '@composio/core'` (a different failure from the earlier
 * ERR_REQUIRE_ESM, but same root: a hidden import).
 *
 * `require.resolve` gives nft a plain string literal it DOES follow, so the package and its
 * transitive deps get bundled. Crucially, `resolve` only computes the file path — it never
 * evaluates the module — so it does NOT reintroduce the ERR_REQUIRE_ESM that a real
 * `require()` of this ESM-only package would. Guarded + swallowed so a missing package can
 * never crash boot (Composio just stays disabled).
 */
try {
  require.resolve("@composio/core");
} catch {
  /* not installed in this environment — fine, Composio stays disabled */
}

type ComposioModule = {
  Composio: new (opts: { apiKey: string }) => Composio;
};

let clientPromise: Promise<Composio> | null = null;

export function isComposioLive(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY);
}

async function getClient(): Promise<Composio | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      const mod = (await importESM("@composio/core")) as ComposioModule;
      return new mod.Composio({ apiKey });
    })();
    // Don't cache a rejected import — a transient failure would otherwise wedge
    // Composio off for the lifetime of the warm lambda.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

/**
 * The shared Composio client (null when COMPOSIO_API_KEY is unset), for sibling modules
 * like composioTriggers.service.ts that need the same lazily-imported ESM instance.
 */
export async function getComposioClient(): Promise<Composio | null> {
  return getClient();
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

export interface ToolkitMeta {
  slug: string;
  name: string;
  description: string;
  /** "professional" surfaces it to the work personas; "personal" to the life assistant. */
  audience: "professional" | "personal";
}

/**
 * The curated catalog we surface in the app. Composio has 1,000+ toolkits; these are the
 * ones that map onto concrete PRD gaps, so the connect screen stays a product decision
 * rather than an undifferentiated directory dump.
 */
export const COMPOSIO_CATALOG: ToolkitMeta[] = [
  // Professional — closes the persona vendor gaps logged in PRODUCT-VISION-AND-STATUS.md.
  { slug: "hubspot", name: "HubSpot", description: "CRM contacts, deals, and pipelines", audience: "professional" },
  { slug: "salesforce", name: "Salesforce", description: "Enterprise CRM records and opportunities", audience: "professional" },
  { slug: "zendesk", name: "Zendesk", description: "Support tickets and customer conversations", audience: "professional" },
  { slug: "intercom", name: "Intercom", description: "Customer messaging and support inbox", audience: "professional" },
  { slug: "stripe", name: "Stripe", description: "Payments, customers, and invoices", audience: "professional" },
  { slug: "quickbooks", name: "QuickBooks", description: "Accounting, invoices, and expenses", audience: "professional" },
  // PRD §4.4 names Xero + Excel as primary Finance apps; §4.2 names Google Slides for the
  // status-deck workflow. Verified available on Composio (twilio/zillow/appfolio/dotloop/plaid
  // are NOT — those gaps cannot be closed this way).
  { slug: "xero", name: "Xero", description: "Accounting ledger, invoices, and bank reconciliation", audience: "professional" },
  { slug: "excel", name: "Excel", description: "Spreadsheets — tracking sheets and cash models", audience: "professional" },
  { slug: "googleslides", name: "Google Slides", description: "Status decks and presentation updates", audience: "professional" },
  { slug: "linear", name: "Linear", description: "Issue tracking and product planning", audience: "professional" },
  { slug: "asana", name: "Asana", description: "Projects, tasks, and team workload", audience: "professional" },
  { slug: "greenhouse", name: "Greenhouse", description: "Recruiting pipeline and candidates", audience: "professional" },
  { slug: "docusign", name: "DocuSign", description: "Send and track e-signature envelopes", audience: "professional" },
  { slug: "mailchimp", name: "Mailchimp", description: "Email campaigns and audience lists", audience: "professional" },

  // Personal — the PRD catalog rows still marked "not built".
  { slug: "spotify", name: "Spotify", description: "Play, pause, search music and manage playlists", audience: "personal" },
  { slug: "canvas", name: "Canvas", description: "Courses, assignments, grades, people & enrollments (LMS)", audience: "personal" },
  { slug: "zoom", name: "Zoom", description: "Meetings, recordings, and transcripts", audience: "personal" },
  { slug: "calendly", name: "Calendly", description: "Scheduling links and booked events", audience: "personal" },
  { slug: "dropbox", name: "Dropbox", description: "Cloud files and sharing", audience: "personal" },
  { slug: "airtable", name: "Airtable", description: "Bases, tables, and records", audience: "personal" },
  { slug: "telegram", name: "Telegram", description: "Send messages and manage chats", audience: "personal" },
  { slug: "discord", name: "Discord", description: "Servers, channels, and messages", audience: "personal" },
];

const CATALOG_BY_SLUG = new Map(COMPOSIO_CATALOG.map((t) => [t.slug, t]));

export function getCatalog(): ToolkitMeta[] {
  return COMPOSIO_CATALOG;
}

export function isKnownToolkit(slug: string): boolean {
  return CATALOG_BY_SLUG.has(slug);
}

export function toolkitName(slug: string): string {
  return CATALOG_BY_SLUG.get(slug)?.name ?? slug;
}

// ─── Connection records ───────────────────────────────────────────────────────

export interface ComposioConnection {
  toolkitSlug: string;
  name: string;
  connectedAccountId: string | null;
  status: "pending" | "active" | "failed" | "revoked";
}

export async function listConnections(userId: string): Promise<ComposioConnection[]> {
  try {
    const res = await query<{
      toolkit_slug: string;
      connected_account_id: string | null;
      status: ComposioConnection["status"];
    }>(
      `SELECT toolkit_slug, connected_account_id, status
         FROM composio_connections
        WHERE user_id = $1 AND status <> 'revoked'
        ORDER BY toolkit_slug`,
      [userId],
    );
    return res.rows.map((r) => ({
      toolkitSlug: r.toolkit_slug,
      name: toolkitName(r.toolkit_slug),
      connectedAccountId: r.connected_account_id,
      status: r.status,
    }));
  } catch (err) {
    logger.warn("[composio] listConnections failed", { err: String(err) });
    return [];
  }
}

/** Toolkit slugs whose tools should be loaded for this user's agent turns. */
async function activeToolkitSlugs(userId: string): Promise<string[]> {
  try {
    const res = await query<{ toolkit_slug: string }>(
      `SELECT toolkit_slug FROM composio_connections
        WHERE user_id = $1 AND status = 'active' ORDER BY toolkit_slug`,
      [userId],
    );
    return res.rows.map((r) => r.toolkit_slug);
  } catch (err) {
    logger.warn("[composio] activeToolkitSlugs failed", { err: String(err) });
    return [];
  }
}

async function upsertConnection(
  userId: string,
  toolkitSlug: string,
  connectedAccountId: string | null,
  status: ComposioConnection["status"],
): Promise<void> {
  await query(
    `INSERT INTO composio_connections (user_id, toolkit_slug, connected_account_id, status, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id, toolkit_slug)
     DO UPDATE SET connected_account_id = COALESCE(EXCLUDED.connected_account_id,
                                                   composio_connections.connected_account_id),
                   status = EXCLUDED.status,
                   updated_at = now()`,
    [userId, toolkitSlug, connectedAccountId, status],
  );
}

// ─── Connect / reconcile / disconnect ─────────────────────────────────────────

/**
 * Reuse (or create) a Composio-managed auth config for a toolkit, returning its id.
 *
 * Composio v3 requires a concrete `auth_config_id` before a connection can be linked. We
 * own the config (created via OUR api key against Composio's managed OAuth app — we still
 * register nothing and hold no client secret), and reuse it across users so we don't spawn
 * a fresh config per connect.
 */
/**
 * Toolkits that authenticate against OUR OWN registered OAuth app rather than a
 * Composio-managed one (bring-your-own-credentials). Spotify and Canvas both require
 * this: Composio does not host a managed OAuth app for them, so we pass our client
 * id/secret from the environment. When the env vars are unset we fall back to managed
 * auth (which then surfaces the usual "not supported in-app yet" 422).
 *
 * NOTE: the app's redirect/callback URL registered with Spotify/Canvas must include
 * Composio's hosted callback — see doc/composio-setup.md.
 */
const BYOC_CREDENTIALS: Record<
  string,
  () => { authScheme: string; credentials: Record<string, string> } | null
> = {
  spotify: () => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    return clientId && clientSecret
      ? { authScheme: "OAUTH2", credentials: { client_id: clientId, client_secret: clientSecret } }
      : null;
  },
  canvas: () => {
    const clientId = process.env.CANVAS_CLIENT_ID;
    const clientSecret = process.env.CANVAS_CLIENT_SECRET;
    return clientId && clientSecret
      ? { authScheme: "OAUTH2", credentials: { client_id: clientId, client_secret: clientSecret } }
      : null;
  },
};

async function getOrCreateAuthConfig(
  composio: Composio,
  toolkitSlug: string,
): Promise<string> {
  try {
    const existing = await composio.authConfigs.list({ toolkit: toolkitSlug, limit: 1 });
    const found = existing.items?.find(
      (c) => c.toolkit?.slug?.toLowerCase() === toolkitSlug,
    );
    if (found?.id) return found.id;
  } catch (err) {
    logger.warn("[composio] authConfigs.list failed; will try to create one", {
      err: String(err),
      toolkitSlug,
    });
  }

  try {
    // Most toolkits use Composio's managed OAuth app; BYOC toolkits (Spotify, Canvas)
    // authenticate against our own registered app, so we pass our client credentials.
    const byoc = BYOC_CREDENTIALS[toolkitSlug]?.() ?? null;
    const createOptions = byoc
      ? {
          type: "use_custom_auth",
          authScheme: byoc.authScheme,
          name: `Interlink ${toolkitName(toolkitSlug)}`,
          credentials: byoc.credentials,
        }
      : { type: "use_composio_managed_auth", name: `Interlink ${toolkitName(toolkitSlug)}` };
    // The SDK's create() options are a discriminated union; cast so the BYOC variant
    // (custom-auth) type-checks against either SDK minor version.
    const created = await composio.authConfigs.create(toolkitSlug, createOptions as never);
    if (!created?.id) {
      throw new Error(`Composio returned no auth config id for ${toolkitSlug}.`);
    }
    return created.id;
  } catch (err) {
    // Toolkits that authenticate with an API key / bot token (e.g. Telegram) have no
    // Composio-managed OAuth app, so create() 400s with "Default auth config not found".
    // That's a user-actionable limitation, not a server fault — surface it as a clean 422
    // instead of a raw 500 with a Composio stack string.
    const msg = String((err as Error)?.message ?? "");
    if (/auth config|managed auth|not found/i.test(msg)) {
      throw new AppError(
        `${toolkitName(toolkitSlug)} connects with an API key rather than a sign-in, which isn't supported in-app yet.`,
        422,
      );
    }
    throw err;
  }
}

/**
 * Begin a connect for a toolkit and hand back a consent URL. The app opens it in a browser;
 * completion is observed by `syncConnections`.
 *
 * v3 flow: get/create the toolkit's auth config, then `connectedAccounts.link(userId, cfg)`.
 * This replaces `toolkits.authorize()` / `connectedAccounts.initiate()`, both of which now hit
 * Composio's RETIRED legacy endpoint (the "Creating connections on this endpoint … is no
 * longer supported. Use POST /api/v3/connected_accounts/link" 400 the connect screen showed).
 */
/**
 * Delete every existing connected account for this user+toolkit. Best-effort, never throws.
 *
 * Repeated connect taps and abandoned OAuth flows otherwise leave a trail of EXPIRED/INITIATED
 * connected accounts, and Composio then rejects a new link with "multiple connected accounts
 * found for user … in auth config". Tapping Connect means "(re)connect from scratch", so we
 * clear the slate first — link then always creates exactly one.
 */
async function purgeConnectedAccountsForToolkit(
  composio: Composio,
  userId: string,
  toolkitSlug: string,
): Promise<void> {
  try {
    const remote = await composio.connectedAccounts.list({ userIds: [userId] });
    const matches = (remote.items ?? []).filter(
      (a) => a.toolkit?.slug?.toLowerCase() === toolkitSlug,
    );
    for (const a of matches) {
      try {
        await composio.connectedAccounts.delete(a.id);
      } catch (err) {
        logger.warn("[composio] purge delete failed", { id: a.id, err: String(err) });
      }
    }
  } catch (err) {
    logger.warn("[composio] purge list failed", { toolkitSlug, err: String(err) });
  }
}

export async function connectToolkit(
  userId: string,
  toolkitSlug: string,
): Promise<{ redirectUrl: string }> {
  const composio = await getClient();
  if (!composio) throw new Error("Composio is not configured. Add COMPOSIO_API_KEY on the server.");
  if (!isKnownToolkit(toolkitSlug)) throw new Error(`Unknown toolkit "${toolkitSlug}".`);

  const authConfigId = await getOrCreateAuthConfig(composio, toolkitSlug);

  // Clear any existing connected accounts for this user+toolkit so a retry can't accumulate
  // duplicates and trip Composio's "multiple connected accounts" error.
  await purgeConnectedAccountsForToolkit(composio, userId, toolkitSlug);

  const request = await composio.connectedAccounts.link(userId, authConfigId);
  const redirectUrl = request.redirectUrl;
  if (!redirectUrl) {
    // API-key/bot-token toolkits (e.g. Telegram) have no OAuth consent screen — there is
    // nothing to redirect to. Surface that plainly instead of a blank browser.
    throw new Error(
      `${toolkitName(toolkitSlug)} connects with an API key rather than a sign-in, which isn't supported in-app yet.`,
    );
  }

  await upsertConnection(userId, toolkitSlug, request.id ?? null, "pending");
  return { redirectUrl };
}

/**
 * Reconcile our rows against Composio's truth. Called when the app polls after the
 * browser consent step — this is what flips a connection `pending` → `active`, and it
 * works regardless of how Composio's hosted callback is configured (no webhook needed).
 */
export async function syncConnections(userId: string): Promise<ComposioConnection[]> {
  const composio = await getClient();
  if (!composio) return listConnections(userId);

  try {
    const remote = await composio.connectedAccounts.list({ userIds: [userId] });
    // A user can have several connected accounts per toolkit (abandoned OAuth attempts leave
    // EXPIRED rows). Keep the BEST one per toolkit so a stale duplicate can never overwrite a
    // live connection as "pending"/"failed": ACTIVE > pending > failed.
    const rank = (s: ComposioConnection["status"]) => (s === "active" ? 3 : s === "pending" ? 2 : 1);
    const best = new Map<string, { id: string | null; status: ComposioConnection["status"] }>();
    for (const account of remote.items ?? []) {
      const slug = account.toolkit?.slug?.toLowerCase();
      if (!slug || !isKnownToolkit(slug)) continue;
      // Composio statuses: INITIALIZING | INITIATED | ACTIVE | FAILED | EXPIRED | INACTIVE.
      const status: ComposioConnection["status"] =
        account.status === "ACTIVE"
          ? "active"
          : account.status === "FAILED" || account.status === "EXPIRED" || account.status === "INACTIVE"
            ? "failed"
            : "pending";
      const prev = best.get(slug);
      if (!prev || rank(status) > rank(prev.status)) best.set(slug, { id: account.id, status });
    }
    for (const [slug, b] of best) {
      await upsertConnection(userId, slug, b.id, b.status);
    }
  } catch (err) {
    // Never fail the caller — fall back to whatever we already have on record.
    logger.warn("[composio] syncConnections failed", { err: String(err) });
  }

  invalidateToolCache(userId);
  return listConnections(userId);
}

export async function disconnectToolkit(userId: string, toolkitSlug: string): Promise<void> {
  const composio = await getClient();
  const res = await query<{ connected_account_id: string | null }>(
    `SELECT connected_account_id FROM composio_connections
      WHERE user_id = $1 AND toolkit_slug = $2`,
    [userId, toolkitSlug],
  );
  const accountId = res.rows[0]?.connected_account_id;

  if (composio && accountId) {
    // Revoke upstream so the user's tokens are actually destroyed, not just hidden.
    try {
      await composio.connectedAccounts.delete(accountId);
    } catch (err) {
      logger.warn("[composio] upstream delete failed; marking revoked locally", {
        err: String(err),
        toolkitSlug,
      });
    }
  }

  await query(
    `UPDATE composio_connections SET status = 'revoked', updated_at = now()
      WHERE user_id = $1 AND toolkit_slug = $2`,
    [userId, toolkitSlug],
  );
  invalidateToolCache(userId);
}

// ─── Gemini schema conversion ─────────────────────────────────────────────────

/**
 * Composio returns full JSON Schema. Gemini's function declarations accept only a
 * narrow OpenAPI-3.0 subset and reject the rest with an opaque HTTP 400 — so an
 * unsanitized connector schema takes down the WHOLE turn, including every native tool
 * in the same request. This sanitizer is load-bearing, not defensive polish.
 *
 * Dropped: $schema/$ref/$defs/definitions, additionalProperties, oneOf/allOf/not,
 * examples, and unsupported `format` values. `anyOf` is dropped rather than translated
 * because Gemini's support for it is inconsistent across model versions.
 */
const GEMINI_ALLOWED_FORMATS = new Set(["enum", "date-time"]);
const GEMINI_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

export function toGeminiSchema(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  // Gemini rejects deeply nested schemas; connectors occasionally ship very deep trees.
  if (depth > 6) return { type: "string" };

  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // A union/ref we can't faithfully express — degrade to a permissive string so the tool
  // stays callable instead of poisoning the request.
  if (src.$ref || src.oneOf || src.allOf || src.not) return { type: "string" };
  if (src.anyOf) {
    const first = (src.anyOf as unknown[]).find((v) => {
      const t = (v as Record<string, unknown>)?.type;
      return typeof t === "string" && t !== "null";
    });
    const collapsed = first ? toGeminiSchema(first, depth + 1) : null;
    return collapsed ?? { type: "string" };
  }

  const type = typeof src.type === "string" ? src.type : undefined;
  out.type = type && GEMINI_TYPES.has(type) ? type : "string";

  if (typeof src.description === "string" && src.description.trim()) {
    out.description = src.description.slice(0, 500);
  }
  if (Array.isArray(src.enum) && src.enum.length > 0) out.enum = src.enum.map(String);
  if (typeof src.format === "string" && GEMINI_ALLOWED_FORMATS.has(src.format)) {
    out.format = src.format;
  }

  if (out.type === "object") {
    const props = src.properties;
    const cleaned: Record<string, unknown> = {};
    if (props && typeof props === "object") {
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        const child = toGeminiSchema(value, depth + 1);
        if (child) cleaned[key] = child;
      }
    }
    out.properties = cleaned;
    const required = Array.isArray(src.required)
      ? src.required.filter((r): r is string => typeof r === "string" && r in cleaned)
      : [];
    out.required = required;
    // An object with no properties is rejected by Gemini; make it a plain string instead.
    if (Object.keys(cleaned).length === 0) return { type: "string", ...(out.description ? { description: out.description } : {}) };
  }

  if (out.type === "array") {
    const items = toGeminiSchema(src.items, depth + 1);
    out.items = items ?? { type: "string" };
  }

  return out;
}

/** Gemini function names must match ^[a-zA-Z0-9_.-]{1,64}$ — Composio slugs can exceed 64. */
function isValidGeminiToolName(slug: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(slug);
}

// ─── Read-only classification ─────────────────────────────────────────────────

/**
 * Read-only tools are auto-chained by the agent loop; everything else is surfaced to the
 * user for confirmation before it runs. We therefore classify by ACTION VERB and default
 * an unrecognized connector tool to WRITE — the safe direction. Worst case the user
 * confirms a harmless read; the alternative (silently auto-running an unknown connector
 * write, e.g. STRIPE_CREATE_REFUND) is not acceptable.
 */
const READ_VERBS = [
  "GET_", "LIST_", "FETCH_", "SEARCH_", "FIND_", "READ_", "RETRIEVE_", "COUNT_", "EXPORT_",
];

export function isComposioReadOnlyTool(slug: string): boolean {
  if (!isComposioToolName(slug)) return false;
  const action = slug.includes("_") ? slug.slice(slug.indexOf("_") + 1) : slug;
  return READ_VERBS.some((verb) => action.startsWith(verb));
}

/** Composio slugs are UPPER_SNAKE (HUBSPOT_CREATE_CONTACT); native tools are lower_snake. */
export function isComposioToolName(name: string): boolean {
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name);
}

// ─── Tool loading (budgeted + cached) ─────────────────────────────────────────

/**
 * Gemini function-calling degrades badly past a few dozen declarations, and the native
 * tool set already spends ~60 of that budget. So we load tools ONLY for toolkits the user
 * actually connected, and cap the total. A user with 3 connected toolkits gets ~36 tools;
 * connecting 300 toolkits would not (and must not) load 3,000.
 */
const MAX_COMPOSIO_TOOLS = 40;
const MAX_TOOLS_PER_TOOLKIT = 12;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * For toolkits whose most-useful actions do NOT fall in the first `MAX_TOOLS_PER_TOOLKIT`
 * tools Composio returns, list the important slugs here — they are pulled to the FRONT before
 * the per-toolkit cap is applied. Without this, Spotify loaded 12 alphabetical playlist/check
 * tools and NONE of play/pause/skip/search, so the agent invented `SPOTIFY_PLAY` and failed
 * with "unable to retrieve tool with slug …". (Spotify has 88 tools; playback controls are ~#64-84.)
 */
const TOOLKIT_PRIORITY_TOOLS: Record<string, string[]> = {
  spotify: [
    "SPOTIFY_SEARCH_FOR_ITEM",
    "SPOTIFY_START_RESUME_PLAYBACK",
    "SPOTIFY_PAUSE_PLAYBACK",
    "SPOTIFY_SKIP_TO_NEXT",
    "SPOTIFY_SKIP_TO_PREVIOUS",
    "SPOTIFY_GET_CURRENTLY_PLAYING_TRACK",
    "SPOTIFY_GET_CURRENT_USER_S_PLAYLISTS",
    "SPOTIFY_ADD_ITEM_TO_PLAYBACK_QUEUE",
    "SPOTIFY_GET_PLAYBACK_STATE",
    "SPOTIFY_TRANSFER_PLAYBACK",
  ],
  canvas: [
    "CANVAS_LIST_YOUR_COURSES",
    "CANVAS_LIST_ASSIGNMENTS",
    "CANVAS_LIST_USERS_IN_COURSE",
    "CANVAS_CREATE_AN_ASSIGNMENT",
    "CANVAS_ENROLL_A_USER",
  ],
};

/**
 * Composio slugs the model commonly guesses wrong → the real slug. The agent (and the app's
 * one-tap prompts) say "play/pause/skip on Spotify"; if it emits a shortened slug we map it so
 * the action still runs instead of failing with "unable to retrieve tool with slug …".
 */
const COMPOSIO_TOOL_ALIASES: Record<string, string> = {
  SPOTIFY_PLAY: "SPOTIFY_START_RESUME_PLAYBACK",
  SPOTIFY_RESUME: "SPOTIFY_START_RESUME_PLAYBACK",
  SPOTIFY_START_PLAYBACK: "SPOTIFY_START_RESUME_PLAYBACK",
  SPOTIFY_PLAY_TRACK: "SPOTIFY_START_RESUME_PLAYBACK",
  SPOTIFY_PAUSE: "SPOTIFY_PAUSE_PLAYBACK",
  SPOTIFY_STOP: "SPOTIFY_PAUSE_PLAYBACK",
  SPOTIFY_SKIP: "SPOTIFY_SKIP_TO_NEXT",
  SPOTIFY_NEXT: "SPOTIFY_SKIP_TO_NEXT",
  SPOTIFY_SKIP_NEXT: "SPOTIFY_SKIP_TO_NEXT",
  SPOTIFY_SKIP_TRACK: "SPOTIFY_SKIP_TO_NEXT",
  SPOTIFY_PREVIOUS: "SPOTIFY_SKIP_TO_PREVIOUS",
  SPOTIFY_SEARCH: "SPOTIFY_SEARCH_FOR_ITEM",
  SPOTIFY_SEARCH_TRACKS: "SPOTIFY_SEARCH_FOR_ITEM",
  SPOTIFY_GET_PLAYLISTS: "SPOTIFY_GET_CURRENT_USER_S_PLAYLISTS",
};

/** Resolve a (possibly guessed) Composio slug to the real one. */
export function resolveComposioSlug(slug: string): string {
  return COMPOSIO_TOOL_ALIASES[slug] ?? slug;
}

/** Sort key that pulls a toolkit's priority slugs to the front (others keep their order). */
function priorityRank(priority: string[], slug: string | undefined): number {
  if (!slug) return priority.length + 1;
  const i = priority.indexOf(slug);
  return i === -1 ? priority.length : i;
}

const toolCache = new Map<string, { at: number; tools: GeminiToolFunction[] }>();

export function invalidateToolCache(userId: string): void {
  toolCache.delete(userId);
}

/**
 * The Gemini function declarations for this user's connected Composio toolkits.
 * Returns [] when Composio is off or nothing is connected — so callers can always
 * spread it unconditionally.
 */
export async function getComposioToolsForUser(userId: string): Promise<GeminiToolFunction[]> {
  const composio = await getClient();
  if (!composio) return [];

  const cached = toolCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.tools;

  const slugs = await activeToolkitSlugs(userId);
  if (slugs.length === 0) {
    toolCache.set(userId, { at: Date.now(), tools: [] });
    return [];
  }

  const tools: GeminiToolFunction[] = [];
  try {
    for (const slug of slugs) {
      if (tools.length >= MAX_COMPOSIO_TOOLS) break;
      // Per-toolkit rather than one bulk call, so the per-toolkit cap is enforceable and
      // one broken toolkit can't wipe out every other toolkit's tools.
      const priority = TOOLKIT_PRIORITY_TOOLS[slug];
      // When a toolkit has priority tools, pull a wider page so those slugs are actually in it,
      // then reorder them to the front; otherwise just take the first N.
      const list = await composio.tools.getRawComposioTools({
        toolkits: [slug],
        limit: priority ? 100 : MAX_TOOLS_PER_TOOLKIT,
      });
      const ordered = priority
        ? [...list].sort((a, b) => priorityRank(priority, a.slug) - priorityRank(priority, b.slug))
        : list;

      let perToolkit = 0;
      for (const tool of ordered) {
        if (tools.length >= MAX_COMPOSIO_TOOLS || perToolkit >= MAX_TOOLS_PER_TOOLKIT) break;
        if (!tool.slug || !isValidGeminiToolName(tool.slug)) continue;

        const parameters = toGeminiSchema(tool.inputParameters) ?? {
          type: "object",
          properties: {},
          required: [],
        };
        // Name the app in the description — the model picks tools largely off this text.
        const label = toolkitName(slug);
        const description = `[${label}] ${tool.description ?? tool.name ?? tool.slug}`.slice(0, 1000);

        tools.push({ name: tool.slug, description, parameters });
        perToolkit += 1;
      }
    }
  } catch (err) {
    // A Composio outage must not take down the assistant — the native tools still work.
    logger.warn("[composio] getComposioToolsForUser failed; continuing with native tools only", {
      err: String(err),
    });
    return cached?.tools ?? [];
  }

  toolCache.set(userId, { at: Date.now(), tools });
  logger.info("[composio] loaded tools", { userId, toolkits: slugs.length, tools: tools.length });
  return tools;
}

/** The connected toolkit names, for the agent's "Connected apps:" line. */
export async function connectedToolkitNames(userId: string): Promise<string[]> {
  if (!isComposioLive()) return [];
  const slugs = await activeToolkitSlugs(userId);
  return slugs.map(toolkitName);
}

// ─── Execution ────────────────────────────────────────────────────────────────

function summarizeExecuteData(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  const payload = (data.data ?? data) as unknown;
  try {
    const json = JSON.stringify(payload);
    if (!json || json === "{}" || json === "null") return "";
    return json.length > 1200 ? `${json.slice(0, 1200)}…` : json;
  } catch {
    return "";
  }
}

/**
 * Run one Composio tool. Mirrors executeAction()'s contract: always resolves, never
 * throws, so the assistant reports a failure cleanly instead of dropping the turn.
 */
export async function executeComposioTool(
  userId: string,
  requestedSlug: string,
  args: Record<string, unknown> = {},
): Promise<ExecuteResult> {
  const composio = await getClient();
  if (!composio) {
    return { ok: false, message: "That app isn't available — Composio is not configured on the server." };
  }

  // Map a guessed slug (e.g. SPOTIFY_PLAY) to the real one before anything else.
  const slug = resolveComposioSlug(requestedSlug);

  // Proactive connection check: a tool for a known toolkit that isn't ACTIVE (e.g. an OAuth
  // that was started but never finished — status 'pending') would otherwise fail with an
  // opaque "Error executing the tool". Tell the user plainly to finish connecting it.
  const toolkitSlug = slug.split("_")[0].toLowerCase();
  if (isKnownToolkit(toolkitSlug)) {
    const active = await activeToolkitSlugs(userId);
    if (!active.includes(toolkitSlug)) {
      return {
        ok: false,
        message: `${toolkitName(toolkitSlug)} isn't fully connected yet. Open Settings → Connected accounts and finish connecting ${toolkitName(toolkitSlug)}, then try again.`,
      };
    }
  }

  try {
    const result = await composio.tools.execute(slug, {
      userId,
      arguments: args,
      // Composio refuses a manual execute against the floating "latest" toolkit version
      // unless this is set (ComposioToolVersionRequiredError). Pinning a version per
      // toolkit is the hardened option, but it means hand-maintaining a version map for
      // every connector — deferred, see doc/composio-setup.md.
      dangerouslySkipVersionCheck: true,
    });

    if (!result.successful) {
      const reason = result.error ?? "the app rejected the request";
      return { ok: false, message: `${toolLabel(slug)} failed: ${reason}` };
    }

    const summary = summarizeExecuteData(result.data);
    return {
      ok: true,
      message: summary ? `${toolLabel(slug)} succeeded.\n${summary}` : `${toolLabel(slug)} succeeded.`,
      data: result.data,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[composio] execute failed", { slug, err: message });
    // A missing/expired connection is the common case — say so actionably.
    if (/connected account|not connected|no connection/i.test(message)) {
      const app = toolkitName(slug.split("_")[0].toLowerCase());
      return { ok: false, message: `Connect ${app} in Settings → Connected accounts first, then try again.` };
    }
    return { ok: false, message: `${toolLabel(slug)} failed: ${message}` };
  }
}

/** "HUBSPOT_CREATE_CONTACT" → "HubSpot · create contact" (for user-facing messages). */
function toolLabel(slug: string): string {
  const [head, ...rest] = slug.split("_");
  const app = toolkitName(head.toLowerCase());
  const action = rest.join(" ").toLowerCase();
  return action ? `${app} · ${action}` : app;
}

/** Human-readable confirmation text for a pending Composio write action. */
export function summarizeComposioAction(slug: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)}`);
  const detail = entries.length ? ` (${entries.join(", ")})` : "";
  return `Run ${toolLabel(slug)}${detail}?`;
}
