import { RECOVERY_ACTOR, RECOVERY_AUDIT_ACTIONS } from "@/lib/payment-recovery";
import { prisma } from "@/lib/db";
import { getFailedJobs, QUEUE_NAMES, type FailedJobInfo } from "@/lib/queue";

/** Data for the admin "System health" page that is not part of the pure health report. */

export interface RecoveredPaymentRow {
  id: string;
  at: Date;
  /** `recovered`: the booking was paid. `flagged`: captured but needs a refund (slot taken, amount mismatch...). */
  outcome: "recovered" | "flagged";
  paymentId: string | null;
  razorpayPaymentId: string | null;
  bookingId: string | null;
  amountMinor: number | null;
  currency: string | null;
  reason: string | null;
}

function field(detail: unknown, key: string): unknown {
  return detail && typeof detail === "object" ? (detail as Record<string, unknown>)[key] : undefined;
}
const str = (v: unknown) => (typeof v === "string" ? v : null);
const num = (v: unknown) => (typeof v === "number" ? v : null);

/** Payments the recovery job applied (or flagged), newest first, from the audit log. */
export async function listRecoveredPayments(limit = 10): Promise<RecoveredPaymentRow[]> {
  const rows = await prisma.adminAuditLog.findMany({
    where: { adminEmail: RECOVERY_ACTOR.email, action: { in: Object.values(RECOVERY_AUDIT_ACTIONS) } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    outcome: r.action === RECOVERY_AUDIT_ACTIONS.recovered ? "recovered" : "flagged",
    paymentId: r.targetId,
    razorpayPaymentId: str(field(r.detail, "razorpayPaymentId")),
    bookingId: str(field(r.detail, "bookingId")),
    amountMinor: num(field(r.detail, "amountMinor")),
    currency: str(field(r.detail, "currency")),
    reason: str(field(r.detail, "reason")),
  }));
}

export interface FailedJobsView {
  jobs: FailedJobInfo[];
  /** Queues whose failed jobs could not be read (Redis down). */
  unavailable: string[];
}

/** The most recent failed jobs across the meetings, messages and reminders queues. */
export async function listFailedJobs(perQueue = 10): Promise<FailedJobsView> {
  const unavailable: string[] = [];
  const lists = await Promise.all(
    QUEUE_NAMES.map((name) =>
      getFailedJobs(name, perQueue).catch(() => {
        unavailable.push(name);
        return [] as FailedJobInfo[];
      }),
    ),
  );
  const jobs = lists.flat().sort((a, b) => (b.failedAt?.getTime() ?? 0) - (a.failedAt?.getTime() ?? 0));
  return { jobs: jobs.slice(0, perQueue * 2), unavailable };
}
