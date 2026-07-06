/**
 * YouTube + YouTube Music service (Personal Mode). Reuses the shared Google OAuth
 * token (YouTube Data API v3). Requires the `youtube` scope (see GOOGLE_SCOPES in
 * routes/auth.routes.ts) — existing users must reconnect Google to grant it.
 *
 * NOTE ON PLAYBACK: neither YouTube nor YouTube Music exposes an official
 * playback-control API (unlike Spotify's Web API). We therefore support search +
 * playlist automation and return tappable links (music.youtube.com / youtube.com)
 * the user opens to play — we cannot start playback on a device from the server.
 */

import { google, youtube_v3 } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getYouTubeClient(userId: string): Promise<youtube_v3.Youtube> {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.youtube({ version: "v3", auth });
}

export interface YouTubeVideo {
  videoId: string;
  title: string;
  channel: string;
  url: string;
}

/**
 * Search YouTube. When `musicOnly` is set, biases toward songs and returns
 * music.youtube.com links (so the result opens in YouTube Music).
 */
export async function searchYouTube(
  userId: string,
  query: string,
  opts: { musicOnly?: boolean } = {},
): Promise<YouTubeVideo[]> {
  const yt = await getYouTubeClient(userId);
  const res = await yt.search.list({
    part: ["snippet"],
    q: opts.musicOnly ? `${query} song` : query,
    type: ["video"],
    maxResults: 12,
  });
  const base = opts.musicOnly ? "https://music.youtube.com/watch?v=" : "https://www.youtube.com/watch?v=";
  return (res.data.items ?? [])
    .filter((i) => i.id?.videoId)
    .map((i) => ({
      videoId: i.id!.videoId!,
      title: i.snippet?.title ?? "",
      channel: i.snippet?.channelTitle ?? "",
      url: `${base}${i.id!.videoId!}`,
    }));
}

export interface YouTubePlaylist {
  id: string;
  title: string;
  itemCount: number;
  url: string;
}

/** List the user's own YouTube playlists. */
export async function listYouTubePlaylists(userId: string): Promise<YouTubePlaylist[]> {
  const yt = await getYouTubeClient(userId);
  const res = await yt.playlists.list({ part: ["snippet", "contentDetails"], mine: true, maxResults: 25 });
  return (res.data.items ?? [])
    .filter((p) => p.id)
    .map((p) => ({
      id: p.id!,
      title: p.snippet?.title ?? "Untitled",
      itemCount: p.contentDetails?.itemCount ?? 0,
      url: `https://www.youtube.com/playlist?list=${p.id!}`,
    }));
}

/** Create a new (private) YouTube playlist. */
export async function createYouTubePlaylist(
  userId: string,
  title: string,
  description?: string,
): Promise<YouTubePlaylist> {
  const yt = await getYouTubeClient(userId);
  const res = await yt.playlists.insert({
    part: ["snippet", "status"],
    requestBody: { snippet: { title, description }, status: { privacyStatus: "private" } },
  });
  const id = res.data.id ?? "";
  return { id, title: res.data.snippet?.title ?? title, itemCount: 0, url: `https://www.youtube.com/playlist?list=${id}` };
}

/** Add a video to one of the user's playlists. */
export async function addToYouTubePlaylist(userId: string, playlistId: string, videoId: string): Promise<void> {
  const yt = await getYouTubeClient(userId);
  await yt.playlistItems.insert({
    part: ["snippet"],
    requestBody: { snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } },
  });
}

/** The user's liked videos. */
export async function getLikedVideos(userId: string): Promise<YouTubeVideo[]> {
  const yt = await getYouTubeClient(userId);
  const res = await yt.videos.list({ part: ["snippet"], myRating: "like", maxResults: 15 });
  return (res.data.items ?? [])
    .filter((v) => v.id)
    .map((v) => ({
      videoId: v.id!,
      title: v.snippet?.title ?? "",
      channel: v.snippet?.channelTitle ?? "",
      url: `https://www.youtube.com/watch?v=${v.id!}`,
    }));
}
