import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasMarketingAnalyticsRefreshTarget, marketingAnalyticsRefreshRange } from "./analytics-schedule.model";

describe("Marketing analytics refresh schedule model", () => {
  it("uses a complete UTC window ending three days before today", () => {
    assert.deepEqual(marketingAnalyticsRefreshRange(30, new Date("2026-09-23T18:40:00.000Z")), {
      startDate: "2026-08-22", endDate: "2026-09-20",
    });
    assert.deepEqual(marketingAnalyticsRefreshRange(90, new Date("2026-01-02T00:05:00.000Z")), {
      startDate: "2025-10-02", endDate: "2025-12-30",
    });
  });

  it("requires at least one selected read-only provider target", () => {
    assert.equal(hasMarketingAnalyticsRefreshTarget({}), false);
    assert.equal(hasMarketingAnalyticsRefreshTarget({ stripeBalance: true }), true);
    assert.equal(hasMarketingAnalyticsRefreshTarget({ stripeBalance: false }), false);
  });
});
