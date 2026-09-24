import assert from "node:assert/strict";
import test from "node:test";
import { canResolveAsProviderDraft } from "./campaign-state";

const minute = 60_000;
const start = new Date(1_000_000);

test("an in-flight send never unlocks after a single immediate provider read", () => {
  assert.equal(canResolveAsProviderDraft({
    status: "sending", providerActionStartedAt: start, providerSyncedAt: new Date(start.getTime() + 30_000),
    nowMs: start.getTime() + 31_000,
  }), false);
});

test("a recent provider check does not unlock an ambiguous send", () => {
  assert.equal(canResolveAsProviderDraft({
    status: "send_review", providerActionStartedAt: start, providerSyncedAt: new Date(start.getTime() + 3 * minute),
    nowMs: start.getTime() + 4 * minute,
  }), false);
});

test("two separated checks can resolve a settled ambiguous action as an unsent draft", () => {
  assert.equal(canResolveAsProviderDraft({
    status: "scheduling", providerActionStartedAt: start, providerSyncedAt: new Date(start.getTime() + 6 * minute),
    nowMs: start.getTime() + 9 * minute,
  }), true);
});

test("missing action timestamps never unlock a send retry", () => {
  assert.equal(canResolveAsProviderDraft({
    status: "send_review", providerActionStartedAt: null, providerSyncedAt: new Date(start.getTime() + 9 * minute),
    nowMs: start.getTime() + 12 * minute,
  }), false);
});

test("a confirmed unschedule or recoverable provider draft resolves immediately", () => {
  assert.equal(canResolveAsProviderDraft({ status: "unscheduling", providerActionStartedAt: start, providerSyncedAt: null }), true);
  assert.equal(canResolveAsProviderDraft({ status: "provider_review", providerActionStartedAt: null, providerSyncedAt: null }), true);
});
