/**
 * RentCast API client (US property + market data) for the Real Estate vertical.
 *
 * RentCast uses a simple API-key header (X-Api-Key) and has a free tier, so it's a
 * single service-wide key in `RENTCAST_API_KEY` rather than per-user OAuth. Every
 * function degrades gracefully: if the key isn't set (or a call fails) it returns
 * an empty result and callers surface a "connect RentCast" notice instead of erroring.
 *
 * Docs: https://developers.rentcast.io/reference/introduction
 */

const RENTCAST_BASE = "https://api.rentcast.io/v1";

export interface MarketListing {
  address: string;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  priceCents: number;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  propertyType: string | null;
}

export interface MarketStats {
  zipCode: string;
  averagePriceCents: number | null;
  medianPriceCents: number | null;
  minPriceCents: number | null;
  maxPriceCents: number | null;
  averagePricePerSqftCents: number | null;
  newListings: number | null;
  totalListings: number | null;
}

export function isRentCastConfigured(): boolean {
  return Boolean(process.env.RENTCAST_API_KEY);
}

async function rentcastGet<T>(path: string): Promise<T | null> {
  const key = process.env.RENTCAST_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${RENTCAST_BASE}${path}`, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const toCents = (dollars: unknown): number =>
  typeof dollars === "number" && Number.isFinite(dollars) ? Math.round(dollars * 100) : 0;
const toCentsOrNull = (dollars: unknown): number | null =>
  typeof dollars === "number" && Number.isFinite(dollars) ? Math.round(dollars * 100) : null;

export interface MarketSearchParams {
  city?: string;
  state?: string;
  zipCode?: string;
  beds?: number;
  /** Client-side max price filter in dollars (RentCast's list endpoint has no price param). */
  maxPriceDollars?: number;
  limit?: number;
}

/** Search active for-sale listings. Returns [] when RentCast isn't configured. */
export async function searchListings(params: MarketSearchParams): Promise<MarketListing[]> {
  if (!isRentCastConfigured()) return [];
  const qs = new URLSearchParams({ status: "Active", limit: String(params.limit ?? 20) });
  if (params.city) qs.set("city", params.city);
  if (params.state) qs.set("state", params.state);
  if (params.zipCode) qs.set("zipCode", params.zipCode);
  if (params.beds != null) qs.set("bedrooms", String(params.beds));

  const data = await rentcastGet<
    {
      formattedAddress?: string; addressLine1?: string; city?: string; state?: string; zipCode?: string;
      price?: number; bedrooms?: number; bathrooms?: number; squareFootage?: number; propertyType?: string;
    }[]
  >(`/listings/sale?${qs}`);
  if (!data || !Array.isArray(data)) return [];

  const listings = data.map((d) => ({
    address: d.formattedAddress ?? d.addressLine1 ?? "Unknown address",
    city: d.city ?? null,
    state: d.state ?? null,
    zipCode: d.zipCode ?? null,
    priceCents: toCents(d.price),
    beds: d.bedrooms ?? null,
    baths: d.bathrooms ?? null,
    sqft: d.squareFootage ?? null,
    propertyType: d.propertyType ?? null,
  }));
  const max = params.maxPriceDollars ? params.maxPriceDollars * 100 : Infinity;
  return listings.filter((l) => l.priceCents === 0 || l.priceCents <= max);
}

/** Aggregate sale-market statistics for a ZIP code. Null when unavailable. */
export async function getMarketStats(zipCode: string): Promise<MarketStats | null> {
  if (!isRentCastConfigured() || !zipCode.trim()) return null;
  const data = await rentcastGet<{
    zipCode?: string;
    saleData?: {
      averagePrice?: number; medianPrice?: number; minPrice?: number; maxPrice?: number;
      averagePricePerSquareFoot?: number; newListings?: number; totalListings?: number;
    };
  }>(`/markets?zipCode=${encodeURIComponent(zipCode.trim())}&dataType=Sale`);
  const s = data?.saleData;
  if (!s) return null;
  return {
    zipCode: data?.zipCode ?? zipCode.trim(),
    averagePriceCents: toCentsOrNull(s.averagePrice),
    medianPriceCents: toCentsOrNull(s.medianPrice),
    minPriceCents: toCentsOrNull(s.minPrice),
    maxPriceCents: toCentsOrNull(s.maxPrice),
    averagePricePerSqftCents: toCentsOrNull(s.averagePricePerSquareFoot),
    newListings: s.newListings ?? null,
    totalListings: s.totalListings ?? null,
  };
}
