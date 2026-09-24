import { test } from "node:test";
import assert from "node:assert/strict";
import { canUnscheduleSocialPublish, isSocialPublishDue, isSocialPublishWithinQueueWindow, SOCIAL_PUBLISH_CLOCK_SKEW_MS, SOCIAL_PUBLISH_QUEUE_WINDOW_MS, socialPublishScheduleJobId } from "./social-scheduling.model";

test("social schedule queue window includes due and near-term posts but defers distant posts", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  assert.equal(isSocialPublishWithinQueueWindow(new Date(now.getTime() - 1), now), true);
  assert.equal(isSocialPublishWithinQueueWindow(new Date(now.getTime() + SOCIAL_PUBLISH_QUEUE_WINDOW_MS), now), true);
  assert.equal(isSocialPublishWithinQueueWindow(new Date(now.getTime() + SOCIAL_PUBLISH_QUEUE_WINDOW_MS + 1), now), false);
  assert.equal(isSocialPublishWithinQueueWindow(new Date("invalid"), now), false);
});

test("scheduled publish job keys change when a schedule generation changes", () => {
  assert.equal(socialPublishScheduleJobId("schedule-1", 3), "marketing-social-publish:schedule-1:3");
  assert.notEqual(socialPublishScheduleJobId("schedule-1", 3), socialPublishScheduleJobId("schedule-1", 4));
});

test("only waiting or queued posts can be unscheduled without provider review", () => {
  for (const status of ["pending", "dispatching", "queued"]) assert.equal(canUnscheduleSocialPublish(status), true);
  for (const status of ["publishing", "completed", "review", "cancelled"]) assert.equal(canUnscheduleSocialPublish(status), false);
});

test("a delivery slightly ahead of the slot counts as due so clock skew cannot strand a queued post", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  assert.equal(isSocialPublishDue(new Date(now.getTime() - 1), now), true);
  assert.equal(isSocialPublishDue(new Date(now.getTime() + 1_500), now), true);
  assert.equal(isSocialPublishDue(new Date(now.getTime() + SOCIAL_PUBLISH_CLOCK_SKEW_MS), now), true);
  assert.equal(isSocialPublishDue(new Date(now.getTime() + SOCIAL_PUBLISH_CLOCK_SKEW_MS + 1), now), false);
});
