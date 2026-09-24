import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../../utils/errors";
import { getMarketingTurnstileConfig, validateMarketingTurnstile } from "./turnstile.service";

const enabledConfig = {
  enabled: true, misconfigured: false, siteKey: "site-key", secretKey: "secret-key",
};

test("Turnstile stays disabled when both optional deployment keys are absent", async () => {
  const config = getMarketingTurnstileConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.misconfigured, false);
  await validateMarketingTurnstile(undefined, "forms.example.test", config, async () => {
    throw new Error("should not call siteverify while disabled");
  });
});

test("a partial Turnstile setup is reported and fails closed", async () => {
  const config = getMarketingTurnstileConfig({ MARKETING_TURNSTILE_SITE_KEY: "site-key" });
  assert.equal(config.misconfigured, true);
  await assert.rejects(
    validateMarketingTurnstile("token", "forms.example.test", config),
    (error: unknown) => error instanceof AppError && error.statusCode === 503,
  );
});

test("enabled validation sends only the token and secret and checks the returned hostname", async () => {
  let sent: Record<string, unknown> | null = null;
  await validateMarketingTurnstile("single-use-token", "forms.example.test", enabledConfig, async (input, init) => {
    assert.equal(input, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init?.method, "POST");
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ success: true, hostname: "forms.example.test" }), { status: 200 });
  });
  assert.deepEqual(sent, { secret: "secret-key", response: "single-use-token" });
});

test("missing, rejected, or cross-host Turnstile tokens fail closed", async () => {
  const isBadRequest = (error: unknown) => error instanceof AppError && error.statusCode === 400;
  await assert.rejects(validateMarketingTurnstile(undefined, "forms.example.test", enabledConfig), isBadRequest);
  await assert.rejects(
    validateMarketingTurnstile("bad-token", "forms.example.test", enabledConfig, async () =>
      new Response(JSON.stringify({ success: false }), { status: 200 })),
    isBadRequest,
  );
  await assert.rejects(
    validateMarketingTurnstile("valid-token", "forms.example.test", enabledConfig, async () =>
      new Response(JSON.stringify({ success: true, hostname: "attacker.example" }), { status: 200 })),
    isBadRequest,
  );
});

test("Siteverify outages never accept an unvalidated submission", async () => {
  await assert.rejects(
    validateMarketingTurnstile("token", "forms.example.test", enabledConfig, async () => { throw new Error("network unavailable"); }),
    (error: unknown) => error instanceof AppError && error.statusCode === 503,
  );
});
