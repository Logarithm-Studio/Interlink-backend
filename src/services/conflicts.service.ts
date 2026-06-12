/**
 * Conflict detection service — two-stage pipeline.
 *
 * Stage 1 (SQL)  — `fetchCandidatePairs`:
 *   Candidate pair selection via a self-join on the `events` table.
 *   The join predicate applies the user's buffer so that events that are
 *   "too close" (within `default_buffer_minutes`) are also detected.
 *
 * Stage 2 (TypeScript) — `scoreConflict`:
 *   Deterministic, side-effect-free severity scoring using:
 *   - Overlap duration (longest overlap → highest base score)
 *   - Whether the conflict is a hard overlap or only a buffer violation
 *   - Organizer priority (user is organizer → higher importance)
 *   - Required attendee weight (both events have required attendees → higher)
 *
 * Public surface:
 *   `detectConflicts(userId, from?, to?)` — used by the API route and the
 *     conflicts worker.  Loads user preferences from DB automatically.
 *   `enqueueConflictDetection(userId, rangeFrom, rangeTo)` — fire-and-forget
 *     enqueue of a `conflicts.detect` job.  Called from events.service after
 *     each upsert/delete.
 */

import { randomUUID } from "crypto";
import { query } from "../config/db";
import { enqueueJob } from "./jobQueue.service";
import { JobType } from "../jobs/schemas/envelope";
import { ConflictResult, Attendee } from "../types";

// ─── Internal types ───────────────────────────────────────────────────────────

interface CandidateRow {
  event_a_id: string;
  event_b_id: string;
  a_start: Date;
  a_end: Date;
  b_start: Date;
  b_end: Date;
  a_organizer_email: string | null;
  b_organizer_email: string | null;
  a_attendees: unknown;
  b_attendees: unknown;
  user_email: string;
  conflict_type: "overlap" | "buffer_violation";
  overlap_minutes: number;
}

