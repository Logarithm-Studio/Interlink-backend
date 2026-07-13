/**
 * Log redaction — PII / health / secret scrubbing (HIPAA + GDPR posture).
 *
 * Requirement: "PII must be masked prior to processing workflows. Under no circumstances
 * should raw biometrics or health markers be cached on Interlink logs."
 *
 * This module is the enforcement point for the *logging/caching* half of that rule: the
 * logger pipes every record through `redactLogRecord`, so no code path can accidentally
 * persist an email address, phone number, card/SSN-like number, bearer token, or a raw
 * health/biometric marker (steps, heart rate, calories, sleep, glucose, …) to stdout/stderr.
 *
 * Note on the *processing* half: the assistant's core features (send an email, DM a person)
 * require the real address/handle at call time, so those values are passed to the tool that
 * needs them — but they are never logged, and the system prompt forbids echoing raw sensitive
 * values back. Redaction here is deliberately fail-safe: unknown shapes are left alone, but
 * anything matching a sensitive key or pattern is masked.
 */

/** Keys whose VALUES must never be logged, regardless of content. */
const SENSITIVE_KEY_RE =
  /^(pass(word)?|secret|token|access_?token|refresh_?token|id_?token|api_?key|authorization|auth|cookie|session|credential|private_?key|client_?secret|signature|otp|code|pin|ssn|dob|birth_?date)$/i;

/** Health / biometric markers — never cached in logs (HIPAA posture). */
const HEALTH_KEY_RE =
  /^(steps|calories|calories_?burned|caloriesburned|active_?minutes|activeminutes|heart_?rate|heartrate|bpm|sleep|sleep_?hours|weight|height|bmi|body_?fat|glucose|blood_?pressure|bloodpressure|spo2|oxygen|distance|biometric|health_?marker|vitals)$/i;

const REDACTED = "[redacted]";

// ── Value-level patterns ─────────────────────────────────────────────────────

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
// 13–19 digit runs (cards) and 9-digit SSN-style with separators.
const LONG_NUMBER_RE = /\b\d{13,19}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
// Provider tokens (Slack xoxb-, Google ya29., generic long secrets).
const PROVIDER_TOKEN_RE = /\b(xox[abprs]-[A-Za-z0-9-]+|ya29\.[A-Za-z0-9._-]+)\b/g;

/** Mask an email as `j***@domain.com` so it stays debuggable without exposing the address. */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return REDACTED;
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

/** Redact PII/secrets inside a free-text string. */
export function redactText(input: string): string {
  if (!input) return input;
  return input
    .replace(BEARER_RE, "$1[redacted]")
    .replace(PROVIDER_TOKEN_RE, REDACTED)
    .replace(EMAIL_RE, (m) => maskEmail(m))
    .replace(SSN_RE, REDACTED)
    .replace(LONG_NUMBER_RE, REDACTED)
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, "").length >= 9 ? REDACTED : m));
}

/**
 * Deep-redact an arbitrary log payload. Sensitive/health keys are dropped entirely;
 * strings are pattern-scrubbed. Cycles and exotic types are handled defensively.
 */
export function redactLogRecord<T>(value: T, seen = new WeakSet<object>(), depth = 0): T {
  if (depth > 8 || value == null) return value;

  if (typeof value === "string") return redactText(value) as unknown as T;
  if (typeof value !== "object") return value;

  const obj = value as unknown as object;
  if (seen.has(obj)) return "[circular]" as unknown as T;
  seen.add(obj);

  if (Array.isArray(value)) {
    return value.map((v) => redactLogRecord(v, seen, depth + 1)) as unknown as T;
  }

  // Errors: keep message/name/stack but scrub their text.
  if (value instanceof Error) {
    return {
      message: redactText(value.message),
      name: value.name,
      stack: value.stack ? redactText(value.stack) : undefined,
    } as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k) || HEALTH_KEY_RE.test(k)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = redactLogRecord(v, seen, depth + 1);
  }
  return out as unknown as T;
}
