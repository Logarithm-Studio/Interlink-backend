/**
 * Listing photos + public share pages.
 *
 * Why this exists: an agent's real job is putting a property in front of buyers, and no free
 * API can do that — publishing to Zillow/an MLS needs broker credentials and membership fees.
 * So instead of syndicating, we host: photos go to Supabase Storage (free tier, already part of
 * this project's stack) and each listing can get its own public page the agent emails to matched
 * buyers through the existing Gmail path.
 *
 * The bucket `listing-photos` is public and capped at 5 MB / image (jpeg|png|webp) at the bucket
 * level, so a malformed upload is rejected by Storage rather than trusted from the client.
 */

import { randomBytes } from "crypto";
import { getSupabase } from "../../../config/supabase";
import { query } from "../../../config/db";
import { BadRequestError, NotFoundError } from "../../../utils/errors";

const BUCKET = "listing-photos";
/** Storage rejects larger, but reject early so we don't ship a 10 MB body to Supabase first. */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS_PER_LISTING = 12;

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface ListingPhotosResult {
  photos: string[];
  shareUrl: string | null;
}

/** Public URL for an object in the public bucket. */
function publicUrl(path: string): string {
  return getSupabase().storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Read the caller's own listing, or throw. Every entry point is user-scoped. */
async function ownedListing(userId: string, listingId: string): Promise<{ photos: string[]; shareSlug: string | null }> {
  const res = await query<{ photos: string[] | null; share_slug: string | null }>(
    `SELECT photos, share_slug FROM re_listings WHERE id = $1 AND user_id = $2`,
    [listingId, userId],
  );
  const row = res.rows[0];
  if (!row) throw new NotFoundError("Listing");
  return { photos: Array.isArray(row.photos) ? row.photos : [], shareSlug: row.share_slug };
}

/**
 * Upload one base64 image and append its public URL to the listing.
 *
 * base64 may be a bare payload or a `data:image/png;base64,...` URL — the app's image picker
 * can produce either depending on platform, so both are accepted.
 */
export async function uploadListingPhoto(
  userId: string,
  listingId: string,
  base64Input: string,
  contentTypeInput?: string,
): Promise<ListingPhotosResult> {
  const { photos, shareSlug } = await ownedListing(userId, listingId);
  if (photos.length >= MAX_PHOTOS_PER_LISTING) {
    throw new BadRequestError(`A listing can have at most ${MAX_PHOTOS_PER_LISTING} photos.`);
  }

  // Accept a data URL by splitting off the header, which also tells us the real mime type.
  let base64 = base64Input.trim();
  let contentType = contentTypeInput;
  const dataUrl = base64.match(/^data:([\w/+.-]+);base64,(.*)$/s);
  if (dataUrl) {
    contentType = contentType ?? dataUrl[1];
    base64 = dataUrl[2];
  }
  contentType = (contentType ?? "image/jpeg").toLowerCase();

  const ext = MIME_EXT[contentType];
  if (!ext) throw new BadRequestError("Photos must be JPEG, PNG, or WebP.");

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new BadRequestError("Photo data is not valid base64.");
  }
  if (bytes.length === 0) throw new BadRequestError("Photo is empty.");
  if (bytes.length > MAX_BYTES) throw new BadRequestError("Photos must be under 5 MB.");

  // Path is scoped by user + listing so a listing's images are trivially findable/deletable,
  // and the random suffix keeps re-uploads of the same file from colliding.
  const path = `${userId}/${listingId}/${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;

  const { error } = await getSupabase().storage.from(BUCKET).upload(path, bytes, {
    contentType,
    upsert: false,
  });
  if (error) throw new BadRequestError(`Upload failed: ${error.message}`);

  const next = [...photos, publicUrl(path)];
  await query(`UPDATE re_listings SET photos = $3::jsonb WHERE id = $1 AND user_id = $2`, [
    listingId,
    userId,
    JSON.stringify(next),
  ]);

  return { photos: next, shareUrl: shareUrl(shareSlug) };
}

/** Drop one photo from the listing and delete the stored object. */
export async function removeListingPhoto(
  userId: string,
  listingId: string,
  url: string,
): Promise<ListingPhotosResult> {
  const { photos, shareSlug } = await ownedListing(userId, listingId);
  const next = photos.filter((p) => p !== url);
  if (next.length === photos.length) throw new NotFoundError("Photo");

  await query(`UPDATE re_listings SET photos = $3::jsonb WHERE id = $1 AND user_id = $2`, [
    listingId,
    userId,
    JSON.stringify(next),
  ]);

  // Best-effort object cleanup — the listing is already correct, so a storage hiccup here
  // must not fail the request (it would leave the UI showing a photo the user deleted).
  const marker = `/${BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx >= 0) {
    await getSupabase().storage.from(BUCKET).remove([url.slice(idx + marker.length)]).catch(() => undefined);
  }

  return { photos: next, shareUrl: shareUrl(shareSlug) };
}

