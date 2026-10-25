import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkerOrigin } from "./workerOrigin";

test("production workers use the stable project domain instead of an old tunnel", () => {
  assert.equal(resolveWorkerOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "interlink-backend.vercel.app", VERCEL_URL: "release.vercel.app", API_BASE_URL: "https://old.ngrok-free.dev" }), "https://interlink-backend.vercel.app");
});
test("preview workers stay on their own deployment instead of calling production", () => {
  assert.equal(resolveWorkerOrigin({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "interlink-backend.vercel.app", VERCEL_URL: "preview.vercel.app", API_BASE_URL: "https://interlink-backend.vercel.app" }), "https://preview.vercel.app");
});
test("local workers preserve the explicitly configured callback origin", () => {
  assert.equal(resolveWorkerOrigin({ API_BASE_URL: "http://localhost:5000/" }), "http://localhost:5000");
  assert.equal(resolveWorkerOrigin({ API_BASE_URL: "https://current.ngrok-free.dev" }), "https://current.ngrok-free.dev");
  assert.equal(resolveWorkerOrigin({}), undefined);
});
test("worker callbacks reject credential-bearing, insecure or path-prefixed origins", () => {
  for (const API_BASE_URL of ["https://user:password@example.com", "http://example.com", "https://example.com/api", "https://example.com/?secret=value", "https://example.com/#fragment", "not a url"]) {
    assert.throws(() => resolveWorkerOrigin({ API_BASE_URL }));
  }
});
