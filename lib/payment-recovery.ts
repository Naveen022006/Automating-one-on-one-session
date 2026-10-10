import type { Prisma } from "@/generated/prisma/client";
import { recordAudit, type AuditActor } from "@/lib/admin/audit";
import { prisma } from "@/lib/db";
import { applyCapturedPayment, type CaptureResult } from "@/lib/payment-capture";
import { fetchOrderPayments, RazorpayHttpError, type RazorpayPayment } from "@/lib/payments";
import { requeueCreateMeeting } from "@/lib/queue";

/**
 * Missed-webhook recovery. Only Razorpay's webhook marks a booking paid, so a lost webhook (tunnel down, outage, wrong
 * secret) leaves a customer who really paid on a booking that sits in PENDING_PAYMENT until it expires. This job asks
 * Razorpay about orders that look abandoned and, when one was in fact captured, applies the very same transition the
 * webhook would have (lib/payment-capture.ts).
 */

/** Orders younger than this are left to the webhook (the customer may still be on the payment sheet). */
export const RECOVERY_MIN_AGE_MS = 3 * 60_000;
/** Orders older than this are no longer checked. */
export const RECOVERY_MAX_AGE_MS = 7 * 86_400_000;
/** Payments looked at per run. */
export const RECOVERY_BATCH_SIZE = 50;
/** Stop a run after this many Razorpay/apply failures in a row (Razorpay down: do not hammer it). */
export const RECOVERY_MAX_CONSECUTIVE_ERRORS = 3;
/** Safety net so one slow run cannot run into the next one. */
export const RECOVERY_MAX_RUN_MS = 100_000;

/** A booking in one of these states with an unpaid order may in fact have been paid. */
export const RECOVERABLE_BOOKING_STATUSES = ["HELD", "PENDING_PAYMENT", "EXPIRED"] as const;

/** The system actor recorded in the admin audit log for every recovered payment. */
export const RECOVERY_ACTOR: AuditActor = { adminId: null, email: "system:payment-recovery" };
export const RECOVERY_AUDIT_ACTIONS = { recovered: "payment.recovered", flagged: "payment.recovered_needs_refund" } as const;

/**
 * How long to wait before asking about the same order again, by order age: the first hour is checked on every run (the
 * worker runs every two minutes), the rest of the first day every half hour, the rest of the week every six hours. That
 * keeps abandoned carts from being fetched thousands of times while a payment that is really missing is found quickly.
 */
export const RECHECK_TIERS: { maxAgeMs: number; everyMs: number }[] = [
  { maxAgeMs: 3_600_000, everyMs: 90_000 },
  { maxAgeMs: 86_400_000, everyMs: 30 * 60_000 },
  { maxAgeMs: RECOVERY_MAX_AGE_MS, everyMs: 6 * 3_600_000 },
];

export function recheckIntervalMs(ageMs: number): number {
  for (const t of RECHECK_TIERS) if (ageMs < t.maxAgeMs) return t.everyMs;
  return RECHECK_TIERS[RECHECK_TIERS.length - 1].everyMs;
}

/** Payments worth asking Razorpay about right now. `extra` narrows the set (used by tests and one-off checks). */
export function recoverableWhere(now: Date, extra?: Prisma.PaymentWhereInput): Prisma.PaymentWhereInput {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let youngest = RECOVERY_MIN_AGE_MS;
  const tiers: Prisma.PaymentWhereInput[] = RECHECK_TIERS.map((t) => {
    const tier: Prisma.PaymentWhereInput = {
      createdAt: { lte: ago(youngest), gt: ago(t.maxAgeMs) },
      OR: [{ recoveryCheckedAt: null }, { recoveryCheckedAt: { lte: ago(t.everyMs) } }],
    };
    youngest = t.maxAgeMs;
    return tier;
  });
  return {
    status: "CREATED",
    booking: { status: { in: [...RECOVERABLE_BOOKING_STATUSES] } },
    AND: [{ OR: tiers }, ...(extra ? [extra] : [])],
  };
}

