import test from "node:test";
import assert from "node:assert/strict";
import { shouldResetMarketingContentApproval } from "./content-state";

test("substantive edits invalidate marketing content already under or past review", () => {
  for (const status of ["in_review", "approved", "planned"] as const) {
    assert.equal(shouldResetMarketingContentApproval(status, true), true, `${status} must be reviewed again`);
  }
});

test("draft edits and schedule-only changes do not reset approval", () => {
  assert.equal(shouldResetMarketingContentApproval("draft", true), false);
  assert.equal(shouldResetMarketingContentApproval("approved", false), false);
  assert.equal(shouldResetMarketingContentApproval("planned", false), false);
});
