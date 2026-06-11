import { BadRequestError } from "../utils/errors";

export type TravelMode = "driving" | "walking" | "bicycling" | "transit";
export type DistanceUnits = "metric" | "imperial";

export interface LatLng {
  lat: number;
  lng: number;
}

interface GeocodeResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    place_id?: string;
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
    };
  }>;
}

interface DistanceMatrixResponse {
  status: string;
  error_message?: string;
  rows?: Array<{
    elements?: Array<{
      status?: string;
      distance?: { text?: string; value?: number };
      duration?: { text?: string; value?: number };
      duration_in_traffic?: { text?: string; value?: number };
    }>;
  }>;
  origin_addresses?: string[];
  destination_addresses?: string[];
}

interface RoutesApiResponse {
  routes?: Array<{
    distanceMeters?: number;
    duration?: string;
    staticDuration?: string;
    legs?: Array<{
      distanceMeters?: number;
      duration?: string;
      staticDuration?: string;
    }>;
  }>;
  geocodingResults?: {
    destination?: {
      placeId?: string;
    };
  };
}

const ROUTES_FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.staticDuration",
  "routes.legs.distanceMeters",
  "routes.legs.duration",
  "routes.legs.staticDuration",
  "geocodingResults.destination.placeId",
].join(",");
const ROUTES_DEPARTURE_NOW_OFFSET_MS = 2 * 60 * 1000;
const ROUTES_FUTURE_TIMESTAMP_RE = /timestamp must be set to a future time/i;

function getGoogleApiKey(): string {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable is not set");
  }
  return apiKey;
}

function toLatLngString(value: LatLng): string {
  return `${value.lat.toFixed(6)},${value.lng.toFixed(6)}`;
}

function extractGoogleErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload.trim();
  }

  if (typeof payload === "object" && payload !== null) {
    const maybeRecord = payload as {
      error_message?: unknown;
      status?: unknown;
      error?: { message?: unknown; status?: unknown };
    };

    if (typeof maybeRecord.error?.message === "string") {
      return maybeRecord.error.message;
    }
    if (typeof maybeRecord.error_message === "string") {
      return maybeRecord.error_message;
    }
    if (typeof maybeRecord.status === "string") {
      return `Google API status: ${maybeRecord.status}`;
    }
  }

  return fallback;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new BadRequestError(
      extractGoogleErrorMessage(
        payload,
        `Google Maps API request failed with status ${response.status}`,
      ),
    );
  }

  return payload as T;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toLatLngIfValid(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseLatLng(value: string): LatLng | null {
  const match = value.match(
    /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/,
  );
  if (!match) return null;

  // Avoid false positives like "Room 3, Floor 4".
  const hasDecimal = match[1].includes(".") || match[2].includes(".");
  if (!hasDecimal) return null;

  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return toLatLngIfValid(lat, lng);
}

function firstUrlInText(value: string): string | null {
  const match = value.match(/https?:\/\/\S+/i);
  return match?.[0] ?? null;
}

function isGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "maps.app.goo.gl" || host === "goo.gl" || host === "g.co") {
    return true;
  }
  return /^(.+\.)?google\.[a-z.]+$/.test(host);
}

function isShortGoogleMapsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "maps.app.goo.gl" || host === "goo.gl" || host === "g.co";
}

async function maybeExpandShortGoogleMapsUrl(rawUrl: string): Promise<string> {
  try {
    const url = new URL(rawUrl);
    if (!isShortGoogleMapsHost(url.hostname)) return rawUrl;

    const response = await fetch(rawUrl, {
      method: "GET",
      redirect: "follow",
    });
    return response.url || rawUrl;
  } catch {
    return rawUrl;
  }
}

function parseLatLngFromGoogleMapsUrl(url: URL): LatLng | null {
  const queryCandidates = ["q", "query", "destination", "daddr", "ll", "center"];

  for (const key of queryCandidates) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    const parsed = parseLatLng(value);
    if (parsed) return parsed;
  }

  const atMatch = url.pathname.match(
    /@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/,
  );
  if (atMatch) {
    const parsed = toLatLngIfValid(Number(atMatch[1]), Number(atMatch[2]));
    if (parsed) return parsed;
  }

  const bangMatch = `${url.pathname}${url.search}${url.hash}`.match(
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  );
  if (bangMatch) {
    const parsed = toLatLngIfValid(Number(bangMatch[1]), Number(bangMatch[2]));
    if (parsed) return parsed;
  }

  return null;
}

function decodeGooglePathToken(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value.replace(/\+/g, " ");
  }
}