export interface RecoverySummary {
  startedAt: Date;
  /** Payments selected for this run. */
  candidates: number;
  /** Razorpay lookups that answered (including "no such order"). */
  lookupsOk: number;
  /** Razorpay lookups that failed (network, timeout, 5xx, auth...). */
  lookupErrors: number;
  /** Orders Razorpay answered 400/404 for (for example test-mode orders after switching to live keys). Counted in lookupsOk. */
  unknownOrders: number;
  /** Captured payments left for the next run because Razorpay captured them under 3 minutes ago (the webhook is probably seconds away). */
  tooFresh: number;
  /** Payments found captured at Razorpay and turned into paid bookings. */
  recovered: number;
  /** Payments found captured but flagged for refund (slot taken, amount mismatch...). */
  flagged: number;
  /** Captured at Razorpay but our own update failed (it will be retried on the next run). */
  applyFailures: number;
  /** The run stopped early (too many failures in a row, or out of time). */
  aborted: boolean;
  lastError?: string;
  recoveredBookingIds: string[];
}

export interface RecoveryDeps {
  /** Razorpay's payments for one order. Defaults to the real API call. */
  fetchOrderPayments: (orderId: string) => Promise<RazorpayPayment[]>;
  /** Called inside the same transaction that marks the booking paid; bounded by `enqueueTimeoutMs`. */
  enqueue: (bookingId: string) => Promise<void>;
  /** How long to wait for `enqueue` before rolling the payment back to be retried. Default 5 s. */
  enqueueTimeoutMs?: number;
  now: () => Date;
  batchSize: number;
  maxRunMs: number;
  /** Narrows the payments considered (tests). */
  extraWhere?: Prisma.PaymentWhereInput;
  log: (message: string, ...rest: unknown[]) => void;
}

const defaultDeps: RecoveryDeps = {
  fetchOrderPayments: (orderId) => fetchOrderPayments(orderId),
  // requeueCreateMeeting first clears a finished job with this booking's id (a plain add would be a silent no-op).
  enqueue: requeueCreateMeeting,
  now: () => new Date(),
  batchSize: RECOVERY_BATCH_SIZE,
  maxRunMs: RECOVERY_MAX_RUN_MS,
  log: (message, ...rest) => console.log(`[payment-recovery] ${message}`, ...rest),
};

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Razorpay does not know this order (400/404): asking again will not help, so back off like a normal "not paid". */
const isPerOrderRejection = (e: unknown) => e instanceof RazorpayHttpError && (e.status === 400 || e.status === 404);

/**
 * One recovery pass. Never throws: Razorpay being unreachable, or one payment failing to apply, is logged and counted in
 * the summary and the pass moves on (a few failures in a row end the pass early). Safe to run at any time, concurrently
 * with the webhook or another worker: the payment is applied under the booking row lock and only if it is still unpaid.
 */
