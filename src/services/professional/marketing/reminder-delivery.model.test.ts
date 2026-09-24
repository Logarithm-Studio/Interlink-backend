import test from "node:test";
import assert from "node:assert/strict";
import {
  canRetryMarketingReminderDelivery,
  marketingReminderDeliveryKey,
} from "./reminder-delivery.model";

test("only confirmed failed marketing reminder sends are safe to retry", () => {
  assert.equal(canRetryMarketingReminderDelivery("failed"), true);
  assert.equal(canRetryMarketingReminderDelivery("pending"), false);
  assert.equal(canRetryMarketingReminderDelivery("sending"), false);
  assert.equal(canRetryMarketingReminderDelivery("sent"), false);
  assert.equal(canRetryMarketingReminderDelivery("review"), false);
  assert.equal(canRetryMarketingReminderDelivery("review", true), true);
});

test("reminder delivery keys are stable and distinct by time and channel", () => {
  const reminderAt = new Date("2026-09-24T10:00:00.000Z");
  assert.equal(
    marketingReminderDeliveryKey("followup-1", reminderAt, "email"),
    marketingReminderDeliveryKey("followup-1", new Date(reminderAt), "email"),
  );
  assert.notEqual(
    marketingReminderDeliveryKey("followup-1", reminderAt, "email"),
    marketingReminderDeliveryKey("followup-1", reminderAt, "push"),
  );
  assert.notEqual(
    marketingReminderDeliveryKey("followup-1", reminderAt, "email"),
    marketingReminderDeliveryKey("followup-1", new Date(reminderAt.getTime() + 1), "email"),
  );
});
