import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeAgentActionRequest, requestsAttachmentAnalysisOnly } from "./agent-intent";

test("record questions and negated writes never force an unrelated write tool", () => {
  for (const request of ["Did the campaign actually get saved? Give me its exact saved record ID and status. Read the saved campaign; do not create another draft.", "List my connected Facebook Pages. Do not publish anything.", "Summarize my open pipeline.", "What is the status of my invoice?", "Do not send a message.", "Show me the draft campaign."]) {
    assert.equal(looksLikeAgentActionRequest(request), false, request);
  }
});

test("only explicit no-action attachment analysis narrows the workflow catalog", () => {
  for (const request of ["Summarize this attached brief in two sentences.", "Analyse the attached file.", "Review this brief and explain its assumptions.", "Summarize this attached brief in two sentences. Do not create or change anything.", "Please analyse this file. Read-only.", "Review this brief. Don't perform any actions."]) assert.equal(requestsAttachmentAnalysisOnly(request), true, request);
  for (const request of ["Summarize this and save a campaign draft.", "Create the opportunity described in the file.", "Draft an email but do not send it.", "Review this resume and schedule an interview.", "Summarize this report, then email it to me.", "Summarize the brief and save a local draft. Do not publish anything."]) assert.equal(requestsAttachmentAnalysisOnly(request), false, request);
});
test("explicit reviewed action requests can still request a tool", () => {
  for (const request of ["Create a campaign draft", "Please add a contact", "Can you schedule a meeting?", "I want you to draft a follow-up", "Using this attached PRD, create exactly two Jira issues.", "Based on this brief, save a local campaign.", "Save a local ticket.", "Do not publish anything. Create a local draft."]) {
    assert.equal(looksLikeAgentActionRequest(request), true, request);
  }
});
