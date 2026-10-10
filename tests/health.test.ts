import "dotenv/config";
import assert from "node:assert/strict";
import { test } from "node:test";
import { reportNotice } from "../lib/observability";
import {
  DEFAULT_THRESHOLDS,
  HealthKv,
  MemoryKv,
  deriveRedisState,
  evaluateHealth,
  evaluateQueue,
  evaluateRecovery,
  evaluateRecoveryStale,
  evaluateRedis,
  evaluateWorker,
  nextRecoveryState,
  parseAlertEmails,
  planAlerts,
  readHeartbeat,
  recordRecoveryRun,
  readRecoveryState,
  thresholdsFromEnv,
  writeHeartbeat,
  type HealthCondition,
  type HealthRedis,
  type HealthSnapshot,
} from "../lib/health";
import { processAlerts, runHealthMonitor, runWatchdog } from "../lib/health-alerts";
import { singleFlight } from "../worker/monitoring";

/**
 * System health, with no database and no Redis: the pure evaluation, alert planning and dedupe, the heartbeat over a
 * fake Redis, and the worker's no-overlap guard.
 */

const T = DEFAULT_THRESHOLDS;
const NOW = Date.parse("2026-10-10T12:00:00Z");

const healthy: HealthSnapshot = {
  at: NOW,
  heartbeat: { state: "ok", at: NOW - 10_000 },
  redis: "ok",
  unrecoveredPayments: 0,
  recovery: { consecutiveFailedRuns: 0, lastRunAt: NOW - 60_000, lastError: null, lastCandidates: 3, lastRecovered: 0 },
  stuckMeetings: 0,
  failedConfirmations: 0,
  unsweptHolds: 0,
  queues: {
    meetings: { waiting: 0, active: 1, failed: 0, delayed: 0 },
    messages: { waiting: 2, active: 0, failed: 0, delayed: 0 },
    reminders: { waiting: 0, active: 0, failed: 0, delayed: 140 },
  },
};
const withChange = (patch: Partial<HealthSnapshot>): HealthSnapshot => ({ ...healthy, ...patch });
const byId = (snapshot: HealthSnapshot, id: string) => {
  const c = evaluateHealth(snapshot, T).conditions.find((x) => x.id === id);
  assert.ok(c, `condition ${id} missing`);
  return c;
};

// --- thresholds -------------------------------------------------------------------------------------------------

test("thresholds default sensibly and can be overridden from the environment", () => {
  assert.deepEqual(thresholdsFromEnv({}), DEFAULT_THRESHOLDS);
  const t = thresholdsFromEnv({
    HEALTH_WORKER_STALE_SECONDS: "60",
    HEALTH_QUEUE_FAILED_MAX: "0",
    HEALTH_ALERT_DEDUPE_MINUTES: "30",
    HEALTH_MEETING_STUCK_MINUTES: "not a number",
    HEALTH_QUEUE_WAITING_MAX: "-5",
    HEALTH_HOLD_SWEEP_GRACE_MINUTES: "",
  });
  assert.equal(t.workerStaleSeconds, 60);
  assert.equal(t.queueFailedMax, 0);
  assert.equal(t.alertDedupeMinutes, 30);
  assert.equal(t.meetingStuckMinutes, DEFAULT_THRESHOLDS.meetingStuckMinutes, "invalid value keeps the default");
  assert.equal(t.queueWaitingMax, DEFAULT_THRESHOLDS.queueWaitingMax, "negative value keeps the default");
  assert.equal(t.holdSweepGraceMinutes, DEFAULT_THRESHOLDS.holdSweepGraceMinutes, "empty value keeps the default");
});

// --- evaluation -------------------------------------------------------------------------------------------------

test("a healthy snapshot has no unhealthy conditions", () => {
  const report = evaluateHealth(healthy, T);
  assert.deepEqual(report.unhealthy, []);
  assert.ok(report.conditions.length >= 8);
  assert.ok(report.conditions.every((c) => c.status === "ok"));
});

