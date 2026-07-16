/**
 * Live for-sale listings via a RapidAPI Realtor.com feed — a FREE-tier alternative to RentCast
 * for real, current market listings.
 *
 * There is no keyless source of real nationwide MLS listings; the cheapest real option is a
 * RapidAPI Realtor.com feed with a free tier (sign up free at rapidapi.com, subscribe to the
 * "Realtor" API's free/Basic plan, no card for the free tier). Configure:
 *   RAPIDAPI_KEY            — your RapidAPI key (required)
 *   RAPIDAPI_LISTINGS_HOST  — default "realtor.p.rapidapi.com"
 *   RAPIDAPI_LISTINGS_PATH  — default "/properties/v2/list-for-sale"
 *
 * Degrades gracefully: no key (or a failed call) returns [] and callers surface a notice.
 * The response parser is deliberately tolerant of the two common Realtor.com shapes (the v2
 * flat `properties[]` and the v3 nested `data.home_search.results[]`) so it survives minor
 * differences between the various RapidAPI clones.
 */

import type { MarketListing } from "./rentcast.service";

const DEFAULT_HOST = "realtor.p.rapidapi.com";
const DEFAULT_PATH = "/properties/v2/list-for-sale";

export function isRapidListingsConfigured(): boolean {
  return Boolean(process.env.RAPIDAPI_KEY);
}

interface SearchOpts {
  city?: string;
  state?: string;
  zipCode?: string;
  beds?: number;
  maxPriceDollars?: number;
  limit?: number;
}

export async function searchRapidListings(opts: SearchOpts): Promise<MarketListing[]> {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return [];

  const host = process.env.RAPIDAPI_LISTINGS_HOST || DEFAULT_HOST;
  const path = process.env.RAPIDAPI_LISTINGS_PATH || DEFAULT_PATH;
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 42);

  const params = new URLSearchParams({ offset: "0", limit: String(limit), sort: "relevance" });
  const zip = opts.zipCode?.trim();
  const city = opts.city?.trim();
  if (zip) {
    params.set("postal_code", zip);
  } else if (city) {
    params.set("city", city);
    if (opts.state?.trim()) params.set("state_code", opts.state.trim().toUpperCase());
  } else {
    return [];
  }
  if (opts.beds) params.set("beds_min", String(opts.beds));
  if (opts.maxPriceDollars) params.set("price_max", String(Math.round(opts.maxPriceDollars)));

  try {
    const res = await fetch(`https://${host}${path}?${params.toString()}`, {
      headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": host },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as Record<string, unknown>;
    const rows = findResults(json);
    return rows.map(mapListing).filter((l): l is MarketListing => l !== null);
  } catch {
    return [];
  }
}

/** Locate the results array across the common Realtor.com API response shapes. */
function findResults(json: Record<string, unknown>): Record<string, unknown>[] {
  const data = json?.data as Record<string, unknown> | undefined;
  const homeSearch = data?.home_search as Record<string, unknown> | undefined;
  const candidate =
    (json?.properties as unknown) ??
    (homeSearch?.results as unknown) ??
    (data?.results as unknown) ??
    (json?.results as unknown) ??
    (data?.properties as unknown) ??
    [];
  return Array.isArray(candidate) ? (candidate as Record<string, unknown>[]) : [];
}

function pick<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v !== null && v !== undefined) return v;
  return null;
}

function mapListing(item: Record<string, unknown>): MarketListing | null {
  const description = (item.description ?? {}) as Record<string, unknown>;
  const location = (item.location ?? {}) as Record<string, unknown>;
  const addr = (item.address ?? location.address ?? {}) as Record<string, unknown>;
  const buildingSize = (item.building_size ?? {}) as Record<string, unknown>;

  const line = pick(addr.line as string, addr.formatted_address as string);
  const priceDollars = pick(item.price as number, item.list_price as number, description.list_price as number);
  if (!line && priceDollars == null) return null;

  const sqft = pick(buildingSize.size as number, description.sqft as number);
  const beds = pick(item.beds as number, description.beds as number);
  const baths = pick(item.baths as number, description.baths as number, description.baths_consolidated as number);

  return {
    address: line ?? "(address withheld)",
    city: pick(addr.city as string) ?? null,
    state: pick(addr.state_code as string, addr.state as string) ?? null,
    zipCode: pick(addr.postal_code as string) ?? null,
    priceCents: typeof priceDollars === "number" ? Math.round(priceDollars * 100) : 0,
    beds: typeof beds === "number" ? beds : null,
    baths: typeof baths === "number" ? baths : null,
    sqft: typeof sqft === "number" ? sqft : null,
    propertyType: pick(item.prop_type as string, description.type as string) ?? null,
  };
}
