import assert from "node:assert/strict";
import test from "node:test";
import { transcribeAudio } from "./multimodal.service";
import { MAX_ASSISTANT_ATTACHMENT_BYTES, prepareAssistantAttachment } from "./attachment.service";

test("voice transcription reserves output for the transcript and reports provider outages", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  const provider = process.env.PROFESSIONAL_AI_PROVIDER;
  process.env.GEMINI_API_KEY = "fixture";
  process.env.PROFESSIONAL_AI_PROVIDER = "gemini";
  let fail = false;
  globalThis.fetch = (async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
    assert.ok(body.generationConfig.maxOutputTokens >= 2048);
    if (fail) return new Response("Provider unavailable", { status: 503 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ text: "Create a reviewed launch task." }) }] } }] }));
  }) as typeof fetch;
  try {
    assert.equal((await transcribeAudio("Zml4dHVyZQ==", "audio/mp4")).text, "Create a reviewed launch task.");
    fail = true;
    await assert.rejects(transcribeAudio("Zml4dHVyZQ==", "audio/mp4"), /transcription.*unavailable/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalKey;
    if (provider === undefined) delete process.env.PROFESSIONAL_AI_PROVIDER; else process.env.PROFESSIONAL_AI_PROVIDER = provider;
  }
});

test("inline attachments fit the hosted transport and malformed bytes cannot become document context", () => {
  assert.equal(MAX_ASSISTANT_ATTACHMENT_BYTES, 3 * 1024 * 1024);
  const tooLarge = prepareAssistantAttachment({ data: Buffer.alloc(MAX_ASSISTANT_ATTACHMENT_BYTES + 1).toString("base64"), mimeType: "application/pdf", name: "large.pdf" });
  assert.equal(tooLarge.ok, false);
  if (!tooLarge.ok) assert.match(tooLarge.message, /3 MB/);
  assert.equal(prepareAssistantAttachment({ data: "not@@valid-base64", mimeType: "image/png", name: "broken.png" }).ok, false);
});