test("worker heartbeat: fresh is ok, past the threshold is critical, missing is critical, unreadable is unknown", () => {
  assert.equal(evaluateWorker({ state: "ok", at: NOW - 100_000 }, NOW, T).status, "ok");
  assert.equal(evaluateWorker({ state: "ok", at: NOW - T.workerStaleSeconds * 1000 }, NOW, T).status, "ok", "exactly at the limit is still fine");
  const stale = evaluateWorker({ state: "ok", at: NOW - (T.workerStaleSeconds + 1) * 1000 }, NOW, T);
  assert.equal(stale.status, "critical");
  assert.match(stale.detail, /Worker is not running/);
  assert.equal(stale.value, T.workerStaleSeconds + 1);
  const missing = evaluateWorker({ state: "missing" }, NOW, T);
  assert.equal(missing.status, "critical");
  assert.match(missing.detail, /Worker is not running/);
  const unknown = evaluateWorker({ state: "unknown", reason: "Redis is not configured", redis: "not-configured" }, NOW, T);
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.value, null);
});

test("count conditions are unhealthy above zero and unknown when they could not be measured", () => {
  assert.equal(byId(withChange({ unrecoveredPayments: 1 }), "payments-unrecovered").status, "critical");
  assert.equal(byId(withChange({ stuckMeetings: 2 }), "meetings-stuck").status, "warn");
  assert.equal(byId(withChange({ failedConfirmations: 1 }), "confirmations-failed").status, "warn");
  assert.equal(byId(withChange({ unsweptHolds: 4 }), "holds-unswept").status, "warn");
  assert.match(byId(withChange({ stuckMeetings: 2 }), "meetings-stuck").detail, /2 paid bookings/);
  for (const [key, id] of [
    ["unrecoveredPayments", "payments-unrecovered"],
    ["stuckMeetings", "meetings-stuck"],
    ["failedConfirmations", "confirmations-failed"],
    ["unsweptHolds", "holds-unswept"],
  ] as const) {
    const c = byId(withChange({ [key]: null }), id);
    assert.equal(c.status, "unknown", id);
    assert.equal(c.value, null);
  }
});

test("queue thresholds: failed and waiting are flagged above their limits, delayed never is", () => {
  const q = (counts: Partial<{ waiting: number; active: number; failed: number; delayed: number }>) =>
    evaluateQueue("meetings", { waiting: 0, active: 0, failed: 0, delayed: 0, ...counts }, T);
  assert.equal(q({}).status, "ok");
  assert.equal(q({ failed: T.queueFailedMax }).status, "ok", "at the limit is fine");
  assert.equal(q({ failed: T.queueFailedMax + 1 }).status, "warn");
  assert.equal(q({ waiting: T.queueWaitingMax + 1 }).status, "warn");
  assert.equal(q({ delayed: 100_000 }).status, "ok", "reminders wait in 'delayed' by design");
  assert.match(q({ failed: 9, waiting: 2 }).detail, /9 failed jobs/);
  assert.equal(evaluateQueue("meetings", null, T).status, "unknown");
  const strict = { ...T, queueFailedMax: 0 };
  assert.equal(evaluateQueue("messages", { waiting: 0, active: 0, failed: 1, delayed: 0 }, strict).status, "warn");
});

test("recovery: only a streak of all-failed runs is critical", () => {
  const state = (n: number) => ({ consecutiveFailedRuns: n, lastRunAt: NOW, lastError: "timeout", lastCandidates: 5, lastRecovered: 0 });
  assert.equal(evaluateRecovery(state(0), T).status, "ok");
  assert.equal(evaluateRecovery(state(T.recoveryFailingRuns - 1), T).status, "ok");
  const bad = evaluateRecovery(state(T.recoveryFailingRuns), T);
  assert.equal(bad.status, "critical");
  assert.match(bad.detail, /timeout/);
  assert.equal(evaluateRecovery(null, T).status, "unknown");
});

