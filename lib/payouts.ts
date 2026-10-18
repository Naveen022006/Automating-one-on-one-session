import { Prisma } from "@/generated/prisma/client";
import { parseFlag } from "@/lib/admin/policy";
import { prisma } from "@/lib/db";
import { fetchPayment, type RazorpayPayment } from "@/lib/payments";

/**
 * Reconciliation and the payout ledger. The platform owner collects every customer payment, checks each against
 * Razorpay ("reconciles" it), and then pays influencers by hand from the reconciled money. This module decides what
 * is payable, locks payments into a payout so nothing is paid twice, and records the transfer when it is made.
 *
 *   payable = captured, reconciled, not already in a payout, no refund in flight, the session happened and its
 *             hold period has passed.   payout = (paid - refunded) - platform fee
 */

export class PayoutError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    /** A machine-readable reason the console reacts to (for example `influencer-suspended`: ask the administrator to confirm). */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * An administrator's explicit decision to move money for a suspended influencer ("pay anyway"). Approving or paying an EXISTING payout
 * is refused for a suspended influencer unless this is given; the reason goes into the audit entry. (Creating a new payout is always
 * refused while suspended: that is the stricter rule in createPayout.)
 */
export interface SuspendedOverride {
  reason: string;
}

/**
 * Throws `influencer-suspended` (409) when the payout's influencer is suspended and no override was given. Returns whether the
 * override was USED (the influencer is suspended and the administrator confirmed), so the caller can record it in the audit entry.
 */
async function checkSuspended(influencerId: string, override?: SuspendedOverride): Promise<boolean> {
  const row = await prisma.influencer.findUnique({ where: { id: influencerId }, select: { suspendedAt: true } });
  if (!row?.suspendedAt) return false;
  if (!override) {
    throw new PayoutError("This influencer is suspended. Reinstate them first, or confirm that you want to pay anyway.", 409, "influencer-suspended");
  }
  return true;
}

/* ---------- Configuration ---------- */

/** Days after a session ends before its money becomes payable (room for disputes and refunds). */
export function payoutHoldDays(env = process.env): number {
  const n = Number(env.PAYOUT_HOLD_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 90 ? Math.floor(n) : 2;
}

/** The platform fee in basis points when an influencer has no override. 1000 = 10%. Default 0. */
export function defaultFeeBps(env = process.env): number {
  const n = Number(env.PLATFORM_FEE_BPS);
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.floor(n) : 0;
}

export function effectiveFeeBps(override: number | null | undefined, env = process.env): number {
  return override ?? defaultFeeBps(env);
}

export function formatFeePercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/**
 * PAYOUT_FOUR_EYES: a second administrator must approve a payout before it can be marked as paid. Default on in
 * production, off elsewhere (so a developer with one admin account is not blocked).
 */
export function fourEyesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseFlag(env.PAYOUT_FOUR_EYES, env.NODE_ENV === "production");
}

/**
 * PAYOUT_FOUR_EYES_MIN_MINOR: approval is only needed at or above this net amount, in the MINOR units (paise, cents) of
 * each payout's own currency; no conversion is made, so one number is applied to INR, USD and so on alike. The
 * amount compared is the payout's net plus the other unapproved payouts of the same influencer and currency from the
 * last 24 hours (see recentUnapprovedMinor), so splitting one transfer into several below-threshold ones does not
 * avoid approval. 0 (default) = always.
 */
export function fourEyesMinMinor(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PAYOUT_FOUR_EYES_MIN_MINOR);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Look-back for the threshold: unapproved payouts created within this long before the check count together. */
export const APPROVAL_WINDOW_MS = 24 * 3_600_000;

/**
 * Whether a payout of this net amount must be approved before it can be marked as paid. `recentUnapprovedMinor` is the
 * net total of the same influencer's other unapproved payouts in the same currency from the last 24 hours (0 when the
 * threshold is 0, because then every payout needs approval anyway).
 */
export function approvalRequired(netMinor: number, env: NodeJS.ProcessEnv = process.env, recentUnapprovedMinor = 0): boolean {
  return fourEyesEnabled(env) && netMinor + recentUnapprovedMinor >= fourEyesMinMinor(env);
}

