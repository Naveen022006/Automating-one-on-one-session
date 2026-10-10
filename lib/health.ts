/**
 * Health checks behind GET /api/health (liveness) and GET /api/ready (readiness).
 *
 *   liveness   "is this process up?"  No dependencies at all, so a database or Redis outage can never make an
 *              orchestrator kill and restart a healthy process.
 *   readiness  "can this instance serve traffic?"  Pings Postgres and, when REDIS_URL is set, Redis, each with a
 *              short timeout. A failing instance is taken out of the load balancer (503) but not restarted.
 *
 * The response names which check failed and nothing else: no connection strings, hostnames or error messages.
 * The cause is written to the server log (code or class name only, throttled).
 */

export type CheckStatus = "ok" | "fail" | "skipped";

export interface ReadinessResult {
  ok: boolean;
  checks: { db: CheckStatus; redis: CheckStatus };
}

export interface ReadinessDeps {
  pingDb: () => Promise<unknown>;
  /** null when Redis is not configured: the check is reported as "skipped" and does not affect readiness. */
  pingRedis: (() => Promise<unknown>) | null;
  /** Per-check budget, default 3000 ms. A cold connection to a remote pooler can take ~1 s; set the probe timeout to 5 s. */
  timeoutMs?: number;
  /** Called with the check name and a short, secret-free reason ("timeout", an error code or class name). */
  onFailure?: (check: "db" | "redis", reason: string) => void;
}

const TIMEOUT = Symbol("timeout");

/** Runs one ping with a deadline. Never throws, never leaks the underlying error beyond a short reason. */
async function runCheck(
  name: "db" | "redis",
  ping: () => Promise<unknown>,
  timeoutMs: number,
  onFailure?: ReadinessDeps["onFailure"],
): Promise<CheckStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      timer.unref?.();
    });
    // The ping may reject after we have stopped waiting; attach a handler so that never becomes an unhandled rejection.
    const attempt = ping();
    attempt.catch(() => {});
    const winner = await Promise.race([attempt, deadline]);
    if (winner === TIMEOUT) {
      onFailure?.(name, "timeout");
      return "fail";
    }
    return "ok";
  } catch (e) {
    onFailure?.(name, reasonOf(e));
    return "fail";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Error code (ECONNREFUSED, P1001, ...) or class name. Deliberately never the message, which can carry hostnames. */
function reasonOf(e: unknown): string {
  if (e && typeof e === "object") {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(code)) return code;
    const name = (e as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(name)) return name;
  }
  return "error";
}

export async function checkReadiness(deps: ReadinessDeps): Promise<ReadinessResult> {
  const timeoutMs = deps.timeoutMs ?? 3_000;
  const [db, redis] = await Promise.all([
    runCheck("db", deps.pingDb, timeoutMs, deps.onFailure),
    deps.pingRedis ? runCheck("redis", deps.pingRedis, timeoutMs, deps.onFailure) : Promise.resolve<CheckStatus>("skipped"),
  ]);
  return { ok: db !== "fail" && redis !== "fail", checks: { db, redis } };
}

/** The HTTP response for /api/ready: 200 when every configured dependency answered, 503 otherwise. Never cached. */
export async function readinessResponse(deps: ReadinessDeps): Promise<Response> {
  const result = await checkReadiness(deps);
  return Response.json(result, { status: result.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

/** The liveness response: the process is running and can answer HTTP. Touches nothing else. */
export function livenessResponse(): Response {
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}

/* ---------- real dependencies (loaded lazily so the checks above stay importable without Prisma or Redis) ---------- */

type PingableRedis = { ping(): Promise<unknown>; on(event: string, listener: () => void): unknown; disconnect(): void };
let redisClient: PingableRedis | undefined;

/** Closes the readiness Redis connection (tests and graceful shutdown). The next ping opens a new one. */
export function closeReadinessConnections(): void {
  redisClient?.disconnect();
  redisClient = undefined;
}

/** One long-lived, fail-fast connection used only for readiness pings (separate from the queues and rate limiter). */
async function redisPing(): Promise<unknown> {
  if (!redisClient) {
    const { default: IORedis } = await import("ioredis");
    const client = new IORedis(process.env.REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
      retryStrategy: (attempt) => Math.min(attempt * 250, 3_000),
    }) as unknown as PingableRedis;
    // ioredis prints every connection error to the console unless a listener exists; failures are reported by the check.
    client.on("error", () => {});
    redisClient = client;
  }
  return redisClient.ping();
}

const lastLogged = new Map<string, number>();

/** Logs a readiness failure at most once a minute per check, so a probe every few seconds cannot flood the log. */
export function logReadinessFailure(check: "db" | "redis", reason: string, now = Date.now()): void {
  if (now - (lastLogged.get(check) ?? 0) < 60_000) return;
  lastLogged.set(check, now);
  console.error(`[ready] ${check} check failed: ${reason}`);
}

export function defaultReadinessDeps(): ReadinessDeps {
  return {
    pingDb: async () => {
      const { prisma } = await import("@/lib/db");
      return prisma.$queryRaw`SELECT 1`;
    },
    pingRedis: process.env.REDIS_URL ? redisPing : null,
    onFailure: logReadinessFailure,
  };
}
