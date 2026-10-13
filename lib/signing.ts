import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function secret(): string {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error("APP_SECRET must be set (at least 16 characters)");
  return s;
}

/**
 * The secret that signed links before the last rotation (doc/08-deployment.md section 9). It only VERIFIES: everything new is
 * signed with APP_SECRET. Ignored when unset, shorter than 16 characters or equal to APP_SECRET.
 */
function previousSecret(current: string): string | null {
  const s = process.env.APP_SECRET_PREVIOUS;
  return s && s.length >= 16 && s !== current ? s : null;
}

function mac(purpose: string, body: string, key: string): Buffer {
  // The purpose is mixed in so a signature minted for one use can never be replayed for another.
  return createHmac("sha256", key).update(`${purpose}:${body}`).digest();
}

/** `<base64url(json)>.<base64url(hmac)>`, expiring `ttlSec` from now. */
export function signToken(purpose: string, data: Record<string, unknown>, ttlSec: number, key = secret()): string {
  const body = Buffer.from(JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSec })).toString("base64url");
  return `${body}.${mac(purpose, body, key).toString("base64url")}`;
}

/**
 * Returns the payload if the signature is valid and not expired, otherwise null. Without an explicit `key` a token signed
 * with APP_SECRET_PREVIOUS is accepted too, so links already sent survive a rotation of APP_SECRET.
 */
export function verifyToken<T extends Record<string, unknown>>(
  purpose: string,
  token: string | null | undefined,
  key?: string,
): (T & { exp: number }) | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const given = Buffer.from(sig, "base64url");
  const current = key ?? secret();
  const keys = key !== undefined ? [key] : [current, ...(previousSecret(current) ? [previousSecret(current)!] : [])];
  const signedBy = keys.some((k) => {
    const expected = mac(purpose, body, k);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!signedBy) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
    return typeof data.exp === "number" && data.exp > Date.now() / 1000 ? data : null;
  } catch {
    return null;
  }
}

export function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
