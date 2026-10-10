/**
 * System health: the pure part. Takes a snapshot of measurements (gathered by lib/health.ts) and decides, with no I/O,
 * which conditions are unhealthy, what to say about them, and which alerts to send or clear. Everything here is
 * unit-tested without a database or Redis (tests/health.test.ts).
 */

export interface QueueCounts {
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
}

/** Thresholds. Counts are "unhealthy when above"; ages are "unhealthy when older than". Overridable by env. */
export interface HealthThresholds {
  /** Worker heartbeat older than this means the worker is not running. */
  workerStaleSeconds: number;
  /** A payment that Razorpay reports captured but we never booked, older than this, is unhealthy. */
  paymentUnrecoveredMinutes: number;
  /** A PAID booking without a Meet link for longer than this. */
  meetingStuckMinutes: number;
  /** Failed jobs kept in one queue before it is flagged. */
  queueFailedMax: number;
  /** Jobs waiting in one queue before it is flagged as backed up. */
  queueWaitingMax: number;
  /** An unpaid hold may be past its expiry for this long before the sweeper is considered stalled. */
  holdSweepGraceMinutes: number;
  /** Consecutive recovery runs in which every Razorpay lookup failed. */
  recoveryFailingRuns: number;
  /** The recovery loop runs every 2 minutes; if its last run is older than this it is stuck or not running (3x the interval). */
  recoveryStaleMinutes: number;
  /** The same alert key is sent at most once per this many minutes. */
  alertDedupeMinutes: number;
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  workerStaleSeconds: 180,
  paymentUnrecoveredMinutes: 10,
  meetingStuckMinutes: 15,
  queueFailedMax: 5,
  queueWaitingMax: 50,
  holdSweepGraceMinutes: 5,
  recoveryFailingRuns: 3,
  recoveryStaleMinutes: 6,
  alertDedupeMinutes: 60,
};

const ENV_KEYS: Record<keyof HealthThresholds, string> = {
  workerStaleSeconds: "HEALTH_WORKER_STALE_SECONDS",
  paymentUnrecoveredMinutes: "HEALTH_PAYMENT_UNRECOVERED_MINUTES",
  meetingStuckMinutes: "HEALTH_MEETING_STUCK_MINUTES",
  queueFailedMax: "HEALTH_QUEUE_FAILED_MAX",
  queueWaitingMax: "HEALTH_QUEUE_WAITING_MAX",
  holdSweepGraceMinutes: "HEALTH_HOLD_SWEEP_GRACE_MINUTES",
  recoveryFailingRuns: "HEALTH_RECOVERY_FAILING_RUNS",
  recoveryStaleMinutes: "HEALTH_RECOVERY_STALE_MINUTES",
  alertDedupeMinutes: "HEALTH_ALERT_DEDUPE_MINUTES",
};

/** Thresholds with env overrides; a missing or invalid value keeps the default. */
export function thresholdsFromEnv(env: Record<string, string | undefined> = process.env): HealthThresholds {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(ENV_KEYS) as (keyof HealthThresholds)[]) {
    const raw = env[ENV_KEYS[key]];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) out[key] = n;
  }
  return out;
}

export type HeartbeatReading =
  | { state: "ok"; at: number }
  /** Redis answered and there is no heartbeat key (never written, or expired). */
  | { state: "missing" }
  /**
   * Nothing can be said about the worker: Redis is not configured (`not-configured`, normal in local development) or it is
   * configured but did not answer (`down`, an outage).
   */
  | { state: "unknown"; reason: string; redis: "not-configured" | "down" };

export type RedisState = "not-configured" | "ok" | "down";

/**
 * Whether Redis is answering. Not configured is not an outage. A failed heartbeat read alone could be one flaky
 * connection, so Redis only counts as down when no queue answered either.
 */
export function deriveRedisState(heartbeat: HeartbeatReading, queues: Record<string, QueueCounts | null>): RedisState {
  if (heartbeat.state !== "unknown") return "ok";
  if (heartbeat.redis === "not-configured") return "not-configured";
  return Object.values(queues).some((q) => q !== null) ? "ok" : "down";
}

export interface RecoveryState {
  /** Recovery runs in a row in which Razorpay lookups were attempted and every one failed. */
  consecutiveFailedRuns: number;
  lastRunAt: number | null;
  lastError: string | null;
  lastCandidates: number;
  lastRecovered: number;
}

