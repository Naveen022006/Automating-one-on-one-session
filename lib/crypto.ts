import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * Parses a base64 AES-256 key: returns the 32 key bytes, or null when the value does not decode to exactly 32
 * bytes. This is deliberately the same lenient decoding the app has always used (Node's base64 decoder skips
 * characters outside the alphabet, e.g. a stray newline), so a key that works today keeps working.
 */
export function parseKeyBytes(raw: string | undefined | null): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

function loadNamedKey(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = parseKeyBytes(raw);
  if (!key) throw new Error(`${name} must be 32 bytes, base64 encoded (generate: openssl rand -base64 32)`);
  return key;
}

/** The current key: every new ciphertext is written with it. */
function loadKey(): Buffer {
  return loadNamedKey("TOKEN_ENCRYPTION_KEY");
}

/**
 * The previous key, only present during a key rotation (see doc/08-deployment.md). Decryption falls back to it so
 * a rolling deploy, where some instances already hold the new key while rows are still encrypted with the old
 * one, keeps working. Returns null when not configured.
 */
function loadPreviousKey(): Buffer | null {
  if (!process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS) return null;
  return loadNamedKey("TOKEN_ENCRYPTION_KEY_PREVIOUS");
}

/**
 * AES-256-GCM. Output is `v1.<iv>.<tag>.<ciphertext>` (base64url). `aad` is authenticated but not stored:
 * pass the owning row id so a ciphertext copied onto another row fails to decrypt.
 *
 * Always encrypts with the CURRENT key (TOKEN_ENCRYPTION_KEY) unless a key is passed explicitly.
 */
export function encryptSecret(plaintext: string, aad: string, key = loadKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ct].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

function decryptWithKey(payload: string, aad: string, key: Buffer): string {
  const [version, iv, tag, ct] = payload.split(".");
  if (version !== VERSION || !iv || !tag || !ct) throw new Error("Unrecognised encrypted payload format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/**
 * Decrypts a payload. With no `key` argument it tries the current key and then, if configured,
 * TOKEN_ENCRYPTION_KEY_PREVIOUS. An explicit `key` is used on its own (no fallback). A wrong key or a wrong `aad`
 * fails GCM authentication and throws; a malformed payload throws immediately.
 */
export function decryptSecret(payload: string, aad: string, key?: Buffer): string {
  if (key) return decryptWithKey(payload, aad, key);
  const current = loadKey();
  try {
    return decryptWithKey(payload, aad, current);
  } catch (currentError) {
    // A payload that is not even in our format will not decrypt under any key.
    if (currentError instanceof Error && currentError.message === "Unrecognised encrypted payload format") throw currentError;
    const previous = loadPreviousKey();
    if (!previous) throw currentError;
    try {
      return decryptWithKey(payload, aad, previous);
    } catch {
      // Report the failure for the current key: that is the one an operator should be looking at.
      throw currentError;
    }
  }
}

/** Like decryptSecret with one specific key, but returns null instead of throwing. Used by the rotation tool. */
export function tryDecryptSecret(payload: string, aad: string, key: Buffer): string | null {
  try {
    return decryptWithKey(payload, aad, key);
  } catch {
    return null;
  }
}
