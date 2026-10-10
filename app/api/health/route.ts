import { NextResponse } from "next/server";
import { runWatchdog } from "@/lib/health-alerts";

export const dynamic = "force-dynamic";

/**
 * Liveness of the background worker and of Redis, for an uptime monitor to poll (every few minutes is plenty). 200 while the
 * worker's heartbeat is fresh (or cannot be determined because Redis is not configured, as in local development), 503 when
 * the worker is not running or when Redis is configured but not answering.
 *
 * It is also the watchdog: the worker cannot report its own death, so each call that finds the heartbeat stale (or Redis
 * down) raises the same alert as the health monitor (webhook + ADMIN_ALERT_EMAILS, at most once an hour) and a later call
 * that finds it healthy again sends the "recovered" note. Only liveness is exposed; business details stay behind the admin login.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const { worker, redis } = await runWatchdog();
    const workerDown = worker.status === "critical";
    const redisDown = redis.status === "critical";
    return NextResponse.json(
      {
        ok: !workerDown && !redisDown,
        worker: workerDown ? "not-running" : worker.status === "ok" ? "running" : "unknown",
        redis: redisDown ? "unreachable" : redis.status === "ok" ? "ok" : "not-configured",
        heartbeatAgeSec: worker.value,
      },
      { status: workerDown || redisDown ? 503 : 200, headers },
    );
  } catch (e) {
    console.error("[health] watchdog failed", e);
    return NextResponse.json({ ok: false, worker: "unknown", redis: "unknown", heartbeatAgeSec: null }, { status: 503, headers });
  }
}