test("nextRecoveryState counts all-failed runs and resets on any success or an empty run", () => {
  const run = (o: Partial<Parameters<typeof nextRecoveryState>[1]>) =>
    ({ at: NOW, candidates: 4, lookupsOk: 0, lookupErrors: 0, recovered: 0, aborted: false, ...o });
  let s = nextRecoveryState(null, run({ lookupErrors: 3, aborted: true, lastError: "ECONNRESET" }));
  assert.equal(s.consecutiveFailedRuns, 1);
  assert.equal(s.lastError, "ECONNRESET");
  s = nextRecoveryState(s, run({ lookupErrors: 3, aborted: true, lastError: "ECONNRESET" }));
  assert.equal(s.consecutiveFailedRuns, 2);
  s = nextRecoveryState(s, run({ candidates: 4, lookupsOk: 1, lookupErrors: 2 }));
  assert.equal(s.consecutiveFailedRuns, 0, "one answered lookup proves Razorpay is reachable");
  assert.equal(s.lastError, null);
  s = nextRecoveryState({ ...s, consecutiveFailedRuns: 2 }, run({ candidates: 0 }));
  assert.equal(s.consecutiveFailedRuns, 0, "nothing to check clears the streak");
  s = nextRecoveryState({ ...s, consecutiveFailedRuns: 2 }, run({ candidates: 0, aborted: true }));
  assert.equal(s.consecutiveFailedRuns, 2, "a run that could not even start says nothing");
});

test("parseAlertEmails trims, lowercases, de-duplicates and drops invalid entries", () => {
  assert.deepEqual(parseAlertEmails(" Ops@Example.com, ops@example.com ,bad, owner@example.com, <a@b.co>, two words@x.com,"), ["ops@example.com", "owner@example.com"]);
  assert.deepEqual(parseAlertEmails(undefined), []);
  assert.deepEqual(parseAlertEmails(""), []);
});

// --- alert planning (pure) --------------------------------------------------------------------------------------

const cond = (id: string, status: HealthCondition["status"]): HealthCondition => ({
  id,
  label: id,
  status,
  value: status === "ok" ? 0 : 1,
  unit: "x",
  detail: `${id} is ${status}`,
});
const none = new Set<string>();

test("planAlerts: an unhealthy condition alerts once, then is held back while deduped", () => {
  const report = { conditions: [cond("a", "warn"), cond("b", "critical"), cond("c", "ok")] };
  const first = planAlerts(report, { recentlyAlerted: none, active: none });
  assert.deepEqual(first.notify.map((c) => c.id), ["a", "b"]);
  assert.deepEqual(first.recovered, []);

  const second = planAlerts(report, { recentlyAlerted: new Set(["a", "b"]), active: new Set(["a", "b"]) });
  assert.deepEqual(second.notify, []);
  const partial = planAlerts(report, { recentlyAlerted: new Set(["a"]), active: new Set(["a"]) });
  assert.deepEqual(partial.notify.map((c) => c.id), ["b"], "each key is deduped on its own");
});

test("planAlerts: a cleared condition produces a recovery note; an unmeasurable one produces nothing", () => {
  const report = { conditions: [cond("a", "ok"), cond("b", "unknown"), cond("c", "ok")] };
  const plan = planAlerts(report, { recentlyAlerted: none, active: new Set(["a", "b"]) });
  assert.deepEqual(plan.recovered.map((c) => c.id), ["a"], "b is unknown, c was never raised");
  assert.deepEqual(plan.notify, []);
});

// --- KV, heartbeat ----------------------------------------------------------------------------------------------

