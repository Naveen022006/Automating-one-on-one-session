// Integration test: needs a migrated Postgres at DATABASE_URL (skipped otherwise).
// A truncated or mistyped link (QA-5, doc/10-react-migration-qa-customer.md) gets the "invalid or expired" answer for its token,
// not "Please check the highlighted fields." with nothing highlighted.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prisma } from "../lib/db";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

after(() => prisma.$disconnect());

test("reset-password: a short or unknown token is 'invalid or has expired', tied to the token", { skip }, async () => {
  const { POST } = await import("../app/api/auth/reset-password/route");
  for (const token of ["abc", "x".repeat(43)]) {
    const res = await POST(post("http://localhost/api/auth/reset-password", { token, password: "a-long-enough-password-1" }));
    assert.equal(res.status, 400, token);
    const body = (await res.json()) as { error: string; field?: string };
    assert.match(body.error, /invalid or has expired/, token);
    assert.equal(body.field, "token");
  }
  const empty = await POST(post("http://localhost/api/auth/reset-password", { token: "", password: "x" }));
  assert.match(((await empty.json()) as { error: string }).error, /highlighted fields/, "an empty token is still a form error");
});

test("verify-email: a short token is 'invalid, already used, or expired'", { skip }, async () => {
  const { POST } = await import("../app/api/auth/verify-email/route");
  const res = await POST(post("http://localhost/api/auth/verify-email", { token: "abc" }));
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as { error: string }).error, /invalid, already used, or expired/);
});