/**
 * Base URL for public listing pages.
 *
 * Deliberately NOT just `API_BASE_URL`: that variable is routinely pointed at an ngrok tunnel
 * for local webhook testing, and a share link is pasted into a buyer's email where it must keep
 * working long after the tunnel dies. Prefer an explicit override, then the production domain
 * Vercel injects automatically, and only fall back to API_BASE_URL for a self-hosted run.
 */
function publicBase(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  return (process.env.API_BASE_URL ?? "").replace(/\/+$/, "");
}

function shareUrl(slug: string | null): string | null {
  if (!slug) return null;
  const base = publicBase();
  return base ? `${base}/l/${slug}` : null;
}

/**
 * Give the listing a public page (idempotent) and return its URL.
 *
 * The slug is random rather than the listing id: the page is unauthenticated, so ids must not be
 * enumerable and the owner's user_id must never appear in a link they paste into an email.
 */
export async function publishListing(userId: string, listingId: string): Promise<{ shareUrl: string; slug: string }> {
  const { shareSlug } = await ownedListing(userId, listingId);
  let slug = shareSlug;

  if (!slug) {
    slug = randomBytes(9).toString("base64url");
    await query(`UPDATE re_listings SET share_slug = $3 WHERE id = $1 AND user_id = $2`, [listingId, userId, slug]);
  }

  const url = shareUrl(slug);
  if (!url) throw new BadRequestError("Public base URL is not configured on the server.");
  return { shareUrl: url, slug };
}

/** Take a listing's public page down. */
export async function unpublishListing(userId: string, listingId: string): Promise<void> {
  await query(`UPDATE re_listings SET share_slug = NULL WHERE id = $1 AND user_id = $2`, [listingId, userId]);
}

export interface PublicListing {
  address: string;
  priceCents: number;
  currency: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  status: string;
  description: string | null;
  photos: string[];
  agentName: string | null;
  agentEmail: string | null;
}

/** Look up a published listing by slug — the only unauthenticated read in this module. */
export async function getPublicListing(slug: string): Promise<PublicListing | null> {
  const res = await query<{
    address: string; price_cents: string | number; currency: string;
    beds: number | null; baths: number | null; sqft: number | null;
    status: string; description: string | null; photos: string[] | null;
    agent_name: string | null; agent_email: string | null;
  }>(
    `SELECT l.address, l.price_cents, l.currency, l.beds, l.baths, l.sqft, l.status,
            l.description, l.photos, u.full_name AS agent_name, u.email AS agent_email
       FROM re_listings l
       JOIN users u ON u.id = l.user_id
      WHERE l.share_slug = $1`,
    [slug],
  );
  const r = res.rows[0];
  if (!r) return null;

  return {
    address: r.address,
    priceCents: typeof r.price_cents === "string" ? parseInt(r.price_cents, 10) : r.price_cents,
    currency: r.currency,
    beds: r.beds,
    baths: r.baths,
    sqft: r.sqft,
    status: r.status,
    description: r.description,
    photos: Array.isArray(r.photos) ? r.photos : [],
    agentName: r.agent_name,
    agentEmail: r.agent_email,
  };
}
