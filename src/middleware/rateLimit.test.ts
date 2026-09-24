import test from "node:test";
import assert from "node:assert/strict";
import { marketingFormRateLimitWindowExpiresAt } from "./rateLimit";

test("public marketing intake rate-limit window expires five minutes after its first request", () => {
  assert.equal(marketingFormRateLimitWindowExpiresAt(1_000), 1_300);
});
