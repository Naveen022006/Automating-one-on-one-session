// Pure tests of the small shared helpers the view endpoints and old pages rely on (no database).
import assert from "node:assert/strict";
import { test } from "node:test";
import { safeNextPath as viaHttp } from "../lib/http";
import { jsonify } from "../lib/jsonify";
import { safeNextPath } from "../lib/safe-next-path";
import { jsonView } from "../lib/views/http";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

test("jsonify gives exactly what the browser receives: Dates become ISO strings, undefined disappears", () => {
  const at = new Date("2026-03-04T05:06:07.000Z");
  const out = jsonify({ at, nested: { list: [at, null], skip: undefined }, n: 1 });
  assert.deepEqual(out, { at: "2026-03-04T05:06:07.000Z", nested: { list: ["2026-03-04T05:06:07.000Z", null] }, n: 1 });
  assert.equal(jsonify(undefined), undefined);
  // The type is the point: a Date method on a Jsonify'd field must not compile. (Checked by tsc through this expression.)
  const s: string = out.at;
  assert.equal(typeof s, "string");
});

test("safeNextPath lives in one place: lib/http re-exports the very same function", () => {
  assert.equal(viaHttp, safeNextPath);
  assert.equal(safeNextPath("/dashboard/sessions?x=1#a"), "/dashboard/sessions?x=1#a");
  assert.equal(safeNextPath("https://evil.example/x"), "/dashboard");
  assert.equal(safeNextPath("//evil.example"), "/dashboard");
  assert.equal(safeNextPath("/\\evil.example"), "/dashboard");
  assert.equal(safeNextPath("/a\tb"), "/dashboard");
  assert.equal(safeNextPath(undefined, "/admin"), "/admin");
});

test("jsonView sets private, no-store, never CORS, and refuses an array body", async () => {
  const res = jsonView({ ok: true }, { status: 201 });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await res.json(), { ok: true });
  assert.throws(() => jsonView([1, 2] as unknown as object), /object, not an array/);
});

test("assertNoSecretKeys fails on hash/enc/secret/password/token keys at any depth and honours the allow list", () => {
  assertNoSecretKeys({ name: "x", rows: [{ id: 1, amountMinor: 5 }], deep: { a: { b: [{ c: 1 }] } } });
  for (const bad of ["passwordHash", "tokenHash", "totpSecretEnc", "refreshTokenEnc", "apiSecret", "accessToken", "PASSWORD", "ipHash"]) {
    assert.throws(() => assertNoSecretKeys({ rows: [{ ok: 1, nested: { [bad]: "x" } }] }), new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), bad);
  }
  assert.throws(() => assertNoSecretKeys({ pollToken: "t" }));
  assertNoSecretKeys({ pollToken: "t", booking: { token: "m" } }, ["pollToken", "token"]);
  // Values are not inspected; only names are.
  assertNoSecretKeys({ note: "the password reset email was sent" });
});