function parseAddressFromGoogleMapsUrl(url: URL): string | null {
  const queryCandidates = ["q", "query", "destination", "daddr", "address"];

  for (const key of queryCandidates) {
    const value = url.searchParams.get(key);
    if (!value) continue;
    if (parseLatLng(value)) continue;
    const normalized = normalizeWhitespace(value);
    if (normalized.length >= 3) return normalized;
  }

  const placeMatch = url.pathname.match(/\/maps\/(?:place|search)\/([^/]+)/i);
  if (placeMatch?.[1]) {
    const decoded = normalizeWhitespace(decodeGooglePathToken(placeMatch[1]));
    if (decoded.length >= 3 && !parseLatLng(decoded)) {
      return decoded;
    }
  }

  return null;
}

async function resolveAddressInput(rawAddress: string): Promise<{
  location: LatLng | null;
  address: string | null;
  formattedAddress: string;
}> {
  const trimmed = normalizeWhitespace(rawAddress);
  if (!trimmed) {
    throw new BadRequestError("Destination address is required");
  }

  const directCoords = parseLatLng(trimmed);
  if (directCoords) {
    const coordLabel = toLatLngString(directCoords);
    return {
      location: directCoords,
      address: null,
      formattedAddress: coordLabel,
    };
  }

  const urlCandidate = firstUrlInText(trimmed);
  if (!urlCandidate) {
    return {
      location: null,
      address: trimmed,
      formattedAddress: trimmed,
    };
  }

  const parseGoogleUrl = (urlText: string): {
    location: LatLng | null;
    address: string | null;
    formattedAddress: string;
  } | null => {
    try {
      const parsedUrl = new URL(urlText);
      if (!isGoogleHost(parsedUrl.hostname)) return null;

      const coords = parseLatLngFromGoogleMapsUrl(parsedUrl);
      if (coords) {
        const coordLabel = toLatLngString(coords);
        return {
          location: coords,
          address: null,
          formattedAddress: coordLabel,
        };
      }

      const extractedAddress = parseAddressFromGoogleMapsUrl(parsedUrl);
      if (extractedAddress) {
        return {
          location: null,
          address: extractedAddress,
          formattedAddress: extractedAddress,
        };
      }

      return null;
    } catch {
      return null;
    }
  };

  const expandedUrl = await maybeExpandShortGoogleMapsUrl(urlCandidate);
  const parsedExpanded = parseGoogleUrl(expandedUrl);
  if (parsedExpanded) return parsedExpanded;

  const parsedRaw = parseGoogleUrl(urlCandidate);
  if (parsedRaw) return parsedRaw;

  const withoutUrl = normalizeWhitespace(trimmed.replace(urlCandidate, " "));
  if (withoutUrl.length >= 3) {
    return {
      location: null,
      address: withoutUrl,
      formattedAddress: withoutUrl,
    };
  }

  return {
    location: null,
    address: trimmed,
    formattedAddress: trimmed,
  };
}

function toRoutesTravelMode(mode: TravelMode):
  | "DRIVE"
  | "WALK"
  | "BICYCLE"
  | "TRANSIT" {
  switch (mode) {
    case "walking":
      return "WALK";
    case "bicycling":
      return "BICYCLE";
    case "transit":
      return "TRANSIT";
    default:
      return "DRIVE";
  }
}

function parseProtoDurationSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round(parsed));
}

function formatDurationText(seconds: number): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${totalMinutes} min`;
  }
  if (minutes === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${minutes} min`;
}

