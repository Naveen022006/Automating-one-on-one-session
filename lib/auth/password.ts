import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { COMMON_PASSWORDS } from "./common-passwords";

/**
 * Password hashing with scrypt (memory-hard, built into Node, no native dependency to install).
 *
 * The spec asks for argon2id or bcrypt >= 12. scrypt is OWASP's recommended alternative when argon2id is not
 * available, and avoids shipping a native module (argon2 needs node-gyp on every deploy target). Parameters follow
 * the OWASP Password Storage Cheat Sheet (N=2^15, r=8, p=3: ~32 MiB per hash). The stored string is
 * self-describing (`scrypt$N$r$p$salt$hash`), so parameters can be raised later, or argon2id introduced, and old
 * hashes upgraded on the next successful login via `needsRehash`.
 */

const N = 2 ** 15;
const R = 8;
const P = 3;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFKC"), salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;
  const key = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    ...cost,
    maxmem: Math.max(MAXMEM, 128 * cost.N * cost.r * 2),
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** True when a stored hash uses weaker parameters than the current ones (rehash after a successful login). */
export function needsRehash(stored: string): boolean {
  const [algo, n, r, p] = stored.split("$");
  return algo !== "scrypt" || Number(n) < N || Number(r) < R || Number(p) < P;
}

/**
 * A precomputed hash of a random password. Login verifies against it when the email is unknown, so the response
 * time does not reveal whether an account exists.
 */
let dummyHash: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(18).toString("base64url"));
  return dummyHash;
}

/**
 * Returns a human-readable problem with the password, or null if it is acceptable. Rules: 10-200 characters,
 * not on the common-password list, not just the user's email/name, not one repeated character or a simple
 * keyboard/number run.
 */
export function passwordProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return "This password is too common. Choose something less predictable.";
  if (/^(.)\1+$/.test(password)) return "Do not use a single repeated character.";
  if (isSimpleRun(lower)) return "Do not use a simple sequence of keys or numbers.";
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return "Do not include your email address in the password.";
  const name = context.name?.toLowerCase().replace(/\s+/g, "");
  if (name && name.length >= 4 && lower.replace(/\s+/g, "") === name) return "Do not use your name as the password.";
  return null;
}

const RUNS = ["0123456789", "1234567890", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

function isSimpleRun(lower: string): boolean {
  const stripped = lower.replace(/[^a-z0-9]/g, "");
  if (stripped.length < 6) return false;
  return RUNS.some((run) => run.includes(stripped) || [...run].reverse().join("").includes(stripped));
}
