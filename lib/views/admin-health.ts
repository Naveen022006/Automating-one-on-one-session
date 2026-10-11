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

/**
 * Environment variables whose values are secrets or connection strings: the names the build's secret scan looks for, plus every
 * webhook and every `..._URL` (a Slack webhook URL is itself a secret; so can be an SMS provider URL that carries a key).
 */
const SECRET_ENV_NAME = /SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL|WEBHOOK|_URL$/i;
/**
 * `scheme://` followed by the user and password up to the LAST `@` of the same word, so a password that itself contains `@`, `/`,
 * `?` or `#` is covered whole (`postgresql://user:p@ss/w#rd@host:5432/db`). A URL with no credentials but an `@` further on
 * (`https://host/x?mail=a@b.c`) is cut at that `@` too: the scrubber prefers hiding too much to leaking.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)\S*?@(?=[^\s@]*(?:\s|$))/gi;
const BEARER = /\bBearer\s+\S+/gi;
const SECRET_QUERY_PARAM = /([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|authkey|auth|key|secret|client_secret|password|passwd|signature|sig)=)[^&\s]+/gi;
const SECRET_JSON_FIELD = /("(?:access_token|refresh_token|id_token|token|api_key|apikey|secret|client_secret|password)"\s*:\s*")[^"]+/gi;

/**
 * Error messages from Redis, Razorpay, Meta, an SMS provider or the queue library are shown on the page. This takes a secret out
 * of such a message if one slipped in:
 *   - any secret-looking environment value (8 characters or more; see SECRET_ENV_NAME) becomes "[hidden]";
 *   - the user and password part of a URL (`redis://user:password@host`) becomes `***`;
 *   - `Bearer <token>` becomes `Bearer [hidden]`;
 *   - the value of a `?token=`, `&access_token=`, `?authkey=`, `?key=`... query parameter, or of a `"access_token":"..."` JSON
 *     field, becomes `[hidden]`.
 */
export function scrubHealthText(text: string, env: Record<string, string | undefined> = process.env): string {
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV_NAME.test(name) && typeof value === "string" && value.length >= 8)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[hidden]");
  return out
    .replace(URL_CREDENTIALS, "$1***@")
    .replace(BEARER, "Bearer [hidden]")
    .replace(SECRET_QUERY_PARAM, "$1[hidden]")
    .replace(SECRET_JSON_FIELD, "$1[hidden]");
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
    /** The rows of the "Monitored conditions" table: every condition except the worker's, which has its own card. */
    conditions: AdminHealthCondition[];
    /** How many of ALL the conditions (the worker's included) could not be measured. */
    unknownCount: number;
    unhealthy: { label: string; status: ConditionStatus }[];
  };
  worker: {
    status: ConditionStatus;
    /** Only while the worker is not running (the page shows them in that alert); null otherwise. */
    detail: string | null;
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
  recovery: { lastRunAt: number; lastCandidates: number; lastRecovered: number } | null;
  queueNames: string[];
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number } | null>;
  recovered: {
    id: string;
    at: Date;
    outcome: "recovered" | "flagged";
    /** The "Razorpay payment" column: the Razorpay payment id, else our payment id; null shows a dash. */
    reference: string | null;
    amountMinor: number | null;
    currency: string | null;
    /** The "Note" column: the reason, else "Booking <id>", else empty. */
    note: string;
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
      conditions: report.conditions
        .filter((c) => c.id !== "worker-heartbeat")
        .map((c) => ({
          id: c.id,
          label: c.label,
          status: c.status,
          value: c.value,
          detail: scrub(c.detail),
          hint: c.hint ? scrub(c.hint) : null,
          href: c.href ?? null,
        })),
      unknownCount: report.conditions.filter((c) => c.status === "unknown").length,
      unhealthy: report.unhealthy.map((c) => ({ label: c.label, status: c.status })),
    },
    worker: {
      status: worker.status,
      detail: worker.status === "critical" ? scrub(worker.detail) : null,
      hint: worker.status === "critical" && worker.hint ? scrub(worker.hint) : null,
      lastBeatAt: lastBeat,
      lastBeatAgeText: lastBeat === null ? null : formatAge((snapshot.at - lastBeat) / 1000),
      heartbeatState: snapshot.heartbeat.state,
      heartbeatReason: snapshot.heartbeat.state === "unknown" ? scrub(snapshot.heartbeat.reason) : null,
    },
    // The card only shows a run that happened; without one it says "No run recorded yet".
    recovery: recovery?.lastRunAt ? { lastRunAt: recovery.lastRunAt, lastCandidates: recovery.lastCandidates, lastRecovered: recovery.lastRecovered } : null,
    queueNames: [...input.queueNames],
    queues: Object.fromEntries(
      Object.entries(snapshot.queues).map(([name, q]) => [name, q ? { waiting: q.waiting, active: q.active, delayed: q.delayed, failed: q.failed } : null]),
    ),
    recovered: recovered.map((r) => ({
      id: r.id,
      at: r.at,
      outcome: r.outcome,
      reference: r.razorpayPaymentId ?? r.paymentId,
      amountMinor: r.amountMinor,
      currency: r.currency,
      note: r.reason !== null ? scrub(r.reason) : r.bookingId ? `Booking ${r.bookingId}` : "",
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