function fakeRedis(opts: { fail?: boolean } = {}): HealthRedis & { data: Map<string, string>; setCalls: unknown[][] } {
  const data = new Map<string, string>();
  const setCalls: unknown[][] = [];
  return {
    data,
    setCalls,
    async get(key) {
      if (opts.fail) throw new Error("connection refused");
      return data.get(key) ?? null;
    },
    async set(key, value, ...args) {
      if (opts.fail) throw new Error("connection refused");
      setCalls.push([key, value, ...args]);
      if (args.includes("NX") && data.has(key)) return null;
      data.set(key, value);
      return "OK";
    },
    async del(key) {
      if (opts.fail) throw new Error("connection refused");
      return data.delete(key) ? 1 : 0;
    },
  };
}

test("heartbeat: written with a TTL, read back fresh; a stale or absent one is reported as such", async () => {
  const redis = fakeRedis();
  const kv = new HealthKv(redis);
  assert.deepEqual(await readHeartbeat(kv), { state: "missing" });
  await writeHeartbeat(kv, NOW);
  const set = redis.setCalls[0];
  assert.equal(set[0], "health:worker-heartbeat");
  assert.deepEqual(set.slice(2, 4), ["EX", 3600], "heartbeat key expires on its own");
  assert.deepEqual(await readHeartbeat(kv), { state: "ok", at: NOW });
  assert.equal(evaluateWorker(await readHeartbeat(kv), NOW + 10 * 60_000, T).status, "critical", "ten minutes later it is stale");
  redis.data.set("health:worker-heartbeat", "not json");
  assert.deepEqual(await readHeartbeat(kv), { state: "missing" });
});

test("heartbeat: with Redis down the writer falls back to memory and never throws; a reader reports unknown", async () => {
  const down = new HealthKv(fakeRedis({ fail: true }));
  await writeHeartbeat(down, NOW);
  assert.deepEqual(await readHeartbeat(down), { state: "unknown", reason: "Redis did not answer: connection refused", redis: "down" });
  assert.equal(JSON.parse((await down.get("health:worker-heartbeat"))!).at, NOW, "kept in process memory");

  const none = new HealthKv(null);
  await writeHeartbeat(none, NOW);
  assert.deepEqual(await readHeartbeat(none), { state: "unknown", reason: "Redis is not configured", redis: "not-configured" });
});

test("HealthKv.setNx claims a key exactly once, in Redis and in memory", async () => {
  const redisKv = new HealthKv(fakeRedis());
  assert.equal(await redisKv.setNx("k", "1", 60), true);
  assert.equal(await redisKv.setNx("k", "1", 60), false);
  const memKv = new HealthKv(null);
  assert.equal(await memKv.setNx("k", "1", 60), true);
  assert.equal(await memKv.setNx("k", "1", 60), false);
  const failing = new HealthKv(fakeRedis({ fail: true }));
  assert.equal(await failing.setNx("k", "1", 60), true, "falls back to memory");
  assert.equal(await failing.setNx("k", "1", 60), false);
});

test("MemoryKv honours TTLs", () => {
  let now = 1_000;
  const kv = new MemoryKv(() => now);
  kv.set("a", "1", 10);
  assert.equal(kv.get("a"), "1");
  now += 9_999;
  assert.equal(kv.get("a"), "1");
  now += 2;
  assert.equal(kv.get("a"), null);
  assert.equal(kv.setNx("a", "2", 10), true);
});

test("recordRecoveryRun persists the streak across runs", async () => {
  const kv = new HealthKv(fakeRedis());
  assert.equal(await readRecoveryState(kv), null);
  const base = { at: NOW, candidates: 2, lookupsOk: 0, lookupErrors: 2, recovered: 0, aborted: true, lastError: "boom" };
  await recordRecoveryRun(base, kv);
  const second = await recordRecoveryRun(base, kv);
  assert.equal(second.consecutiveFailedRuns, 2);
  assert.equal((await readRecoveryState(kv))?.consecutiveFailedRuns, 2);
});

// --- alert dispatch: dedupe, once an hour, recovered note --------------------------------------------------------

