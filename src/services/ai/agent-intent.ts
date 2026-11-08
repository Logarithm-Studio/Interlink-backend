/** Only force a tool for an explicit imperative, never merely an entity noun. */
export function looksLikeAgentActionRequest(message: string): boolean {
  const actionable = message.replace(/\b(?:do not|don't|never|avoid)\b[^.!?;\n]*/gi, " ").replace(/^[\s.!?;]+/, "").trim();
  return /^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|(?:i want|i need|i'd like)\s+you\s+to\s+)?(?:please\s+)?(?:create|add|make|send|draft|write|generate|update|assign|move|close|remind|schedule|log|post|file|enrich|route|clean|sync|release|record|mark|pay|refund)\b/i.test(actionable);
}

/** Analysis needs the source; a separate action request keeps the workflow catalog. */
export function requestsAttachmentAnalysisOnly(message: string): boolean {
  const affirmative = message.replace(/\b(?:do not|don't|never|without)\b[^.!?;\n]*/gi, " ");
  return /^\s*(?:please\s+)?(?:summari[sz]e|analy[sz]e|explain|review|compare)\b/i.test(message)
    && !/\b(?:save|export|send|email|publish|post|create|add|update|delete|assign|schedule|import|sync|route|set|mark|log|upload|share|book|cancel|remove|move)\b/i.test(affirmative);
}