function formatDistanceText(distanceMeters: number, units: DistanceUnits): string {
  if (units === "imperial") {
    const miles = distanceMeters / 1609.344;
    if (miles >= 10) {
      return `${Math.round(miles)} mi`;
    }
    if (miles >= 1) {
      return `${miles.toFixed(1)} mi`;
    }
    const feet = distanceMeters * 3.28084;
    return `${Math.round(feet)} ft`;
  }

  if (distanceMeters >= 10_000) {
    return `${Math.round(distanceMeters / 1000)} km`;
  }
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(distanceMeters)} m`;
}

async function getDistanceViaRoutes(params: {
  origin: LatLng;
  destination: { location: LatLng } | { address: string };
  mode: TravelMode;
  units: DistanceUnits;
  departureTime?: "now";
}): Promise<{
  mode: TravelMode;
  units: DistanceUnits;
  origin: LatLng;
  destination: {
    location: LatLng | null;
    formattedAddress: string;
    placeId: string | null;
  };
  distanceText: string;
  distanceMeters: number;
  durationText: string;
  durationSeconds: number;
  durationInTrafficText: string | null;
  durationInTrafficSeconds: number | null;
}> {
  const destinationData = "address" in params.destination
    ? await resolveAddressInput(params.destination.address)
    : {
        location: params.destination.location,
        address: null,
        formattedAddress: toLatLngString(params.destination.location),
      };

  const requestBody: Record<string, unknown> = {
    origin: {
      location: {
        latLng: {
          latitude: params.origin.lat,
          longitude: params.origin.lng,
        },
      },
    },
    destination: destinationData.location
      ? {
          location: {
            latLng: {
              latitude: destinationData.location.lat,
              longitude: destinationData.location.lng,
            },
          },
        }
      : {
          address: destinationData.address,
        },
    travelMode: toRoutesTravelMode(params.mode),
  };

  if (params.mode === "driving") {
    requestBody.routingPreference = "TRAFFIC_AWARE_OPTIMAL";
    if (params.departureTime === "now") {
      // Routes traffic-aware mode can reject timestamps equal to "now".
      // Nudge slightly into the future for stable real-time ETA responses.
      requestBody.departureTime = new Date(
        Date.now() + ROUTES_DEPARTURE_NOW_OFFSET_MS,
      ).toISOString();
    }
  }

  const payload = await fetchJson<RoutesApiResponse>(
    "https://routes.googleapis.com/directions/v2:computeRoutes",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": getGoogleApiKey(),
        "X-Goog-FieldMask": ROUTES_FIELD_MASK,
      },
      body: JSON.stringify(requestBody),
    },
  );

  const route = payload.routes?.[0];
  if (!route) {
    throw new BadRequestError("No route returned by Google Routes API");
  }

  const firstLeg = route.legs?.[0];
  const distanceMeters = route.distanceMeters ?? firstLeg?.distanceMeters;
  const trafficDurationSeconds =
    parseProtoDurationSeconds(route.duration) ??
    parseProtoDurationSeconds(firstLeg?.duration);
  const staticDurationSeconds =
    parseProtoDurationSeconds(route.staticDuration) ??
    parseProtoDurationSeconds(firstLeg?.staticDuration);
  const durationSeconds = staticDurationSeconds ?? trafficDurationSeconds;

  if (
    typeof distanceMeters !== "number" ||
    typeof durationSeconds !== "number"
  ) {
    throw new BadRequestError(
      "Google Routes API did not return usable distance/time values",
    );
  }

  const durationInTrafficSeconds =
    params.mode === "driving"
      ? (trafficDurationSeconds ?? durationSeconds)
      : null;

  return {
    mode: params.mode,
    units: params.units,
    origin: params.origin,
    destination: {
      location: destinationData.location,
      formattedAddress: destinationData.formattedAddress,
      placeId: payload.geocodingResults?.destination?.placeId ?? null,
    },
    distanceText: formatDistanceText(distanceMeters, params.units),
    distanceMeters,
    durationText: formatDurationText(durationSeconds),
    durationSeconds,
    durationInTrafficText:
      durationInTrafficSeconds !== null
        ? formatDurationText(durationInTrafficSeconds)
        : null,
    durationInTrafficSeconds,
  };
}

async function getDistanceViaLegacyDistanceMatrix(params: {
  origin: LatLng;
  destination: { location: LatLng } | { address: string };
  mode: TravelMode;
  units: DistanceUnits;
  departureTime?: "now";
}): Promise<{
  mode: TravelMode;
  units: DistanceUnits;
  origin: LatLng;
  destination: {
    location: LatLng | null;
    formattedAddress: string;
    placeId: string | null;
  };
  distanceText: string;
  distanceMeters: number;
  durationText: string;
  durationSeconds: number;
  durationInTrafficText: string | null;
  durationInTrafficSeconds: number | null;
}> {
  const destinationData = "address" in params.destination
    ? await resolveAddressInput(params.destination.address)
    : {
        location: params.destination.location,
        address: null,
        formattedAddress: toLatLngString(params.destination.location),
      };

  const destinationQuery = destinationData.location
    ? toLatLngString(destinationData.location)
    : destinationData.address;

  if (!destinationQuery) {
    throw new BadRequestError("Destination address is required");
  }

  const query = new URLSearchParams({
    origins: toLatLngString(params.origin),
    destinations: destinationQuery,
    mode: params.mode,
    units: params.units,
    key: getGoogleApiKey(),
  });

  if (params.mode === "driving" && params.departureTime === "now") {
    query.set("departure_time", "now");
  }

  const payload = await fetchJson<DistanceMatrixResponse>(
    `https://maps.googleapis.com/maps/api/distancematrix/json?${query.toString()}`,
  );

  if (payload.status !== "OK") {
    throw new BadRequestError(
      payload.error_message ??
        `Google Distance Matrix failed with status ${payload.status}`,
    );
  }

  const element = payload.rows?.[0]?.elements?.[0];
  if (!element) {
    throw new BadRequestError("No distance result returned by Google Maps");
  }

  if (element.status !== "OK") {
    throw new BadRequestError(
      `Google Distance Matrix element status: ${element.status}`,
    );
  }

  const distanceMeters = element.distance?.value;
  const durationSeconds = element.duration?.value;

  if (
    typeof distanceMeters !== "number" ||
    typeof durationSeconds !== "number"
  ) {
    throw new BadRequestError(
      "Google Maps did not return usable distance/time values",
    );
  }

  return {
    mode: params.mode,
    units: params.units,
    origin: params.origin,
    destination: {
      location: destinationData.location,
      formattedAddress:
        payload.destination_addresses?.[0] ?? destinationData.formattedAddress,
      placeId: null,
    },
    distanceText:
      element.distance?.text ?? formatDistanceText(distanceMeters, params.units),
    distanceMeters,
    durationText: element.duration?.text ?? formatDurationText(durationSeconds),
    durationSeconds,
    durationInTrafficText: element.duration_in_traffic?.text ?? null,
    durationInTrafficSeconds: element.duration_in_traffic?.value ?? null,
  };
}

