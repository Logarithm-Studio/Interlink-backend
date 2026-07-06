/**
 * Spotify Web API service.
 *
 * OAuth PKCE flow (safe for mobile). Tokens stored in connected_integrations.
 * Scopes: user-read-playback-state user-modify-playback-state playlist-read-private
 *         user-library-read user-read-currently-playing
 */

import { getIntegration, updateAccessToken, upsertIntegration } from "../integrations/tokenStore";
import { BadRequestError } from "../../utils/errors";

const SPOTIFY_BASE = "https://api.spotify.com/v1";
const SPOTIFY_ACCOUNTS = "https://accounts.spotify.com";

function clientId(): string {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) throw new Error("SPOTIFY_CLIENT_ID is not configured.");
  return id;
}
function clientSecret(): string {
  const s = process.env.SPOTIFY_CLIENT_SECRET;
  if (!s) throw new Error("SPOTIFY_CLIENT_SECRET is not configured.");
  return s;
}
function redirectUri(): string {
  // Backend-mediated OAuth: Spotify redirects to our https callback, which
  // exchanges the code and deep-links into the app. Custom-scheme redirects do
  // not reliably hand back to the app from an external browser. Override with
  // SPOTIFY_REDIRECT_URI (must match what's registered in the Spotify app).
  return (
    process.env.SPOTIFY_REDIRECT_URI ??
    `${process.env.API_BASE_URL ?? "http://localhost:5000"}/api/v1/spotify/callback`
  );
}

// ─── OAuth ────────────────────────────────────────────────────────────────────

export function buildAuthUrl(state: string): string {
  const scopes = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "playlist-read-private",
    "user-library-read",
    "user-read-currently-playing",
  ].join(" ");

  const params = new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: scopes,
    state,
    show_dialog: "false",
  });
  return `${SPOTIFY_ACCOUNTS}/authorize?${params}`;
}