/** The measurements. A `null` count means it could not be measured (the query failed), which is not the same as zero. */
export interface HealthSnapshot {
  at: number;
  heartbeat: HeartbeatReading;
  redis: RedisState;
  unrecoveredPayments: number | null;
  recovery: RecoveryState | null;
  stuckMeetings: number | null;
  failedConfirmations: number | null;
  unsweptHolds: number | null;
  /** Per queue name; null when Redis could not be asked. */
  queues: Record<string, QueueCounts | null>;
}

/** `unknown` = could not be measured; it never raises or clears an alert. */
export type ConditionStatus = "ok" | "warn" | "critical" | "unknown";

export interface HealthCondition {
  /** Stable alert key (also the dedupe key). */
  id: string;
  label: string;
  status: ConditionStatus;
  /** What was measured: a count, or an age in seconds for the heartbeat. Null when unknown. */
  value: number | null;
  unit: string;
  /** One sentence about the current state. */
  detail: string;
  /** What to do about it, shown when unhealthy. */
  hint?: string;
  /** Admin page to look at. */
  href?: string;
}

export interface HealthReport {
  at: number;
  conditions: HealthCondition[];
  unhealthy: HealthCondition[];
}

export const isUnhealthy = (c: HealthCondition) => c.status === "warn" || c.status === "critical";

export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function evaluateWorker(heartbeat: HeartbeatReading, now: number, t: HealthThresholds = DEFAULT_THRESHOLDS): HealthCondition {
  const base = { id: "worker-heartbeat", label: "Background worker", unit: "seconds" };
  const hint = "Start it with `npm run worker` (or restart its process). Until then bookings are not confirmed, holds are not released and reminders are not sent.";
  if (heartbeat.state === "unknown") {
    return { ...base, status: "unknown", value: null, detail: `Cannot tell whether the worker is running (${heartbeat.reason}).` };
  }
  if (heartbeat.state === "missing") {
    return { ...base, status: "critical", value: null, detail: "Worker is not running: no heartbeat has been recorded.", hint };
  }
  const age = Math.max(0, Math.round((now - heartbeat.at) / 1000));
  if (age > t.workerStaleSeconds) {
    return { ...base, status: "critical", value: age, detail: `Worker is not running: the last heartbeat was ${formatAge(age)} ago.`, hint };
  }
  return { ...base, status: "ok", value: age, detail: `Worker is running (last heartbeat ${formatAge(age)} ago).` };
}

function countCondition(
  id: string,
  label: string,
  unit: [string, string],
  count: number | null,
  opts: { status: Exclude<ConditionStatus, "ok" | "unknown">; okText: string; badText: (n: number) => string; hint: string; href?: string },
): HealthCondition {
  if (count === null) return { id, label, unit: unit[1], status: "unknown", value: null, detail: "Could not be measured right now." };
  if (count === 0) return { id, label, unit: unit[1], status: "ok", value: 0, detail: opts.okText };
  return { id, label, unit: unit[1], status: opts.status, value: count, detail: opts.badText(count), hint: opts.hint, href: opts.href };
}

export function evaluateQueue(name: string, counts: QueueCounts | null, t: HealthThresholds = DEFAULT_THRESHOLDS): HealthCondition {
  const base = { id: `queue:${name}`, label: `Queue "${name}"`, unit: "failed jobs" };
  if (!counts) return { ...base, status: "unknown", value: null, detail: "Redis could not be asked for the job counts." };
  const summary = `${counts.waiting} waiting, ${counts.active} active, ${counts.delayed} delayed, ${counts.failed} failed`;
  const reasons: string[] = [];
  if (counts.failed > t.queueFailedMax) reasons.push(`${plural(counts.failed, "failed job")} (more than ${t.queueFailedMax})`);
  if (counts.waiting > t.queueWaitingMax) reasons.push(`${counts.waiting} jobs waiting (more than ${t.queueWaitingMax})`);
  if (reasons.length === 0) return { ...base, status: "ok", value: counts.failed, detail: summary };
  return {
    ...base,
    status: "warn",
    value: counts.failed,
    detail: `${reasons.join("; ")}. ${summary}.`,
    hint: "Open the failed job list below for the reason; failed jobs are kept until someone removes them.",
  };
}

