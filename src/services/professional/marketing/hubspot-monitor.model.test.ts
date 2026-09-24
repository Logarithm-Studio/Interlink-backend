import assert from "node:assert/strict";
import test from "node:test";
import { changedHubSpotFields, fingerprintHubSpotProperties, mergeHubSpotReviewFields } from "./hubspot-monitor.model";

const initial = fingerprintHubSpotProperties({
  contact: { firstname: "Ada", lastname: "Lovelace", company: "Analytical Engines", jobtitle: "Mathematician", phone: null },
  deal: { dealname: "Research", dealstage: "qualified", amount: "150.00", deal_currency_code: "USD", closedate: null },
}, "unit-test-key");

test("HubSpot monitor fingerprints supported fields without storing provider values", () => {
  assert.equal(JSON.stringify(initial).includes("Ada"), false);
  assert.deepEqual(changedHubSpotFields(initial, { ...initial }), []);
  assert.notEqual(
    initial["contact.firstname"],
    fingerprintHubSpotProperties({ contact: { firstname: "Ada" }, deal: {} }, "another-unit-key")["contact.firstname"],
  );
});

test("HubSpot monitor groups related property changes into safe review fields", () => {
  const next = { ...initial, "contact.firstname": "changed", "deal.amount": "changed", "deal.deal_currency_code": "changed" };
  assert.deepEqual(changedHubSpotFields(initial, next), ["contact_name", "deal_value"]);
});

test("review queue accumulates new provider differences and clears only chosen fields", () => {
  assert.deepEqual(
    mergeHubSpotReviewFields(["contact_name", "deal_value"], ["deal_stage"], ["contact_name"]),
    ["deal_stage", "deal_value"],
  );
  assert.deepEqual(mergeHubSpotReviewFields(["unsupported"], [], []), []);
});
