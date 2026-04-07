/**
 * `calendar_decline` workflow step — declines a Google Calendar event.
 *
 * Expects the resume payload (from the prior `wait_for_input` step) to contain:
 *   - `eventId`     — internal DB UUID of the event to decline
 *   - `calendarId`  — optional (defaults to "primary")
 *
 * The step looks up the user's email, fetches the event, and calls
 * `declineGoogleEvent` which sets the user's attendee responseStatus to
 * "declined" (or deletes the event if the user is the sole organizer).
 *
 * After declining on Google, the event is deleted from the local DB so it
 * no longer appears in conflict detection.
 *
 * The step config supports an explicit `nextStepId` to override linear ordering.
 */

import { query } from "../../config/db";
import { declineGoogleEvent } from "../../services/calendar/google";
import { getEventById, deleteEvent } from "../../services/events.service";
import { clearConflictsByEventId } from "../../services/conflicts.service";
import type { StepContext, StepResult } from "../registry";

interface DeclineConfig {
  nextStepId?: string;
}

export async function calendarDeclineHandler(
  ctx: StepContext,
): Promise<StepResult> {
  const config = ctx.stepDefinition.config as DeclineConfig;

  const payload =
    ctx.resumePayload ??
    (ctx.executionContext.outputs as Record<string, Record<string, unknown>>)?.[
      "decline_input"
    ] ??
    {};

  const eventId = (payload.eventId ?? payload.event_id) as string | undefined;
  if (!eventId) {
    throw new Error(
      `calendar_decline step ${ctx.stepId}: missing required field "eventId" ` +
        "in resume payload.",
    );
  }

  // Validate that the chosen event is actually one of the conflicting events
  // from the trigger — prevents the user from declining an arbitrary event.
  const trigger = ctx.executionContext.trigger as
    | Record<string, unknown>
    | undefined;
  const conflictingEvents = (
    trigger?.conflict as Record<string, unknown> | undefined
  )?.conflictingEvents as string[] | undefined;
  if (
    conflictingEvents &&
    conflictingEvents.length > 0 &&
    !conflictingEvents.includes(eventId)
  ) {
    throw new Error(
      `calendar_decline step ${ctx.stepId}: eventId "${eventId}" is not ` +
        "one of the conflicting events in this workflow. " +
        `Valid IDs: ${conflictingEvents.join(", ")}`,
    );
  }

  const event = await getEventById(ctx.userId, eventId);
  if (!event) {
    throw new Error(
      `calendar_decline step ${ctx.stepId}: event ${eventId} not found ` +
        "for this user.",
    );
  }

  if (event.provider !== "google") {
    throw new Error(
      `calendar_decline step ${ctx.stepId}: only Google events supported.`,
    );
  }

  // Look up user email
  const userRes = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 LIMIT 1",
    [ctx.userId],
  );
  const userEmail = userRes.rows[0]?.email ?? "";

  const calendarId = (payload.calendarId as string) ?? "primary";

  // Decline on Google (patches attendee status or deletes)
  await declineGoogleEvent(
    ctx.userId,
    userEmail,
    event.externalEventId,
    calendarId,
  );

  // Remove the event from local DB
  await deleteEvent(ctx.userId, eventId);

  // Immediately clear all conflict rows that involved this event so the
  // conflicts list reflects the user's action without waiting for the worker.
  await clearConflictsByEventId(ctx.userId, eventId);

  console.log(
    `[workflow:calendar_decline] event=${eventId} declined | ` +
      `execution=${ctx.executionId} step=${ctx.stepId}`,
  );

  return {
    output: {
      eventId,
      eventTitle: event.title,
      declined: true,
      organizerEmail: event.organizerEmail,
    },
    nextStepId: config.nextStepId,
  };
}