/**
 * The net total of this influencer's OTHER payouts in the same currency that are not approved (pending or already paid
 * without approval) and were created in the last 24 hours. Without it a single administrator could create several
 * payouts each under PAYOUT_FOUR_EYES_MIN_MINOR (unreconciling payments and re-creating payouts is a one-person
 * action) and pay them all unapproved. Cancelled payouts are not counted. Returns 0 without querying when four-eyes is
 * off or the threshold is 0.
 */
export async function recentUnapprovedMinor(
  payout: { id: string; influencerId: string; currency: string },
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  if (!fourEyesEnabled(env) || fourEyesMinMinor(env) === 0) return 0;
  const sum = await db.payout.aggregate({
    where: {
      influencerId: payout.influencerId,
      currency: payout.currency,
      id: { not: payout.id },
      approvedAt: null,
      status: { in: ["PENDING", "PAID"] },
      createdAt: { gte: new Date(now.getTime() - APPROVAL_WINDOW_MS) },
    },
    _sum: { netMinor: true },
  });
  return sum._sum.netMinor ?? 0;
}

/** For the console: the recent-unapproved total of each pending, unapproved payout in a list (one cheap query each). */
export async function recentUnapprovedFor(
  payouts: { id: string; influencerId: string; currency: string; status: string; approvedAt: Date | null }[],
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, number>> {
  const open = payouts.filter((p) => p.status === "PENDING" && p.approvedAt === null);
  return new Map(await Promise.all(open.map(async (p) => [p.id, await recentUnapprovedMinor(p, now, env)] as const)));
}

/** Whether this payout needs approval, counting its unapproved siblings of the last 24 hours towards the threshold. */
export async function payoutNeedsApproval(
  payout: { id: string; influencerId: string; currency: string; netMinor: number },
  now = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return approvalRequired(payout.netMinor, env, await recentUnapprovedMinor(payout, now, env));
}

export interface PayoutApprovalView {
  /** This payout needs a second administrator's approval before it can be paid. */
  required: boolean;
  approved: boolean;
  approvedByEmail: string | null;
  /** The viewing administrator may approve it now (pending, not approved, and not the one who created it). */
  canApprove: boolean;
  /** The viewing administrator created it, so someone else has to approve. */
  createdByViewer: boolean;
  /** Mark as paid is allowed (pending, and approved if approval is required). */
  canMarkPaid: boolean;
}

const sameAdmin = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What the admin console shows and enables for one payout, from the viewer's point of view. */
export function payoutApprovalView(
  payout: { status: string; netMinor: number; createdByEmail: string; approvedAt: Date | null; approvedByEmail: string | null },
  viewerEmail: string,
  env: NodeJS.ProcessEnv = process.env,
  /** From recentUnapprovedMinor(); only matters when PAYOUT_FOUR_EYES_MIN_MINOR > 0. */
  recentUnapproved = 0,
): PayoutApprovalView {
  const required = approvalRequired(payout.netMinor, env, recentUnapproved);
  const approved = payout.approvedAt != null;
  const pending = payout.status === "PENDING";
  const createdByViewer = sameAdmin(payout.createdByEmail, viewerEmail);
  return {
    required,
    approved,
    approvedByEmail: payout.approvedByEmail,
    canApprove: pending && !approved && !createdByViewer,
    createdByViewer,
    canMarkPaid: pending && (!required || approved),
  };
}

/* ---------- Pure rules (unit-tested) ---------- */

/** The booking statuses whose payment is the influencer's to be paid (the same set createPayout's claim, approve and mark-paid check). */
export const PAYABLE_BOOKING_STATUSES = ["PAID", "SCHEDULED", "COMPLETED"] as const;

/** A payment that must not be in a payout: flagged for a refund, or its booking was cancelled / failed / expired. */
const flaggedPaymentWhere: Prisma.PaymentWhereInput = {
  OR: [{ needsRefund: true }, { booking: { status: { notIn: [...PAYABLE_BOOKING_STATUSES] } } }],
};

/** How many payments of each payout are flagged (for the console: "contains a flagged payment: cancel and recreate"). */
export async function flaggedPaymentCounts(payoutIds: string[]): Promise<Map<string, number>> {
  if (payoutIds.length === 0) return new Map();
  const rows = await prisma.payment.groupBy({ by: ["payoutId"], where: { payoutId: { in: payoutIds }, ...flaggedPaymentWhere }, _count: { _all: true } });
  return new Map(rows.filter((r) => r.payoutId !== null).map((r) => [r.payoutId as string, r._count._all]));
}

export interface PayablePayment {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  refundedMinor: number;
  refundStatus: string | null;
  reconciledAt: Date | null;
  payoutId: string | null;
  bookingStatus: string;
  sessionEnd: Date;
  /** Flagged for a refund (a cancelled booking still owed one, a double payment, a failed refund): money that is not the influencer's yet. */
  needsRefund?: boolean;
}

export type Blocker =
  | "flagged-for-refund"
  | "not-paid"
  | "fully-refunded"
  | "in-payout"
  | "refund-in-flight"
  | "not-reconciled"
  | "booking-not-held"
  | "session-not-finished";

export const BLOCKER_LABEL: Record<Blocker, string> = {
  "not-paid": "Not paid",
  "fully-refunded": "Fully refunded",
  "in-payout": "Already in a payout",
  "refund-in-flight": "Refund in progress",
  "flagged-for-refund": "Flagged for a refund",
  "not-reconciled": "Waiting for reconciliation",
  "booking-not-held": "Session did not take place as booked",
  "session-not-finished": "Session not finished yet, or in the hold period",
};

export const netOf = (p: Pick<PayablePayment, "amountMinor" | "refundedMinor">) => p.amountMinor - p.refundedMinor;

/** Why a payment cannot be paid out yet, or null when it can. Checked in a fixed order so the reason is stable. */
export function payoutBlocker(p: PayablePayment, now: Date, holdDays: number): Blocker | null {
  if (p.status !== "CAPTURED" && p.status !== "REFUNDED") return "not-paid";
  if (netOf(p) <= 0) return "fully-refunded";
  if (p.payoutId) return "in-payout";
  if (p.refundStatus === "requested" || p.refundStatus === "pending") return "refund-in-flight";
  if (p.needsRefund) return "flagged-for-refund";
  if (!p.reconciledAt) return "not-reconciled";
  if (p.bookingStatus !== "SCHEDULED" && p.bookingStatus !== "COMPLETED") return "booking-not-held";
  if (p.sessionEnd.getTime() + holdDays * 86_400_000 > now.getTime()) return "session-not-finished";
  return null;
}

/** floor(net x bps / 10000): the fee never rounds up, so the influencer is never charged a fraction too much. */
export function computeFee(netMinor: number, bps: number): number {
  return Math.floor((netMinor * bps) / 10_000);
}

export interface PayoutTotals {
  grossMinor: number;
  refundsMinor: number;
  feeMinor: number;
  netMinor: number;
}

export function buildPayoutTotals(payments: Pick<PayablePayment, "amountMinor" | "refundedMinor">[], feeBps: number): PayoutTotals {
  const grossMinor = payments.reduce((n, p) => n + p.amountMinor, 0);
  const refundsMinor = payments.reduce((n, p) => n + p.refundedMinor, 0);
  const afterRefunds = grossMinor - refundsMinor;
  const feeMinor = computeFee(afterRefunds, feeBps);
  return { grossMinor, refundsMinor, feeMinor, netMinor: afterRefunds - feeMinor };
}

export interface RazorpayCheck {
  ok: boolean;
  reason?: string;
}

/** Compares our record of a payment with what Razorpay says about it. */
export function checkAgainstRazorpay(
  local: { providerPaymentId: string | null; providerOrderId: string; amountMinor: number; currency: string },
  remote: Pick<RazorpayPayment, "id" | "order_id" | "amount" | "currency" | "status">,
): RazorpayCheck {
  if (!local.providerPaymentId || remote.id !== local.providerPaymentId) return { ok: false, reason: "Razorpay payment id does not match" };
  if (remote.order_id !== local.providerOrderId) return { ok: false, reason: "Razorpay order does not match" };
  if (remote.amount !== local.amountMinor || remote.currency !== local.currency) {
    return { ok: false, reason: `Razorpay amount differs (${remote.amount} ${remote.currency})` };
  }
  if (remote.status !== "captured" && remote.status !== "refunded") return { ok: false, reason: `Razorpay status is ${remote.status}` };
  return { ok: true };
}

/* ---------- Database ---------- */

export interface PayableRow extends PayablePayment {
  providerPaymentId: string | null;
  providerOrderId: string;
  customerName: string;
  serviceTitle: string;
  sessionStart: Date;
  blocker: Blocker | null;
}

/** Every captured (or refunded) payment of an influencer that is not yet part of a payout, with its blocker. */
export async function loadPayable(influencerId: string, now = new Date(), db: Prisma.TransactionClient | typeof prisma = prisma): Promise<PayableRow[]> {
  const holdDays = payoutHoldDays();
  const rows = await db.payment.findMany({
    where: {
      status: { in: ["CAPTURED", "REFUNDED"] },
      payoutId: null,
      booking: { session: { service: { influencerId } } },
    },
    orderBy: { createdAt: "asc" },
    include: {
      booking: { select: { status: true, customerName: true, session: { select: { startTime: true, endTime: true, service: { select: { title: true } } } } } },
    },
  });
  return rows.map((r) => {
    const base: PayablePayment = {
      id: r.id,
      status: r.status,
      amountMinor: r.amountMinor,
      currency: r.currency,
      refundedMinor: r.refundAmountMinor ?? 0,
      refundStatus: r.refundStatus,
      reconciledAt: r.reconciledAt,
      payoutId: r.payoutId,
      bookingStatus: r.booking.status,
      sessionEnd: r.booking.session.endTime,
      needsRefund: r.needsRefund,
    };
    return {
      ...base,
      providerPaymentId: r.providerPaymentId,
      providerOrderId: r.providerOrderId,
      customerName: r.booking.customerName,
      serviceTitle: r.booking.session.service.title,
      sessionStart: r.booking.session.startTime,
      blocker: payoutBlocker(base, now, holdDays),
    };
  });
}

export interface CurrencyOverview {
  currency: string;
  /** Payable right now, after the platform fee. */
  readyMinor: number;
  readyGrossMinor: number;
  readyFeeMinor: number;
  readyCount: number;
  /** Paid by customers but not payable yet. */
  waitingMinor: number;
  waitingCount: number;
  waitingByReason: Partial<Record<Blocker, number>>;
}

export function summariseCurrencies(rows: PayableRow[], feeBps: number): CurrencyOverview[] {
  const by = new Map<string, PayableRow[]>();
  for (const r of rows) by.set(r.currency, [...(by.get(r.currency) ?? []), r]);
  return [...by.entries()].map(([currency, list]) => {
    const ready = list.filter((r) => r.blocker === null);
    const waiting = list.filter((r) => r.blocker !== null && r.blocker !== "fully-refunded");
    const t = buildPayoutTotals(ready, feeBps);
    const reasons: Partial<Record<Blocker, number>> = {};
    for (const w of waiting) reasons[w.blocker!] = (reasons[w.blocker!] ?? 0) + 1;
    return {
      currency,
      readyMinor: t.netMinor,
      readyGrossMinor: t.grossMinor - t.refundsMinor,
      readyFeeMinor: t.feeMinor,
      readyCount: ready.length,
      waitingMinor: waiting.reduce((n, w) => n + netOf(w), 0),
      waitingCount: waiting.length,
      waitingByReason: reasons,
    };
  });
}

/* ---------- Reconciliation ---------- */

export interface ReconcileResult {
  id: string;
  ok: boolean;
  reason?: string;
}

/**
 * Marks payments reconciled after confirming each one with Razorpay (status, amount, order and currency must match).
 * A payment that cannot be confirmed is left unreconciled with the reason, never trusted on our own record alone.
 */
export async function reconcilePayments(
  paymentIds: string[],
  adminEmail: string,
  deps: { fetchPayment: (id: string) => Promise<RazorpayPayment> } = { fetchPayment: (id) => fetchPayment(id) },
): Promise<ReconcileResult[]> {
  const unique = [...new Set(paymentIds)].slice(0, 100);
  const payments = await prisma.payment.findMany({ where: { id: { in: unique } } });
  const byId = new Map(payments.map((p) => [p.id, p]));
  const results: ReconcileResult[] = [];

  for (const id of unique) {
    const p = byId.get(id);
    if (!p) {
      results.push({ id, ok: false, reason: "Payment not found" });
      continue;
    }
    if (p.reconciledAt) {
      results.push({ id, ok: true });
      continue;
    }
    if (p.status !== "CAPTURED" && p.status !== "REFUNDED") {
      results.push({ id, ok: false, reason: "Only paid payments can be reconciled" });
      continue;
    }
    try {
      const remote = await deps.fetchPayment(p.providerPaymentId ?? "");
      const check = checkAgainstRazorpay(p, remote);
      if (!check.ok) {
        results.push({ id, ok: false, reason: check.reason });
        continue;
      }
      await prisma.payment.updateMany({ where: { id, reconciledAt: null }, data: { reconciledAt: new Date(), reconciledByEmail: adminEmail } });
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, reason: e instanceof Error ? e.message.slice(0, 160) : "Could not reach Razorpay" });
    }
  }
  return results;
}

