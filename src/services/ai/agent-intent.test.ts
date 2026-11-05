import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeAgentActionRequest } from "./agent-intent";

test("record questions and negated writes never force an unrelated write tool", () => {
  for (const request of ["Did the campaign actually get saved? Give me its exact saved record ID and status. Read the saved campaign; do not create another draft.", "List my connected Facebook Pages. Do not publish anything.", "Summarize my open pipeline.", "What is the status of my invoice?", "Do not send a message.", "Show me the draft campaign."]) {
    assert.equal(looksLikeAgentActionRequest(request), false, request);
  }
});
test("explicit reviewed action requests can still request a tool", () => {
  for (const request of ["Create a campaign draft", "Please add a contact", "Can you schedule a meeting?", "I want you to draft a follow-up", "Do not publish anything. Create a local draft."]) {
    assert.equal(looksLikeAgentActionRequest(request), true, request);
  }
});
