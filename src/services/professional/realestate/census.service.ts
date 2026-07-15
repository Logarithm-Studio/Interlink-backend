/**
 * US Census ACS market-data client for the Real Estate vertical — a FREE alternative to
 * RentCast for area market stats (median home value, median rent, owner-occupancy by ZIP).
 *
 * The Census API is official US government data with no usage cost. It requires a free API
 * key (instant signup, no credit card: https://api.census.gov/data/key_signup.html) set as
 * CENSUS_API_KEY. Like the RentCast client, every function degrades gracefully: no key (or a
 * failed call) returns null and callers surface a "not configured" notice instead of erroring.
 *
 * Data: ACS 5-year estimates (acs5), which cover every ZIP Code Tabulation Area.
 *   B25077_001E — median home value (owner-occupied)
 *   B25064_001E — median gross rent (renter-occupied, incl. utilities)
 *   B25003_001E — total occupied units;  B25003_002E — owner-occupied units
 */

// Latest ACS 5-year release. Bump when a newer vintage is published.
const ACS_YEAR = 2023;
const CENSUS_BASE = "https://api.census.gov/data";

export interface CensusMarketStats {
  zipCode: string;
  areaName: string | null;
  medianHomeValueCents: number | null;
  medianGrossRentCents: number | null;
  ownerOccupiedPct: number | null;
  source: string;
}

export function isCensusConfigured(): boolean {
  return Boolean(process.env.CENSUS_API_KEY);
}

/** Census encodes "no data" as large negative sentinels (e.g. -666666666). Treat as null. */
function num(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export async function getCensusMarketStats(zip: string): Promise<CensusMarketStats | null> {
  const key = process.env.CENSUS_API_KEY;
  const zipCode = String(zip).trim();
  if (!key || !/^\d{5}$/.test(zipCode)) return null;

  const vars = "NAME,B25077_001E,B25064_001E,B25003_001E,B25003_002E";
  const url =
    `${CENSUS_BASE}/${ACS_YEAR}/acs/acs5?get=${vars}` +
    `&for=zip%20code%20tabulation%20area:${zipCode}&key=${key}`;

  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    // Response: [[header...],[row...]] — a bare row means no data for that ZCTA.
    const data = (await res.json()) as string[][];
    if (!Array.isArray(data) || data.length < 2) return null;
    const [, row] = data;
    const [name, homeVal, rent, totalOcc, ownerOcc] = row;

    const homeValueDollars = num(homeVal);
    const rentDollars = num(rent);
    const total = num(totalOcc);
    const owner = num(ownerOcc);

    return {
      zipCode,
      areaName: name ?? null,
      medianHomeValueCents: homeValueDollars != null ? Math.round(homeValueDollars * 100) : null,
      medianGrossRentCents: rentDollars != null ? Math.round(rentDollars * 100) : null,
      ownerOccupiedPct: total && owner != null ? Math.round((owner / total) * 100) : null,
      source: `US Census ACS ${ACS_YEAR} 5-year`,
    };
  } catch {
    return null;
  }
}
