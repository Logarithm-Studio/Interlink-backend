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

function getGoogleApiKey(): string {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_API_KEY environment variable is not set");
  }
  return apiKey;
}

function toLatLngString(value: LatLng): string {
  return `${value.lat},${value.lng}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new BadRequestError(
      `Google Maps API request failed with status ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

export async function geocodeAddress(address: string): Promise<{
  location: LatLng;
  formattedAddress: string;
  placeId: string | null;
}> {
  const trimmed = address.trim();
  if (!trimmed) {
    throw new BadRequestError("Destination address is required");
  }

  const params = new URLSearchParams({
    address: trimmed,
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
    formattedAddress: first.formatted_address ?? trimmed,
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
    location: LatLng;
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

  const destinationData = "address" in params.destination
    ? await geocodeAddress(params.destination.address)
    : {
        location: params.destination.location,
        formattedAddress: toLatLngString(params.destination.location),
        placeId: null,
      };

  const query = new URLSearchParams({
    origins: toLatLngString(params.origin),
    destinations: toLatLngString(destinationData.location),
    mode,
    units,
    key: getGoogleApiKey(),
  });

  if (mode === "driving" && params.departureTime === "now") {
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

  if (typeof distanceMeters !== "number" || typeof durationSeconds !== "number") {
    throw new BadRequestError("Google Maps did not return usable distance/time values");
  }

  return {
    mode,
    units,
    origin: params.origin,
    destination: {
      location: destinationData.location,
      formattedAddress:
        payload.destination_addresses?.[0] ?? destinationData.formattedAddress,
      placeId: destinationData.placeId,
    },
    distanceText: element.distance?.text ?? `${distanceMeters} m`,
    distanceMeters,
    durationText: element.duration?.text ?? `${durationSeconds} sec`,
    durationSeconds,
    durationInTrafficText: element.duration_in_traffic?.text ?? null,
    durationInTrafficSeconds: element.duration_in_traffic?.value ?? null,
  };
}
