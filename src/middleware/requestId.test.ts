import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveRequestPath } from "./requestId";

test("redacts public activation link tokens from request log paths", () => {
  const token = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEFG";
  assert.equal(redactSensitiveRequestPath(`/api/v1/marketing/activation-visit/${token}`), "/api/v1/marketing/activation-visit/:token");
  assert.equal(redactSensitiveRequestPath("/api/v1/marketing/activations/123/tracked-link"), "/api/v1/marketing/activations/123/tracked-link");
});
