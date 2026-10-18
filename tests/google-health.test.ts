import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { GoogleReconnectError, GoogleRequestError, GoogleTransientError } from "../lib/google";
import {
  GOOGLE_HEALTH_EVERY_MS,
  GOOGLE_HEALTH_FIRST_RUN_MS,
  checkGoogleConnections,
  startGoogleHealth,
  verdictForRefreshError,
  type GoogleHealthDeps,
} from "../worker/google-health";

/**
 * The daily Google connection check (worker/google-health.ts): which failures kill a connection, that a transient error
 * never does, the alert dedupe, bounded concurrency and the schedule. Database- and Google-free: every dependency is injected.
 */

test("only Google saying the grant is gone kills a connection; every other failure is 'unknown'", () => {
  assert.equal(verdictForRefreshError(new GoogleReconnectError("Refresh token rejected: invalid_grant")), "dead");
  assert.equal(verdictForRefreshError(new GoogleTransientError("Token refresh failed (500)")), "unknown");
  assert.equal(verdictForRefreshError(new GoogleTransientError("Google request failed: fetch failed")), "unknown");
  assert.equal(verdictForRefreshError(new GoogleRequestError("400")), "unknown");
  assert.equal(verdictForRefreshError(new Error("Unsupported state or unable to authenticate data")), "unknown", "an unreadable stored token");
  assert.equal(verdictForRefreshError("boom"), "unknown");
  assert.equal(verdictForRefreshError(undefined), "unknown");
});

/** What the fake world does for each influencer: Google accepts ("ok"), answers with an error, the grant is gone, or cannot be read. */
type Outcome = "ok" | "gone" | { unreadable: Error } | Error;

const connectedAt = (id: string) => new Date(Date.UTC(2030, 0, 1, 0, 0, id.length));

function fakeDeps(outcomes: Record<string, Outcome>, over: Partial<GoogleHealthDeps> = {}) {
  const log = {
    marked: [] as { id: string; reason: string; connectedAt: Date }[],
    alerts: [] as { id: string; reason: string }[],
    refreshed: [] as string[],
  };
  const byToken = new Map(Object.keys(outcomes).map((id) => [`token-${id}`, id]));
  const deps: GoogleHealthDeps = {
    listActive: async () => Object.keys(outcomes),
    load: async (id) => {
      const o = outcomes[id];
      if (o === "gone") return null;
      if (typeof o === "object" && "unreadable" in o) throw o.unreadable;
      return { refreshToken: `token-${id}`, connectedAt: connectedAt(id), clientKind: "own" as const };
    },
    refresh: async (token) => {
      const id = byToken.get(token)!;
      log.refreshed.push(id);
      const o = outcomes[id];
      if (o !== "ok") throw o;
    },
    markDead: async (id, reason, at) => (log.marked.push({ id, reason, connectedAt: at }), true),
    alert: async (id, reason) => void log.alerts.push({ id, reason }),
    ...over,
  };
  return { deps, log };
}

test("a revoked grant is flagged and alerted once; transient failures and unreadable tokens are left alone", async () => {
  const { deps, log } = fakeDeps({
    alive: "ok",
    revoked: new GoogleReconnectError("Refresh token rejected: Token has been expired or revoked."),
    offline: new GoogleTransientError("Google request failed: fetch failed"),
    unreadable: { unreadable: new Error("Unsupported state or unable to authenticate data") },
    rejectedByUs: new GoogleTransientError("Token refresh failed (401 invalid_client): Unauthorized"),
    vanished: "gone",
  });

  const s = await checkGoogleConnections(deps);

  assert.deepEqual(s, { checked: 6, ok: 1, skipped: 1, dead: 1, unknown: 3, alerted: 1, lastError: s.lastError });
  assert.deepEqual(log.marked.map((m) => m.id), ["revoked"], "never marks a connection dead on a transient error");
  assert.match(log.marked[0].reason, /expired or revoked/);
  assert.deepEqual(log.alerts.map((a) => a.id), ["revoked"]);
  assert.ok(s.lastError, "the first unknown failure is kept for the log");
});

