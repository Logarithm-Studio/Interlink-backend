import { randomBytes, randomUUID } from "crypto";
import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";
import { query } from "../../config/db";
import { getCalendarSyncQueue } from "../../queues/queues";
import { JobType } from "../../jobs/schemas/envelope";

export interface WatchChannel {
  id: string;
  userId: string;
  channelId: string;
  resourceId: string;
  channelToken: string;
  calendarId: string;
  expiration: Date;
  syncToken: string | null;
  createdAt: Date;
  updatedAt: Date;
}

type ChannelRow = {
  id: string;
  user_id: string;
  channel_id: string;
  resource_id: string;
  channel_token: string;
  calendar_id: string;
  expiration: Date;
  sync_token: string | null;
  created_at: Date;
  updated_at: Date;
};

function rowToChannel(row: ChannelRow): WatchChannel {
  return {
    id: row.id,
    userId: row.user_id,
    channelId: row.channel_id,
    resourceId: row.resource_id,
    channelToken: row.channel_token,
    calendarId: row.calendar_id,
    expiration: row.expiration,
    syncToken: row.sync_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function buildOAuth2Client(accessToken: string) {
  const client = new google.auth.OAuth2();
  client.setCredentials({ access_token: accessToken });
  return client;
}

const WATCH_RENEWAL_LEAD_MS = 12 * 60 * 60 * 1000; // 12 h before expiry

async function getChannelsForUserCalendar(
  userId: string,
  calendarId: string,
): Promise<WatchChannel[]> {
  const result = await query<ChannelRow>(
    `SELECT * FROM google_watch_channels
      WHERE user_id = $1 AND calendar_id = $2
      ORDER BY expiration DESC`,
    [userId, calendarId],
  );
  return result.rows.map(rowToChannel);
}

export async function scheduleWatchRenewal(
  channel: WatchChannel,
): Promise<void> {
  const delayMs = Math.max(
    0,
    channel.expiration.getTime() - Date.now() - WATCH_RENEWAL_LEAD_MS,
  );
  const jobId = `google-watch-renew|${channel.channelId}`;

  await getCalendarSyncQueue().add(
    JobType.GOOGLE_WATCH_RENEW,
    {
      jobType: JobType.GOOGLE_WATCH_RENEW,
      requestId: randomUUID(),
      idempotencyKey: jobId,
      userId: channel.userId,
      payload: {
        channelId: channel.channelId,
        calendarId: channel.calendarId,
      },
    },
    {
      jobId,
      delay: delayMs,
      attempts: 8,
      backoff: { type: "calendar_exp" as "exponential", delay: 30_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
    },
  );
}

/**
 * Create a Google Calendar push notification watch channel for a user.
 * Registers the channel with Google and persists the details to the DB.
 *
 * Requires `GOOGLE_WEBHOOK_URL` to be set in the environment — this must
 * be a publicly reachable HTTPS URL (e.g. your ngrok tunnel in dev).
 */
export async function createWatchChannel(
  userId: string,
  calendarId = "primary",
): Promise<WatchChannel> {
  const webhookUrl = process.env.GOOGLE_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("GOOGLE_WEBHOOK_URL is not set");

  // Ensure a single active watch channel per (user, calendar) for MVP.
  const existing = await getChannelsForUserCalendar(userId, calendarId);
  for (const channel of existing) {
    await stopWatchChannel(channel.channelId);
  }

  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = buildOAuth2Client(accessToken);
  const cal = google.calendar({ version: "v3", auth });

  const channelId = randomUUID();
  const channelToken = randomBytes(32).toString("hex");

  // Google's maximum TTL is 1 week (604 800 s); use 6 days to give renewal headroom.
  const expirationMs = Date.now() + 6 * 24 * 60 * 60 * 1000;

  const { data } = await cal.events.watch({
    calendarId,
    requestBody: {
      id: channelId,
      token: channelToken,
      type: "web_hook",
      address: webhookUrl,
      expiration: String(expirationMs),
    },
  });

  if (!data.resourceId || !data.expiration) {
    throw new Error(
      "Google watch response is missing resourceId or expiration",
    );
  }

  const result = await query<ChannelRow>(
    `INSERT INTO google_watch_channels
       (user_id, channel_id, resource_id, channel_token, calendar_id, expiration)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6::bigint / 1000.0))
     RETURNING *`,
    [
      userId,
      channelId,
      data.resourceId,
      channelToken,
      calendarId,
      data.expiration,
    ],
  );

  const channel = rowToChannel(result.rows[0]);
  await scheduleWatchRenewal(channel);
  return channel;
}

/**
 * Look up a watch channel by its Google-assigned channel_id.
 * Returns null if not found (e.g. the channel was stopped or never existed).
 */
export async function getChannelByChannelId(
  channelId: string,
): Promise<WatchChannel | null> {
  const result = await query<ChannelRow>(
    "SELECT * FROM google_watch_channels WHERE channel_id = $1",
    [channelId],
  );
  return result.rows[0] ? rowToChannel(result.rows[0]) : null;
}

/**
 * Return all channels expiring within the next `withinMs` milliseconds.
 * Used by the renewal job to proactively renew before they expire.
 */
export async function getExpiringChannels(
  withinMs = 24 * 60 * 60 * 1000,
): Promise<WatchChannel[]> {
  const result = await query<ChannelRow>(
    `SELECT * FROM google_watch_channels
     WHERE expiration <= now() + ($1 || ' milliseconds')::interval`,
    [String(withinMs)],
  );
  return result.rows.map(rowToChannel);
}

/**
 * Stop a Google Calendar watch channel: unregisters it from Google's side
 * and deletes the row from the database.
 *
 * Failures to stop the channel on Google's side are logged but not re-thrown
 * so the DB cleanup still proceeds (stale channels expire automatically).
 */
export async function stopWatchChannel(channelId: string): Promise<void> {
  const channel = await getChannelByChannelId(channelId);
  if (!channel) return;

  try {
    const accessToken = await refreshGoogleTokenIfNeeded(channel.userId);
    const auth = buildOAuth2Client(accessToken);
    const cal = google.calendar({ version: "v3", auth });
    await cal.channels.stop({
      requestBody: { id: channel.channelId, resourceId: channel.resourceId },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[googleWatch] Failed to stop channel ${channelId} on Google: ${msg}`,
    );
  }

  await query("DELETE FROM google_watch_channels WHERE channel_id = $1", [
    channelId,
  ]);
}

/**
 * Stop and remove every active watch channel for a user.
 * Returns the number of channels that were targeted for cleanup.
 */
export async function stopAllWatchChannelsForUser(
  userId: string,
): Promise<number> {
  const result = await query<Pick<ChannelRow, "channel_id">>(
    "SELECT channel_id FROM google_watch_channels WHERE user_id = $1",
    [userId],
  );

  for (const row of result.rows) {
    await stopWatchChannel(row.channel_id);
  }

  return result.rows.length;
}

/**
 * Renew a watch channel: stop the old one and immediately create a new one
 * for the same user + calendar. The new channel has a fresh 6-day TTL.
 */
export async function renewWatchChannel(
  channelId: string,
): Promise<WatchChannel | null> {
  const old = await getChannelByChannelId(channelId);
  if (!old) return null;

  await stopWatchChannel(channelId);
  return createWatchChannel(old.userId, old.calendarId);
}
