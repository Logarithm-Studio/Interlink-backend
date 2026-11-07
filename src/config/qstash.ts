import { Client, Receiver } from "@upstash/qstash";

let _client: Client | null = null;
let _receiver: Receiver | null = null;
let keyRefreshInFlight: Promise<Receiver | null> | null = null;
let nextKeyRefreshAt = 0;

const qstashUrl = () => (process.env.QSTASH_URL?.trim() || "https://qstash-eu-central-1.upstash.io").replace(/\/$/, "");

export class QStashKeyLookupError extends Error {
  constructor(code: string, readonly diagnostic: { upstreamStatus?: number; errorType?: string; causeCode?: string }) {
    super(code);
  }
}

export function getQStashClient(): Client {
  if (_client) return _client;
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token) throw new Error("QSTASH_TOKEN must be set");
  _client = new Client({ token, baseUrl: qstashUrl(), devMode: false });
  return _client;
}

export function getQStashReceiver(): Receiver {
  if (_receiver) return _receiver;
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY?.trim();
  const next = process.env.QSTASH_NEXT_SIGNING_KEY?.trim();
  if (!current || !next) {
    throw new Error(
      "QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY must be set",
    );
  }
  _receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next, devMode: false });
  return _receiver;
}

/** Recover stale deployment keys from the publisher's authenticated account. */
export async function refreshQStashReceiver(): Promise<Receiver | null> {
  if (keyRefreshInFlight) return keyRefreshInFlight;
  const token = process.env.QSTASH_TOKEN?.trim();
  if (!token || Date.now() < nextKeyRefreshAt) return null;
  nextKeyRefreshAt = Date.now() + 5 * 60_000;
  keyRefreshInFlight = (async () => {
    try {
      const response = await fetch(`${qstashUrl()}/v2/keys`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new QStashKeyLookupError(response.status === 401 || response.status === 403 ? "WORKER_PUBLISHER_UNAUTHORIZED" : "WORKER_KEY_LOOKUP_UNAVAILABLE", { upstreamStatus: response.status });
      const keys = await response.json() as { current?: unknown; next?: unknown } | null;
      if (typeof keys?.current !== "string" || !keys.current.trim() || typeof keys.next !== "string" || !keys.next.trim()) throw new Error("WORKER_KEY_RESPONSE_INVALID");
      _receiver = new Receiver({ currentSigningKey: keys.current.trim(), nextSigningKey: keys.next.trim(), devMode: false });
      return _receiver;
    } catch (error) {
      if (error instanceof Error && ["WORKER_PUBLISHER_UNAUTHORIZED", "WORKER_KEY_LOOKUP_UNAVAILABLE", "WORKER_KEY_RESPONSE_INVALID"].includes(error.message)) throw error;
      const errorType = error instanceof Error && ["TypeError", "ReferenceError", "TimeoutError", "AbortError", "SyntaxError"].includes(error.name) ? error.name : "UnknownError";
      const cause = error instanceof Error ? (error as Error & { cause?: { code?: unknown } }).cause : undefined;
      const causeCode = typeof cause?.code === "string" && ["ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ERR_INVALID_CHAR", "ERR_INVALID_HTTP_TOKEN", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(cause.code) ? cause.code : undefined;
      throw new QStashKeyLookupError("WORKER_KEY_LOOKUP_UNAVAILABLE", { errorType, ...(causeCode ? { causeCode } : {}) });
    }
  })();
  try { return await keyRefreshInFlight; }
  finally { keyRefreshInFlight = null; }
}
