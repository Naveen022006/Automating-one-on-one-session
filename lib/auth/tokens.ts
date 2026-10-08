import { createHash, randomBytes } from "node:crypto";

/** 32 random bytes, base64url. Used for session cookies and emailed single-use tokens. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Only this hash is stored, so a database leak does not expose usable tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
