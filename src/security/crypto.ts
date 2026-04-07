/**
 * AES-256-GCM application-layer encryption for provider tokens.
 *
 * Each encryption call produces a fresh random 12-byte IV.
 * The 16-byte GCM authentication tag is appended to the ciphertext and stored
 * separately so integrity can be verified on decryption.
 *
 * Usage:
 *   import { encrypt, decrypt } from "./crypto";
 *   const { iv, tag, ciphertext, kid } = await encrypt("my-secret");
 *   const plaintext = await decrypt(ciphertext, iv, tag, kid);
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  CipherGCMTypes,
} from "crypto";
import { getKey } from "./keyring";

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";

export interface EncryptResult {
  /** hex-encoded 12-byte IV */
  iv: string;
  /** hex-encoded 16-byte GCM auth tag */
  tag: string;
  /** hex-encoded ciphertext */
  ciphertext: string;
  /** Key ID used to encrypt — required for decryption key lookup */
  kid: string;
}

/**
 * Encrypt `plaintext` using the active key from the keyring.
 * Returns all fields needed to store and later decrypt the value.
 */
export function encrypt(plaintext: string): EncryptResult {
  const { kid, key } = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    kid,
  };
}

/**
 * Decrypt a value previously encrypted with `encrypt()`.
 * Throws if the key ID is unknown, the tag is invalid, or decryption fails.
 */
export function decrypt(
  ciphertext: string,
  iv: string,
  tag: string,
  kid: string,
): string {
  const { key } = getKey(kid);
  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, "hex"),
  ) as ReturnType<typeof createDecipheriv> & { setAuthTag(t: Buffer): void };
  (decipher as { setAuthTag(t: Buffer): void }).setAuthTag(
    Buffer.from(tag, "hex"),
  );
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
