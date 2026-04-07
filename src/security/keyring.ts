/**
 * Key ring — maps key IDs (kid) to 32-byte AES-256 key material.
 *
 * Configuration
 * ─────────────
 * ENCRYPTION_KEY        Hex-encoded 32-byte (64 hex chars) primary key. kid="1".
 * ENCRYPTION_KEY_<KID>  Additional keys for rotation, e.g. ENCRYPTION_KEY_2.
 *
 * Key rotation
 * ────────────
 * 1. Generate a new key and set ENCRYPTION_KEY_2 (or the next KID).
 * 2. Deploy the new version — new writes use the highest-priority key.
 * 3. Re-encrypt old rows in a background job (optional but recommended).
 * 4. Once all rows are migrated, remove the old key env var.
 *
 * The active key (used for new encryptions) is the one registered with
 * `registerKey({ active: true })`. Only one active key is allowed.
 */

interface KeyEntry {
  kid: string;
  key: Buffer;
  active: boolean;
}

const _keys = new Map<string, KeyEntry>();
let _activeKid: string | null = null;
let _isInitialised = false;

/**
 * Register a key into the ring.
 * Call this at startup before any encrypt/decrypt calls.
 */
export function registerKey(entry: {
  kid: string;
  hexKey: string;
  active?: boolean;
}): void {
  if (entry.hexKey.length !== 64) {
    throw new Error(
      `[keyring] key kid="${entry.kid}" must be 64 hex chars (32 bytes); got ${entry.hexKey.length}`,
    );
  }
  const keyBuf = Buffer.from(entry.hexKey, "hex");
  if (keyBuf.length !== 32) {
    throw new Error(
      `[keyring] key kid="${entry.kid}" Buffer length must be 32`,
    );
  }
  _keys.set(entry.kid, { kid: entry.kid, key: keyBuf, active: !!entry.active });
  if (entry.active) {
    _activeKid = entry.kid;
  }
}

/**
 * Bootstrap the key ring from environment variables.
 * Called once at process startup (server.ts or worker.ts).
 *
 * Reads ENCRYPTION_KEY (kid="1") and any ENCRYPTION_KEY_<N> variants.
 */
export function initKeyring(): void {
  if (_isInitialised) {
    return;
  }

  const primaryHex = process.env.ENCRYPTION_KEY;
  if (!primaryHex) {
    throw new Error(
      "[keyring] ENCRYPTION_KEY env var is required for token encryption",
    );
  }
  registerKey({ kid: "1", hexKey: primaryHex, active: true });

  // Load rotation keys: ENCRYPTION_KEY_2, ENCRYPTION_KEY_3, ...
  for (let n = 2; n <= 10; n++) {
    const hex = process.env[`ENCRYPTION_KEY_${n}`];
    if (!hex) break;
    registerKey({ kid: String(n), hexKey: hex, active: false });
  }

  _isInitialised = true;
}

/**
 * Return the key entry for the given kid (or the active key if no kid given).
 * Throws an AppError if the key is not found.
 */
export function getKey(kid?: string): KeyEntry {
  if (kid) {
    const entry = _keys.get(kid);
    if (!entry) {
      throw new Error(
        `[keyring] No key registered for kid="${kid}". Key rotation required.`,
      );
    }
    return entry;
  }

  if (!_activeKid) {
    throw new Error(
      "[keyring] No active key configured. Call initKeyring() at startup.",
    );
  }

  const entry = _keys.get(_activeKid);
  if (!entry) {
    throw new Error(`[keyring] Active kid="${_activeKid}" not found in ring.`);
  }
  return entry;
}
