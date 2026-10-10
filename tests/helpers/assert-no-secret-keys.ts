import assert from "node:assert/strict";

/**
 * The data-exposure check for every JSON view endpoint (doc/10-react-migration-plan.md, section 2.8).
 *
 * Server components only ever sent rendered markup; a JSON endpoint sends whatever object it returns, so a careless
 * `...row` can put an encrypted token, a password hash or a signing secret on the wire. Every endpoint test passes the
 * parsed response body through this function. It fails on any key, at any depth, whose NAME looks like a hash, a ciphertext,
 * a secret, a password or a token.
 *
 * `allow` lists key names that are deliberate and equal to something the old server page already embedded in its markup:
 * `pollToken` (pay view) and `token` (manage view). Anything else needs a reviewer's agreement, not a longer allow list.
 */
const SECRET_KEY = /hash|enc$|secret|password|token/i;

export function assertNoSecretKeys(value: unknown, allow: readonly string[] = [], where = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecretKeys(item, allow, `${where}[${i}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assert.ok(!SECRET_KEY.test(key) || allow.includes(key), `${where}.${key}: a key that looks like a hash, token or secret must not be sent to the browser`);
      assertNoSecretKeys(child, allow, `${where}.${key}`);
    }
  }
}