/** Undo a reconciliation (a payment that was marked by mistake). Not allowed once it is part of a payout. */
export async function unreconcilePayment(paymentId: string): Promise<boolean> {
  const { count } = await prisma.payment.updateMany({
    where: { id: paymentId, payoutId: null, reconciledAt: { not: null } },
    data: { reconciledAt: null, reconciledByEmail: null },
  });
  return count > 0;
}

/* ---------- Payouts ---------- */

function destinationLabel(a: { method: "BANK" | "UPI"; bankName: string | null; accountNumberMasked: string | null; upiIdMasked: string | null }): string {
  return a.method === "BANK" ? `${a.bankName ?? "Bank"} ${a.accountNumberMasked ?? ""}`.trim() : `UPI ${a.upiIdMasked ?? ""}`.trim();
}

/**
 * Creates a PENDING payout from every payable payment in one currency and locks those payments to it. Runs in a
 * transaction under a row lock on the influencer, so two administrators clicking at once cannot pay the same
 * payments twice. Refuses unless the influencer's payout details are verified.
 */
export async function createPayout(
  influencerId: string,
  currency: string,
  adminEmail: string,
  now = new Date(),
  /** Tests only: runs between reading the payable payments and claiming them, to interleave another administrator's action. */
  hooks: { afterRead?: () => Promise<void> } = {},
) {
  return guardConflicts(() => prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM influencers WHERE id = ${influencerId} FOR UPDATE`;
      if (locked.length === 0) throw new PayoutError("Influencer not found", 404);

      const influencer = await tx.influencer.findUniqueOrThrow({ where: { id: influencerId }, select: { platformFeeBps: true, payoutAccount: true, suspendedAt: true } });
      // Read under the row lock above, so a suspension in progress and a payout being created cannot both win.
      if (influencer.suspendedAt) throw new PayoutError("This influencer is suspended. Reinstate them before creating a payout.", 409);
      const account = influencer.payoutAccount;
      if (!account) throw new PayoutError("This influencer has not added payout details.");
      if (account.status !== "VERIFIED") throw new PayoutError("Verify the influencer's payout details before creating a payout.");

      const rows = (await loadPayable(influencerId, now, tx)).filter((r) => r.currency === currency && r.blocker === null);
      if (rows.length === 0) throw new PayoutError(`Nothing is payable in ${currency} right now.`);

      const feeBps = effectiveFeeBps(influencer.platformFeeBps);
      const totals = buildPayoutTotals(rows, feeBps);
      if (totals.netMinor <= 0) throw new PayoutError("The payable amount is zero after refunds and fees.");

      const payout = await tx.payout.create({
        data: {
          influencerId,
          currency,
          grossMinor: totals.grossMinor,
          refundsMinor: totals.refundsMinor,
          feeBps,
          feeMinor: totals.feeMinor,
          netMinor: totals.netMinor,
          paymentCount: rows.length,
          destination: destinationLabel(account),
          createdByEmail: adminEmail,
        },
      });
      // Conditional on payoutId IS NULL: a payment already taken by another payout is never stolen.
      await hooks.afterRead?.();
      // Also conditional on what was read: no refund in flight now and the same refund total as in the snapshot above, so a refund claimed
      // by an administrator between the read and this write turns the count check below into a 409 instead of an overpayment.
      const claimed = await tx.payment.updateMany({
        where: {
          payoutId: null,
          // Re-checked here: a cancel or a flag that landed between the read and this claim keeps the payment out (the count check below turns it into a 409).
          needsRefund: false,
          booking: { status: { in: [...PAYABLE_BOOKING_STATUSES] } },
          OR: rows.map((r) => ({
            id: r.id,
            AND: [
              { OR: [{ refundStatus: null }, { refundStatus: { notIn: ["requested", "pending"] } }] },
              r.refundedMinor > 0 ? { refundAmountMinor: r.refundedMinor } : { OR: [{ refundAmountMinor: null }, { refundAmountMinor: 0 }] },
            ],
          })),
        },
        data: { payoutId: payout.id },
      });
      if (claimed.count !== rows.length) throw new PayoutError("Payments changed while creating the payout. Please try again.", 409);
      return payout;
    },
    { timeout: 20_000 },
  ));
}

/**
 * A payout's figures are a snapshot taken when it was created. Before it is approved or marked paid, its payments must still match that
 * snapshot: no refund in flight (requested / pending) and the same refund total as `payout.refundsMinor`. Otherwise (a refund made from the
 * dashboard, in the Razorpay dashboard and applied by webhook, ...) the net would be stale and the influencer overpaid: refused with
 * 409 `refund-in-flight`; cancel the payout and create it again. The payments are locked (`FOR UPDATE`) for the rest of the transaction,
 * so a refund update cannot slip in between this check and the status change.
 */
async function assertRefundsSettled(tx: Prisma.TransactionClient, payoutId: string, refundsMinor: number, notPendingMessage: string): Promise<void> {
  // Lock order everywhere (createPayout, cancelPayout, here): the payout row first, then its payments. Taking the payments first would
  // deadlock with a concurrent cancel (which locks the payout, then updates the payments).
  const locked = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM payouts WHERE id = ${payoutId} FOR UPDATE`;
  if (locked.length === 0 || locked[0].status !== "PENDING") throw new PayoutError(notPendingMessage, 409);
  const rows = await tx.$queryRaw<{ refund_status: string | null; refund_amount_minor: number | null; needs_refund: boolean; booking_status: string }[]>`
    SELECT p.refund_status, p.refund_amount_minor, p.needs_refund, b.status::text AS booking_status
    FROM payments p JOIN bookings b ON b.id = p.booking_id
    WHERE p.payout_id = ${payoutId} FOR UPDATE OF p`;
  if (rows.some((r) => r.needs_refund || !(PAYABLE_BOOKING_STATUSES as readonly string[]).includes(r.booking_status))) {
    throw new PayoutError(
      "A payment in this payout is flagged for a refund, or its booking was cancelled, after the payout was created. Cancel this payout, refund the flagged payment from Payments (Needs refund tab), then create the payout again.",
      409,
      "flagged-payment",
    );
  }
  const inFlight = rows.some((r) => r.refund_status === "requested" || r.refund_status === "pending");
  const total = rows.reduce((n, r) => n + (r.refund_amount_minor ?? 0), 0);
  if (inFlight || total !== refundsMinor) {
    throw new PayoutError(
      "A payment in this payout was refunded (or a refund is in progress) after the payout was created, so its amount is out of date. Cancel this payout and create it again.",
      409,
      "refund-in-flight",
    );
  }
}

/**
 * Four-eyes approval: a PENDING payout gets `approvedAt` / `approvedByEmail`, and only an administrator OTHER than the
 * one who created it may do this. Enforced here (not just hidden in the UI), and the update is conditional on the
 * payout still being pending and unapproved, so concurrent approvals cannot overwrite each other.
 */
/** A deadlock or serialization failure between two administrators' actions is a "try again", not a server error. */
async function guardConflicts<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; message?: string; meta?: { code?: string }; cause?: { code?: string; originalCode?: string; message?: string } };
    const codes = [err.code, err.meta?.code, err.cause?.code, err.cause?.originalCode];
    const text = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
    if (codes.some((c) => c === "40P01" || c === "40001" || c === "P2034") || /deadlock detected|could not serialize access/i.test(text)) {
      throw new PayoutError("Another change to this payout or its payments happened at the same moment. Reload and try again.", 409, "try-again");
    }
    throw e;
  }
}

