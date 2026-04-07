/**
 * `calendar_reschedule` workflow step — reschedules a Google Calendar event.
 *
 * Expects the resume payload (from the prior `wait_for_input` step) to contain:
 *   - `eventId`   — internal DB UUID of the event to reschedule
 *   - `startTime` — new start time (ISO-8601)
 *   - `endTime`   — new end time (ISO-8601)
 *   - `title`     — optional new title
 *   - `description` — optional new description
 *   - `calendarId`  — optional (defaults to "primary")
 *
 * The step also reads the user's email from the DB and verifies the user is
 * the organizer. Only Google events are supported; other providers throw.
 *
 * The step config supports an explicit `nextStepId` to override linear ordering.
 */

import { query } from "../../config/db";
import { patchGoogleEvent } from "../../services/calendar/google";
import { upsertEvent, getEventById } from "../../services/events.service";
import { clearConflictsByEventId } from "../../services/conflicts.service";
import type { StepContext, StepResult } from "../registry";

interface RescheduleConfig {
  nextStepId?: string;
}

export async function calendarRescheduleHandler(
  ctx: StepContext,
): Promise<StepResult> {
  const config = ctx.stepDefinition.config as RescheduleConfig;

  // The resume payload comes from the prior wait_for_input step or is merged
  // into execution context by the engine when the user submits their action.
  const payload =
    ctx.resumePayload ??
    (ctx.executionContext.outputs as Record<string, Record<string, unknown>>)?.[
      "reschedule_input"
    ] ??
    {};

  const eventId = (payload.eventId ?? payload.event_id) as string | undefined;
  const startTime = (payload.startTime ?? payload.start_time) as
    | string
    | undefined;
  const endTime = (payload.endTime ?? payload.end_time) as string | undefined;

  if (!eventId || !startTime || !endTime) {
    throw new Error(
      `calendar_reschedule step ${ctx.stepId}: missing required fields ` +
        "(eventId, startTime, endTime) in resume payload.",
    );
  }

  // Validate that the chosen event is actually one of the conflicting events
  // from the trigger — prevents the user from rescheduling an arbitrary event.
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
      `calendar_reschedule step ${ctx.stepId}: eventId "${eventId}" is not ` +
        "one of the conflicting events in this workflow. " +
        `Valid IDs: ${conflictingEvents.join(", ")}`,
    );
  }
  const event = await getEventById(ctx.userId, eventId);
  if (!event) {
    throw new Error(
      `calendar_reschedule step ${ctx.stepId}: event ${eventId} not found ` +
        "for this user.",
    );
  }

  if (event.provider !== "google") {
    throw new Error(
      `calendar_reschedule step ${ctx.stepId}: only Google events supported.`,
    );
  }

  // Verify organizer
  const userRes = await query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1 LIMIT 1",
    [ctx.userId],
  );
  const userEmail = userRes.rows[0]?.email ?? "";
  const organizer = (event.organizerEmail ?? "").toLowerCase();
  if (organizer && organizer !== userEmail.toLowerCase()) {
    throw new Error(
      `calendar_reschedule step ${ctx.stepId}: user is not the organizer ` +
        "and cannot reschedule this event.",
    );
  }

  const title = (payload.title as string) ?? event.title;
  const description =
    payload.description !== undefined
      ? (payload.description as string | null)
      : event.description;
  const calendarId = (payload.calendarId as string) ?? "primary";

  // Patch on Google
  await patchGoogleEvent(ctx.userId, event.externalEventId, {
    startTime,
    endTime,
    title,
    description,
    calendarId,
  });

  // Update local DB
  const updated = {
    ...event,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    title,
    description: description ?? null,
  };
  await upsertEvent(updated);

  // Immediately clear all conflict rows that involved this event so the
  // conflicts list reflects the user's action without waiting for the worker.
  await clearConflictsByEventId(ctx.userId, eventId);

  console.log(
    `[workflow:calendar_reschedule] event=${eventId} rescheduled | ` +
      `execution=${ctx.executionId} step=${ctx.stepId}`,
  );

  return {
    output: {
      eventId,
      previousStart: event.startTime,
      previousEnd: event.endTime,
      newStart: startTime,
      newEnd: endTime,
      title,
      rescheduled: true,
    },
    nextStepId: config.nextStepId,
  };
}
