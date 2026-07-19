/**
 * SimplyRETS listings — a KEYLESS, unlimited source of realistic MLS-shaped for-sale
 * listings, used as the default `search_market` source when no RentCast/RapidAPI key is set.
 *
 * WHY: RentCast's free tier is 50 calls/month and RapidAPI feeds need a signed-up key.
 * SimplyRETS publishes a public demo dataset (Houston, TX metro) behind fixed demo
 * credentials `simplyrets:simplyrets` with no rate limit — perfect for building and demoing
 * the buyer-matching / market-search flow end to end with real listing objects, at zero setup.
 *
 * When the user gets real MLS access, set SIMPLYRETS_API_KEY / SIMPLYRETS_API_SECRET and this
 * same service returns their live listings instead of the demo set — no code change.
 *
 * Docs: https://docs.simplyrets.com/api/index.html
 */

import type { MarketListing } from "./rentcast.service";

const SIMPLYRETS_BASE = "https://api.simplyrets.com";

/** Demo credentials are public and unlimited; real MLS creds override them via env. */
function credentials(): { user: string; pass: string } {
  return {
    user: process.env.SIMPLYRETS_API_KEY || "simplyrets",
    pass: process.env.SIMPLYRETS_API_SECRET || "simplyrets",
  };
}

/** Always available — the demo creds are baked in, so there is never a "not configured" case. */
export function isSimplyRetsConfigured(): boolean {
  return true;
}

/** True when the caller is using their OWN MLS credentials rather than the shared demo set. */
export function isSimplyRetsLive(): boolean {
  return Boolean(process.env.SIMPLYRETS_API_KEY && process.env.SIMPLYRETS_API_SECRET);
}

interface SearchOpts {
  city?: string;
  state?: string;
  zipCode?: string;
  beds?: number;
  maxPriceDollars?: number;
  limit?: number;
}

interface SimplyRetsAddress {
  full?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}
interface SimplyRetsProperty {
  bedrooms?: number;
  bathsFull?: number;
  bathsHalf?: number;
  area?: number;
  type?: string;
}
interface SimplyRetsListing {
  address?: SimplyRetsAddress;
  listPrice?: number;
  property?: SimplyRetsProperty;
}

export async function searchSimplyRets(opts: SearchOpts): Promise<MarketListing[]> {
  const { user, pass } = credentials();
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 50);

  const params = new URLSearchParams({ limit: String(limit) });
  // The demo dataset is Houston-metro only; `q` does a forgiving text match across the
  // address, so a city/ZIP still narrows results without hard-failing on an exact-match param.
  const q = opts.zipCode?.trim() || opts.city?.trim();
  if (q) params.set("q", q);
  if (opts.beds) params.set("minbeds", String(opts.beds));
  if (opts.maxPriceDollars) params.set("maxprice", String(Math.round(opts.maxPriceDollars)));

  try {
    const res = await fetch(`${SIMPLYRETS_BASE}/properties?${params.toString()}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as SimplyRetsListing[];
    if (!Array.isArray(data)) return [];
    return data.map(mapListing).filter((l): l is MarketListing => l !== null);
  } catch {
    return [];
  }
}

function mapListing(item: SimplyRetsListing): MarketListing | null {
  const addr = item.address ?? {};
  const prop = item.property ?? {};
  const line = addr.full;
  if (!line && item.listPrice == null) return null;
  return {
    address: line ?? "(address withheld)",
    city: addr.city ?? null,
    state: addr.state ?? null,
    zipCode: addr.postalCode ?? null,
    priceCents: typeof item.listPrice === "number" ? Math.round(item.listPrice * 100) : 0,
    beds: typeof prop.bedrooms === "number" ? prop.bedrooms : null,
    baths: typeof prop.bathsFull === "number" ? prop.bathsFull : null,
    sqft: typeof prop.area === "number" ? prop.area : null,
    propertyType: prop.type ?? null,
  };
}
