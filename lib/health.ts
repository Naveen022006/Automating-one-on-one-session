import { hostname } from "node:os";
import IORedis from "ioredis";
import type { Prisma } from "@/generated/prisma/client";
import { TIMED_SEAT_STATUSES } from "@/lib/holds";
import { prisma } from "@/lib/db";
import { RECOVERABLE_BOOKING_STATUSES, RECOVERY_MAX_AGE_MS } from "@/lib/payment-recovery";
import { getQueueCounts, QUEUE_NAMES } from "@/lib/queue";
import {
  deriveRedisState,
  evaluateHealth,
  nextRecoveryState,
  thresholdsFromEnv,
  type HealthReport,
  type HealthSnapshot,
  type HealthThresholds,
  type HeartbeatReading,
  type QueueCounts,
  type RecoveryRunFacts,
  type RecoveryState,
} from "@/lib/health-eval";

export * from "@/lib/health-eval";

/**
 * System health, the I/O half: the worker heartbeat, the shared key-value store (Redis, with an in-memory fallback), and
 * gathering the measurements that lib/health-eval.ts judges. The worker writes the heartbeat and runs the monitor
 * (lib/health-alerts.ts); the admin page and /api/health read the same keys.
 */

// ---------------------------------------------------------------------------------------------------------------
// Key-value store

/** The subset of ioredis the store uses, so tests can pass a fake. */
export interface HealthRedis {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/** Process-local store with TTLs: what the health code uses when Redis is not configured or is down. */
export class MemoryKv {
  private readonly data = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): string | null {
    const hit = this.data.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.data.delete(key);
      return null;
    }
    return hit.value;
  }
  set(key: string, value: string, ttlSec: number): void {
    this.data.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
  }
  /** Sets only if absent. True when this call set it. */
  setNx(key: string, value: string, ttlSec: number): boolean {
    if (this.get(key) !== null) return false;
    this.set(key, value, ttlSec);
    return true;
  }
  /** True when a live entry was removed. */
  del(key: string): boolean {
    const had = this.get(key) !== null;
    this.data.delete(key);
    return had;
  }
}

export type RemoteRead = { ok: true; value: string | null } | { ok: false; reason: string; configured: boolean };

let lastFallbackLog = 0;
function logFallback(e: unknown) {
  const now = Date.now();
  if (now - lastFallbackLog < 60_000) return;
  lastFallbackLog = now;
  console.error("[health] Redis unavailable, using in-memory state:", e instanceof Error ? e.message : e);
}

/**
 * Redis first; if Redis is not configured or a command fails, the same operation runs against process memory so the
 * worker and the monitor keep working (their state is then per-process, which is fine for a single worker).
 * It never throws.
 */
export class HealthKv {
  constructor(
    private readonly redis: HealthRedis | null,
    private readonly memory: MemoryKv = new MemoryKv(),
  ) {}

  get hasRedis(): boolean {
    return this.redis !== null;
  }

  async get(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        const value = await this.redis.get(key);
        // Something written while Redis was down lives only in memory; it is still the truth for this process.
        return value ?? this.memory.get(key);
      } catch (e) {
        logFallback(e);
      }
    }
    return this.memory.get(key);
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, value, "EX", ttlSec);
        return;
      } catch (e) {
        logFallback(e);
      }
    }
    this.memory.set(key, value, ttlSec);
  }

  /** Atomic "claim": true if the key did not exist and now does. */
  async setNx(key: string, value: string, ttlSec: number): Promise<boolean> {
    // Already claimed in this process while Redis was down: do not claim it a second time now that Redis is back.
    if (this.memory.get(key) !== null) return false;
    if (this.redis) {
      try {
        return (await this.redis.set(key, value, "EX", ttlSec, "NX")) === "OK";
      } catch (e) {
        logFallback(e);
      }
    }
    return this.memory.setNx(key, value, ttlSec);
  }

  async del(key: string): Promise<void> {
    await this.delIfExists(key);
  }

  /**
   * Deletes the key and says whether THIS call removed it. Two callers deleting the same key concurrently (a monitor run
   * and /api/health, say) cannot both get `true`, which is what lets exactly one of them send a "recovered" note.
   */
  async delIfExists(key: string): Promise<boolean> {
    let removed = this.memory.del(key);
    if (this.redis) {
      try {
        removed = Number(await this.redis.del(key)) > 0 || removed;
      } catch (e) {
        logFallback(e);
      }
    }
    return removed;
  }

  /** Redis only, no fallback: lets a reader tell "no heartbeat" from "could not ask". */
  async remoteGet(key: string): Promise<RemoteRead> {
    if (!this.redis) return { ok: false, reason: "Redis is not configured", configured: false };
    try {
      return { ok: true, value: await this.redis.get(key) };
    } catch (e) {
      return { ok: false, reason: `Redis did not answer: ${e instanceof Error ? e.message : e}`, configured: true };
    }
  }
}

