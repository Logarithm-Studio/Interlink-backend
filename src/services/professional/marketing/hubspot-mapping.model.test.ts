import assert from "node:assert/strict";
import test from "node:test";
import {
  mapConfiguredHubSpotOwnerToRep,
  mapConfiguredHubSpotStageToInterlink,
  fingerprintHubSpotSyncPreview,
  pickMappedHubSpotDealStage,
} from "./hubspot-mapping.model";

const pipeline = {
  id: "pipeline-a",
  label: "Sales pipeline",
  stages: [
    { id: "stage-1", label: "New lead", metadata: { isClosed: "false", probability: "0.1" } },
    { id: "stage-2", label: "Qualified to buy", metadata: { isClosed: false, probability: "0.4" } },
    { id: "stage-won", label: "Custom success", metadata: { isClosed: "true", probability: "1.0" } },
    { id: "stage-lost", label: "Closed lost", metadata: { isClosed: true, probability: "0.0" } },
  ],
};

test("HubSpot outbound stages use configured IDs rather than matching labels or order", () => {
  assert.deepEqual(pickMappedHubSpotDealStage("lead", pipeline, { lead: "stage-2" }), {
    id: "stage-2", label: "Qualified to buy",
  });
  assert.throws(() => pickMappedHubSpotDealStage("proposal", pipeline, {}), /Map the Interlink/);
});

test("closed outcomes must map to the provider's corresponding closed stage", () => {
  assert.equal(pickMappedHubSpotDealStage("won", pipeline, { won: "stage-won" }).id, "stage-won");
  assert.equal(pickMappedHubSpotDealStage("lost", pipeline, { lost: "stage-lost" }).id, "stage-lost");
  assert.throws(() => pickMappedHubSpotDealStage("won", pipeline, { won: "stage-1" }), /closed-won/);
  assert.throws(() => pickMappedHubSpotDealStage("won", { id: "broken", stages: [{ id: "closed", metadata: { isClosed: true } }] }, { won: "closed" }), /closed-won/);
});

test("HubSpot inbound stages import only through a unique stage and selected-pipeline mapping", () => {
  const mappings = { lead: "stage-1", qualified: "stage-2" } as const;
  assert.equal(mapConfiguredHubSpotStageToInterlink("pipeline-a", "stage-2", "pipeline-a", mappings), "qualified");
  assert.equal(mapConfiguredHubSpotStageToInterlink("pipeline-b", "stage-2", "pipeline-a", mappings), null);
  assert.equal(mapConfiguredHubSpotStageToInterlink("pipeline-a", "stage-unknown", "pipeline-a", mappings), null);
  assert.equal(mapConfiguredHubSpotStageToInterlink("pipeline-a", "stage-1", "pipeline-a", { lead: "stage-1", qualified: "stage-1" }), null);
});

test("HubSpot owners map back only when one local rep owns the provider ID", () => {
  assert.equal(mapConfiguredHubSpotOwnerToRep("owner-1", { repA: "owner-1", repB: "owner-2" }), "repA");
  assert.equal(mapConfiguredHubSpotOwnerToRep("owner-x", { repA: "owner-1" }), null);
  assert.equal(mapConfiguredHubSpotOwnerToRep("owner-1", { repA: "owner-1", repB: "owner-1" }), null);
});

test("HubSpot sync confirmation fingerprints change with provider, local, or mapping values", () => {
  const preview = { deal: { stageId: "stage-1", ownerId: "owner-1" }, contact: { email: "a@example.com" } };
  const fingerprint = fingerprintHubSpotSyncPreview(preview);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprintHubSpotSyncPreview(preview), fingerprint);
  assert.notEqual(fingerprintHubSpotSyncPreview({ ...preview, deal: { ...preview.deal, stageId: "stage-2" } }), fingerprint);
});
