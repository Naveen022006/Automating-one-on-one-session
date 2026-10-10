import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { hashToken } from "@/lib/auth/tokens";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) with node:crypto only: HMAC-SHA1, 30-second steps,
 * 6 digits, base32 secrets (RFC 4648, what authenticator apps scan or take as a manual key). Pure functions; the
 * database side (encrypted secret, replay marker, recovery codes) lives in lib/admin/mfa.ts.
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** A code is accepted from this many steps before or after the current one (clock drift, typing time). */
export const TOTP_WINDOW = 1;

/* ---------- Base32 (RFC 4648, no padding) ---------- */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Case-insensitive; spaces, dashes and `=` padding are ignored (users paste keys in groups of four). Throws on other characters. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** A new random secret: 160 bits (the HMAC-SHA1 block recommendation), as 32 base32 characters. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** `ABCD EFGH ...` for display. */
export function formatSecretForDisplay(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

/* ---------- HOTP / TOTP ---------- */

/** RFC 4226: HMAC-SHA1 over the 8-byte big-endian counter, dynamic truncation, `digits` decimal digits. */
export function hotp(key: Uint8Array, counter: number, digits = TOTP_DIGITS): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The time step (T in RFC 6238) containing `timeMs`. */
export function timeStepOf(timeMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(timeMs / 1000 / stepSeconds);
}

/** The code a correctly synced authenticator shows at `timeMs`. */
export function totpAt(secretBase32: string, timeMs: number, opts: { digits?: number; stepSeconds?: number } = {}): string {
  return hotp(base32Decode(secretBase32), timeStepOf(timeMs, opts.stepSeconds), opts.digits);
}

/** Equal-length comparison without an early exit, so timing does not reveal how many digits matched. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What a user typed as a TOTP code ("123 456", "123-456"), reduced to the 6 digits; null when it is not one. */
export function normaliseTotpInput(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(digits) ? digits : null;
}

export type TotpResult = { ok: true; step: number } | { ok: false; reason: "invalid" | "replayed" };

/**
 * Checks a code against the steps `now - window .. now + window`. Every candidate is computed and compared (no early
 * exit). `lastStep` is the last step already accepted for this secret: a code from that step or an earlier one is
 * refused as "replayed", so a code observed by someone else (shoulder-surfing, a phishing page) cannot be used again.
 * On success the caller must persist the returned `step` atomically (see lib/admin/mfa.ts).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: { now?: number; window?: number; lastStep?: number | null; digits?: number; stepSeconds?: number } = {},
): TotpResult {
  const digits = opts.digits ?? TOTP_DIGITS;
  const typed = normaliseTotpInput(code);
  if (!typed || typed.length !== digits) return { ok: false, reason: "invalid" };

  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const window = opts.window ?? TOTP_WINDOW;
  const current = timeStepOf(opts.now ?? Date.now(), opts.stepSeconds);

  let matched: number | null = null;
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    if (step < 0) continue;
    const hit = constantTimeEqual(hotp(key, step, digits), typed);
    if (hit && (matched === null || step > matched)) matched = step;
  }
  if (matched === null) return { ok: false, reason: "invalid" };
  if (opts.lastStep != null && matched <= opts.lastStep) return { ok: false, reason: "replayed" };
  return { ok: true, step: matched };
}

/** The `otpauth://` URI an authenticator app imports (as a QR code or by pasting). */
export function otpauthUri(opts: { secret: string; account: string; issuer: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ---------- Recovery codes ---------- */

export const RECOVERY_CODE_COUNT = 10;
// No 0/o/1/l/i: codes are read off a screen or paper and typed by hand.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const RECOVERY_HALF = 6;

/** `count` random single-use codes shaped like `k7m2xq-p9w3nd` (12 characters from 31, about 59 bits each). */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const seen = new Set<string>();
  while (seen.size < count) {
    let raw = "";
    for (let i = 0; i < RECOVERY_HALF * 2; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    seen.add(`${raw.slice(0, RECOVERY_HALF)}-${raw.slice(RECOVERY_HALF)}`);
  }
  return [...seen];
}

/** Lowercase, with spaces and dashes removed, so "K7M2XQ P9W3ND" and "k7m2xq-p9w3nd" are the same code. */
export function normaliseRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}

export function looksLikeRecoveryCode(input: string): boolean {
  return new RegExp(`^[a-z0-9]{${RECOVERY_HALF * 2}}$`).test(normaliseRecoveryCode(input));
}

/**
 * SHA-256 (hashToken, as for session and email tokens), mixed with the admin id so identical codes of two admins
 * never share a hash. Only this value is stored; the code itself is shown once.
 */
export function hashRecoveryCode(adminId: string, code: string): string {
  return hashToken(`admin-recovery:${adminId}:${normaliseRecoveryCode(code)}`);
}