export async function runPaymentRecovery(overrides: Partial<RecoveryDeps> = {}): Promise<RecoverySummary> {
  const deps = { ...defaultDeps, ...overrides };
  const started = deps.now();
  const summary: RecoverySummary = {
    startedAt: started,
    candidates: 0,
    lookupsOk: 0,
    lookupErrors: 0,
    unknownOrders: 0,
    tooFresh: 0,
    recovered: 0,
    flagged: 0,
    applyFailures: 0,
    aborted: false,
    recoveredBookingIds: [],
  };

  try {
    const batch = await prisma.payment.findMany({
      where: recoverableWhere(started, deps.extraWhere),
      // Never-checked first, then the longest-unchecked, so one stubborn payment cannot starve the rest.
      orderBy: [{ recoveryCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      take: deps.batchSize,
      select: { id: true, bookingId: true, providerOrderId: true },
    });
    summary.candidates = batch.length;

    let consecutiveErrors = 0;
    for (const payment of batch) {
      if (consecutiveErrors >= RECOVERY_MAX_CONSECUTIVE_ERRORS || deps.now().getTime() - started.getTime() > deps.maxRunMs) {
        summary.aborted = true;
        break;
      }

      // 1) Ask Razorpay.
      let attempts: RazorpayPayment[];
      try {
        attempts = await deps.fetchOrderPayments(payment.providerOrderId);
        summary.lookupsOk++;
      } catch (e) {
        if (isPerOrderRejection(e)) {
          // Razorpay answered: it does not know this order (e.g. a test-mode order after switching to live keys). That is
          // an answer, not an outage: it neither counts towards stopping the run nor towards "lookups are failing".
          summary.lookupsOk++;
          summary.unknownOrders++;
          consecutiveErrors = 0;
          await markChecked(payment.id, deps.now());
          continue;
        }
        summary.lookupErrors++;
        summary.lastError = errText(e);
        consecutiveErrors++;
        continue;
      }

      const captured = attempts.find((a) => a.status === "captured");
      if (!captured) {
        consecutiveErrors = 0;
        await markChecked(payment.id, deps.now());
        continue;
      }

      // Captured moments ago: the webhook is very probably seconds away. Leave it for the next run so a normal, slightly
      // late webhook does not show up as "a webhook never arrived".
      if (captured.created_at && deps.now().getTime() - captured.created_at * 1000 < RECOVERY_MIN_AGE_MS) {
        summary.tooFresh++;
        consecutiveErrors = 0;
        continue;
      }

      // 2) Razorpay has the money: apply it exactly as the webhook would.
      try {
        const result = await applyRecovered(payment, captured, deps);
        consecutiveErrors = 0;
        if (result.outcome === "paid") {
          summary.recovered++;
          if (result.bookingId) summary.recoveredBookingIds.push(result.bookingId);
          deps.log(`recovered payment ${captured.id} (order ${payment.providerOrderId}): booking ${result.bookingId} is now PAID`);
        } else if (result.outcome === "flagged") {
          summary.flagged++;
          deps.log(`payment ${captured.id} (order ${payment.providerOrderId}) captured but needs a refund: ${result.reason}`);
        } else {
          await markChecked(payment.id, deps.now()); // already applied by the webhook (or a replay): nothing changed
        }
      } catch (e) {
        summary.applyFailures++;
        summary.lastError = errText(e);
        consecutiveErrors++;
        deps.log(`could not apply captured payment ${captured.id} (order ${payment.providerOrderId}): ${errText(e)}`);
        // Remembered on the row so the health monitor can say "Razorpay has this money and we could not book it".
        await prisma.payment
          .updateMany({ where: { id: payment.id, status: "CREATED" }, data: { recoveryError: errText(e) } })
          .catch(() => {});
      }
    }
  } catch (e) {
    // Selecting the batch failed (database unreachable...). The next run tries again.
    summary.lastError = errText(e);
    summary.aborted = true;
    console.error("[payment-recovery] run failed", errText(e));
  }

  if (summary.lookupErrors > 0) {
    deps.log(`${summary.lookupErrors} Razorpay lookup(s) failed${summary.aborted ? ", stopping early" : ""}: ${summary.lastError}`);
  }
  return summary;
}

async function markChecked(paymentId: string, at: Date): Promise<void> {
  try {
    await prisma.payment.updateMany({ where: { id: paymentId, status: "CREATED" }, data: { recoveryCheckedAt: at, recoveryError: null } });
  } catch (e) {
    console.error("[payment-recovery] could not stamp recovery_checked_at", errText(e));
  }
}

/** The transaction: idempotency record, the shared capture transition, and the audit row, all or nothing. */
async function applyRecovered(
  payment: { id: string; bookingId: string; providerOrderId: string },
  captured: RazorpayPayment,
  deps: RecoveryDeps,
): Promise<CaptureResult> {
  return prisma.$transaction(
    async (tx) => {
      // A synthetic webhook-event id: a replay of this recovery (or a second worker) is a no-op.
      const inserted = await tx.$executeRaw`
        INSERT INTO webhook_events (id, provider, event_id, type, received_at)
        VALUES (${"we_" + crypto.randomUUID()}, 'razorpay', ${"recovery:" + captured.id}, 'recovery.payment.captured', now())
        ON CONFLICT (provider, event_id) DO NOTHING`;
      if (inserted === 0) return { outcome: "ignored", bookingId: payment.bookingId };

      const detail = {
        orderId: payment.providerOrderId,
        razorpayPaymentId: captured.id,
        bookingId: payment.bookingId,
        amountMinor: captured.amount,
        currency: captured.currency,
      };
      const result = await applyCapturedPayment(
        tx,
        { id: captured.id, order_id: payment.providerOrderId, amount: captured.amount, currency: captured.currency },
        deps.enqueue,
        {
          // Audited before the job is queued, so a failed audit write rolls back before anything leaves the database.
          beforeEnqueue: () =>
            recordAudit(RECOVERY_ACTOR, { action: RECOVERY_AUDIT_ACTIONS.recovered, targetType: "payment", targetId: payment.id, detail }, tx),
          enqueueTimeoutMs: deps.enqueueTimeoutMs,
        },
      );
      if (result.outcome === "flagged") {
        await recordAudit(
          RECOVERY_ACTOR,
          { action: RECOVERY_AUDIT_ACTIONS.flagged, targetType: "payment", targetId: payment.id, detail: { ...detail, reason: result.reason ?? null } },
          tx,
        );
      }
      return result;
    },
    { timeout: 15_000 },
  );
}