export async function approvePayout(payoutId: string, adminEmail: string, now = new Date(), override?: SuspendedOverride) {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, select: { status: true, createdByEmail: true, approvedAt: true, influencerId: true, refundsMinor: true } });
  if (!payout) throw new PayoutError("Payout not found", 404);
  if (payout.status !== "PENDING") throw new PayoutError("Only a pending payout can be approved.", 409);
  if (sameAdmin(payout.createdByEmail, adminEmail)) {
    throw new PayoutError("You created this payout, so a different administrator has to approve it.", 403);
  }
  if (payout.approvedAt) throw new PayoutError("This payout is already approved.", 409);
  const suspendedOverride = await checkSuspended(payout.influencerId, override);
  const count = await guardConflicts(() => prisma.$transaction(async (tx) => {
    await assertRefundsSettled(tx, payoutId, payout.refundsMinor, "Only a pending payout can be approved.");
    const done = await tx.payout.updateMany({
      // The suspension is part of the condition too, so a suspension that lands after the read above cannot be raced.
      where: { id: payoutId, status: "PENDING", approvedAt: null, ...(override ? {} : { influencer: { suspendedAt: null } }) },
      data: { approvedAt: now, approvedByEmail: adminEmail },
    });
    return done.count;
  }));
  if (count === 0) {
    await checkSuspended(payout.influencerId, override); // suspended in the meantime: say so, not "changed"
    throw new PayoutError("This payout changed while you were approving it. Reload and try again.", 409);
  }
  return { ...(await prisma.payout.findUniqueOrThrow({ where: { id: payoutId } })), suspendedOverride };
}

