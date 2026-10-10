import { listFailedJobs, listRecoveredPayments, type FailedJobsView, type RecoveredPaymentRow } from "@/lib/admin/health-data";
import { collectSnapshot, evaluateHealth, formatAge, thresholdsFromEnv, type ConditionStatus, type HealthSnapshot, type HealthThresholds } from "@/lib/health";
import { QUEUE_NAMES } from "@/lib/queue";

/**
 * The admin System health page's data, for the old Next page and GET /api/admin/health. The caller has already passed the
 * admin gate (`requireAdminPage` / `requireAdminMfa()`).
 *
 * It sends the judged conditions and the numbers the page shows, never the raw environment: of the thresholds only the four
 * the page prints, and every free-text field that can carry an error message goes through scrubHealthText().
 */

/** Environment variables whose values are secrets or connection strings (the same names the build's secret scan looks for). */
const SECRET_ENV_NAME = /SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL/;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;

/**
 * Error messages from Redis, Razorpay or the queue library are shown on the page. This takes a secret out of such a message
 * if one slipped in: any secret-looking environment value (8 characters or more) becomes "[hidden]", and the user and
 * password part of a URL (`redis://user:password@host`) becomes `***`.
 */
export function scrubHealthText(text: string, env: Record<string, string | undefined> = process.env): string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[hidden]");
  return out.replace(URL_CREDENTIALS, "$1***@");
}

export interface AdminHealthCondition {
  id: string;
  label: string;
  status: ConditionStatus;
  /** A count, or an age in seconds; null when it could not be measured. */
  value: number | null;
  detail: string;
  hint: string | null;
  /** The admin page to look at. */
  href: string | null;
}

export interface AdminHealthView {
  /** When the checks ran (ms since the epoch). */
  at: number;
  /** The four limits the page prints under the conditions table. */
  thresholds: { workerStaleSeconds: number; meetingStuckMinutes: number; queueFailedMax: number; queueWaitingMax: number };
  report: {
    /** All of them, the worker's first. */
    conditions: AdminHealthCondition[];
    unhealthy: { id: string; label: string; status: ConditionStatus }[];
  };
  worker: {
    status: ConditionStatus;
    detail: string;
    hint: string | null;
    /** ms since the epoch; null when no heartbeat could be read. */
    lastBeatAt: number | null;
    /** For example "45 s", formatted on the server. */
    lastBeatAgeText: string | null;
    heartbeatState: "ok" | "missing" | "unknown";
    /** Why the heartbeat is unknown (Redis not configured or not answering). */
    heartbeatReason: string | null;
  };
  /** The last payment-recovery run; null when none was recorded. */
  recovery: { lastRunAt: number | null; lastCandidates: number; lastRecovered: number } | null;
  queueNames: string[];
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number } | null>;
  recovered: {
    id: string;
    at: Date;
    outcome: "recovered" | "flagged";
    paymentId: string | null;
    razorpayPaymentId: string | null;
    bookingId: string | null;
    amountMinor: number | null;
    currency: string | null;
    reason: string | null;
  }[];
  failed: {
    jobs: { queue: string; id: string; name: string; bookingId: string | null; failedReason: string; attemptsMade: number; failedAt: Date | null }[];
    /** Queues whose failed jobs could not be read (Redis down). */
    unavailable: string[];
  };
}

/** The measurements in, the page's data out. Pure, so a test can feed it a snapshot with a stale heartbeat. */
export function buildAdminHealthView(
  input: { snapshot: HealthSnapshot; thresholds: HealthThresholds; recovered: RecoveredPaymentRow[]; failed: FailedJobsView; queueNames: readonly string[] },
  env: Record<string, string | undefined> = process.env,
): AdminHealthView {
  const { snapshot, thresholds, recovered, failed } = input;
  const report = evaluateHealth(snapshot, thresholds);
  const worker = report.conditions.find((c) => c.id === "worker-heartbeat")!;
  const lastBeat = snapshot.heartbeat.state === "ok" ? snapshot.heartbeat.at : null;
  const scrub = (text: string) => scrubHealthText(text, env);
  const recovery = snapshot.recovery;

  return {
    at: report.at,
    thresholds: {
      workerStaleSeconds: thresholds.workerStaleSeconds,
      meetingStuckMinutes: thresholds.meetingStuckMinutes,
      queueFailedMax: thresholds.queueFailedMax,
      queueWaitingMax: thresholds.queueWaitingMax,
    },
    report: {
      conditions: report.conditions.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        value: c.value,
        detail: scrub(c.detail),
        hint: c.hint ? scrub(c.hint) : null,
        href: c.href ?? null,
      })),
      unhealthy: report.unhealthy.map((c) => ({ id: c.id, label: c.label, status: c.status })),
    },
    worker: {
      status: worker.status,
      detail: scrub(worker.detail),
      hint: worker.hint ? scrub(worker.hint) : null,
      lastBeatAt: lastBeat,
      lastBeatAgeText: lastBeat === null ? null : formatAge((snapshot.at - lastBeat) / 1000),
      heartbeatState: snapshot.heartbeat.state,
      heartbeatReason: snapshot.heartbeat.state === "unknown" ? scrub(snapshot.heartbeat.reason) : null,
    },
    recovery: recovery ? { lastRunAt: recovery.lastRunAt, lastCandidates: recovery.lastCandidates, lastRecovered: recovery.lastRecovered } : null,
    queueNames: [...input.queueNames],
    queues: Object.fromEntries(
      Object.entries(snapshot.queues).map(([name, q]) => [name, q ? { waiting: q.waiting, active: q.active, delayed: q.delayed, failed: q.failed } : null]),
    ),
    recovered: recovered.map((r) => ({
      id: r.id,
      at: r.at,
      outcome: r.outcome,
      paymentId: r.paymentId,
      razorpayPaymentId: r.razorpayPaymentId,
      bookingId: r.bookingId,
      amountMinor: r.amountMinor,
      currency: r.currency,
      reason: r.reason === null ? null : scrub(r.reason),
    })),
    failed: {
      jobs: failed.jobs.map((j) => ({
        queue: j.queue,
        id: j.id,
        name: j.name,
        bookingId: j.bookingId,
        failedReason: scrub(j.failedReason),
        attemptsMade: j.attemptsMade,
        failedAt: j.failedAt,
      })),
      unavailable: [...failed.unavailable],
    },
  };
}

export async function loadAdminHealthView(): Promise<AdminHealthView> {
  const thresholds = thresholdsFromEnv();
  const [snapshot, recovered, failed] = await Promise.all([collectSnapshot({ thresholds }), listRecoveredPayments(10), listFailedJobs(10)]);
  return buildAdminHealthView({ snapshot, thresholds, recovered, failed, queueNames: QUEUE_NAMES });
}
