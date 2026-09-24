import assert from "node:assert/strict";
import test from "node:test";
import { mapMarketingActivationCrmOutcomes } from "./activation-outcomes.model";

test("marketing activation CRM outcomes keep currencies separate and combine signed contracts", () => {
  const result = mapMarketingActivationCrmOutcomes([
    { activation_id: "activation-a", currency: "EUR", opportunities: 1, crm_won_deals: 0, pipeline_cents: "12000", closed_won_cents: "0" },
    { activation_id: "activation-a", currency: "USD", opportunities: 2, crm_won_deals: 1, pipeline_cents: "5000", closed_won_cents: "8000" },
  ], [
    { activation_id: "activation-a", currency: "USD", signed_contract_cents: "7500" },
    { activation_id: "activation-a", currency: "EUR", signed_contract_cents: "11000" },
  ]);

  assert.deepEqual(result.get("activation-a"), {
    opportunities: 3,
    wonDeals: 1,
    pipelineByCurrency: [
      { currency: "EUR", amountCents: 12000 },
      { currency: "USD", amountCents: 5000 },
    ],
    closedWonByCurrency: [{ currency: "USD", amountCents: 8000 }],
    signedContractByCurrency: [
      { currency: "EUR", amountCents: 11000 },
      { currency: "USD", amountCents: 7500 },
    ],
  });
});

test("marketing activation CRM outcomes default missing currency amounts to empty arrays", () => {
  const result = mapMarketingActivationCrmOutcomes([
    { activation_id: "activation-b", currency: "USD", opportunities: 1, crm_won_deals: 0, pipeline_cents: "0", closed_won_cents: "0" },
  ], []);
  assert.deepEqual(result.get("activation-b"), {
    opportunities: 1, wonDeals: 0, pipelineByCurrency: [], closedWonByCurrency: [], signedContractByCurrency: [],
  });
});
