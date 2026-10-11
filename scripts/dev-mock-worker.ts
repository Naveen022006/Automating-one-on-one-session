/**
 * Whether `npm run dev:mock` may start a worker, as a pure function (tests/dev-mock-worker.test.ts). Imports nothing.
 *
 * Why this is a safety rule and not a convenience: the worker is not only "the demo's jobs". Two of its timers sweep the WHOLE
 * database: worker/google-health.ts asks Google about every influencer's connection, and worker/whatsapp-sync.ts asks Meta
 * about every WhatsApp connection (both within a couple of minutes of starting). Pointed at the mock, which answers
 * invalid_grant / error 190 for every token it did not issue, they mark EVERY other influencer in that database
 * reconnect-needed or ERROR, alert them and take their booking page offline. The worker also consumes whatever is queued on the
 * Redis it connects to (other users' jobs, stamped with mock Meet links), and conversely any OTHER worker on that Redis will
 * pick up the demo's jobs and send MOCK-NOT-REAL tokens to the real Google and Meta. So by default no worker is started, and one
 * is started only against a Postgres and a Redis on this machine with no other worker running, or on explicit request.
 */

/** Hosts that mean "this machine" for a store URL (host only; never the user name or password). */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The host of a URL for messages, or "(not a URL)". Never includes credentials. */
export function storeHost(raw: string | undefined): string {
  if (!raw) return "(not set)";
  try {
    return new URL(raw).hostname || "(no host)";
  } catch {
    return "(not a URL)";
  }
}

/** True when a Postgres or Redis URL names this machine: localhost, 127.0.0.1 or [::1]. Unset, malformed or padded is not local. */
export function isLocalStoreUrl(raw: string | undefined): boolean {
  if (!raw || raw !== raw.trim()) return false;
  try {
    // Lower-cased: the URL parser keeps the case of the host for non-http schemes (postgres://, redis://).
    return LOCAL_HOSTS.has(new URL(raw).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export type HeartbeatReading = { state: "ok"; at: number } | { state: "missing" } | { state: "unknown"; reason: string };

/** The worker's own staleness rule (HEALTH_WORKER_STALE_SECONDS, default 180 s): a heartbeat younger than this is a live worker. */
export const WORKER_STALE_SECONDS = 180;

export function workerIsLive(heartbeat: HeartbeatReading | undefined, now: number, staleSeconds = WORKER_STALE_SECONDS): boolean {
  return heartbeat?.state === "ok" && now - heartbeat.at <= staleSeconds * 1000;
}

export interface WorkerPlanInput {
  /** `--with-worker`: the user asked for a worker (the default is none). */
  withWorker: boolean;
  /** `--allow-shared-stores`: start it even though the checks below object. */
  allowSharedStores: boolean;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  /** What the Redis the worker would use says about another worker (undefined when it was not read). */
  heartbeat?: HeartbeatReading;
  now: number;
  staleSeconds?: number;
}

export interface WorkerPlan {
  /** Start the worker. */
  start: boolean;
  /** Why not (or, when `overridden`, what was overridden). Empty when nothing objects. */
  problems: string[];
  /** The user overrode a problem with --allow-shared-stores: the sweeps can reach a shared store. */
  sharedStores: boolean;
}

/** Whether the heartbeat is worth reading: only when a worker was asked for and the Redis is this machine's or the user overrode. */
export function shouldReadHeartbeat(input: Pick<WorkerPlanInput, "withWorker" | "allowSharedStores" | "redisUrl">): boolean {
  return input.withWorker && Boolean(input.redisUrl) && (isLocalStoreUrl(input.redisUrl) || input.allowSharedStores);
}

export function planWorker(input: WorkerPlanInput): WorkerPlan {
  if (!input.withWorker) return { start: false, problems: [], sharedStores: false };
  const problems: string[] = [];
  if (!isLocalStoreUrl(input.databaseUrl)) problems.push(`DATABASE_URL is not on this machine (host: ${storeHost(input.databaseUrl)})`);
  if (!isLocalStoreUrl(input.redisUrl)) problems.push(`REDIS_URL is not on this machine (host: ${storeHost(input.redisUrl)})`);
  const hb = input.heartbeat;
  if (workerIsLive(hb, input.now, input.staleSeconds)) {
    const age = Math.max(0, Math.round((input.now - (hb as { at: number }).at) / 1000));
    problems.push(`another worker is running against this Redis (its heartbeat is ${age} s old; it would pick up the demo's jobs, and the demo's worker would pick up its jobs)`);
  } else if (hb?.state === "unknown") {
    problems.push(`could not read the worker heartbeat from Redis, so it is unknown whether another worker is running (${hb.reason})`);
  }
  if (problems.length === 0) return { start: true, problems, sharedStores: false };
  return input.allowSharedStores ? { start: true, problems, sharedStores: true } : { start: false, problems, sharedStores: false };
}

/** The help text of --allow-shared-stores: the consequences, in plain words. */
export const ALLOW_SHARED_STORES_HELP =
  "  --allow-shared-stores   With --with-worker, start the worker even though DATABASE_URL or REDIS_URL is not on this machine or another worker is running.\n" +
  "                          DANGEROUS. The worker's sweeps ask the mock about EVERY influencer's Google and WhatsApp connection in that database; the\n" +
  "                          mock rejects every token it did not issue, so every other influencer there is marked reconnect-needed or ERROR, alerted,\n" +
  "                          and their booking page goes offline. The worker also takes queued jobs of other users on that Redis and stamps mock Meet\n" +
  "                          links on real bookings, and any other worker will pick up the demo's jobs and send MOCK-NOT-REAL tokens to the real\n" +
  "                          Google and Meta. Use it only on stores that hold nothing but this demo.";

export const DEV_MOCK_HELP = [
  "npm run dev:mock [-- options]",
  "",
  "Starts the local mock of Google and Meta (127.0.0.1 only) and `next dev`, with the app pointed at the mock. No worker by default.",
  "",
  "  --app-url <url>         where the app is (a local address); default http://localhost:3000",
  "  --next-port <port>      the port next dev listens on; default: the port of --app-url",
  "  --port <port>           the mock's port; default 4010",
  "  --reset                 forget all the mock's fake state first",
  "  --with-worker           also start the worker (hold expiry, Meet links, messages, reminders, payment recovery). Refused unless DATABASE_URL and",
  "                          REDIS_URL are on this machine and no other worker is running: use a Postgres and Redis dedicated to the demo.",
  ALLOW_SHARED_STORES_HELP,
  "  --help                  this text",
].join("\n");

/** What to print when no worker is started: how to run the worker-dependent steps without harming a shared database. */
export const NO_WORKER_NOTE = [
  "Worker        NOT started. Without it nothing after payment happens: no Meet link, no confirmation messages, no hold expiry.",
  "              To run those steps safely use a Postgres and a Redis that hold only this demo (local, e.g. docker run -p 5432:5432 postgres:16-alpine",
  "              and docker run -p 6379:6379 redis:7-alpine; then prisma migrate deploy and npm run db:seed), put their URLs in DATABASE_URL and",
  "              REDIS_URL, stop any other worker (yours or the owner's), then: npm run dev:mock -- --with-worker",
].join("\n");

export const SHARED_STORES_BANNER =
  "WARNING: the worker is running against a database or Redis that is NOT on this machine (or next to another worker). Its sweeps ask the MOCK about every influencer's Google and WhatsApp connection there: expect other influencers to be marked reconnect-needed or ERROR within minutes. Stop it (Ctrl+C) unless these stores hold only this demo.";
