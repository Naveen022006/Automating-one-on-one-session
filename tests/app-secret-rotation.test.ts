// APP_SECRET rotation (doc/08-deployment.md section 9): APP_SECRET_PREVIOUS only verifies, so links already sent keep working.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { validateEnv } from "../lib/env";
import { signToken, verifyToken } from "../lib/signing";

const OLD = "old-app-secret-0123456789-abcdefghijklmnop";
const NEW = "new-app-secret-0123456789-abcdefghijklmnop";
const saved = { current: process.env.APP_SECRET, previous: process.env.APP_SECRET_PREVIOUS };

const setSecrets = (current: string | undefined, previous: string | undefined) => {
  if (current === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = current;
  if (previous === undefined) delete process.env.APP_SECRET_PREVIOUS;
  else process.env.APP_SECRET_PREVIOUS = previous;
};

beforeEach(() => setSecrets(OLD, undefined));
after(() => setSecrets(saved.current, saved.previous));

test("a link signed before the rotation is accepted while APP_SECRET_PREVIOUS holds the old secret", () => {
  const before = signToken("customer-self-service", { b: "booking1" }, 3600);
  setSecrets(NEW, undefined);
  assert.equal(verifyToken("customer-self-service", before), null, "without the fallback the old link is dead");
  setSecrets(NEW, OLD);
  assert.equal(verifyToken<{ b: string }>("customer-self-service", before)?.b, "booking1");
  assert.equal(verifyToken("booking-pay", before), null, "the purpose still has to match");
});

test("everything new is signed with APP_SECRET, so it survives removing the previous secret", () => {
  setSecrets(NEW, OLD);
  const fresh = signToken("booking-pay", { b: "booking2" }, 3600);
  setSecrets(NEW, undefined);
  assert.equal(verifyToken<{ b: string }>("booking-pay", fresh)?.b, "booking2");
  setSecrets(OLD, undefined);
  assert.equal(verifyToken("booking-pay", fresh), null, "it was not signed with the old one");
});

test("the fallback never revives an expired link, and an explicit key means only that key", () => {
  const expired = signToken("customer-self-service", { b: "b3" }, -10);
  const live = signToken("customer-self-service", { b: "b3" }, 3600);
  setSecrets(NEW, OLD);
  assert.equal(verifyToken("customer-self-service", expired), null);
  assert.equal(verifyToken("customer-self-service", live, NEW), null, "an explicit key does not fall back");
  assert.ok(verifyToken("customer-self-service", live, OLD));
});

test("a previous secret that is too short or equals APP_SECRET is ignored", () => {
  const before = signToken("x", { b: "b4" }, 3600);
  setSecrets(NEW, "short");
  assert.equal(verifyToken("x", before), null);
  setSecrets(NEW, NEW);
  assert.equal(verifyToken("x", before), null);
});

test("start-up check: a rotation in progress, a too-short or an identical previous secret are warnings", () => {
  const base = { NODE_ENV: "development", DATABASE_URL: "postgresql://a:b@localhost:5432/x", APP_SECRET: NEW, TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" };
  const about = (env: Record<string, string>) => validateEnv(env).warnings.filter((w) => w.startsWith("APP_SECRET_PREVIOUS:"));
  assert.deepEqual(about(base), []);
  assert.match(about({ ...base, APP_SECRET_PREVIOUS: OLD })[0] ?? "", /still accepted\. Remove it 30 days after/);
  assert.match(about({ ...base, APP_SECRET_PREVIOUS: "short" })[0] ?? "", /ignored/);
  assert.match(about({ ...base, APP_SECRET_PREVIOUS: NEW })[0] ?? "", /identical/);
  for (const w of validateEnv({ ...base, APP_SECRET_PREVIOUS: OLD }).warnings) assert.ok(!w.includes(OLD), "never prints the value");
});