/**
 * PENDING -> PAID once the administrator has sent the money. Needs the bank reference (UTR), and, when four-eyes
 * approval applies to this payout (PAYOUT_FOUR_EYES, PAYOUT_FOUR_EYES_MIN_MINOR), an approval from a second admin.
 */
export async function markPayoutPaid(payoutId: string, reference: string, adminEmail: string, env: NodeJS.ProcessEnv = process.env, override?: SuspendedOverride) {
  const ref = reference.trim();
  if (ref.length < 6 || ref.length > 60) throw new PayoutError("Enter the bank reference (UTR) of the transfer.");
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, select: { status: true, netMinor: true, approvedAt: true, influencerId: true, currency: true, refundsMinor: true } });
  if (!payout || payout.status !== "PENDING") throw new PayoutError("This payout is not pending (it may already be paid or cancelled).", 409);
  const suspendedOverride = await checkSuspended(payout.influencerId, override);
  // The threshold applies to this payout plus the influencer's other unapproved payouts of the last 24 hours (no splitting).
  const needsApproval = await payoutNeedsApproval({ id: payoutId, influencerId: payout.influencerId, currency: payout.currency, netMinor: payout.netMinor }, new Date(), env);
  if (needsApproval && !payout.approvedAt) {
    throw new PayoutError("This payout has to be approved by a second administrator before it can be marked as paid.", 409);
  }
  const count = await guardConflicts(() => prisma.$transaction(async (tx) => {
    await assertRefundsSettled(tx, payoutId, payout.refundsMinor, "This payout is not pending (it may already be paid or cancelled).");
    const done = await tx.payout.updateMany({
      // The approval and the suspension are part of the condition too, so the checks cannot be raced.
      where: { id: payoutId, status: "PENDING", ...(needsApproval ? { approvedAt: { not: null } } : {}), ...(override ? {} : { influencer: { suspendedAt: null } }) },
      data: { status: "PAID", reference: ref, paidAt: new Date(), paidByEmail: adminEmail },
    });
    return done.count;
  }));
  if (count === 0) {
    await checkSuspended(payout.influencerId, override); // suspended in the meantime: say so, not "not pending"
    throw new PayoutError("This payout is not pending (it may already be paid or cancelled).", 409);
  }
  const paid = await prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { influencer: { select: { id: true, name: true, email: true } } } });
  return { ...paid, suspendedOverride };
}

