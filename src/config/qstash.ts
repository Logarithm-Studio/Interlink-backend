import { Client, Receiver } from "@upstash/qstash";

let _client: Client | null = null;
let _receiver: Receiver | null = null;
let keyRefreshInFlight: Promise<Receiver | null> | null = null;
let nextKeyRefreshAt = 0;

export function getQStashClient(): Client {
  if (_client) return _client;
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error("QSTASH_TOKEN must be set");
  _client = new Client({ token });
  return _client;
}

export function getQStashReceiver(): Receiver {
  if (_receiver) return _receiver;
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current || !next) {
    throw new Error(
      "QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY must be set",
    );
  }
  _receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next });
  return _receiver;
}

/** Recover stale deployment keys from the publisher's authenticated account. */
export async function refreshQStashReceiver(): Promise<Receiver | null> {
  if (keyRefreshInFlight) return keyRefreshInFlight;
  const token = process.env.QSTASH_TOKEN;
  if (!token || Date.now() < nextKeyRefreshAt) return null;
  nextKeyRefreshAt = Date.now() + 5 * 60_000;
  keyRefreshInFlight = (async () => {
    try {
      const response = await fetch("https://qstash.upstash.io/v2/keys", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return null;
      const keys = await response.json() as { current?: unknown; next?: unknown } | null;
      if (typeof keys?.current !== "string" || !keys.current.trim() || typeof keys.next !== "string" || !keys.next.trim()) return null;
      _receiver = new Receiver({ currentSigningKey: keys.current.trim(), nextSigningKey: keys.next.trim() });
      return _receiver;
    } catch { return null; }
  })();
  try { return await keyRefreshInFlight; }
  finally { keyRefreshInFlight = null; }
}
