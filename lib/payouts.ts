import { Prisma } from "@/generated/prisma/client";
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
  ) {
    super(message);
  }
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

/* ---------- Pure rules (unit-tested) ---------- */

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
}

export type Blocker =
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
export async function createPayout(influencerId: string, currency: string, adminEmail: string, now = new Date()) {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM influencers WHERE id = ${influencerId} FOR UPDATE`;
      if (locked.length === 0) throw new PayoutError("Influencer not found", 404);

      const influencer = await tx.influencer.findUniqueOrThrow({ where: { id: influencerId }, select: { platformFeeBps: true, payoutAccount: true } });
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
      const claimed = await tx.payment.updateMany({ where: { id: { in: rows.map((r) => r.id) }, payoutId: null }, data: { payoutId: payout.id } });
      if (claimed.count !== rows.length) throw new PayoutError("Payments changed while creating the payout. Please try again.", 409);
      return payout;
    },
    { timeout: 20_000 },
  );
}

/** PENDING -> PAID once the administrator has sent the money. Needs the bank reference (UTR). */
export async function markPayoutPaid(payoutId: string, reference: string, adminEmail: string) {
  const ref = reference.trim();
  if (ref.length < 6 || ref.length > 60) throw new PayoutError("Enter the bank reference (UTR) of the transfer.");
  const { count } = await prisma.payout.updateMany({
    where: { id: payoutId, status: "PENDING" },
    data: { status: "PAID", reference: ref, paidAt: new Date(), paidByEmail: adminEmail },
  });
  if (count === 0) throw new PayoutError("This payout is not pending (it may already be paid or cancelled).", 409);
  return prisma.payout.findUniqueOrThrow({ where: { id: payoutId }, include: { influencer: { select: { id: true, name: true, email: true } } } });
}

/** PENDING -> CANCELLED: releases every payment so it can go into a later payout. */
export async function cancelPayout(payoutId: string, note: string | null) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.payout.updateMany({ where: { id: payoutId, status: "PENDING" }, data: { status: "CANCELLED", note: note?.slice(0, 300) ?? null } });
    if (count === 0) throw new PayoutError("Only a pending payout can be cancelled.", 409);
    await tx.payment.updateMany({ where: { payoutId }, data: { payoutId: null } });
  });
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
  for (const p of payouts) {
    if (p.status === "PAID") get(p.currency).paidOutMinor += p.netMinor;
    if (p.status === "PENDING") get(p.currency).pendingMinor += p.netMinor;
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
