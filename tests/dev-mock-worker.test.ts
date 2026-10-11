import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALLOW_SHARED_STORES_HELP,
  DEV_MOCK_HELP,
  NO_WORKER_NOTE,
  SHARED_STORES_BANNER,
  WORKER_STALE_SECONDS,
  isLocalStoreUrl,
  planWorker,
  shouldReadHeartbeat,
  storeHost,
  workerIsLive,
  type WorkerPlanInput,
} from "../scripts/dev-mock-worker";

// The rule that keeps `npm run dev:mock` from sweeping a shared database with a worker that talks to the mock
// (scripts/dev-mock-worker.ts). Pure: no processes, no network.

const NOW = 1_800_000_000_000;
const LOCAL_DB = "postgresql://postgres:postgres@localhost:5432/sessions";
const LOCAL_REDIS = "redis://127.0.0.1:6379";
const base: WorkerPlanInput = { withWorker: true, allowSharedStores: false, databaseUrl: LOCAL_DB, redisUrl: LOCAL_REDIS, heartbeat: { state: "missing" }, now: NOW };
const plan = (o: Partial<WorkerPlanInput>) => planWorker({ ...base, ...o });

test("no worker unless one was asked for, whatever the stores are", () => {
  assert.deepEqual(plan({ withWorker: false }), { start: false, problems: [], sharedStores: false });
  assert.deepEqual(plan({ withWorker: false, databaseUrl: "postgres://x@db.example.com/x", redisUrl: undefined }), { start: false, problems: [], sharedStores: false });
  assert.equal(plan({ withWorker: false, allowSharedStores: true }).start, false, "--allow-shared-stores alone starts nothing");
});

test("which URLs are 'on this machine': localhost, 127.0.0.1 and [::1] only, never by name tricks", () => {
  for (const ok of [LOCAL_DB, LOCAL_REDIS, "redis://[::1]:6379", "rediss://default:pw@localhost:6380/0", "postgres://u@LOCALHOST/db"]) assert.equal(isLocalStoreUrl(ok), true, ok);
  for (const bad of [
    undefined,
    "",
    "not a url",
    " redis://localhost:6379",
    "postgresql://u:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres",
    "redis://redis:6379",
    "redis://localhost.evil.com:6379",
    "postgres://localhost@evil.com/db",
    "redis://0.0.0.0:6379",
    "redis://127.0.0.2:6379",
    "redis://192.168.1.10:6379",
    "redis://app.localhost:6379",
  ]) {
    assert.equal(isLocalStoreUrl(bad), false, String(bad));
  }
});

test("both stores local and no other worker: the worker may start, with nothing to warn about", () => {
  assert.deepEqual(plan({}), { start: true, problems: [], sharedStores: false });
  assert.deepEqual(plan({ heartbeat: undefined }), { start: true, problems: [], sharedStores: false }, "an unread heartbeat (Redis not asked) is not a live worker");
});

test("a database or Redis that is not on this machine refuses the worker, naming the host and never the credentials", () => {
  const remoteDb = plan({ databaseUrl: "postgresql://app:SUPER-SECRET-PW@db.example.com:5432/sessions" });
  assert.equal(remoteDb.start, false);
  assert.equal(remoteDb.problems.length, 1);
  assert.match(remoteDb.problems[0], /DATABASE_URL.*db\.example\.com/);
  const remoteRedis = plan({ redisUrl: "rediss://default:SUPER-SECRET-PW@redis.example.com:6379" });
  assert.equal(remoteRedis.start, false);
  assert.match(remoteRedis.problems[0], /REDIS_URL.*redis\.example\.com/);
  const both = plan({ databaseUrl: undefined, redisUrl: "not a url" });
  assert.equal(both.start, false);
  assert.equal(both.problems.length, 2);
  assert.match(both.problems.join(" "), /\(not set\)/);
  for (const p of [remoteDb, remoteRedis, both]) assert.ok(!p.problems.join(" ").includes("SUPER-SECRET-PW"), "credentials are never in a message");
});

