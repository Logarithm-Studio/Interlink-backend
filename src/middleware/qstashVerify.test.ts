import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import express from "express";
import { verifyQStash } from "./qstashVerify";

test("production worker verification separates missing configuration and binds raw bytes to the destination", async () => {
  const saved = { ...process.env };
  process.env.NODE_ENV = "production";
  process.env.API_BASE_URL = "https://workers.example.invalid";
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.QSTASH_CURRENT_SIGNING_KEY;
  delete process.env.QSTASH_NEXT_SIGNING_KEY;
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
  async function post(path: string, signature?: string, input = body, expectedCode?: string) {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "upstash-signature": signature } : {}) }, body: input });
    const result = await response.json();
    if (expectedCode) assert.equal(result.code, expectedCode);
    return response.status;
  }
  try {
    assert.equal(await post("/one"), 401);
    assert.equal(await post("/one", sign("/one")), 503, "missing deployment keys are an unavailable worker, not an invalid caller");
    process.env.QSTASH_CURRENT_SIGNING_KEY = key;
    process.env.QSTASH_NEXT_SIGNING_KEY = key + "-next";
    assert.equal(await post("/one", sign("/one")), 200);
    assert.equal(await post("/one", sign("/one", body, key + "-next")), 200);
    assert.equal(await post("/one", sign("/one"), '{"probe":true}', "WORKER_BODY_MISMATCH"), 401);
    assert.equal(await post("/two", sign("/one"), body, "WORKER_DESTINATION_MISMATCH"), 401, "a signed job cannot be replayed against another worker");
    assert.equal(await post("/one", sign("/one", body, "wrong-key"), body, "WORKER_SIGNATURE_INVALID"), 401);
    assert.equal(executions, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  }
});
