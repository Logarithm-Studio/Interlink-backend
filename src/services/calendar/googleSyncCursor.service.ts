import { query } from "../../config/db";

/**
 * Retrieve the stored Google Calendar syncToken for a watch channel.
 *
 * Returns null if no syncToken has been persisted yet, which signals that
 * the next sync should be a full time-window fetch rather than incremental.
 */
export async function getSyncToken(channelId: string): Promise<string | null> {
  const result = await query<{ sync_token: string | null }>(
    "SELECT sync_token FROM google_watch_channels WHERE channel_id = $1",
    [channelId],
  );
  return result.rows[0]?.sync_token ?? null;
}

/**
 * Persist a new syncToken after successfully ingesting a page of events.
 *
 * Must be called ONLY after all events on the current page have been upserted,
 * so a crash between pages doesn't advance the cursor past un-ingested data.
 */
export async function setSyncToken(
  channelId: string,
  syncToken: string,
): Promise<void> {
  await query(
    `UPDATE google_watch_channels
     SET sync_token = $2, updated_at = now()
     WHERE channel_id = $1`,
    [channelId, syncToken],
  );
}

/**
 * Clear the syncToken for a channel (e.g. after receiving a 410 Gone from Google).
 *
 * Clearing the cursor forces the next sync to do a full re-fetch, which is
 * the correct recovery path when Google has invalidated the token.
 */
export async function clearSyncToken(channelId: string): Promise<void> {
  await query(
    `UPDATE google_watch_channels
     SET sync_token = NULL, updated_at = now()
     WHERE channel_id = $1`,
    [channelId],
  );
}
