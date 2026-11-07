import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import express from "express";
import { verifyQStash } from "./qstashVerify";
import { getQStashReceiver, refreshQStashReceiver } from "../config/qstash";

test("production worker verification separates missing configuration and binds raw bytes to the destination", async () => {
  const saved = { ...process.env };
  const originalFetch = global.fetch;
  process.env.NODE_ENV = "production";
  process.env.API_BASE_URL = "https://workers.example.invalid";
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
  delete process.env.QSTASH_TOKEN;
  delete process.env.QSTASH_URL;
  const key = "controlled-worker-signing-key";
  const body = '{ "probe": true }';
  function sign(path: string, input = body, secret = key) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "Upstash", sub: process.env.API_BASE_URL + path, exp: now + 60, nbf: now - 5, body: createHash("sha256").update(input).digest("base64url") })).toString("base64url");
    return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
  }
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8"); } }));
  app.use(verifyQStash);
  let executions = 0;
  app.post("/one", (_req, res) => { executions++; res.json({ ok: true }); });
  app.post("/two", (_req, res) => { executions++; res.json({ ok: true }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  async function post(path: string, signature?: string, input = body, expectedCode?: string, expectedReason?: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "upstash-signature": signature } : {}) }, body: input });
    const result = await response.json();
    if (expectedCode) assert.equal(result.code, expectedCode);
    if (expectedReason) assert.equal(result.reason, expectedReason);
    return response.status;
  }
  try {
    assert.equal(await post("/one"), 401);
    assert.equal(await post("/one", sign("/one")), 503, "missing deployment keys are an unavailable worker, not an invalid caller");
    process.env.QSTASH_CURRENT_SIGNING_KEY = ` ${key}\n`;
    process.env.QSTASH_NEXT_SIGNING_KEY = `\n${key}-next `;
    process.env.QSTASH_DEV = "true";
    assert.equal(await post("/one", sign("/one")), 200);
    assert.equal(await post("/one", sign("/one", body, key + "-next")), 200);
    assert.equal(await post("/one", sign("/one"), '{"probe":true}', "WORKER_BODY_MISMATCH"), 401);
    assert.equal(await post("/two", sign("/one"), body, "WORKER_DESTINATION_MISMATCH"), 401, "a signed job cannot be replayed against another worker");
    assert.equal(await post("/one", sign("/one", body, "wrong-key"), body, "WORKER_SIGNATURE_INVALID", "signature_mismatch"), 401);
    const receiver = getQStashReceiver();
    const verify = receiver.verify;
    try {
      receiver.verify = async () => { throw new ReferenceError("crypto is not defined"); };
      assert.equal(await post("/one", sign("/one"), body, "WORKER_CRYPTO_UNAVAILABLE"), 503);
    } finally { receiver.verify = verify; }
    assert.equal(executions, 2);
    let keyReads = 0;
    process.env.QSTASH_TOKEN = "\ncontrolled-publisher-token ";
    global.fetch = async (input, init) => {
      if (String(input) !== "https://qstash-eu-central-1.upstash.io/v2/keys") return originalFetch(input, init);
      keyReads++;
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer controlled-publisher-token");
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(JSON.stringify({ current: key + "-rotated", next: key + "-rotated-next" }));
    };
    assert.deepEqual(await Promise.all([
      post("/one", sign("/one", body, key + "-rotated")),
      post("/two", sign("/two", body, key + "-rotated")),
    ]), [200, 200], "rotated provider keys recover signed jobs without disabling verification");
    assert.equal(keyReads, 1, "concurrent recovery shares one authenticated key lookup");
    assert.equal(await post("/one", sign("/one", body, key + "-rotated"), '{"changed":true}', "WORKER_BODY_MISMATCH"), 401);
    assert.equal(await post("/two", sign("/one", body, key + "-rotated"), body, "WORKER_DESTINATION_MISMATCH"), 401);
    assert.equal(await post("/one", sign("/one", body, "attacker"), body, "WORKER_SIGNATURE_INVALID"), 401);
    assert.equal(keyReads, 1, "invalid callbacks cannot repeatedly fetch keys during the cooldown");
    assert.equal(executions, 4, "only fully verified jobs reach execution after key recovery");
    const now = Date.now;
    try {
      Date.now = () => now() + 5 * 60_000 + 1;
      global.fetch = async () => new Response("{}", { status: 401 });
      await assert.rejects(refreshQStashReceiver(), /WORKER_PUBLISHER_UNAUTHORIZED/);
      Date.now = () => now() + 10 * 60_000 + 2;
      global.fetch = async () => new Response("private upstream details", { status: 429 });
      await assert.rejects(refreshQStashReceiver(), error => {
        assert.equal((error as Error).message, "WORKER_KEY_LOOKUP_UNAVAILABLE");
        assert.deepEqual((error as Error & { diagnostic: unknown }).diagnostic, { upstreamStatus: 429 });
        return true;
      });
      Date.now = () => now() + 15 * 60_000 + 3;
      global.fetch = async () => { throw Object.assign(new TypeError("secret must not appear"), { cause: { code: "ERR_INVALID_CHAR" } }); };
      await assert.rejects(refreshQStashReceiver(), error => {
        assert.equal((error as Error).message, "WORKER_KEY_LOOKUP_UNAVAILABLE");
        assert.deepEqual((error as Error & { diagnostic: unknown }).diagnostic, { errorType: "TypeError", causeCode: "ERR_INVALID_CHAR" });
        return true;
      });
    } finally { Date.now = now; }
    assert.equal(await getQStashReceiver().verify({ signature: sign("/one", body, key + "-rotated"), body, url: process.env.API_BASE_URL + "/one" }), true, "a rejected key lookup never replaces already trusted keys");
  } finally {
    global.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
