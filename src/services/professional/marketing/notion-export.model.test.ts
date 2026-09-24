import assert from "node:assert/strict";
import test from "node:test";
import { validateMarketingNotionMapping, type MarketingNotionMapping } from "./notion-export.model";

const properties = [
  { name: "Campaign", type: "title" },
  { name: "Interlink ID", type: "rich_text" },
  { name: "Goal", type: "rich_text" },
  { name: "Starts", type: "date" },
  { name: "Budget", type: "number" },
];

test("validates required marker and optional properties against the Notion schema", () => {
  const mapping: MarketingNotionMapping = { campaignId: "Interlink ID", objective: "Goal", startDate: "Starts", budget: "Budget" };
  assert.equal(validateMarketingNotionMapping(mapping, properties), "Campaign");
});

test("rejects missing marker, incompatible field types, and duplicate property assignments", () => {
  assert.throws(() => validateMarketingNotionMapping({ campaignId: "" }, properties), /campaign ID/);
  assert.throws(() => validateMarketingNotionMapping({ campaignId: "Budget" }, properties), /compatible/);
  assert.throws(() => validateMarketingNotionMapping({ campaignId: "Interlink ID", objective: "Interlink ID" }, properties), /different/);
  assert.throws(() => validateMarketingNotionMapping({ campaignId: "Interlink ID", objective: "Campaign" }, properties), /compatible/);
});

test("rejects a database without its required title property", () => {
  assert.throws(() => validateMarketingNotionMapping({ campaignId: "Interlink ID" }, properties.slice(1)), /title property/);
});
