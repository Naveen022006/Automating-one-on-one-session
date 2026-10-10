import { NextResponse } from "next/server";
import { runWatchdog } from "@/lib/health-alerts";

export const dynamic = "force-dynamic";

/**
 * Liveness of the background worker, for an uptime monitor to poll (every few minutes is plenty). 200 while the worker's
 * heartbeat is fresh (or cannot be determined, e.g. Redis is not configured), 503 when the worker is not running.
 *
 * It is also the watchdog: the worker cannot report its own death, so each call that finds the heartbeat stale raises
 * the same alert as the health monitor (webhook + ADMIN_ALERT_EMAILS, at most once an hour) and a later call that finds
 * it fresh again sends the "recovered" note. Only liveness is exposed; business details stay behind the admin login.
 */
export async function GET() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const worker = await runWatchdog();
    const down = worker.status === "critical";
    return NextResponse.json(
      {
        ok: !down,
        worker: down ? "not-running" : worker.status === "ok" ? "running" : "unknown",
        heartbeatAgeSec: worker.value,
      },
      { status: down ? 503 : 200, headers },
    );
  } catch (e) {
    console.error("[health] watchdog failed", e);
    return NextResponse.json({ ok: false, worker: "unknown", heartbeatAgeSec: null }, { status: 503, headers });
  }
}