function alertHarness() {
  let now = NOW;
  const kv = new HealthKv(null, new MemoryKv(() => now));
  const notices: { level: string; text: string }[] = [];
  const emails: { to: string; subject: string; text: string }[] = [];
  const deps = {
    kv,
    thresholds: T,
    emails: ["ops@example.com", "owner@example.com"],
    notice: ((level: "warn" | "info", text: string) => void notices.push({ level, text })) as typeof reportNotice,
    sendEmail: async (to: string, m: { subject: string; text: string }) => {
      emails.push({ to, subject: m.subject, text: m.text });
      return true;
    },
    healthUrl: "https://app.example.com/admin/health",
  };
  return { deps, notices, emails, advance: (ms: number) => void (now += ms) };
}

test("an alert is sent once, repeated only after an hour, and a recovery note follows when it clears", async () => {
  const h = alertHarness();
  const bad = { conditions: [cond("meetings-stuck", "warn"), cond("holds-unswept", "ok")] };

  const first = await processAlerts(bad, h.deps);
  assert.deepEqual(first.alerted, ["meetings-stuck"]);
  assert.equal(h.notices.filter((n) => n.level === "warn").length, 1);
  assert.equal(h.emails.length, 2, "one email per recipient");
  assert.deepEqual(h.emails.map((e) => e.to).sort(), ["ops@example.com", "owner@example.com"]);
  assert.match(h.emails[0].subject, /alert: meetings-stuck/);
  assert.match(h.emails[0].text, /admin\/health/);

  // Five minutes later, still broken: silent.
  h.advance(5 * 60_000);
  assert.deepEqual((await processAlerts(bad, h.deps)).alerted, []);
  h.advance(50 * 60_000);
  assert.deepEqual((await processAlerts(bad, h.deps)).alerted, [], "55 minutes in, still inside the hour");
  assert.equal(h.emails.length, 2);

  // Past the hour: again.
  h.advance(6 * 60_000);
  assert.deepEqual((await processAlerts(bad, h.deps)).alerted, ["meetings-stuck"]);
  assert.equal(h.emails.length, 4);

  // It clears: one recovery note, and not a second one.
  h.advance(60_000);
  const good = { conditions: [cond("meetings-stuck", "ok"), cond("holds-unswept", "ok")] };
  const cleared = await processAlerts(good, h.deps);
  assert.deepEqual(cleared.recovered, ["meetings-stuck"]);
  assert.equal(h.notices.filter((n) => n.level === "info").length, 1);
  assert.match(h.emails[4].subject, /recovered: meetings-stuck/);
  assert.equal(h.emails.length, 6);
  assert.deepEqual((await processAlerts(good, h.deps)).recovered, []);
  assert.equal(h.emails.length, 6);
});

test("several conditions in one run share one email per recipient; a measurement gap is not a recovery", async () => {
  const h = alertHarness();
  const out = await processAlerts({ conditions: [cond("a", "warn"), cond("b", "critical")] }, h.deps);
  assert.deepEqual(out.alerted.sort(), ["a", "b"]);
  assert.equal(h.emails.length, 2);
  assert.match(h.emails[0].subject, /and 1 more/);

  // "a" can no longer be measured (Redis blip): neither a recovery note nor a new alert.
  h.advance(10 * 60_000);
  const gap = await processAlerts({ conditions: [cond("a", "unknown"), cond("b", "critical")] }, h.deps);
  assert.deepEqual(gap, { alerted: [], recovered: [], retrying: [] });
});

test("no ADMIN_ALERT_EMAILS: the webhook notice still goes out and nothing throws", async () => {
  const h = alertHarness();
  const out = await processAlerts({ conditions: [cond("a", "critical")] }, { ...h.deps, emails: [] });
  assert.deepEqual(out.alerted, ["a"]);
  assert.equal(h.notices.length, 1);
  assert.equal(h.emails.length, 0);
});