export async function exchangeCode(
  userId: string,
  code: string,
): Promise<void> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: clientId(),
    client_secret: clientSecret(),
  });

  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Spotify token exchange failed: ${t.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope: string;
  };

  await upsertIntegration(userId, "spotify", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(Date.now() + data.expires_in * 1000),
    scopes: data.scope.split(" "),
  });
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
    client_secret: clientSecret(),
  });

  const res = await fetch(`${SPOTIFY_ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error("Spotify token refresh failed");

  const data = (await res.json()) as { access_token: string; expires_in: number };
  await updateAccessToken(userId, "spotify", data.access_token, new Date(Date.now() + data.expires_in * 1000));
  return data.access_token;
}

// ─── Authed fetch with auto-refresh ─────────────────────────────────────────

async function spotifyFetch(
  userId: string,
  path: string,
  opts: RequestInit = {},
): Promise<Response> {
  const integration = await getIntegration(userId, "spotify");
  if (!integration || integration.status === "revoked") {
    throw new BadRequestError("Spotify is not connected. Connect it from Settings → Connected Accounts.");
  }

  let token = integration.accessToken;
  let resp = await fetch(`${SPOTIFY_BASE}${path}`, {
    ...opts,
    headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${token}` },
  });

  if (resp.status === 401 && integration.refreshToken) {
    token = await refreshAccessToken(userId, integration.refreshToken);
    resp = await fetch(`${SPOTIFY_BASE}${path}`, {
      ...opts,
      headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${token}` },
    });
  }

  return resp;
}

// ─── Player ───────────────────────────────────────────────────────────────────

export interface NowPlaying {
  isPlaying: boolean;
  trackName: string | null;
  artistName: string | null;
  albumArtUrl: string | null;
  progressMs: number;
  durationMs: number;
  contextUri: string | null;
}

export async function getNowPlaying(userId: string): Promise<NowPlaying | null> {
  const res = await spotifyFetch(userId, "/me/player/currently-playing");
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) return null;

  const data = (await res.json()) as {
    is_playing?: boolean;
    progress_ms?: number;
    item?: {
      name?: string;
      duration_ms?: number;
      artists?: { name?: string }[];
      album?: { images?: { url?: string }[] };
    };
    context?: { uri?: string };
  };

  return {
    isPlaying: data.is_playing ?? false,
    trackName: data.item?.name ?? null,
    artistName: data.item?.artists?.[0]?.name ?? null,
    albumArtUrl: data.item?.album?.images?.[0]?.url ?? null,
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item?.duration_ms ?? 0,
    contextUri: data.context?.uri ?? null,
  };
}

// ─── Devices ────────────────────────────────────────────────────────────────
//
// The Spotify Web API only accepts playback commands against an *active* device.
// Having the app merely open (idle, nothing ever played this session) leaves the
// account with no active device, and play calls then fail — Spotify reports this
// inconsistently (404 NO_ACTIVE_DEVICE, or a 403 the API mislabels), which is why
// a Premium user with the app open still can't play. We resolve a concrete device
// and pass its id explicitly, transferring playback to wake it if none is active.

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  isActive: boolean;
  isRestricted: boolean;
}

export async function getDevices(userId: string): Promise<SpotifyDevice[]> {
  const res = await spotifyFetch(userId, "/me/player/devices");
  if (!res.ok) return [];
  const data = (await res.json()) as {
    devices?: { id?: string; name?: string; type?: string; is_active?: boolean; is_restricted?: boolean }[];
  };
  return (data.devices ?? []).map((d) => ({
    id: d.id ?? null,
    name: d.name ?? "Unknown device",
    type: d.type ?? "Unknown",
    isActive: d.is_active ?? false,
    isRestricted: d.is_restricted ?? false,
  }));
}

/**
 * Return a device id to target for playback. Prefers the already-active device;
 * otherwise picks the first non-restricted device and transfers playback to it so
 * it becomes active. Throws a clear error if no controllable device exists.
 */
async function resolveDeviceId(userId: string): Promise<string> {
  const devices = await getDevices(userId);
  const usable = devices.filter((d) => d.id && !d.isRestricted);
  if (usable.length === 0) {
    throw new BadRequestError(
      "No available Spotify device. Open the Spotify app on your phone or desktop and play/pause anything once, then try again.",
    );
  }

  const active = usable.find((d) => d.isActive);
  if (active) return active.id!;

  // No active device — wake the first usable one by transferring playback to it.
  const target = usable[0]!;
  await spotifyFetch(userId, "/me/player", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_ids: [target.id], play: false }),
  });
  return target.id!;
}

async function spotifyErrorDetail(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? parsed.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

async function ensureSpotifyOk(res: Response, action: string): Promise<void> {
  if (res.ok || res.status === 204) return;

  const detail = await spotifyErrorDetail(res);
  const lower = detail.toLowerCase();
  if (res.status === 404 || lower.includes("no active device")) {
    throw new BadRequestError("No active Spotify device found. Open Spotify on your phone or desktop, then try again.");
  }
  // Reserve the "needs Premium" wording for responses Spotify actually flags as a
  // premium restriction (reason PREMIUM_REQUIRED). Other 403s — a Dev-Mode app the
  // account isn't allow-listed on, a restricted device, or a missing scope — are
  // NOT about Premium, so we surface their real reason instead of a misleading upsell.
  if (lower.includes("premium")) {
    throw new BadRequestError("Spotify playback control requires Spotify Premium.");
  }
  if (res.status === 403) {
    throw new BadRequestError(
      detail
        ? `Spotify refused this action: ${detail}. If you're on Premium, confirm your account is authorized for this app (Spotify Developer Dashboard) and an active Spotify device is open.`
        : "Spotify refused this playback action. Confirm your account is authorized for this app and an active Spotify device is open.",
    );
  }
  if (res.status === 429) {
    throw new BadRequestError("Spotify is rate limiting requests. Wait a moment and try again.");
  }

  throw new BadRequestError(`${action} failed on Spotify${detail ? `: ${detail}` : "."}`);
}

/**
 * Issue a play command against the resolved device, retrying once if Spotify
 * reports the device isn't ready. `resolveDeviceId` may have just transferred
 * playback to wake an idle device, and that transfer is asynchronous — the first
 * play can 403/404 with a device restriction before the device finishes waking.
 * A single short-delayed retry closes that race for a genuine Premium user.
 */