/** PENDING -> CANCELLED: releases every payment so it can go into a later payout. */
export async function cancelPayout(payoutId: string, note: string | null, hooks: { afterPayoutLocked?: (tx: Prisma.TransactionClient) => Promise<void> } = {}) {
  return guardConflicts(() =>
    prisma.$transaction(async (tx) => {
      const { count } = await tx.payout.updateMany({ where: { id: payoutId, status: "PENDING" }, data: { status: "CANCELLED", note: note?.slice(0, 300) ?? null } });
      if (count === 0) throw new PayoutError("Only a pending payout can be cancelled.", 409);
      await hooks.afterPayoutLocked?.(tx); // tests only: holds the payout row lock before the payments are released
      // The flagged ones are released too but are NOT payable again until they are refunded: the caller tells the administrator which they are.
      const flagged = await tx.payment.findMany({ where: { payoutId, ...flaggedPaymentWhere }, select: { id: true } });
      await tx.payment.updateMany({ where: { payoutId }, data: { payoutId: null } });
      return { flaggedPaymentIds: flagged.map((f) => f.id) };
    }),
  );
}

/** Refunds made on a payment after its payout was paid: money the influencer received that should come back. */
export async function postPayoutRefunds(payoutId: string): Promise<number> {
  const payout = await prisma.payout.findUnique({ where: { id: payoutId }, select: { refundsMinor: true } });
  if (!payout) return 0;
  const sum = await prisma.payment.aggregate({ where: { payoutId }, _sum: { refundAmountMinor: true } });
  return Math.max((sum._sum.refundAmountMinor ?? 0) - payout.refundsMinor, 0);
}