test("a failing email channel or notice hook never throws out of the monitor", async () => {
  const h = alertHarness();
  const out = await processAlerts(
    { conditions: [cond("a", "critical")] },
    {
      ...h.deps,
      sendEmail: async () => {
        throw new Error("smtp down");
      },
    },
  );
  assert.deepEqual(out.alerted, ["a"]);
  assert.deepEqual(out.retrying, ["a"], "every email failed, so the alert is not considered delivered");
  const broken = await processAlerts(
    { conditions: [cond("b", "critical")] },
    {
      ...h.deps,
      notice: (() => {
        throw new Error("webhook hook exploded");
      }) as typeof reportNotice,
    },
  );
  assert.deepEqual(broken.alerted, ["b"], "the email channel still ran");
  assert.equal(h.emails.length, 2, "both recipients were emailed even though the notice hook threw");
});

test("when every email for an alert fails the dedupe key is released so the next run retries; one success keeps it", async () => {
  const h = alertHarness();
  const bad = { conditions: [cond("a", "critical")] };
  let failing = true;
  const flaky = async (to: string, m: { subject: string; text: string }) => {
    if (failing) return false; // sendAccountEmail reports failure as false
    h.emails.push({ to, subject: m.subject, text: m.text });
    return true;
  };
  const first = await processAlerts(bad, { ...h.deps, sendEmail: flaky });
  assert.deepEqual(first.retrying, ["a"]);
  h.advance(5 * 60_000); // well inside the hour: without the release this run would be silent
  failing = false;
  const second = await processAlerts(bad, { ...h.deps, sendEmail: flaky });
  assert.deepEqual(second.alerted, ["a"]);
  assert.deepEqual(second.retrying, []);
  assert.equal(h.emails.length, 2, "delivered to both recipients on the retry");
  h.advance(5 * 60_000);
  assert.deepEqual((await processAlerts(bad, { ...h.deps, sendEmail: flaky })).alerted, [], "now it is deduped as usual");

  // One recipient reachable is enough to keep the dedupe key.
  const h2 = alertHarness();
  const oneOk = async (to: string) => to === "ops@example.com";
  const partial = await processAlerts(bad, { ...h2.deps, sendEmail: oneOk });
  assert.deepEqual(partial.retrying, []);
  h2.advance(60_000);
  assert.deepEqual((await processAlerts(bad, { ...h2.deps, sendEmail: oneOk })).alerted, []);
});

test("overlapping runs send one recovery note, not one each", async () => {
  const h = alertHarness();
  await processAlerts({ conditions: [cond("a", "critical")] }, h.deps);
  const before = h.emails.length;
  const good = { conditions: [cond("a", "ok")] };
  const runs = await Promise.all([processAlerts(good, h.deps), processAlerts(good, h.deps), processAlerts(good, h.deps)]);
  assert.equal(runs.flatMap((r) => r.recovered).length, 1, "only the run whose delete removed the marker announces it");
  assert.equal(h.emails.length - before, 2, "one note to each of the two recipients");
  assert.equal(h.notices.filter((n) => n.level === "info").length, 1);
});

// --- Redis outage, recovery loop, repair, watchdog ---------------------------------------------------------------