interface UserPrefs {
  email: string;
  bufferMinutes: number;
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * True when at least one attendee is marked required
 * (i.e. `optional` is absent or explicitly `false`).
 */
function hasRequiredAttendees(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return (raw as Attendee[]).some((a) => a.optional !== true);
}

/**
 * Deterministic severity score mapped to a tier.
 *
 * Scoring factors (cumulative):
 *   Overlap duration (hard overlaps only):  >60 min = +3, >15 min = +2, >0 = +1
 *   Buffer violations (no raw overlap):     base +0
 *   User is organizer of either event:      +2
 *   Both events have required attendees:    +2; one has required: +1
 *
 * Tier:  score ≥ 5 → high | score ≥ 2 → medium | else → low
 */
function scoreConflict(row: CandidateRow): "high" | "medium" | "low" {
  let score = 0;

  if (row.conflict_type === "overlap") {
    const mins = Number(row.overlap_minutes);
    if (mins > 60) score += 3;
    else if (mins > 15) score += 2;
    else score += 1;
  }
  // buffer_violation contributes 0 to the base score — lower priority by design,
  // but can still reach 'medium' when organizer / attendee weights fire.

  // Organizer weight: user is the organizer of at least one conflicting event.
  const userEmail = row.user_email.toLowerCase();
  const aIsOrg = (row.a_organizer_email ?? "").toLowerCase() === userEmail;
  const bIsOrg = (row.b_organizer_email ?? "").toLowerCase() === userEmail;
  if (aIsOrg || bIsOrg) score += 2;

  // Required attendee weight.
  const aHasRequired = hasRequiredAttendees(row.a_attendees);
  const bHasRequired = hasRequiredAttendees(row.b_attendees);
  if (aHasRequired && bHasRequired) score += 2;
  else if (aHasRequired || bHasRequired) score += 1;

  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Load user email + buffer preference in a single query.
 * Falls back to bufferMinutes = 0 when no user_preferences row exists.
 */
async function getUserPrefs(userId: string): Promise<UserPrefs> {
  const result = await query<{
    email: string;
    default_buffer_minutes: number | null;
  }>(
    `SELECT u.email,
            up.default_buffer_minutes
       FROM users u
  LEFT JOIN user_preferences up ON up.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );

  if (result.rows.length === 0) {
    return { email: "", bufferMinutes: 0 };
  }

  const row = result.rows[0];
  return {
    email: row.email,
    bufferMinutes: row.default_buffer_minutes ?? 0,
  };
}

// ─── SQL stage: candidate pair selection ──────────────────────────────────────

/**
 * Fetch candidate conflict pairs using a self-join with buffer expansion.
 *
 * The JOIN ON predicate applies buffer on both sides so events within
 * `bufferMinutes` of each other are also included as buffer violations.
 *
 * The WHERE clause also expands the search window by `bufferMinutes` so
 * events just outside the requested range are not missed.
 *
 * `conflict_type` and `overlap_minutes` are computed directly in SQL.
 *
 * Parameters:
 *   $1 userId (uuid)
 *   $2 rangeFrom (ISO-8601)
 *   $3 rangeTo   (ISO-8601)
 *   $4 bufferMinutes (integer, 0–120)
 */
async function fetchCandidatePairs(
  userId: string,
  rangeFrom: string,
  rangeTo: string,
  bufferMinutes: number,
): Promise<CandidateRow[]> {
  const result = await query<CandidateRow>(
    `SELECT
       a.id                AS event_a_id,
       b.id                AS event_b_id,
       a.start_time        AS a_start,
       a.end_time          AS a_end,
       b.start_time        AS b_start,
       b.end_time          AS b_end,
       a.organizer_email   AS a_organizer_email,
       b.organizer_email   AS b_organizer_email,
       a.attendees         AS a_attendees,
       b.attendees         AS b_attendees,
       u.email             AS user_email,
       CASE
         WHEN a.start_time < b.end_time
          AND a.end_time   > b.start_time
           THEN 'overlap'
         ELSE 'buffer_violation'
       END                 AS conflict_type,
       GREATEST(0,
         EXTRACT(EPOCH FROM (
           LEAST(a.end_time, b.end_time) - GREATEST(a.start_time, b.start_time)
         )) / 60
       )                   AS overlap_minutes
     FROM events a
     JOIN events b
       ON  a.user_id = b.user_id
       AND a.id < b.id
       AND (a.start_time - ($4 * INTERVAL '1 minute'))
             < (b.end_time   + ($4 * INTERVAL '1 minute'))
       AND (a.end_time   + ($4 * INTERVAL '1 minute'))
             > (b.start_time - ($4 * INTERVAL '1 minute'))
     JOIN users u ON u.id = a.user_id
    WHERE a.user_id = $1
      AND a.is_cancelled = FALSE
      AND b.is_cancelled = FALSE
      AND a.end_time   >= ($2::timestamptz - ($4 * INTERVAL '1 minute'))
      AND a.start_time <= ($3::timestamptz + ($4 * INTERVAL '1 minute'))
      AND b.end_time   >= ($2::timestamptz - ($4 * INTERVAL '1 minute'))
      AND b.start_time <= ($3::timestamptz + ($4 * INTERVAL '1 minute'))
    ORDER BY a.start_time`,
    [userId, rangeFrom, rangeTo, bufferMinutes],
  );

  return result.rows;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect scheduling conflicts for a user within a time range.
 *
 * Automatically loads `default_buffer_minutes` from `user_preferences`.
 * Defaults to the next 14 days when no range is specified (API route default).
 *
 * Returns `ConflictResult[]` ordered by the start time of event A.
 */
export async function detectConflicts(
  userId: string,
  from?: string,
  to?: string,
): Promise<ConflictResult[]> {
  const rangeFrom = from ?? new Date().toISOString();
  const rangeTo =
    to ?? new Date(Date.now() + 14 * 24 * 60 * 60 * 1_000).toISOString();

  const prefs = await getUserPrefs(userId);
  const rows = await fetchCandidatePairs(
    userId,
    rangeFrom,
    rangeTo,
    prefs.bufferMinutes,
  );

  return rows.map((row) => ({
    conflictingEvents: [row.event_a_id, row.event_b_id] as [string, string],
    conflictType: row.conflict_type,
    severity: scoreConflict(row),
    overlapMinutes: Math.round(Number(row.overlap_minutes)),
  }));
}

// ─── Table read ───────────────────────────────────────────────────────────────

/**
 * Read active conflict pairs directly from the `conflicts` table.
 *
 * Faster than `detectConflicts` (indexed lookup vs. self-join) and returns
 * the full persisted shape including `id`, `status`, and detection timestamps.
 *
 * Data is as fresh as the last `conflicts.detect` worker pass, which fires
 * automatically after every calendar sync.
 */
export async function getActiveConflicts(
  userId: string,
): Promise<ConflictResult[]> {
  const result = await query<{
    id: string;
    event_a_id: string;
    event_b_id: string;
    conflict_type: string;
    severity: string;
    overlap_minutes: number;
    status: string;
    first_detected_at: Date;
    last_detected_at: Date;
  }>(
    `SELECT id,
            event_a_id,
            event_b_id,
            conflict_type,
            severity,
            overlap_minutes,
            status,
            first_detected_at,
            last_detected_at
       FROM conflicts
      WHERE user_id = $1
        AND status  = 'active'
      ORDER BY first_detected_at DESC`,
    [userId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    conflictingEvents: [row.event_a_id, row.event_b_id] as [string, string],
    conflictType: row.conflict_type as "overlap" | "buffer_violation",
    severity: row.severity as "high" | "medium" | "low",
    overlapMinutes: row.overlap_minutes,
    status: row.status as "active" | "cleared",
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
  }));
}

// ─── DB persistence ───────────────────────────────────────────────────────────

/**
 * Upsert all currently-active conflict pairs into the `conflicts` table and
 * mark any previously-active pairs that are NOT in the current result as
 * 'cleared'.
 *
 * Canonical pair ordering: event_a_id < event_b_id (UUID string comparison).
 * The DB has a CHECK constraint that enforces this; we sort here so we never
 * violate it regardless of the order `detectConflicts` returns the pair.
 *
 * Returns the input conflicts enriched with:
 *   - `id`               stable UUID from the `conflicts` row
 *   - `status`           always 'active' for the returned slice
 *   - `firstDetectedAt`  set on the first insertion
 *   - `lastDetectedAt`   updated every pass
 *   - `isNew`            true when the row was just inserted this pass
 *   - `severityChanged`  true when severity differs from the stored value
 */
export async function persistConflicts(
  userId: string,
  conflicts: ConflictResult[],
): Promise<
  Array<ConflictResult & { isNew: boolean; severityChanged: boolean }>
> {
  if (conflicts.length === 0) {
    // Nothing active — clear all stale rows for this user.
    await query(
      `UPDATE conflicts
          SET status     = 'cleared',
              cleared_at = now()
        WHERE user_id = $1
          AND status  = 'active'`,
      [userId],
    );
    return [];
  }

  // Upsert each active pair and collect the resulting rows.
  const enriched: Array<
    ConflictResult & { isNew: boolean; severityChanged: boolean }
  > = [];

  for (const c of conflicts) {
    // Canonical order: smaller UUID first.
    const [aId, bId] = [c.conflictingEvents[0], c.conflictingEvents[1]].sort();

    const result = await query<{
      id: string;
      severity: string;
      was_inserted: boolean;
      prev_severity: string | null;
      first_detected_at: Date;
      last_detected_at: Date;
    }>(
      `INSERT INTO conflicts
         (user_id, event_a_id, event_b_id,
          conflict_type, severity, overlap_minutes,
          status, first_detected_at, last_detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), now())
       ON CONFLICT (user_id, event_a_id, event_b_id) DO UPDATE
         SET severity         = EXCLUDED.severity,
             overlap_minutes  = EXCLUDED.overlap_minutes,
             conflict_type    = EXCLUDED.conflict_type,
             status           = 'active',
             cleared_at       = NULL,
             last_detected_at = now()
       RETURNING
         id,
         severity,
         first_detected_at,
         last_detected_at,
         -- xmax = 0 means the row was just inserted (no prior version)
         (xmax = 0)                            AS was_inserted,
         -- Capture previous severity via a subquery so we can detect changes.
         -- On insert xmax = 0 so prev_severity will equal current severity,
         -- meaning severityChanged = false for brand-new rows (correct).
         (SELECT severity FROM conflicts c2
           WHERE c2.user_id    = $1
             AND c2.event_a_id = $2
             AND c2.event_b_id = $3
             AND c2.xmin != conflicts.xmin
           LIMIT 1)                            AS prev_severity`,
      [userId, aId, bId, c.conflictType, c.severity, c.overlapMinutes],
    );

    if (result.rows.length === 0) continue;

    const row = result.rows[0];
    enriched.push({
      ...c,
      conflictingEvents: [aId, bId] as [string, string],
      id: row.id,
      status: "active",
      firstDetectedAt: row.first_detected_at,
      lastDetectedAt: row.last_detected_at,
      isNew: row.was_inserted,
      severityChanged:
        !row.was_inserted &&
        row.prev_severity !== null &&
        row.prev_severity !== c.severity,
    });
  }

  // Clear any previously-active pairs whose BOTH events fall within the
  // detection window AND were not re-detected this pass.
  //
  // Scoping the clear to the detection window prevents cross-window stomping:
  // a narrow-range pass (e.g. one rescheduled event's window) must not mark
  // pairs from other time ranges as 'cleared' just because they weren't
  // re-checked.  Explicit clearance for user actions is handled separately by
  // `clearConflictsByEventId`.
  const candidateEventIds = [
    ...new Set(
      conflicts.flatMap((c) => [
        c.conflictingEvents[0],
        c.conflictingEvents[1],
      ]),
    ),
  ];
  if (candidateEventIds.length > 0) {
    const activeIds = enriched.map((e) => e.id!);
    const eventPlaceholders = candidateEventIds
      .map((_, i) => `$${i + 2}`)
      .join(",");
    const excludeClause =
      activeIds.length > 0
        ? `AND id NOT IN (${activeIds.map((_, i) => `$${i + 2 + candidateEventIds.length}`).join(",")})`
        : "";
    await query(
      `UPDATE conflicts
          SET status     = 'cleared',
              cleared_at = now()
        WHERE user_id  = $1
          AND status   = 'active'
          AND (event_a_id IN (${eventPlaceholders})
            OR event_b_id IN (${eventPlaceholders}))
          ${excludeClause}`,
      [userId, ...candidateEventIds, ...activeIds],
    );
  }

  return enriched;
}

// ─── Explicit action-driven clearance ────────────────────────────────────────

/**
 * Mark all active conflict pairs that involve `eventId` as 'cleared'.
 *
 * Called directly from the `calendar_reschedule` and `calendar_decline`
 * workflow steps immediately after the user acts, so the conflict is removed
 * from the list the moment the action completes — without waiting for the
 * next worker pass.
 */
export async function clearConflictsByEventId(
  userId: string,
  eventId: string,
): Promise<void> {
  await query(
    `UPDATE conflicts
        SET status     = 'cleared',
            cleared_at = now()
      WHERE user_id  = $1
        AND status   = 'active'
        AND (event_a_id = $2 OR event_b_id = $2)`,
    [userId, eventId],
  );
}

// ─── Queue integration ────────────────────────────────────────────────────────

/**
 * Enqueue a `conflicts.detect` BullMQ job for a user and time range.
 *
 * Uses a 5-minute bucket of `rangeFrom` as the coalescing key, so multiple
 * event upserts in the same window produce only one detection pass.
 *
 * Safe to call fire-and-forget — errors are logged but never thrown.
 */
export async function enqueueConflictDetection(
  userId: string,
  rangeFrom: string,
  rangeTo: string,
): Promise<void> {
  const fromBucket = Math.floor(new Date(rangeFrom).getTime() / (5 * 60_000));
  const jobId = `conflicts|detect|${userId}|${fromBucket}`;

  await enqueueJob(
    "conflicts",
    {
      jobType: JobType.CONFLICTS_DETECT,
      requestId: randomUUID(),
      idempotencyKey: jobId,
      userId,
      payload: { userId, rangeFrom, rangeTo } as Record<string, unknown>,
    },
    { jobId, retries: 5 },
  );
}