/* ---------- Influencer-facing summary ---------- */

export interface InfluencerPayoutSummary {
  feeBps: number;
  currencies: { currency: string; paidOutMinor: number; pendingMinor: number; readyMinor: number; waitingMinor: number }[];
  history: { id: string; status: string; currency: string; netMinor: number; feeMinor: number; grossMinor: number; refundsMinor: number; paymentCount: number; destination: string; reference: string | null; paidAt: Date | null; createdAt: Date }[];
}

export async function influencerPayoutSummary(influencerId: string): Promise<InfluencerPayoutSummary> {
  const [inf, rows, payouts] = await Promise.all([
    prisma.influencer.findUniqueOrThrow({ where: { id: influencerId }, select: { platformFeeBps: true } }),
    loadPayable(influencerId),
    prisma.payout.findMany({ where: { influencerId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const feeBps = effectiveFeeBps(inf.platformFeeBps);
  const cur = new Map<string, InfluencerPayoutSummary["currencies"][number]>();
  const get = (c: string) => {
    let v = cur.get(c);
    if (!v) cur.set(c, (v = { currency: c, paidOutMinor: 0, pendingMinor: 0, readyMinor: 0, waitingMinor: 0 }));
    return v;
  };
  for (const o of summariseCurrencies(rows, feeBps)) {
    get(o.currency).readyMinor = o.readyMinor;
    get(o.currency).waitingMinor = o.waitingMinor;
  }
  // Paid out to date and pending are summed in the database over ALL the payouts, not over the 50 of `history`: an influencer with more
  // payouts than that would otherwise be shown less than they were sent (the admin Money page reads this figure).
  const sums = await prisma.payout.groupBy({ by: ["currency", "status"], where: { influencerId, status: { in: ["PAID", "PENDING"] } }, _sum: { netMinor: true } });
  for (const s of sums) {
    if (s.status === "PAID") get(s.currency).paidOutMinor += s._sum.netMinor ?? 0;
    if (s.status === "PENDING") get(s.currency).pendingMinor += s._sum.netMinor ?? 0;
  }
  return {
    feeBps,
    currencies: [...cur.values()],
    history: payouts.map((p) => ({
      id: p.id,
      status: p.status,
      currency: p.currency,
      netMinor: p.netMinor,
      feeMinor: p.feeMinor,
      grossMinor: p.grossMinor,
      refundsMinor: p.refundsMinor,
      paymentCount: p.paymentCount,
      destination: p.destination,
      reference: p.reference,
      paidAt: p.paidAt,
      createdAt: p.createdAt,
    })),
  };
}
