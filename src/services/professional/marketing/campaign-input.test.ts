import assert from "node:assert/strict";
import test from "node:test";
import { parseCampaignInput } from "./campaign-input";

test("campaign date errors identify the date instead of blaming a supplied topic", () => {
  assert.throws(() => parseCampaignInput({ topic: "Launch", startDate: "2026-02-30" }), /startDate.*valid calendar date/i);
});

test("campaign range and goal errors retain their actionable reason", () => {
  assert.throws(() => parseCampaignInput({ topic: "Launch", startDate: "2026-11-02", endDate: "2026-11-01" }), /endDate must be on or after startDate/);
  assert.throws(() => parseCampaignInput({ topic: "Launch", goalMetric: "closed_won_value", goalTarget: 100 }), /currency/);
});

test("campaign parsing preserves valid brief values and rejects a missing topic", () => {
  const brief = parseCampaignInput({ topic: " Launch ", startDate: "2028-02-29", channels: ["facebook", "instagram"], goalMetric: "closed_won_value", goalTarget: 100, goalCurrency: "BDT" });
  assert.equal(brief.topic, "Launch");
  assert.equal(brief.goalCurrency, "BDT");
  assert.deepEqual(brief.channels, ["facebook", "instagram"]);
  assert.throws(() => parseCampaignInput({}), /topic/i);
});