let sharedKv: HealthKv | null = null;
let sharedClient: { quit(): Promise<unknown> } | null = null;

/** The process-wide store. One small Redis connection that fails fast, separate from BullMQ's (which retries forever). */
export function getHealthKv(): HealthKv {
  if (sharedKv) return sharedKv;
  const url = process.env.REDIS_URL;
  if (!url) return (sharedKv = new HealthKv(null));
  const client = new IORedis(url, {
    maxRetriesPerRequest: 1,
    // Generous enough for a cold TLS connection to a hosted Redis, short enough that a dead one cannot hang a page.
    commandTimeout: 4_000,
    connectTimeout: 5_000,
    enableAutoPipelining: true,
  });
  client.on("error", () => {}); // reported through the command failures; an unhandled 'error' event would be noisy
  sharedClient = client;
  return (sharedKv = new HealthKv(client as unknown as HealthRedis));
}

/** Closes the connection (end of a script or test). */
export async function closeHealth(): Promise<void> {
  const client = sharedClient;
  sharedClient = null;
  sharedKv = null;
  await client?.quit().catch(() => {});
}

// ---------------------------------------------------------------------------------------------------------------
// Heartbeat and recovery state

export const HEARTBEAT_KEY = "health:worker-heartbeat";
export const HEARTBEAT_EVERY_MS = 30_000;
/** Long enough that the page can still say "last seen 20 minutes ago"; staleness is judged by the stored time, not the TTL. */
export const HEARTBEAT_TTL_SEC = 3_600;
export const RECOVERY_STATE_KEY = "health:recovery-state";
const RECOVERY_STATE_TTL_SEC = 7 * 86_400;

/** Called by the worker every 30 s. Never throws; with Redis down it records to process memory. */
export async function writeHeartbeat(kv: HealthKv = getHealthKv(), now: number = Date.now()): Promise<void> {
  await kv.set(HEARTBEAT_KEY, JSON.stringify({ at: now, pid: process.pid, host: hostname() }), HEARTBEAT_TTL_SEC);
}

export async function readHeartbeat(kv: HealthKv = getHealthKv()): Promise<HeartbeatReading> {
  const read = await kv.remoteGet(HEARTBEAT_KEY);
  if (!read.ok) return { state: "unknown", reason: read.reason, redis: read.configured ? "down" : "not-configured" };
  if (!read.value) return { state: "missing" };
  try {
    const at = Number((JSON.parse(read.value) as { at?: unknown }).at);
    return Number.isFinite(at) ? { state: "ok", at } : { state: "missing" };
  } catch {
    return { state: "missing" };
  }
}

export async function readRecoveryState(kv: HealthKv = getHealthKv()): Promise<RecoveryState | null> {
  try {
    const raw = await kv.get(RECOVERY_STATE_KEY);
    return raw ? (JSON.parse(raw) as RecoveryState) : null;
  } catch {
    return null;
  }
}