test("Redis configured but not answering is a critical condition; not configured is just unknown", () => {
  assert.equal(evaluateRedis("down", "Redis did not answer: timeout").status, "critical");
  assert.match(evaluateRedis("down", "Redis did not answer: timeout").detail, /not answering/);
  assert.equal(evaluateRedis("ok").status, "ok");
  assert.equal(evaluateRedis("not-configured").status, "unknown");

  const down = { state: "unknown", reason: "Redis did not answer: x", redis: "down" } as const;
  assert.equal(deriveRedisState(down, { meetings: null, messages: null }), "down");
  assert.equal(deriveRedisState(down, { meetings: null, messages: { waiting: 0, active: 0, failed: 0, delayed: 0 } }), "ok", "a queue answered, so one flaky connection is not an outage");
  assert.equal(deriveRedisState({ state: "unknown", reason: "x", redis: "not-configured" }, {}), "not-configured");
  assert.equal(deriveRedisState({ state: "missing" }, { meetings: null }), "ok");
  assert.equal(deriveRedisState({ state: "ok", at: NOW }, {}), "ok");

  const outage = evaluateHealth(
    withChange({ heartbeat: down, redis: "down", queues: { meetings: null, messages: null, reminders: null } }),
    T,
  );
  assert.ok(outage.unhealthy.some((c) => c.id === "redis-unreachable" && c.status === "critical"), "the outage is visible");
  assert.equal(outage.conditions.find((c) => c.id === "worker-heartbeat")?.status, "unknown", "the checks that depend on Redis stay unknown");
  assert.equal(outage.conditions.find((c) => c.id === "recovery-stale")?.status, "unknown");
  assert.equal(outage.unhealthy.length, 1, "no cascade of alerts for one outage");
});

test("a recovery loop that has not run for 3x its interval is critical, unless the worker itself is down", () => {
  const ranAgo = (min: number) => ({ consecutiveFailedRuns: 0, lastRunAt: NOW - min * 60_000, lastError: null, lastCandidates: 0, lastRecovered: 0 });
  assert.equal(evaluateRecoveryStale(ranAgo(1), true, NOW, T).status, "ok");
  assert.equal(evaluateRecoveryStale(ranAgo(T.recoveryStaleMinutes), true, NOW, T).status, "ok", "exactly at the limit is fine");
  const stale = evaluateRecoveryStale(ranAgo(T.recoveryStaleMinutes + 1), true, NOW, T);
  assert.equal(stale.status, "critical");
  assert.equal(stale.id, "recovery-stale");
  assert.match(stale.detail, /should run every 2 minutes/);
  assert.equal(evaluateRecoveryStale(ranAgo(60), false, NOW, T).status, "unknown", "the worker condition already says so");
  assert.equal(evaluateRecoveryStale(null, true, NOW, T).status, "unknown");
  assert.equal(T.recoveryStaleMinutes, 6, "3 x the 2 minute interval");
  assert.equal(thresholdsFromEnv({ HEALTH_RECOVERY_STALE_MINUTES: "10" }).recoveryStaleMinutes, 10);

  // End to end through the evaluation: a stuck loop under a live worker is an unhealthy condition.
  const report = evaluateHealth(withChange({ recovery: ranAgo(30) }), T);
  assert.deepEqual(report.unhealthy.map((c) => c.id), ["recovery-stale"]);
});

function monitorDeps(over: Record<string, unknown> = {}) {
  const h = alertHarness();
  const requeued: number[] = [];
  const deps = {
    ...h.deps,
    emails: [] as string[],
    collect: async () => healthy,
    requeuePending: async () => {
      requeued.push(Date.now());
      return 2;
    },
    ...over,
  };
  return { h, deps, requeued };
}

test("the monitor re-queues paid bookings without a link whenever any are stuck, and survives a failing repair", async () => {
  const stuck = { ...healthy, stuckMeetings: 3 };
  const a = monitorDeps({ collect: async () => stuck });
  const report = await runHealthMonitor(a.deps);
  assert.ok(report?.unhealthy.some((c) => c.id === "meetings-stuck"));
  assert.equal(a.requeued.length, 1, "repaired, not only reported");

  const b = monitorDeps();
  await runHealthMonitor(b.deps);
  assert.equal(b.requeued.length, 0, "nothing stuck, nothing to re-queue");

  const c = monitorDeps({
    collect: async () => stuck,
    requeuePending: async () => {
      throw new Error("redis down");
    },
  });
  const survived = await runHealthMonitor(c.deps);
  assert.ok(survived, "a failing repair does not take the monitor down");
  assert.ok(survived.unhealthy.some((x) => x.id === "meetings-stuck"));
});

