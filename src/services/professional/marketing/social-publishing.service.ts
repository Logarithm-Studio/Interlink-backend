import { AppError } from "../../../utils/errors";
import { executeComposioTool, listConnections } from "../../composio/composio.service";
import {
  beginMarketingContentPublish, finishMarketingContentPublish, flagMarketingContentPublishReview,
  getMarketingContentItem, type MarketingContentItem,
} from "./content.service";

export type MarketingPublishProvider = "facebook" | "instagram" | "linkedin";
export interface MarketingPublishTarget { id: string; name: string; kind: "page" | "professional_account" | "member_profile" }

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function unwrap(value: unknown): JsonObject {
  let current = object(value);
  for (let depth = 0; depth < 5; depth += 1) {
    const next = current.data ?? current.response_data ?? current.responseData ?? current.result;
    if (!next || typeof next !== "object") break;
    current = object(next);
  }
  return current;
}

function findArrays(value: unknown, depth = 0): unknown[][] {
  if (depth > 6 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return [value, ...value.flatMap((item) => findArrays(item, depth + 1))];
  return Object.values(value).flatMap((item) => findArrays(item, depth + 1));
}

function findString(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6 || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findString(item, keys, depth + 1); if (found) return found; }
    return null;
  }
  const row = object(value);
  for (const key of keys) if (typeof row[key] === "string" && (row[key] as string).trim()) return (row[key] as string).trim();
  for (const nested of Object.values(row)) { const found = findString(nested, keys, depth + 1); if (found) return found; }
  return null;
}

function getPostId(value: unknown, action?: string): string | null {
  if (action === "FACEBOOK_CREATE_PHOTO_POST") {
    // Facebook can return the uploaded image asset's `id` even if it has no visible
    // timeline post. Only `post_id` verifies the post produced by this action.
    return findString(value, ["post_id", "postId"]);
  }
  // Prefer the durable feed-post identifier over an attached photo/video asset ID.
  return findString(value, ["post_id", "postId", "x_restli_id", "xRestliId", "media_id", "mediaId", "id"]);
}

function assertProviderConnection(userId: string, provider: MarketingPublishProvider): Promise<boolean> {
  return listConnections(userId).then((connections) => connections.some((connection) =>
    connection.toolkitSlug === provider && connection.status === "active" && Boolean(connection.connectedAccountId),
  ));
}

async function execute(userId: string, slug: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result = await executeComposioTool(userId, slug, args);
  if (!result.ok) throw new AppError(result.message || `${slug} failed.`, 502);
  return result.data;
}

export function normalizeFacebookPublishTargets(value: unknown): MarketingPublishTarget[] {
  const rows = findArrays(value).find((items) => items.length > 0 && items.every((entry) => {
    const row = object(entry);
    return typeof row.id === "string" && (typeof row.name === "string" || typeof row.page_name === "string");
  })) ?? [];
  return rows.map((entry) => {
    const row = object(entry);
    return { id: String(row.id), name: String(row.name ?? row.page_name), kind: "page" as const };
  }).filter((item) => /^\d{5,30}$/.test(item.id));
}

export function linkedinAuthorUrn(value: unknown): string | null {
  const id = findString(value, ["id", "person_id", "personId", "author"]);
  if (!id) return null;
  return id.startsWith("urn:li:") ? id : `urn:li:person:${id}`;
}

export function marketingProviderPostId(value: unknown, action?: string): string | null {
  return getPostId(value, action);
}

export function instagramMediaContainerId(value: unknown): string | null {
  return findString(value, ["creation_id", "creationId", "id"]);
}

export function facebookPublishRequest(item: Pick<MarketingContentItem, "title" | "body" | "assetUrl">, pageId: string): { tool: string; args: Record<string, unknown> } {
  const asset = item.assetUrl ? parsePublicHttpsUrl(item.assetUrl) : null;
  if (item.assetUrl && !asset) throw new AppError("Use a public HTTPS asset link before publishing to Facebook.", 400);
  if (asset && /\.(jpe?g|png)$/i.test(asset.pathname)) {
    return { tool: "FACEBOOK_CREATE_PHOTO_POST", args: { page_id: pageId, message: item.body, url: asset.toString(), published: true } };
  }
  if (asset && /\.mp4$/i.test(asset.pathname)) {
    return { tool: "FACEBOOK_CREATE_VIDEO_POST", args: { page_id: pageId, description: item.body, title: item.title, file_url: asset.toString(), published: true } };
  }
  return { tool: "FACEBOOK_CREATE_POST", args: { page_id: pageId, message: item.body, published: true, ...(asset ? { link: asset.toString() } : {}) } };
}

