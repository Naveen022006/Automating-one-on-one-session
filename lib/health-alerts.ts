import { appUrl } from "@/lib/brand";
import {
  collectSnapshot,
  getHealthKv,
  readHeartbeat,
  type HealthKv,
} from "@/lib/health";
import {
  deriveRedisState,
  evaluateHealth,
  evaluateRedis,
  evaluateWorker,
  isUnhealthy,
  parseAlertEmails,
  planAlerts,
  thresholdsFromEnv,
  type HealthCondition,
  type HealthReport,
  type HealthSnapshot,
  type HealthThresholds,
} from "@/lib/health-eval";
import { reportError, reportNotice } from "@/lib/observability";
import { within } from "@/lib/timeout";
import type { RenderedEmail } from "@/lib/email/layout";

/**
 * Health alerting: runs the monitor, tells the owner when a condition crosses its threshold and when it clears.
 * Every alert key is sent at most once per dedupe window (an atomic Redis `SET NX EX`, with an in-memory fallback), so
 * a problem that stays broken produces one message an hour rather than one per monitor run. Nothing here throws.
 */

const ALERTED_PREFIX = "health:alerted:";
const ACTIVE_PREFIX = "health:active:";
/** A raised alert stays "active" (so a recovery note can follow) for this long after it was last seen unhealthy. */
const ACTIVE_TTL_SEC = 7 * 86_400;

export interface AlertDeps {
  kv: HealthKv;
  thresholds: HealthThresholds;
  /** Recipients of the email (ADMIN_ALERT_EMAILS). Empty = webhook and log only. */
  emails: string[];
  notice: typeof reportNotice;
  sendEmail: (to: string, message: RenderedEmail) => Promise<boolean>;
  healthUrl: string;
}

async function defaultSendEmail(to: string, message: RenderedEmail): Promise<boolean> {
  const { sendAccountEmail } = await import("@/lib/email");
  return sendAccountEmail({ email: to }, message, "system-health");
}

/** Fills in what the caller did not override. Each default is built only when needed (no Redis connection if `kv` is given). */
function resolveAlertDeps(o: Partial<AlertDeps>): AlertDeps {
  return {
    kv: o.kv ?? getHealthKv(),
    thresholds: o.thresholds ?? thresholdsFromEnv(),
    emails: o.emails ?? parseAlertEmails(process.env.ADMIN_ALERT_EMAILS),
    notice: o.notice ?? reportNotice,
    sendEmail: o.sendEmail ?? defaultSendEmail,
    healthUrl: o.healthUrl ?? `${appUrl()}/admin/health`,
  };
}

export interface AlertResult {
  /** Alert keys sent now. */
  alerted: string[];
  /** Alert keys that cleared now. */
  recovered: string[];
  /** Alert keys whose emails all failed: their dedupe key was released so the next run tries again. */
  retrying: string[];
}

/** Sends the alerts and recovery notes a report calls for, and remembers them. */
export async function processAlerts(report: Pick<HealthReport, "conditions">, overrides: Partial<AlertDeps> = {}): Promise<AlertResult> {
  const result: AlertResult = { alerted: [], recovered: [], retrying: [] };
  try {
    const deps = resolveAlertDeps(overrides);
    const { kv } = deps;

    const recentlyAlerted = new Set<string>();
    const active = new Set<string>();
    await Promise.all(
      report.conditions.map(async (c) => {
        if (isUnhealthy(c)) {
          if ((await kv.get(ALERTED_PREFIX + c.id)) !== null) recentlyAlerted.add(c.id);
        } else if (c.status === "ok") {
          if ((await kv.get(ACTIVE_PREFIX + c.id)) !== null) active.add(c.id);
        }
      }),
    );
    const plan = planAlerts(report, { recentlyAlerted, active });

    // Still broken: keep the "active" marker alive so the eventual recovery is announced.
    await Promise.all(report.conditions.filter(isUnhealthy).map((c) => kv.set(ACTIVE_PREFIX + c.id, "1", ACTIVE_TTL_SEC)));

    // Claim before sending: of several monitors (or a monitor and the watchdog) racing, exactly one wins each key.
    const dedupeSec = Math.max(1, Math.round(deps.thresholds.alertDedupeMinutes * 60));
    const toSend: HealthCondition[] = [];
    for (const c of plan.notify) {
      if (await kv.setNx(ALERTED_PREFIX + c.id, new Date().toISOString(), dedupeSec)) toSend.push(c);
    }

    // The channels are independent: a broken webhook hook must not stop the email, and the other way round.
    const notify: AlertDeps["notice"] = (level, text, context) => {
      try {
        deps.notice(level, text, context);
      } catch (e) {
        console.error("[health] notice hook failed:", e instanceof Error ? e.message : e);
      }
    };

    if (toSend.length > 0) {
      for (const c of toSend) {
        notify("warn", `Health alert: ${c.label}: ${c.detail}`, { where: "health-monitor", alert: c.id, status: c.status, value: c.value });
      }
      const mail = await emailAll(deps, true, toSend);
      result.alerted = toSend.map((c) => c.id);
      if (mail.attempted > 0 && mail.delivered === 0) {
        // Nobody could be emailed. Do not let the dedupe window swallow the alert: release it so the next run tries again.
        await Promise.all(toSend.map((c) => kv.del(ALERTED_PREFIX + c.id)));
        result.retrying = toSend.map((c) => c.id);
      }
    }

    if (plan.recovered.length > 0) {
      // Only the caller whose delete actually removed the marker announces the recovery, so two overlapping runs
      // (monitor + /api/health, or parallel /api/health calls) cannot each send one.
      const announce: HealthCondition[] = [];
      for (const c of plan.recovered) {
        if (await kv.delIfExists(ACTIVE_PREFIX + c.id)) announce.push(c);
      }
      for (const c of announce) notify("info", `Health recovered: ${c.label}`, { where: "health-monitor", alert: c.id });
      if (announce.length > 0) await emailAll(deps, false, announce);
      result.recovered = announce.map((c) => c.id);
    }
  } catch (e) {
    reportError(e, { where: "health-alerts" });
  }
  return result;
}