test("another live worker on the Redis refuses it; a stale or missing heartbeat does not; an unreadable one fails closed", () => {
  const live = plan({ heartbeat: { state: "ok", at: NOW - 20_000 } });
  assert.equal(live.start, false);
  assert.match(live.problems[0], /another worker is running.*20 s old/);
  assert.equal(workerIsLive({ state: "ok", at: NOW - WORKER_STALE_SECONDS * 1000 }, NOW), true, "exactly at the limit still counts as live");
  assert.equal(workerIsLive({ state: "ok", at: NOW - WORKER_STALE_SECONDS * 1000 - 1 }, NOW), false);
  assert.deepEqual(plan({ heartbeat: { state: "ok", at: NOW - 10 * 60_000 } }), { start: true, problems: [], sharedStores: false }, "a heartbeat from ten minutes ago is a dead worker");
  assert.equal(plan({ heartbeat: { state: "missing" } }).start, true);
  const unknown = plan({ heartbeat: { state: "unknown", reason: "Redis did not answer: timeout" } });
  assert.equal(unknown.start, false);
  assert.match(unknown.problems[0], /could not read the worker heartbeat/);
  assert.equal(workerIsLive(undefined, NOW), false);
  assert.equal(workerIsLive({ state: "ok", at: NOW + 5_000 }, NOW), true, "a clock a little ahead is still a live worker");
});

test("problems add up, and --allow-shared-stores starts the worker anyway but says the sweeps can reach a shared store", () => {
  const all = plan({ databaseUrl: "postgres://app@db.example.com/x", redisUrl: "redis://redis.example.com:6379", heartbeat: { state: "ok", at: NOW - 1_000 } });
  assert.equal(all.start, false);
  assert.equal(all.problems.length, 3);

  const overridden = plan({ databaseUrl: "postgres://app@db.example.com/x", redisUrl: "redis://redis.example.com:6379", heartbeat: { state: "ok", at: NOW - 1_000 }, allowSharedStores: true });
  assert.equal(overridden.start, true);
  assert.equal(overridden.sharedStores, true);
  assert.equal(overridden.problems.length, 3, "what was overridden stays visible");
  // Overriding changes nothing when there was nothing to override: no scary banner for a clean local setup.
  assert.deepEqual(plan({ allowSharedStores: true }), { start: true, problems: [], sharedStores: false });
});

test("the heartbeat is only read when it can matter: a worker was asked for and the Redis is local or the user overrode", () => {
  assert.equal(shouldReadHeartbeat({ withWorker: true, allowSharedStores: false, redisUrl: LOCAL_REDIS }), true);
  assert.equal(shouldReadHeartbeat({ withWorker: false, allowSharedStores: false, redisUrl: LOCAL_REDIS }), false, "no worker asked for: touch no Redis");
  assert.equal(shouldReadHeartbeat({ withWorker: true, allowSharedStores: false, redisUrl: "redis://redis.example.com:6379" }), false, "refused already; do not even connect to a Redis that is not ours");
  assert.equal(shouldReadHeartbeat({ withWorker: true, allowSharedStores: true, redisUrl: "redis://redis.example.com:6379" }), true);
  assert.equal(shouldReadHeartbeat({ withWorker: true, allowSharedStores: true, redisUrl: undefined }), false);
});

test("the texts tell the truth: the flag's help states the consequences, the default launch says how to run the worker safely", () => {
  assert.match(ALLOW_SHARED_STORES_HELP, /DANGEROUS/);
  assert.match(ALLOW_SHARED_STORES_HELP, /every other influencer/i);
  assert.match(ALLOW_SHARED_STORES_HELP, /reconnect-needed or ERROR/);
  assert.match(ALLOW_SHARED_STORES_HELP, /booking page goes offline/);
  assert.match(ALLOW_SHARED_STORES_HELP, /queued jobs of other users/);
  assert.match(ALLOW_SHARED_STORES_HELP, /MOCK-NOT-REAL tokens to the real/);
  assert.ok(DEV_MOCK_HELP.includes(ALLOW_SHARED_STORES_HELP), "--help prints it");
  assert.match(DEV_MOCK_HELP, /--with-worker/);
  assert.match(NO_WORKER_NOTE, /NOT started/);
  assert.match(NO_WORKER_NOTE, /--with-worker/);
  assert.match(NO_WORKER_NOTE, /stop any other worker/);
  assert.match(NO_WORKER_NOTE, /Postgres and a Redis that hold only this demo/);
  assert.match(SHARED_STORES_BANNER, /WARNING/);
  assert.match(SHARED_STORES_BANNER, /marked reconnect-needed or ERROR/);
  assert.equal(storeHost("postgresql://u:pw@db.example.com:5432/x"), "db.example.com");
  assert.equal(storeHost(undefined), "(not set)");
  assert.equal(storeHost("::"), "(not a URL)");
});
