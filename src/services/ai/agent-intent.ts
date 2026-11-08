/** Only force a tool for an explicit imperative, never merely an entity noun. */
export function looksLikeAgentActionRequest(message: string): boolean {
  const actionable = message.replace(/\b(?:do not|don't|never|avoid)\b[^.!?;\n]*/gi, " ").replace(/^[\s.!?;]+/, "").trim();
  return /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|(?:i want|i need|i'd like)\s+you\s+to\s+)?(?:please\s+)?(?:create|add|make|send|draft|write|generate|update|assign|move|close|remind|schedule|log|post|file|enrich|route|clean|sync|release|record|mark|pay|refund)\b/i.test(actionable);
}

/** Explicit no-action analysis needs the source, not the workflow catalog. */
export function requestsAttachmentAnalysisOnly(message: string): boolean {
  return /^\s*(?:please\s+)?(?:summari[sz]e|analy[sz]e|explain|review|compare)\b/i.test(message)
    && /\b(?:(?:do not|don't|never)\s+(?:(?:create|change|modify)(?:\s+or\s+(?:create|change|modify))?\s+anything|(?:perform|take|execute)\s+any\s+actions)|read[- ]only|analysis[- ]only)\b/i.test(message);
}