export async function geocodeAddress(address: string): Promise<{
  location: LatLng;
  formattedAddress: string;
  placeId: string | null;
}> {
  const resolved = await resolveAddressInput(address);

  if (resolved.location) {
    return {
      location: resolved.location,
      formattedAddress: resolved.formattedAddress,
      placeId: null,
    };
  }

  if (!resolved.address) {
    throw new BadRequestError("Destination address is required");
  }

  const params = new URLSearchParams({
    address: resolved.address,
    key: getGoogleApiKey(),
  });

  const payload = await fetchJson<GeocodeResponse>(
    `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`,
  );

  if (payload.status !== "OK" || !payload.results?.length) {
    throw new BadRequestError(
      payload.error_message ??
        `Google geocoding failed with status ${payload.status}`,
    );
  }

  const first = payload.results[0];
  const lat = first.geometry?.location?.lat;
  const lng = first.geometry?.location?.lng;

  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new BadRequestError("Could not resolve destination coordinates");
  }

  return {
    location: { lat, lng },
    formattedAddress: first.formatted_address ?? resolved.formattedAddress,
    placeId: first.place_id ?? null,
  };
}

export async function getDistanceFromOrigin(params: {
  origin: LatLng;
  destination: { location: LatLng } | { address: string };
  mode?: TravelMode;
  units?: DistanceUnits;
  departureTime?: "now";
}): Promise<{
  mode: TravelMode;
  units: DistanceUnits;
  origin: LatLng;
  destination: {
    location: LatLng | null;
    formattedAddress: string;
    placeId: string | null;
  };
  distanceText: string;
  distanceMeters: number;
  durationText: string;
  durationSeconds: number;
  durationInTrafficText: string | null;
  durationInTrafficSeconds: number | null;
}> {
  const mode = params.mode ?? "driving";
  const units = params.units ?? "metric";

  try {
    return await getDistanceViaRoutes({
      origin: params.origin,
      destination: params.destination,
      mode,
      units,
      departureTime: params.departureTime,
    });
  } catch (routesErr) {
    let routesMessage =
      routesErr instanceof Error ? routesErr.message : "routes_lookup_failed";

    // Some Routes responses can reject near-now traffic timestamps.
    // Retry once without explicit departureTime before legacy fallback.
    if (
      params.departureTime === "now" &&
      ROUTES_FUTURE_TIMESTAMP_RE.test(routesMessage)
    ) {
      try {
        return await getDistanceViaRoutes({
          origin: params.origin,
          destination: params.destination,
          mode,
          units,
        });
      } catch (routesRetryErr) {
        routesMessage =
          routesRetryErr instanceof Error
            ? routesRetryErr.message
            : routesMessage;
      }
    }

    try {
      return await getDistanceViaLegacyDistanceMatrix({
        origin: params.origin,
        destination: params.destination,
        mode,
        units,
        departureTime: params.departureTime,
      });
    } catch (legacyErr) {
      const legacyMessage =
        legacyErr instanceof Error
          ? legacyErr.message
          : "distance_matrix_lookup_failed";

      throw new BadRequestError(
        `Google routing failed via Routes API and Distance Matrix fallback. ` +
          `Routes: ${routesMessage}. Distance Matrix: ${legacyMessage}`,
      );
    }
  }
}
