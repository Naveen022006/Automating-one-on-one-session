import { appUrl } from "@/lib/brand";
import {
  collectSnapshot,
  getHealthKv,
  readHeartbeat,
  type HealthKv,
} from "@/lib/health";
import {
  evaluateHealth,
  evaluateWorker,
  isUnhealthy,
  parseAlertEmails,
  planAlerts,
  thresholdsFromEnv,
  type HealthCondition,
  type HealthReport,
  type HealthThresholds,
} from "@/lib/health-eval";
import { reportError, reportNotice } from "@/lib/observability";
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
}

/** Sends the alerts and recovery notes a report calls for, and remembers them. */
export async function processAlerts(report: Pick<HealthReport, "conditions">, overrides: Partial<AlertDeps> = {}): Promise<AlertResult> {
  const result: AlertResult = { alerted: [], recovered: [] };
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
      await emailAll(deps, true, toSend);
      result.alerted = toSend.map((c) => c.id);
    }

    if (plan.recovered.length > 0) {
      for (const c of plan.recovered) {
        notify("info", `Health recovered: ${c.label}`, { where: "health-monitor", alert: c.id });
        await kv.del(ACTIVE_PREFIX + c.id);
      }
      await emailAll(deps, false, plan.recovered);
      result.recovered = plan.recovered.map((c) => c.id);
    }
  } catch (e) {
    reportError(e, { where: "health-alerts" });
  }
  return result;
}

async function emailAll(deps: AlertDeps, alert: boolean, conditions: HealthCondition[]): Promise<void> {
  if (deps.emails.length === 0) return;
  try {
    const { systemHealthMessage } = await import("@/lib/email/templates");
    const message = systemHealthMessage({
      recovered: !alert,
      items: conditions.map((c) => ({ label: c.label, detail: c.detail, hint: alert ? c.hint : undefined })),
      healthUrl: deps.healthUrl,
    });
    await Promise.all(
      deps.emails.map((to) =>
        deps.sendEmail(to, message).catch((e) => {
          console.error("[health] alert email failed:", e instanceof Error ? e.message : e);
          return false;
        }),
      ),
    );
  } catch (e) {
    console.error("[health] could not send alert email:", e instanceof Error ? e.message : e);
  }
}

/**
 * The scheduled monitor (the worker runs it every five minutes): measure everything, judge it, alert. Returns the report
 * (or null if measuring itself failed). Never throws.
 */
export async function runHealthMonitor(overrides: Partial<AlertDeps> = {}): Promise<HealthReport | null> {
  try {
    const thresholds = overrides.thresholds ?? thresholdsFromEnv();
    const snapshot = await collectSnapshot({ thresholds, ...(overrides.kv ? { kv: overrides.kv } : {}) });
    const report = evaluateHealth(snapshot, thresholds);
    await processAlerts(report, { thresholds, ...overrides });
    return report;
  } catch (e) {
    reportError(e, { where: "health-monitor" });
    return null;
  }
}

/**
 * The worker cannot report its own death, so something outside it has to look. This checks only the heartbeat and
 * raises (or clears) the same alert key as the monitor. It is called by /api/health, which an uptime service can poll.
 */
export async function runWatchdog(overrides: Partial<AlertDeps> = {}): Promise<HealthCondition> {
  const thresholds = overrides.thresholds ?? thresholdsFromEnv();
  const kv = overrides.kv ?? getHealthKv();
  const condition = evaluateWorker(await readHeartbeat(kv), Date.now(), thresholds);
  await processAlerts({ conditions: [condition] }, { thresholds, kv, ...overrides });
  return condition;
}