/** Remembers how the last recovery run went (the monitor turns a streak of all-failed runs into an alert). */
export async function recordRecoveryRun(run: RecoveryRunFacts, kv: HealthKv = getHealthKv()): Promise<RecoveryState> {
  const next = nextRecoveryState(await readRecoveryState(kv), run);
  await kv.set(RECOVERY_STATE_KEY, JSON.stringify(next), RECOVERY_STATE_TTL_SEC);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// Gathering the measurements

/** One failed measurement must not blank the whole page: it becomes `null` ("could not be measured"). */
async function measured<T>(work: () => Promise<T>, what: string, quiet = false): Promise<T | null> {
  try {
    return await work();
  } catch (e) {
    if (!quiet) console.error(`[health] could not measure ${what}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export interface SnapshotDeps {
  kv: HealthKv;
  now: number;
  thresholds: HealthThresholds;
  /** Job counts of one queue; throws when Redis cannot be asked. */
  queueCounts: (name: string) => Promise<QueueCounts>;
}

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000);

/** Razorpay has the money (the recovery job saw it captured) but applying it failed, for longer than the threshold. */
export function unrecoveredPaymentsWhere(now: number, t: HealthThresholds): Prisma.PaymentWhereInput {
  return {
    status: "CREATED",
    recoveryError: { not: null },
    createdAt: { lte: minutesAgo(now, t.paymentUnrecoveredMinutes), gt: new Date(now - RECOVERY_MAX_AGE_MS) },
    booking: { status: { in: [...RECOVERABLE_BOOKING_STATUSES] } },
  };
}

/** Paid, session still ahead, and no Meet link after the threshold (updated_at is when it last changed, i.e. became PAID). */
export function stuckMeetingsWhere(now: number, t: HealthThresholds): Prisma.BookingWhereInput {
  return {
    status: "PAID",
    eventId: null,
    meetLink: null,
    updatedAt: { lte: minutesAgo(now, t.meetingStuckMinutes) },
    session: { endTime: { gt: new Date(now) } },
  };
}

/** An upcoming paid booking whose confirmation failed on a customer channel and went out on none. */
export function failedConfirmationsWhere(now: number): Prisma.BookingWhereInput {
  const confirmation = { template: "booking-confirmation", channel: { in: ["WHATSAPP", "SMS"] as ("WHATSAPP" | "SMS")[] } };
  return {
    status: { in: ["PAID", "SCHEDULED"] },
    session: { endTime: { gt: new Date(now) } },
    messages: {
      some: { ...confirmation, status: "FAILED" },
      none: { ...confirmation, status: { in: ["SENT", "DELIVERED", "READ"] } },
    },
  };
}

/** An unpaid hold well past its expiry that the worker's sweeper has not released. */
export function unsweptHoldsWhere(now: number, t: HealthThresholds): Prisma.BookingWhereInput {
  return { status: { in: [...TIMED_SEAT_STATUSES] }, holdExpiresAt: { lte: minutesAgo(now, t.holdSweepGraceMinutes) } };
}

export async function collectSnapshot(overrides: Partial<SnapshotDeps> = {}): Promise<HealthSnapshot> {
  const deps: SnapshotDeps = {
    kv: overrides.kv ?? getHealthKv(),
    now: overrides.now ?? Date.now(),
    thresholds: overrides.thresholds ?? thresholdsFromEnv(),
    queueCounts: overrides.queueCounts ?? ((name) => getQueueCounts(name)),
  };
  const { now, thresholds: t } = deps;

  const [heartbeat, recovery, unrecoveredPayments, stuckMeetings, failedConfirmations, unsweptHolds, queueEntries] = await Promise.all([
    readHeartbeat(deps.kv),
    readRecoveryState(deps.kv),
    measured(() => prisma.payment.count({ where: unrecoveredPaymentsWhere(now, t) }), "unrecovered payments"),
    measured(() => prisma.booking.count({ where: stuckMeetingsWhere(now, t) }), "paid bookings without a Meet link"),
    measured(() => prisma.booking.count({ where: failedConfirmationsWhere(now) }), "failed confirmations"),
    measured(() => prisma.booking.count({ where: unsweptHoldsWhere(now, t) }), "unswept holds"),
    Promise.all(
      // Without REDIS_URL there are no queues to ask (local development); that is "unknown", not an error to log.
      QUEUE_NAMES.map(async (name) => [name, await measured(() => deps.queueCounts(name), `queue ${name}`, !process.env.REDIS_URL)] as const),
    ),
  ]);

  const queues: Record<string, QueueCounts | null> = Object.fromEntries(queueEntries);
  return {
    at: now,
    heartbeat,
    redis: deriveRedisState(heartbeat, queues),
    unrecoveredPayments,
    recovery,
    stuckMeetings,
    failedConfirmations,
    unsweptHolds,
    queues,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The report shown to people

const REPORT_CACHE_MS = 20_000;
let cached: { at: number; report: Promise<HealthReport> } | null = null;

/**
 * The current health report. Cached in-process for a few seconds so the admin layout, the overview and the health page
 * rendered together (and a refresh-happy admin) share one set of queries; pass `fresh` for the health page itself.
 */
export async function getHealthReport(opts: { fresh?: boolean } = {}): Promise<HealthReport> {
  const now = Date.now();
  if (!opts.fresh && cached && now - cached.at < REPORT_CACHE_MS) return cached.report;
  const report = collectSnapshot().then((s) => evaluateHealth(s, thresholdsFromEnv()));
  cached = { at: now, report };
  report.catch(() => {
    if (cached?.report === report) cached = null;
  });
  return report;
}

/** Test hook. */
export function resetHealthCache(): void {
  cached = null;
}
