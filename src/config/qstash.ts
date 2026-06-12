import { Client, Receiver } from "@upstash/qstash";

let _client: Client | null = null;
let _receiver: Receiver | null = null;

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