test("the monitor reports a measurement failure as null instead of throwing", async () => {
  const m = monitorDeps({
    collect: async () => {
      throw new Error("database down");
    },
  });
  assert.equal(await runHealthMonitor(m.deps), null);
});

test("the watchdog alerts on a Redis outage once, retries the read first, and stays quiet without Redis configured", async () => {
  const h = alertHarness();
  const reads: number[] = [];
  const flakyRedis = fakeRedis({ fail: true });
  const origGet = flakyRedis.get.bind(flakyRedis);
  flakyRedis.get = async (key: string) => {
    reads.push(1);
    return origGet(key);
  };
  const kv = new HealthKv(flakyRedis, new MemoryKv(() => NOW));
  const down = await runWatchdog({ ...h.deps, kv, retryDelayMs: 1 });
  assert.equal(down.redis.status, "critical");
  assert.equal(down.worker.status, "unknown");
  assert.ok(reads.length >= 2, "the failed read was retried before declaring an outage");
  assert.equal(h.notices.filter((n) => n.level === "warn").length, 1);
  assert.match(h.notices[0].text, /Redis/);

  await runWatchdog({ ...h.deps, kv, retryDelayMs: 1 });
  assert.equal(h.notices.filter((n) => n.level === "warn").length, 1, "deduped on the next poll");

  const noRedis = alertHarness();
  const quiet = await runWatchdog({ ...noRedis.deps, kv: new HealthKv(null), retryDelayMs: 1 });
  assert.equal(quiet.redis.status, "unknown");
  assert.equal(noRedis.notices.length, 0);

  // Healthy Redis, stale heartbeat: the worker alert, not a Redis one.
  const stale = alertHarness();
  const redis = fakeRedis();
  const kv2 = new HealthKv(redis);
  await writeHeartbeat(kv2, Date.now() - 20 * 60_000);
  const w = await runWatchdog({ ...stale.deps, kv: kv2 });
  assert.equal(w.redis.status, "ok");
  assert.equal(w.worker.status, "critical");
  assert.match(stale.notices[0].text, /Worker is not running/);
});

test("a value written to memory during a Redis outage is still found, and not claimed twice, once Redis is back", async () => {
  const memory = new MemoryKv();
  const kv = new HealthKv(fakeRedis({ fail: true }), memory);
  await kv.set("health:active:x", "1", 600);
  assert.equal(await kv.setNx("health:alerted:x", "1", 600), true, "claimed in memory during the outage");
  // Redis returns (a new, healthy client; the process memory is the same).
  const recovered = new HealthKv(fakeRedis(), memory);
  assert.equal(await recovered.get("health:active:x"), "1", "the marker written during the outage is still seen");
  assert.equal(await recovered.setNx("health:alerted:x", "1", 600), false, "the claim made during the outage still counts");
  assert.equal(await recovered.delIfExists("health:active:x"), true);
  assert.equal(await recovered.delIfExists("health:active:x"), false, "only the first deleter gets true");
});

// --- single flight ----------------------------------------------------------------------------------------------

test("singleFlight skips a tick while the previous run is still going, and runs again afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started = 0;
  let skipped = 0;
  const job = singleFlight(
    async () => {
      started++;
      await gate;
    },
    { onSkip: () => skipped++ },
  );
  const first = job();
  assert.equal(await job(), false, "second tick while the first runs is skipped");
  assert.equal(await job(), false);
  assert.equal(skipped, 2);
  release();
  assert.equal(await first, true);
  assert.equal(await job(), true, "free again once the first finished");
  assert.equal(started, 2);
});

test("singleFlight reports a throwing job and keeps running on later ticks", async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const job = singleFlight(
    async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
    { onError: (e) => errors.push(e) },
  );
  assert.equal(await job(), true);
  assert.equal(errors.length, 1);
  assert.equal(await job(), true);
  assert.equal(calls, 2);
});