async function playOnResolvedDevice(userId: string, body: unknown, action: string): Promise<void> {
  const deviceId = await resolveDeviceId(userId);
  const send = () =>
    spotifyFetch(userId, `/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
      method: "PUT",
      ...(body !== undefined
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });

  let res = await send();
  if (!res.ok && res.status !== 204 && (res.status === 403 || res.status === 404)) {
    await new Promise((resolve) => setTimeout(resolve, 600));
    res = await send();
  }
  await ensureSpotifyOk(res, action);
}

export async function resumePlayback(userId: string): Promise<void> {
  await playOnResolvedDevice(userId, undefined, "Resume playback");
}

export async function pausePlayback(userId: string): Promise<void> {
  await ensureSpotifyOk(await spotifyFetch(userId, "/me/player/pause", { method: "PUT" }), "Pause playback");
}

export async function skipToNext(userId: string): Promise<void> {
  await ensureSpotifyOk(await spotifyFetch(userId, "/me/player/next", { method: "POST" }), "Skip track");
}

export async function skipToPrevious(userId: string): Promise<void> {
  await ensureSpotifyOk(await spotifyFetch(userId, "/me/player/previous", { method: "POST" }), "Previous track");
}

export async function playContext(userId: string, contextUri: string): Promise<void> {
  await playOnResolvedDevice(userId, { context_uri: contextUri }, "Play context");
}

export async function playTrack(userId: string, trackUri: string): Promise<void> {
  await playOnResolvedDevice(userId, { uris: [trackUri] }, "Play track");
}

// ─── Library ─────────────────────────────────────────────────────────────────

export interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  trackCount: number;
  imageUrl: string | null;
  uri: string;
}

export async function getUserPlaylists(userId: string): Promise<SpotifyPlaylist[]> {
  const res = await spotifyFetch(userId, "/me/playlists?limit=50");
  if (!res.ok) return [];

  const data = (await res.json()) as {
    items?: {
      id?: string;
      name?: string;
      description?: string;
      tracks?: { total?: number };
      images?: { url?: string }[];
      uri?: string;
    }[];
  };

  return (data.items ?? [])
    .filter((p) => p.id)
    .map((p) => ({
      id: p.id!,
      name: p.name ?? "Untitled",
      description: p.description ?? null,
      trackCount: p.tracks?.total ?? 0,
      imageUrl: p.images?.[0]?.url ?? null,
      uri: p.uri!,
    }));
}

export interface SearchResult {
  tracks: { id: string; name: string; artistName: string; uri: string }[];
  albums: { id: string; name: string; artistName: string; uri: string }[];
  playlists: { id: string; name: string; uri: string }[];
}

export async function search(userId: string, q: string, types: string = "track,album,playlist"): Promise<SearchResult> {
  const params = new URLSearchParams({ q, type: types, limit: "10" });
  const res = await spotifyFetch(userId, `/search?${params}`);
  if (!res.ok) await ensureSpotifyOk(res, "Search");

  const data = (await res.json()) as {
    tracks?: { items?: { id?: string; name?: string; artists?: { name?: string }[]; uri?: string }[] };
    albums?: { items?: { id?: string; name?: string; artists?: { name?: string }[]; uri?: string }[] };
    playlists?: { items?: { id?: string; name?: string; uri?: string }[] };
  };

  return {
    tracks: (data.tracks?.items ?? [])
      .filter((t) => t.id)
      .map((t) => ({ id: t.id!, name: t.name ?? "", artistName: t.artists?.[0]?.name ?? "", uri: t.uri! })),
    albums: (data.albums?.items ?? [])
      .filter((a) => a.id)
      .map((a) => ({ id: a.id!, name: a.name ?? "", artistName: a.artists?.[0]?.name ?? "", uri: a.uri! })),
    playlists: (data.playlists?.items ?? [])
      .filter((p) => p.id)
      .map((p) => ({ id: p.id!, name: p.name ?? "", uri: p.uri! })),
  };
}