export function evaluateRecovery(recovery: RecoveryState | null, t: HealthThresholds = DEFAULT_THRESHOLDS): HealthCondition {
  const base = { id: "recovery-failing", label: "Payment recovery lookups", unit: "failed runs" };
  if (!recovery) return { ...base, status: "unknown", value: null, detail: "No payment recovery run has been recorded yet." };
  if (recovery.consecutiveFailedRuns >= t.recoveryFailingRuns) {
    return {
      ...base,
      status: "critical",
      value: recovery.consecutiveFailedRuns,
      detail: `Razorpay could not be reached by ${plural(recovery.consecutiveFailedRuns, "recovery run")} in a row${recovery.lastError ? `: ${recovery.lastError}` : ""}. A payment whose webhook was lost would not be found.`,
      hint: "Check Razorpay's status and the RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET values the worker uses.",
    };
  }
  return { ...base, status: "ok", value: recovery.consecutiveFailedRuns, detail: "Razorpay lookups are answering." };
}

/**
 * Redis is where the job queues, the worker heartbeat and the alert dedupe live. When it is configured but not answering,
 * every other Redis-based check turns "unknown", so the outage itself has to be a condition that alerts.
 */
export function evaluateRedis(state: RedisState, reason?: string): HealthCondition {
  const base = { id: "redis-unreachable", label: "Redis", unit: "" };
  if (state === "not-configured") {
    return { ...base, status: "unknown", value: null, detail: "Redis is not configured (REDIS_URL): job queues and the worker heartbeat are unavailable." };
  }
  if (state === "ok") return { ...base, status: "ok", value: null, detail: "Redis is answering." };
  return {
    ...base,
    status: "critical",
    value: null,
    detail: `Redis is configured but is not answering${reason ? ` (${reason})` : ""}. Queued jobs, reminders and the worker heartbeat cannot be checked.`,
    hint: "Check the Redis service and REDIS_URL. Paid bookings wait without a Meet link until it is back; recovery re-queues them automatically.",
  };
}

/** The recovery loop records a timestamp every run; a stale one means the loop is stuck or crashing even though the worker is up. */
export function evaluateRecoveryStale(
  recovery: RecoveryState | null,
  workerOk: boolean,
  now: number,
  t: HealthThresholds = DEFAULT_THRESHOLDS,
): HealthCondition {
  const base = { id: "recovery-stale", label: "Payment recovery loop", unit: "seconds" };
  if (!workerOk) return { ...base, status: "unknown", value: null, detail: "Not checked while the worker's state is not known to be running." };
  if (!recovery?.lastRunAt) return { ...base, status: "unknown", value: null, detail: "No payment recovery run has been recorded (it may be turned off)." };
  const age = Math.max(0, Math.round((now - recovery.lastRunAt) / 1000));
  if (age > t.recoveryStaleMinutes * 60) {
    return {
      ...base,
      status: "critical",
      value: age,
      detail: `Payment recovery last ran ${formatAge(age)} ago; it should run every 2 minutes. A payment whose webhook was lost would not be found.`,
      hint: "The recovery loop is stuck or crashing while the worker is up: read the worker log and restart the worker.",
    };
  }
  return { ...base, status: "ok", value: age, detail: `Payment recovery last ran ${formatAge(age)} ago.` };
}

