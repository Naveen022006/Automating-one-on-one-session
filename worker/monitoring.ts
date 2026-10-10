import { HEARTBEAT_EVERY_MS, recordRecoveryRun, writeHeartbeat } from "../lib/health";
import { runHealthMonitor } from "../lib/health-alerts";
import { reportError, reportNotice } from "../lib/observability";
import { runPaymentRecovery } from "../lib/payment-recovery";

/**
 * Worker schedule for the safety nets that sit beside the queues: a heartbeat every 30 s (so the admin console and
 * /api/health/watchdog can tell the worker is alive), missed-webhook payment recovery every 2 minutes, and the system health
 * monitor every 5 minutes. Each job runs on its own timer and never overlaps itself: if the previous run is still going
 * when the timer fires, that tick is skipped. Nothing here can throw out of a timer.
 */

export const RECOVERY_EVERY_MS = 2 * 60_000;
export const MONITOR_EVERY_MS = 5 * 60_000;

/**
 * Wraps an async job so that a call made while the previous call is still running is skipped instead of started.
 * Resolves true if the job ran, false if it was skipped; a job that throws is reported and counts as having run.
 */
export function singleFlight<A extends unknown[]>(
  job: (...args: A) => Promise<unknown>,
  opts: { name?: string; onSkip?: () => void; onError?: (e: unknown) => void } = {},
): (...args: A) => Promise<boolean> {
  let running = false;
  return async (...args: A) => {
    if (running) {
      opts.onSkip?.();
      return false;
    }
    running = true;
    try {
      await job(...args);
    } catch (e) {
      (opts.onError ?? ((err) => reportError(err, { where: `worker:${opts.name ?? "job"}` })))(e);
    } finally {
      running = false;
    }
    return true;
  };
}

/** One recovery pass plus bookkeeping. Exported for tests and for a manual one-off run. */
export async function recoveryTick(): Promise<void> {
  const summary = await runPaymentRecovery();
  await recordRecoveryRun({
    at: Date.now(),
    candidates: summary.candidates,
    lookupsOk: summary.lookupsOk,
    lookupErrors: summary.lookupErrors,
    recovered: summary.recovered,
    aborted: summary.aborted,
    lastError: summary.lastError,
  });
  if (summary.recovered > 0 || summary.flagged > 0 || summary.applyFailures > 0) {
    console.log(
      `[worker] payment recovery: ${summary.recovered} recovered, ${summary.flagged} flagged for refund, ${summary.applyFailures} could not be applied (of ${summary.candidates} checked)`,
    );
  }
  if (summary.recovered + summary.flagged > 0) {
    // A payment only reaches recovery when its webhook did not: worth knowing, because the next one may not be found as fast.
    reportNotice("warn", `Payment recovery found ${summary.recovered + summary.flagged} payment(s) whose Razorpay webhook never arrived. Check the webhook URL and secret.`, {
      where: "payment-recovery",
      recovered: summary.recovered,
      flagged: summary.flagged,
    });
  }
}

function recoveryDisabledReason(): string | null {
  if (process.env.PAYMENT_RECOVERY_ENABLED === "false") return "PAYMENT_RECOVERY_ENABLED=false";
  if (!process.env.REDIS_URL) return "REDIS_URL is not set (a recovered payment could not queue its meeting job)";
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) return "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set";
  return null;
}

/** Starts the heartbeat, recovery and monitor timers. Returns a function that stops them. */
export function startMonitoring(): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, fn: () => unknown) => {
    const t = setInterval(() => void fn(), ms);
    t.unref(); // the BullMQ workers keep the process alive; these must not
    timers.push(t);
  };
  const after = (ms: number, fn: () => unknown) => {
    const t = setTimeout(() => void fn(), ms);
    t.unref();
    timers.push(t);
  };

  const heartbeat = singleFlight(() => writeHeartbeat(), { name: "heartbeat" });
  void heartbeat();
  every(HEARTBEAT_EVERY_MS, heartbeat);

  const disabled = recoveryDisabledReason();
  if (disabled) {
    console.warn(`[worker] payment recovery is off: ${disabled}`);
  } else {
    const recovery = singleFlight(recoveryTick, {
      name: "payment-recovery",
      onSkip: () => console.warn("[worker] payment recovery is still running; skipping this tick"),
    });
    after(15_000, recovery); // let start-up settle (and the database pool free up) first
    every(RECOVERY_EVERY_MS, recovery);
    console.log(`[worker] payment recovery running every ${RECOVERY_EVERY_MS / 60_000} min`);
  }

  const monitor = singleFlight(() => runHealthMonitor(), {
    name: "health-monitor",
    onSkip: () => console.warn("[worker] health monitor is still running; skipping this tick"),
  });
  after(60_000, monitor);
  every(MONITOR_EVERY_MS, monitor);
  console.log(`[worker] health monitor running every ${MONITOR_EVERY_MS / 60_000} min, heartbeat every ${HEARTBEAT_EVERY_MS / 1000} s`);

  return () => {
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
  };
}
