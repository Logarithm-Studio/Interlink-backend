import assert from "node:assert/strict";
import test from "node:test";
import { dealMarker } from "./hubspot-sync.service";

test("HubSpot deal recovery marker is deterministic and contains no UUID punctuation", () => {
  const first = dealMarker("7f4995e2-cdbf-4e9e-a4c0-1cdabc26e237");
  const second = dealMarker("7f4995e2-cdbf-4e9e-a4c0-1cdabc26e237");
  assert.equal(first, second);
  assert.match(first, /^INTERLINKDEAL[0-9A-F]{32}$/);
});