/** Emails every recipient; `attempted` is how many sends were tried, `delivered` how many the provider accepted. */
async function emailAll(deps: AlertDeps, alert: boolean, conditions: HealthCondition[]): Promise<{ attempted: number; delivered: number }> {
  if (deps.emails.length === 0) return { attempted: 0, delivered: 0 };
  try {
    const { systemHealthMessage } = await import("@/lib/email/templates");
    const message = systemHealthMessage({
      recovered: !alert,
      items: conditions.map((c) => ({ label: c.label, detail: c.detail, hint: alert ? c.hint : undefined })),
      healthUrl: deps.healthUrl,
    });
    const sent = await Promise.all(
      deps.emails.map((to) =>
        deps.sendEmail(to, message).catch((e) => {
          console.error("[health] alert email failed:", e instanceof Error ? e.message : e);
          return false;
        }),
      ),
    );
    return { attempted: sent.length, delivered: sent.filter(Boolean).length };
  } catch (e) {
    console.error("[health] could not send alert email:", e instanceof Error ? e.message : e);
    return { attempted: deps.emails.length, delivered: 0 };
  }
}

export interface MonitorDeps extends AlertDeps {
  /** Measures everything. Defaults to the real database and Redis. */
  collect: (thresholds: HealthThresholds, kv?: HealthKv) => Promise<HealthSnapshot>;
  /** Re-queues create-meeting for paid bookings that have no link. Defaults to requeuePendingMeetings. */
  requeuePending: () => Promise<number>;
}

async function defaultRequeuePending(): Promise<number> {
  const { requeuePendingMeetings } = await import("@/lib/meeting");
  return requeuePendingMeetings();
}

/**
 * The scheduled monitor (the worker runs it every five minutes): measure everything, judge it, alert, and repair what can
 * be repaired. Returns the report (or null if measuring itself failed). Never throws.
 *
 * Repair: a booking that is PAID but has no Meet link is re-queued (`requeuePendingMeetings` clears a finished job that
 * would otherwise make BullMQ ignore the new one), so a lost or stale job is fixed rather than only reported.
 */
export async function runHealthMonitor(overrides: Partial<MonitorDeps> = {}): Promise<HealthReport | null> {
  try {
    const thresholds = overrides.thresholds ?? thresholdsFromEnv();
    const collect = overrides.collect ?? ((t: HealthThresholds, kv?: HealthKv) => collectSnapshot({ thresholds: t, ...(kv ? { kv } : {}) }));
    const snapshot = await collect(thresholds, overrides.kv);
    const report = evaluateHealth(snapshot, thresholds);
    await processAlerts(report, { ...overrides, thresholds });

    const stuck = report.conditions.find((c) => c.id === "meetings-stuck");
    if (stuck && (stuck.value ?? 0) > 0) {
      try {
        const n = await within((overrides.requeuePending ?? defaultRequeuePending)(), 30_000, "re-queueing paid bookings without a meeting");
        if (n > 0) console.log(`[health] re-queued create-meeting for ${n} paid booking(s) without a Meet link`);
      } catch (e) {
        reportError(e, { where: "health-monitor:requeue-meetings" });
      }
    }
    return report;
  } catch (e) {
    reportError(e, { where: "health-monitor" });
    return null;
  }
}

export interface WatchdogResult {
  worker: HealthCondition;
  redis: HealthCondition;
}

/**
 * The worker cannot report its own death (and the monitor lives in the worker), so something outside it has to look.
 * This checks the heartbeat and Redis and raises (or clears) the same alert keys as the monitor. It is called by
 * /api/health, which an uptime service can poll. A failed Redis read is retried once before it counts as an outage.
 */
export async function runWatchdog(overrides: Partial<AlertDeps> & { retryDelayMs?: number } = {}): Promise<WatchdogResult> {
  const { retryDelayMs = 750, ...alertOverrides } = overrides;
  const thresholds = alertOverrides.thresholds ?? thresholdsFromEnv();
  const kv = alertOverrides.kv ?? getHealthKv();
  let heartbeat = await readHeartbeat(kv);
  if (heartbeat.state === "unknown" && heartbeat.redis === "down") {
    await new Promise((r) => setTimeout(r, retryDelayMs));
    heartbeat = await readHeartbeat(kv);
  }
  const worker = evaluateWorker(heartbeat, Date.now(), thresholds);
  const redis = evaluateRedis(deriveRedisState(heartbeat, {}), heartbeat.state === "unknown" ? heartbeat.reason : undefined);
  await processAlerts({ conditions: [worker, redis] }, { ...alertOverrides, thresholds, kv });
  return { worker, redis };
}