/** Turns measurements into the list of conditions, in the order the admin page shows them. */
export function evaluateHealth(snapshot: HealthSnapshot, t: HealthThresholds = DEFAULT_THRESHOLDS): HealthReport {
  const worker = evaluateWorker(snapshot.heartbeat, snapshot.at, t);
  const conditions: HealthCondition[] = [
    worker,
    evaluateRedis(snapshot.redis, snapshot.heartbeat.state === "unknown" ? snapshot.heartbeat.reason : undefined),
    countCondition("payments-unrecovered", "Paid at Razorpay but not booked", ["payment", "payments"], snapshot.unrecoveredPayments, {
      status: "critical",
      okText: "No captured payment is waiting to be booked.",
      badText: (n) => `${plural(n, "payment")} captured at Razorpay for longer than ${t.paymentUnrecoveredMinutes} min, but the booking is still unpaid and recovery could not apply it.`,
      hint: "The customer has paid. Find the payment under Payments > Unpaid / failed and read the worker log for the reason recovery could not apply it.",
      href: "/admin/payments?view=unpaid",
    }),
    evaluateRecovery(snapshot.recovery, t),
    evaluateRecoveryStale(snapshot.recovery, worker.status === "ok", snapshot.at, t),
    countCondition("meetings-stuck", "Paid bookings without a Meet link", ["booking", "bookings"], snapshot.stuckMeetings, {
      status: "warn",
      okText: "Every paid booking has its Meet link.",
      badText: (n) => `${plural(n, "paid booking")} still without a Meet link after ${t.meetingStuckMinutes} min.`,
      hint: "Usually the influencer's Google connection, or the create-meeting job failed. See Bookings > Paid, link pending.",
      href: "/admin/bookings?status=PAID",
    }),
    countCondition("confirmations-failed", "Confirmations not delivered", ["booking", "bookings"], snapshot.failedConfirmations, {
      status: "warn",
      okText: "Every upcoming booking's confirmation went out.",
      badText: (n) => `${plural(n, "upcoming booking")} whose confirmation message failed on every channel.`,
      hint: "Open the booking and resend the confirmation, or contact the customer.",
      href: "/admin/bookings",
    }),
    countCondition("holds-unswept", "Expired holds not released", ["hold", "holds"], snapshot.unsweptHolds, {
      status: "warn",
      okText: "Expired holds are being released on time.",
      badText: (n) => `${plural(n, "unpaid hold")} still open more than ${t.holdSweepGraceMinutes} min after expiry. Seats stay correct, but the expiry job is not running.`,
      hint: "The worker's hold-expiry tick is stalled; restart the worker.",
    }),
    ...Object.entries(snapshot.queues).map(([name, counts]) => evaluateQueue(name, counts, t)),
  ];
  return { at: snapshot.at, conditions, unhealthy: conditions.filter(isUnhealthy) };
}

/** What the alert layer knows from earlier runs (Redis in production). */
export interface AlertState {
  /** Alert keys already sent within the dedupe window. */
  recentlyAlerted: ReadonlySet<string>;
  /** Alert keys currently raised (sent at some point and not yet cleared). */
  active: ReadonlySet<string>;
}

export interface AlertPlan {
  /** Unhealthy and not alerted within the dedupe window. */
  notify: HealthCondition[];
  /** Were raised earlier and are measurably fine now. */
  recovered: HealthCondition[];
}

/**
 * Decides what to send. A condition alerts when it is unhealthy and was not alerted in the dedupe window; a condition
 * that was raised and is now measurably healthy produces one "recovered" note. A condition that cannot be measured
 * does neither (an outage of the monitor's own data source must not look like a recovery).
 */
export function planAlerts(report: Pick<HealthReport, "conditions">, state: AlertState): AlertPlan {
  const notify: HealthCondition[] = [];
  const recovered: HealthCondition[] = [];
  for (const c of report.conditions) {
    if (isUnhealthy(c)) {
      if (!state.recentlyAlerted.has(c.id)) notify.push(c);
    } else if (c.status === "ok" && state.active.has(c.id)) {
      recovered.push(c);
    }
  }
  return { notify, recovered };
}

/** Comma-separated ADMIN_ALERT_EMAILS -> a clean, de-duplicated list (invalid entries dropped). */
export function parseAlertEmails(raw: string | undefined): string[] {
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const email = part.trim().toLowerCase();
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) seen.add(email);
  }
  return [...seen];
}

/** What a recovery run changes in the persisted recovery state. */
export interface RecoveryRunFacts {
  at: number;
  candidates: number;
  lookupsOk: number;
  lookupErrors: number;
  recovered: number;
  /** The run stopped early or could not even select its batch. */
  aborted: boolean;
  lastError?: string;
}

export function nextRecoveryState(prev: RecoveryState | null, run: RecoveryRunFacts): RecoveryState {
  // A run only counts as "failing" when it tried Razorpay and nothing came back. A run with nothing to check proves
  // Razorpay is fine as little as it proves it is down, so it clears the streak; a run that could not even start
  // (database error) leaves the streak as it was.
  const failed = run.lookupErrors > 0 && run.lookupsOk === 0;
  const worked = run.lookupsOk > 0 || (run.candidates === 0 && !run.aborted);
  return {
    consecutiveFailedRuns: failed ? (prev?.consecutiveFailedRuns ?? 0) + 1 : worked ? 0 : (prev?.consecutiveFailedRuns ?? 0),
    lastRunAt: run.at,
    lastError: failed ? (run.lastError ?? "lookup failed") : null,
    lastCandidates: run.candidates,
    lastRecovered: run.recovered,
  };
}
