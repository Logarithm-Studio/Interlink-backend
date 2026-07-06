import {
  fetchGoogleEvents,
  fetchGoogleEventsIncremental,
  GoogleSyncTokenExpiredError,
} from "./google";
import { normalizeGoogleEvent } from "./normalizer";
import { upsertEvent, deleteEventByExternalId } from "../events.service";
import { loadActiveRules, EventTypeRule } from "../eventTypeRules.service";
import { NormalizedEvent } from "../../types";
import {
  getSyncToken,
  setSyncToken,
  clearSyncToken,
} from "./googleSyncCursor.service";

// ─── Error types ───────────────────────────────────────────────────────────

/**
 * Thrown by `incrementalSync` when Google invalidates the syncToken (410 Gone).
 * The BullMQ processor must catch this, then re-enqueue a GOOGLE_SYNC job so
 * the next run falls back to a full resync and re-seeds the cursor.
 */
export class FullResyncRequiredError extends Error {
  constructor(
    public readonly channelId: string,
    public readonly calendarId: string,
    public readonly userId: string,
  ) {
    super(`Full resync required for channel ${channelId} — syncToken expired`);
    this.name = "FullResyncRequiredError";
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function upsertAll(
  rawEvents: import("googleapis").calendar_v3.Schema$Event[],
  userId: string,
  provider: "google",
  rules: EventTypeRule[],
  calendarId: string,
  googleAccountId?: string | null,
): Promise<{ synced: number; skipped: number; deleted: number }> {
  let synced = 0;
  let skipped = 0;
  let deleted = 0;

  for (const raw of rawEvents) {
    // Google marks deleted / cancelled events with status='cancelled'.
    // Remove them from our DB immediately so they never appear in conflict
    // detection queries.  Silently no-ops if the event was never synced.
    if (raw.status === "cancelled") {
      if (raw.id) {
        const wasDeleted = await deleteEventByExternalId(
          userId,
          raw.id,
          provider,
          googleAccountId,
        );
        if (wasDeleted) deleted++;
      }
      continue;
    }

    const normalized: NormalizedEvent | null =
      provider === "google"
        ? normalizeGoogleEvent(raw, userId, rules, calendarId, googleAccountId)
        : null;

    if (!normalized) {
      skipped++;
      continue;
    }

    await upsertEvent(normalized);
    synced++;
  }

  return { synced, skipped, deleted };
}

// ─── Full sync ─────────────────────────────────────────────────────────────

/**
 * Perform a full time-window sync for a user.
 *
 * Fetches events from (since ?? 30 days ago) to 90 days in the future,
 * normalises, and upserts each one. Returns the `nextSyncToken` from the
 * final API page so the caller can seed the incremental cursor.
 */
export async function fullSync(
  userId: string,
  provider: "google",
  since?: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<{
  synced: number;
  skipped: number;
  deleted: number;
  nextSyncToken: string | null;
}> {
  if (provider !== "google") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  // Load classification rules once for the entire batch (avoids N+1 queries).
  const rules = await loadActiveRules(userId, provider);

  const { events: rawEvents, nextSyncToken } = await fetchGoogleEvents(
    userId,
    since,
    calendarId,
    googleAccountId,
  );

  const { synced, skipped, deleted } = await upsertAll(
    rawEvents,
    userId,
    provider,
    rules,
    calendarId,
    googleAccountId,
  );

  console.log(
    `📅 Full sync complete for user ${userId} (${provider}): ${synced} synced, ${skipped} skipped, ${deleted} deleted`,
  );

  return { synced, skipped, deleted, nextSyncToken };
}

// ─── Incremental sync ──────────────────────────────────────────────────────

/**
 * Perform an incremental sync for a Google Calendar watch channel.
 *
 * Decision tree:
 * 1. No stored syncToken → fall back to `fullSync`; seed the cursor with the
 *    returned `nextSyncToken` so subsequent calls are incremental.
 * 2. Stored syncToken → call `fetchGoogleEventsIncremental`, upsert all
 *    returned events, advance the cursor ONLY after a successful upsert batch
 *    (guards against cursor corruption on partial failure).
 * 3. 410 Gone → clear the stale cursor, throw `FullResyncRequiredError`;
 *    the BullMQ processor re-enqueues a full GOOGLE_SYNC job.
 */
export async function incrementalSync(
  userId: string,
  channelId: string,
  calendarId = "primary",
  googleAccountId?: string | null,
): Promise<{ synced: number; skipped: number; deleted: number }> {
  // When the caller didn't pin an account, use the channel's own account so
  // events sync against the right mailbox in a multi-account setup.
  let accountId = googleAccountId ?? null;
  if (!accountId) {
    const { query } = await import("../../config/db");
    const res = await query<{ google_account_id: string | null }>(
      `SELECT google_account_id FROM google_watch_channels WHERE channel_id = $1`,
      [channelId],
    ).catch(() => ({ rows: [] as { google_account_id: string | null }[] }));
    accountId = res.rows[0]?.google_account_id ?? null;
  }

  const storedToken = await getSyncToken(channelId);

  // ── Path 1: no cursor yet → full sync + seed cursor ──────────────────────
  if (!storedToken) {
    console.log(
      `[incrementalSync] No syncToken for channel ${channelId} — running full sync`,
    );

    const { synced, skipped, deleted, nextSyncToken } = await fullSync(
      userId,
      "google",
      undefined,
      calendarId,
      accountId,
    );

    if (nextSyncToken) {
      await setSyncToken(channelId, nextSyncToken);
      console.log(
        `[incrementalSync] Seeded syncToken for channel ${channelId}`,
      );
    } else {
      console.warn(
        `[incrementalSync] Warning: Google did not return nextSyncToken for channel ${channelId}; future runs will remain full sync`,
      );
    }

    return { synced, skipped, deleted };
  }

  // ── Path 2: incremental using stored cursor ───────────────────────────────
  console.log(
    `[incrementalSync] Using syncToken for channel ${channelId} (user=${userId})`,
  );

  try {
    const { events: rawEvents, nextSyncToken } =
      await fetchGoogleEventsIncremental(
        userId,
        storedToken,
        calendarId,
        accountId,
      );

    // Load classification rules once for this incremental batch.
    const rules = await loadActiveRules(userId, "google");

    // Upsert all events BEFORE advancing the cursor so that a crash between
    // upserts and setSyncToken causes a safe re-run from the same point.
    const { synced, skipped, deleted } = await upsertAll(
      rawEvents,
      userId,
      "google",
      rules,
      calendarId,
      accountId,
    );

    // Advance cursor only after all upserts in this batch succeed.
    if (nextSyncToken) {
      await setSyncToken(channelId, nextSyncToken);
    }

    console.log(
      `📅 Incremental sync complete for user ${userId}: ${synced} synced, ${skipped} skipped, ${deleted} deleted`,
    );

    return { synced, skipped, deleted };
  } catch (err) {
    // ── Path 3: 410 Gone → clear cursor, signal caller to full-resync ────────
    if (err instanceof GoogleSyncTokenExpiredError) {
      console.warn(
        `[incrementalSync] 410 Gone for channel ${channelId} — clearing cursor`,
      );
      await clearSyncToken(channelId);
      throw new FullResyncRequiredError(channelId, calendarId, userId);
    }
    throw err;
  }
}

// ─── Manual sync entry point ───────────────────────────────────────────────

/**
 * Used by the manual POST /calendar/sync route and any caller without an
 * explicit watch-channel context.
 *
 * Strategy:
 *  1. Pick the user's most-recently-updated Google watch channel, preferring
 *     rows that already have a stored syncToken.
 *  2. If a token is present → incremental sync via that channel (fast path),
 *     with automatic full-sync fallback on 410 cursor expiry.
 *  3. If a channel exists but has no token → run one full sync and seed the
 *     cursor for subsequent incremental runs.
 *  4. If no channel exists → full time-window sync.
 *
 * This prevents manual sync from repeatedly re-downloading the full window.
 */
export async function syncUserCalendar(
  userId: string,
  provider: "google",
  since?: string,
  googleAccountId?: string | null,
): Promise<{ synced: number; skipped: number; deleted: number }> {
  if (provider !== "google") {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  // Prefer the most recently updated channel for this user (scoped to the
  // requested account when one is given — full multi-account behaviour).
  // We intentionally do NOT require expiration > now() for manual sync because
  // syncToken validity is independent of watch-channel webhook expiry.
  const { query } = await import("../../config/db");
  const row = await query<{
    channel_id: string;
    calendar_id: string;
    sync_token: string | null;
    google_account_id: string | null;
  }>(
    `SELECT channel_id, calendar_id, sync_token, google_account_id
       FROM google_watch_channels
      WHERE user_id = $1
        AND ($2::uuid IS NULL OR google_account_id = $2)
      ORDER BY (sync_token IS NOT NULL) DESC, updated_at DESC
      LIMIT 1`,
    [userId, googleAccountId ?? null],
  ).catch(
    () =>
      ({
        rows: [] as {
          channel_id: string;
          calendar_id: string;
          sync_token: string | null;
          google_account_id: string | null;
        }[],
      }),
  );

  const preferredChannel = row.rows[0];
  // Use the channel's own account when we didn't pin one explicitly.
  const accountId = googleAccountId ?? preferredChannel?.google_account_id ?? null;

  if (preferredChannel?.sync_token) {
    const { channel_id: channelId, calendar_id: calendarId } = preferredChannel;
    console.log(
      `[syncUserCalendar] Incremental path via channel=${channelId} for user=${userId}`,
    );
    try {
      return await incrementalSync(userId, channelId, calendarId, accountId);
    } catch (err) {
      if (!(err instanceof FullResyncRequiredError)) {
        throw err;
      }

      console.log(
        `[syncUserCalendar] Incremental cursor expired — falling back to full sync for user=${userId}`,
      );

      const { synced, skipped, deleted, nextSyncToken } = await fullSync(
        userId,
        provider,
        since,
        calendarId,
        accountId,
      );
      if (nextSyncToken) {
        await setSyncToken(channelId, nextSyncToken);
      }
      return { synced, skipped, deleted };
    }
  }

  if (preferredChannel) {
    const { channel_id: channelId, calendar_id: calendarId } = preferredChannel;
    console.log(
      `[syncUserCalendar] Channel found without syncToken — full sync + seed cursor for user=${userId}`,
    );

    const { synced, skipped, deleted, nextSyncToken } = await fullSync(
      userId,
      provider,
      since,
      calendarId,
      accountId,
    );
    if (nextSyncToken) {
      await setSyncToken(channelId, nextSyncToken);
    }
    return { synced, skipped, deleted };
  }

  console.log(
    `[syncUserCalendar] No channel found — full sync for user=${userId}`,
  );
  const { synced, skipped, deleted } = await fullSync(
    userId,
    provider,
    since,
    "primary",
    accountId,
  );
  return { synced, skipped, deleted };
}
