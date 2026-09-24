import assert from "node:assert/strict";
import { test } from "node:test";
import { geminiGenerateContent } from "./geminiClient";

test("Google Search grounding returns the answer, unique secure sources, search queries, and suggestion widget", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalProvider = process.env.PROFESSIONAL_AI_PROVIDER;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.PROFESSIONAL_AI_PROVIDER = "gemini";
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: "Evidence summary and three creative hypotheses." }] },
        groundingMetadata: {
          webSearchQueries: ["market audience need"],
          searchEntryPoint: { renderedContent: "<div>Google Search suggestions</div>" },
          groundingChunks: [
            { web: { uri: "https://example.com/research", title: "Research source" } },
            { web: { uri: "https://example.com/research", title: "Duplicate" } },
            { web: { uri: "http://unsafe.example.com", title: "Not secure" } },
          ],
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await geminiGenerateContent({ system: "research", parts: [{ text: "Find current evidence" }], json: false, googleSearch: true });
    assert.equal(result.raw, "Evidence summary and three creative hypotheses.");
    assert.deepEqual(result.groundingSources, [{ uri: "https://example.com/research", title: "Research source" }]);
    assert.deepEqual(result.webSearchQueries, ["market audience need"]);
    assert.equal(result.searchSuggestionHtml, "<div>Google Search suggestions</div>");
    assert.deepEqual((requestBody?.tools as unknown[])[0], { google_search: {} });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalApiKey;
    if (originalProvider === undefined) delete process.env.PROFESSIONAL_AI_PROVIDER; else process.env.PROFESSIONAL_AI_PROVIDER = originalProvider;
  }
});

test("Google Search grounding leaves source collections empty when metadata is absent", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalProvider = process.env.PROFESSIONAL_AI_PROVIDER;
  process.env.GEMINI_API_KEY = "test-key";
  process.env.PROFESSIONAL_AI_PROVIDER = "gemini";
  globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Answer" }] } }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  })) as typeof fetch;
  try {
    const result = await geminiGenerateContent({ system: "research", parts: [{ text: "Find" }], json: false, googleSearch: true });
    assert.deepEqual(result.groundingSources, []);
    assert.deepEqual(result.webSearchQueries, []);
    assert.equal(result.searchSuggestionHtml, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalApiKey;
    if (originalProvider === undefined) delete process.env.PROFESSIONAL_AI_PROVIDER; else process.env.PROFESSIONAL_AI_PROVIDER = originalProvider;
  }
});