export function instagramMediaRequest(item: Pick<MarketingContentItem, "body" | "assetUrl">, instagramUserId: string): Record<string, unknown> {
  const media = parsePublicHttpsUrl(item.assetUrl ?? "");
  if (!media) throw new AppError("Instagram needs a public HTTPS media URL that Meta can fetch.", 400);
  const isVideo = /\.mp4$/i.test(media.pathname);
  return {
    ig_user_id: instagramUserId,
    caption: item.body,
    ...(isVideo ? { video_url: media.toString(), media_type: "REELS", share_to_feed: true } : { image_url: media.toString() }),
  };
}

export async function getMarketingPublishTargets(userId: string, provider: MarketingPublishProvider): Promise<MarketingPublishTarget[]> {
  if (!await assertProviderConnection(userId, provider)) {
    throw new AppError(`Connect ${provider === "facebook" ? "Facebook Pages" : provider === "instagram" ? "Instagram Business" : "LinkedIn"} before publishing.`, 409);
  }
  if (provider === "facebook") {
    const data = await execute(userId, "FACEBOOK_LIST_MANAGED_PAGES", { fields: "id,name", limit: 100 });
    const pages = normalizeFacebookPublishTargets(data);
    if (!pages.length) throw new AppError("No Facebook Pages are available to this connection. Connect an account with Page publishing access.", 409);
    return pages;
  }
  if (provider === "instagram") {
    const data = await execute(userId, "INSTAGRAM_GET_USER_INFO", { ig_user_id: "me", fields: "id,username,name" });
    const account = unwrap(data);
    const id = findString(account, ["id"]) ?? "me";
    const username = findString(account, ["username", "name"]);
    return [{ id, name: username ? `@${username.replace(/^@/, "")}` : "Connected Instagram professional account", kind: "professional_account" }];
  }
  const data = await execute(userId, "LINKEDIN_GET_MY_INFO", {});
  const author = linkedinAuthorUrn(data);
  if (!author) throw new AppError("LinkedIn did not return the connected member profile ID. Reconnect and try again.", 409);
  const displayName = [findString(data, ["localizedFirstName", "firstName"]), findString(data, ["localizedLastName", "lastName"])].filter(Boolean).join(" ");
  return [{ id: author, name: displayName || "Your LinkedIn member profile", kind: "member_profile" }];
}

export function assertMarketingContentPublishable(item: MarketingContentItem, provider: MarketingPublishProvider): void {
  if (item.channel !== provider) throw new AppError(`This content is for ${item.channel}; choose a matching publishing provider.`, 409);
  if (!(item.status === "approved" || item.status === "planned")) throw new AppError("Only approved or planned content can be published.", 409);
  if (!item.body.trim()) throw new AppError("Add the final post copy before publishing.", 409);
  if (provider === "instagram") {
    if (item.body.length > 2200) throw new AppError("Instagram captions must be 2,200 characters or fewer.", 400);
    if (!item.assetUrl) throw new AppError("Instagram requires a publicly reachable JPEG image or MP4/MOV video asset URL.", 400);
    const parsed = parsePublicHttpsUrl(item.assetUrl);
    if (!parsed) throw new AppError("Instagram needs a public HTTPS media URL that Meta can fetch.", 400);
    if (!/\.(jpe?g|mp4)$/i.test(parsed.pathname)) throw new AppError("For direct Instagram publishing, use a public .jpg, .jpeg, or .mp4 media URL.", 400);
  }
  if (provider === "facebook" && item.assetUrl) {
    const parsed = parsePublicHttpsUrl(item.assetUrl);
    if (!parsed) throw new AppError("Use a public HTTPS asset or destination link before publishing to Facebook.", 400);
    if (/\.(gif|webp|avif|bmp|tiff?|mov|m4v|webm|mpeg|mpg|avi)$/i.test(parsed.pathname)) {
      throw new AppError("Facebook direct media publishing supports JPEG/PNG images and MP4 videos. Use a destination link or a supported media URL.", 400);
    }
  }
  if (provider === "linkedin" && item.assetUrl) {
    const parsed = parsePublicHttpsUrl(item.assetUrl);
    if (!parsed) throw new AppError("Use a public HTTPS destination link or clear the asset link before publishing to LinkedIn.", 400);
    if (/\.(jpe?g|png|gif|webp|avif|bmp|tiff?|mp4|mov|m4v|webm|mpeg|mpg|avi)$/i.test(parsed.pathname)) {
      throw new AppError("Direct LinkedIn publishing supports text and destination links. Use the assistant handoff for a post with an image or video attachment.", 400);
    }
  }
  if (provider === "linkedin" && item.body.length > 3000) throw new AppError("LinkedIn profile posts must be 3,000 characters or fewer.", 400);
  if (provider === "facebook" && item.body.length > 30_000) throw new AppError("This Facebook post exceeds the supported 30,000-character limit.", 400);
}

function parsePublicHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch { return null; }
}

async function publish(userId: string, provider: MarketingPublishProvider, target: MarketingPublishTarget, item: MarketingContentItem): Promise<{ data: unknown; action?: string }> {
  if (provider === "facebook") {
    const request = facebookPublishRequest(item, target.id);
    return { data: await execute(userId, request.tool, request.args), action: request.tool };
  }
  if (provider === "linkedin") {
    if (item.assetUrl && !parsePublicHttpsUrl(item.assetUrl)) throw new AppError("Use a public HTTPS link or clear the asset link before publishing to LinkedIn.", 400);
    return { data: await execute(userId, "LINKEDIN_CREATE_LINKED_IN_POST", {
      author: target.id, commentary: item.body, visibility: "PUBLIC", lifecycleState: "PUBLISHED",
      ...(item.assetUrl ? { contentLandingPage: item.assetUrl } : {}),
    }), action: "LINKEDIN_CREATE_LINKED_IN_POST" };
  }

  const creation = await execute(userId, "INSTAGRAM_POST_IG_USER_MEDIA", instagramMediaRequest(item, target.id));
  const creationId = instagramMediaContainerId(creation);
  if (!creationId) throw new AppError("Instagram accepted media processing but returned no container ID. Check Instagram before retrying.", 502);
  return { data: await execute(userId, "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH", {
    ig_user_id: target.id, creation_id: creationId, max_wait_seconds: 120, poll_interval_seconds: 3,
  }), action: "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH" };
}

export async function publishMarketingContent(userId: string, contentId: string, provider: MarketingPublishProvider, targetId: string): Promise<MarketingContentItem> {
  const initial = await getMarketingContentItem(userId, contentId);
  assertMarketingContentPublishable(initial, provider);
  const targets = await getMarketingPublishTargets(userId, provider);
  const target = targets.find((item) => item.id === targetId);
  if (!target) throw new AppError("Choose a publishing destination available to the connected account.", 400);

  const item = await beginMarketingContentPublish(userId, contentId, provider, target);
  return publishBegunMarketingContent(userId, contentId, provider, target, item);
}

async function publishBegunMarketingContent(
  userId: string,
  contentId: string,
  provider: MarketingPublishProvider,
  target: MarketingPublishTarget,
  item: MarketingContentItem,
): Promise<MarketingContentItem> {
  try {
    const result = await publish(userId, provider, target, item);
    const providerId = getPostId(result.data, result.action);
    if (!providerId) {
      await flagMarketingContentPublishReview(userId, contentId, "The provider returned no verifiable post ID. Check the provider before retrying.");
      throw new AppError("The provider did not return a verifiable post ID. Check its account before taking another action.", 502);
    }
    return await finishMarketingContentPublish(userId, contentId, providerId);
  } catch (error) {
    if (error instanceof AppError && error.message.includes("verifiable post ID")) throw error;
    try {
      await flagMarketingContentPublishReview(userId, contentId, "The provider result was uncertain. Verify whether the post is live before retrying.");
    } catch { /* retain the provider error; publishing state remains locked if the database also failed */ }
    throw new AppError("The provider did not confirm this post. Check its account before retrying; Interlink has locked this item to prevent duplicates.", 502);
  }
}

/**
 * Finish a schedule already atomically claimed by the QStash worker. It deliberately
 * never claims or retries an item itself; a claimed write with an uncertain result is
 * moved to the same provider-review state used by immediate publishing.
 */
export async function publishReservedMarketingContent(
  userId: string,
  contentId: string,
  provider: MarketingPublishProvider,
  targetId: string,
): Promise<MarketingContentItem> {
  const item = await getMarketingContentItem(userId, contentId);
  if (item.status !== "publishing" || item.provider !== provider || item.providerTargetId !== targetId) {
    throw new AppError("The scheduled post is no longer the active confirmed publish request.", 409);
  }
  try {
    const targets = await getMarketingPublishTargets(userId, provider);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new AppError("The selected publishing destination is no longer available. Check the account and schedule a new post.", 409);
    return await publishBegunMarketingContent(userId, contentId, provider, target, item);
  } catch (error) {
    if (error instanceof AppError && error.message.includes("locked this item")) throw error;
    try {
      await flagMarketingContentPublishReview(userId, contentId, "The scheduled provider request did not complete with a verifiable post ID. Check the provider before retrying.");
    } catch { /* preserve the original failure; the item remains locked if storage also failed */ }
    throw new AppError("The scheduled provider result needs review. Check the connected account before retrying.", 502);
  }
}
