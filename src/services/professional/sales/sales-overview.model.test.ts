import test from "node:test";
import assert from "node:assert/strict";
import { buildSalesOverview, formatSalesAmounts } from "./sales-overview.model";
import type { SalesDeal } from "./sales.service";

const now = new Date("2026-10-17T00:00:00Z").getTime();
function deal(id: string, currency: string, amountCents: number, stage: SalesDeal["stage"] = "lead", createdAt = "2026-09-01T00:00:00Z"): SalesDeal {
  return { id, currency, amountCents, stage, title: id, company: null, contactId: null,
    marketingCampaignId: null, contactName: null, closeDate: null, notes: null,
    ownerRep: null, lastActivityAt: null, source: "manual", createdAt: new Date(createdAt) };
}

test("overview separates currencies and legacy dollar totals contain USD only", () => {
  const result = buildSalesOverview([
    deal("usd-open", "USD", 20025), deal("bdt-open", "BDT", 90000),
    deal("bdt-won", "BDT", 50000, "won"), deal("usd-won", "USD", 12345, "won"),
    deal("lost", "USD", 999999, "lost"),
  ], [], now);
  assert.deepEqual(result.pipelineByCurrency, [{ currency: "BDT", amountCents: 90000 }, { currency: "USD", amountCents: 20025 }]);
  assert.deepEqual(result.wonByCurrency, [{ currency: "BDT", amountCents: 50000 }, { currency: "USD", amountCents: 12345 }]);
  assert.equal(result.pipelineValueCents, 20025); assert.equal(result.wonValueCents, 12345);
  assert.equal(result.openCount, 2);
  assert.match(result.briefing, /BDT 900 \+ USD 200\.25/);
  assert.deepEqual(result.stageBreakdown.find((stage) => stage.stage === "won")?.valuesByCurrency, result.wonByCurrency);
});

test("BDT-only wins are never represented as dollars", () => {
  const result = buildSalesOverview([deal("qa-bdt", "BDT", 50000, "won")], [], now);
  assert.equal(result.wonValueCents, 0);
  assert.equal(formatSalesAmounts(result.wonByCurrency), "BDT 500");
});

test("stale deals rank by inactivity instead of incomparable currency amounts", () => {
  const result = buildSalesOverview([
    deal("large-newer", "JPY", 90000000, "qualified", "2026-09-20T00:00:00Z"),
    deal("small-older", "BDT", 100, "lead", "2026-09-01T00:00:00Z"),
    deal("fresh", "USD", 900000000, "lead", "2026-10-16T00:00:00Z"),
  ], [], now);
  assert.deepEqual(result.atRisk.map((item) => [item.id, item.currency]), [["small-older", "BDT"], ["large-newer", "JPY"]]);
});

test("empty overview has explicit zero totals without inventing a currency conversion", () => {
  const result = buildSalesOverview([], [], now);
  assert.deepEqual(result.pipelineByCurrency, []); assert.deepEqual(result.wonByCurrency, []);
  assert.equal(result.pipelineValueCents, 0); assert.equal(result.openCount, 0);
  assert.equal(result.briefing, "0 open deal(s) worth USD 0; 0 need attention.");
});