test("the verdict is tied to the grant version that was read before asking Google", async () => {
  const { deps, log } = fakeDeps({ revoked: new GoogleReconnectError("invalid_grant") });

  await checkGoogleConnections(deps);

  assert.deepEqual(log.marked.map((m) => m.connectedAt), [connectedAt("revoked")], "markDead receives the connectedAt that load returned");
});

test("a verdict for a grant that was renewed meanwhile flips nothing and sends no alert", async () => {
  // markDead is the conditional update: false because the stored connectedAt moved on (the influencer reconnected).
  const { deps, log } = fakeDeps({ revoked: new GoogleReconnectError("invalid_grant") }, { markDead: async () => false });

  const s = await checkGoogleConnections(deps);

  assert.equal(s.alerted, 0);
  assert.deepEqual(log.alerts, []);
});

test("no second alert when the connection was already flagged (markDead says it did not flip anything)", async () => {
  const { deps, log } = fakeDeps({ revoked: new GoogleReconnectError("invalid_grant") }, { markDead: async () => false });

  const s = await checkGoogleConnections(deps);

  assert.equal(s.dead, 1);
  assert.equal(s.alerted, 0);
  assert.deepEqual(log.alerts, []);
});

test("a failure to record one dead connection does not stop the others", async () => {
  const { deps, log } = fakeDeps(
    { a: new GoogleReconnectError("invalid_grant"), b: new GoogleReconnectError("invalid_grant"), c: "ok" },
    {
      markDead: async (id) => {
        if (id === "a") throw new Error("database is down");
        return true;
      },
    },
  );
  deps.concurrency = 1;

  const s = await checkGoogleConnections(deps);

  assert.equal(s.checked, 3);
  assert.equal(s.ok, 1);
  assert.equal(s.dead, 1, "b was recorded");
  assert.equal(s.unknown, 1, "a could not be recorded and will be found again");
  assert.deepEqual(log.alerts.map((a) => a.id), ["b"]);
});

test("refreshes run with bounded concurrency and every connection is checked exactly once", async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `inf${i}`);
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  const { deps } = fakeDeps(Object.fromEntries(ids.map((id) => [id, "ok" as const])), {
    refresh: async (token) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      seen.push(token.replace("token-", ""));
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    },
  });
  deps.concurrency = 3;

  const s = await checkGoogleConnections(deps);

  assert.equal(s.ok, 12);
  assert.equal(peak, 3, "three at a time, never more");
  assert.deepEqual([...seen].sort(), [...ids].sort());
});

test("nothing to check is a clean no-op", async () => {
  const { deps, log } = fakeDeps({});
  const s = await checkGoogleConnections(deps);
  assert.deepEqual(s, { checked: 0, ok: 0, skipped: 0, dead: 0, unknown: 0, alerted: 0, lastError: null });
  assert.deepEqual(log.refreshed, []);
});

test("the check runs shortly after start-up, then daily, and never overlaps itself", async () => {
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let runs = 0;
    let release: () => void = () => {};
    const stop = startGoogleHealth(async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
    });

    mock.timers.tick(GOOGLE_HEALTH_FIRST_RUN_MS);
    assert.equal(runs, 1, "first run shortly after start-up");
    mock.timers.tick(GOOGLE_HEALTH_EVERY_MS); // still running: skipped
    assert.equal(runs, 1, "a pass that is still going is not started twice");
    release();
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(GOOGLE_HEALTH_EVERY_MS);
    assert.equal(runs, 2, "then once a day");
    release();
    stop();
    mock.timers.tick(GOOGLE_HEALTH_EVERY_MS * 3);
    assert.equal(runs, 2, "stopped");
  } finally {
    mock.timers.reset();
  }
});

// Changed with doc/15: it used to assert that the check does not schedule anything without the platform pair. Influencers now bring
// their own Google client (kept in the database), so the check runs even when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are unset.
test("without the platform Google pair the check still runs (influencers have their own clients)", () => {
  const saved = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    let runs = 0;
    const stop = startGoogleHealth(async () => void runs++);
    mock.timers.tick(GOOGLE_HEALTH_FIRST_RUN_MS);
    assert.equal(runs, 1);
    stop();
  } finally {
    mock.timers.reset();
    if (saved.id !== undefined) process.env.GOOGLE_CLIENT_ID = saved.id;
    if (saved.secret !== undefined) process.env.GOOGLE_CLIENT_SECRET = saved.secret;
  }
});
