import assert from "node:assert/strict";
import test from "node:test";
import { buildMarketingActivationTrackedUrl, resolveMarketingPublicBase, safeActivationRedirectTarget } from "./activation-link.model";

test("public activation links prefer the explicit public origin and require HTTPS in production", () => {
  assert.equal(resolveMarketingPublicBase({ PUBLIC_BASE_URL: "https://marketing.example/path", API_BASE_URL: "http://localhost:5000", NODE_ENV: "production" }), "https://marketing.example");
  assert.equal(resolveMarketingPublicBase({ API_BASE_URL: "http://localhost:5000", NODE_ENV: "development" }), "http://localhost:5000");
  assert.equal(resolveMarketingPublicBase({ API_BASE_URL: "http://internal.example", NODE_ENV: "production" }), null);
  assert.equal(resolveMarketingPublicBase({ VERCEL_PROJECT_PRODUCTION_URL: "interlink.example", NODE_ENV: "production" }), "https://interlink.example");
});

test("tracked links use an opaque path under the configured backend origin", () => {
  assert.equal(buildMarketingActivationTrackedUrl("https://api.example", "opaque_token-123"), "https://api.example/api/v1/marketing/activation-visit/opaque_token-123");
});

test("redirect targets reject non-web protocols and credential-bearing URLs", () => {
  assert.equal(safeActivationRedirectTarget("https://events.example/register?source=interlink"), "https://events.example/register?source=interlink");
  assert.equal(safeActivationRedirectTarget("http://events.example/register"), "http://events.example/register");
  assert.equal(safeActivationRedirectTarget("javascript:alert(1)"), null);
  assert.equal(safeActivationRedirectTarget("https://user:pass@events.example/"), null);
  assert.equal(safeActivationRedirectTarget("not a URL"), null);
});
