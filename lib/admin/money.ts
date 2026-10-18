import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { balanceFigures, istStart, nextDay, rangeFigures, type Day } from "@/lib/admin/reports";

/**
 * The queries behind the admin Money page (GET /api/admin/money) and its CSV export: ONE chronological ledger of every money movement
 * of the platform. Nothing is loaded without a bound: the rows come from a single SQL statement (a UNION ALL of three explicit selects,
 * ordered, LIMIT / OFFSET) and the counts and the totals are aggregates. The queries are few and small; the view function runs them in
 * short stages, never more than two connections at a time (the database has a small connection cap).
 *
 * THREE KINDS OF MOVEMENT, each dated by the one timestamp that is the most exact the schema has, and the same one the Reports page
 * (lib/admin/reports.ts) uses, so the rows of a range add up to the Reports figures of that range:
 *   - payment  IN   "Customer payment": payments that are CAPTURED or REFUNDED, by `payments.created_at`. The schema keeps no capture time
 *                    (`updated_at` moves on every reconcile or refund, and webhook_events does not name the payment), so this is the moment
 *                    checkout began, i.e. the Razorpay order was created. A capture applied later by the recovery job does not move it.
 *   - refund   OUT  "Refund to customer": every refund row, by `refunds.created_at` (the refund was recorded when it was requested; its
 *                    status says whether it is pending, processed or failed). Reports counts the pending and processed ones; a FAILED refund
 *                    is listed here (the admin should see it) but is not money out and is not in any total.
 *   - payout   OUT  "Payout to influencer": payouts that are PAID, by `payouts.paid_at` (the day the money was marked as sent). The
 *                    amount is the stored net, the fee is the stored fee: nothing is recomputed here.
 * Payouts that are still PENDING (created, perhaps approved, not sent) are not movements yet: `scheduledPayouts` lists them apart, whatever
 * the range.
 *
 * DAYS ARE INDIAN STANDARD TIME. A range day D covers [D 00:00 IST, D+1 00:00 IST) = [D-1 18:30 UTC, D 18:30 UTC), cut by `istStart` of
 * lib/admin/reports.ts (the very function Reports uses). Money is integer minor units; a currency is never added to another.
 */

export const MONEY_TYPES = ["all", "in", "out", "refunds", "payouts"] as const;
export type MoneyType = (typeof MONEY_TYPES)[number];

/** `?type=`: anything that is not one of the five is "all". */
export function parseMoneyType(value: string | null | undefined): MoneyType {
  return MONEY_TYPES.find((t) => t === value) ?? "all";
}

export type MovementKind = "payment" | "refund" | "payout";

/** Which movements each type shows. */
export const KINDS_OF_TYPE: Record<MoneyType, readonly MovementKind[]> = {
  all: ["payment", "refund", "payout"],
  in: ["payment"],
  out: ["refund", "payout"],
  refunds: ["refund"],
  payouts: ["payout"],
};

/** Rows per page of the ledger. */
export const MONEY_PAGE_SIZE = 50;
/** The most scheduled (created, not yet sent) payouts listed; the total says how many there are. */
export const MONEY_SCHEDULED_CAP = 50;
/** The most influencers offered in the filter's list. */
export const MONEY_INFLUENCER_CHOICES = 200;

export interface MoneyFilter {
  from: Day;
  to: Day;
  type: MoneyType;
  /** Only this influencer's money; null for everybody. */
  influencerId: string | null;
}

/** One movement as read from the database. The view function turns it into the hand-picked DTO; the export into CSV cells. */
export interface MovementRecord {
  kind: MovementKind;
  /** The id of the payment, the refund or the payout. */
  id: string;
  /** When it happened (see the top of the file). */
  at: Date;
  amountMinor: number;
  /** Payouts only: the platform fee kept. */
  feeMinor: number | null;
  currency: string;
  /** As stored: payment CAPTURED | REFUNDED, refund pending | processed | failed, payout PAID. */
  rawStatus: string;
  /** Payments only: flagged for a refund. */
  needsRefund: boolean;
  influencerId: string;
  influencerSlug: string;
  influencerName: string;
  /** Payments and refunds. */
  serviceTitle: string | null;
  /** Payments and refunds; "(erased)" for a customer whose data was erased. */
  customerName: string | null;
  bookingId: string | null;
  paymentId: string | null;
  payoutId: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  /** Payouts: the bank reference (UTR) recorded when it was marked as sent. */
  utr: string | null;
  /** Payouts: the masked label stored with the payout (for example "UPI ****1234"). */
  destination: string | null;
  approvedBy: string | null;
  paidBy: string | null;
}

interface MovementSqlRow {
  kind: string;
  id: string;
  moved_at: Date;
  amount_minor: number;
  fee_minor: number | null;
  currency: string;
  status: string;
  needs_refund: boolean;
  influencer_id: string;
  influencer_slug: string;
  influencer_name: string;
  service_title: string | null;
  customer_name: string | null;
  customer_redacted: boolean;
  booking_id: string | null;
  payment_id: string | null;
  payout_id: string | null;
  provider_payment_id: string | null;
  provider_refund_id: string | null;
  utr: string | null;
  destination: string | null;
  approved_by: string | null;
  paid_by: string | null;
}

/* ---------- Pure helpers (unit-tested) ---------- */

/**
 * A reference shown only by its tail: "****" and the last four characters. A value shorter than eight characters shows nothing of itself
 * (four of five characters would be most of it). Used for the Razorpay payment id and the bank reference (UTR) on the page.
 */
export function maskTail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length >= 8 ? `****${value.slice(-4)}` : "****";
}

/** The status the page shows: a payment is paid, refunded or flagged for a refund; a refund keeps its own; a payout is paid. */
export function movementStatus(r: Pick<MovementRecord, "kind" | "rawStatus" | "needsRefund">): string {
  if (r.kind === "payment") return r.rawStatus === "REFUNDED" ? "refunded" : r.needsRefund ? "flagged" : "paid";
  if (r.kind === "refund") return r.rawStatus;
  return "paid";
}

/** "in" for a customer payment, "out" for a refund and a payout. */
export function movementDirection(kind: MovementKind): "in" | "out" {
  return kind === "payment" ? "in" : "out";
}

/* ---------- The ledger ---------- */

/** The joins from a payment (`p`) to the booking, the service and the influencer who earns it. */
const TO_INFLUENCER = Prisma.sql`JOIN bookings b ON b.id = p.booking_id JOIN sessions se ON se.id = b.session_id JOIN services sv ON sv.id = se.service_id JOIN influencers i ON i.id = sv.influencer_id`;

const onlyInfluencer = (column: Prisma.Sql, influencerId: string | null) => (influencerId ? Prisma.sql`AND ${column} = ${influencerId}` : Prisma.empty);

/** One SELECT per kind, all with the SAME columns in the same order (a UNION ALL needs that). */
function branch(kind: MovementKind, f: MoneyFilter): Prisma.Sql {
  const start = istStart(f.from);
  const end = istStart(nextDay(f.to));
  switch (kind) {
    case "payment":
      return Prisma.sql`
        SELECT 'payment'::text AS kind, p.id AS id, p.created_at AS moved_at, p.amount_minor AS amount_minor, NULL::int AS fee_minor, p.currency AS currency,
               p.status::text AS status, p.needs_refund AS needs_refund, i.id AS influencer_id, i.slug AS influencer_slug, i.name AS influencer_name,
               sv.title AS service_title, b.customer_name AS customer_name, (b.redacted_at IS NOT NULL) AS customer_redacted, b.id AS booking_id,
               p.id AS payment_id, p.payout_id AS payout_id, p.provider_payment_id AS provider_payment_id, NULL::text AS provider_refund_id,
               NULL::text AS utr, NULL::text AS destination, NULL::text AS approved_by, NULL::text AS paid_by
        FROM payments p ${TO_INFLUENCER}
        WHERE p.status IN ('CAPTURED', 'REFUNDED') AND p.created_at >= ${start} AND p.created_at < ${end} ${onlyInfluencer(Prisma.sql`i.id`, f.influencerId)}`;
    case "refund":
      return Prisma.sql`
        SELECT 'refund'::text AS kind, r.id AS id, r.created_at AS moved_at, r.amount_minor AS amount_minor, NULL::int AS fee_minor, p.currency AS currency,
               r.status::text AS status, false AS needs_refund, i.id AS influencer_id, i.slug AS influencer_slug, i.name AS influencer_name,
               sv.title AS service_title, b.customer_name AS customer_name, (b.redacted_at IS NOT NULL) AS customer_redacted, b.id AS booking_id,
               p.id AS payment_id, p.payout_id AS payout_id, p.provider_payment_id AS provider_payment_id, r.provider_refund_id AS provider_refund_id,
               NULL::text AS utr, NULL::text AS destination, NULL::text AS approved_by, NULL::text AS paid_by
        FROM refunds r JOIN payments p ON p.id = r.payment_id ${TO_INFLUENCER}
        WHERE r.created_at >= ${start} AND r.created_at < ${end} ${onlyInfluencer(Prisma.sql`i.id`, f.influencerId)}`;
    case "payout":
      return Prisma.sql`
        SELECT 'payout'::text AS kind, po.id AS id, po.paid_at AS moved_at, po.net_minor AS amount_minor, po.fee_minor AS fee_minor, po.currency AS currency,
               po.status::text AS status, false AS needs_refund, i.id AS influencer_id, i.slug AS influencer_slug, i.name AS influencer_name,
               NULL::text AS service_title, NULL::text AS customer_name, false AS customer_redacted, NULL::text AS booking_id,
               NULL::text AS payment_id, po.id AS payout_id, NULL::text AS provider_payment_id, NULL::text AS provider_refund_id,
               po.reference AS utr, po.destination AS destination, po.approved_by_email AS approved_by, po.paid_by_email AS paid_by
        FROM payouts po JOIN influencers i ON i.id = po.influencer_id
        WHERE po.status = 'PAID' AND po.paid_at >= ${start} AND po.paid_at < ${end} ${onlyInfluencer(Prisma.sql`po.influencer_id`, f.influencerId)}`;
  }
}

/** The movements of the filter as one relation, `(a UNION ALL b UNION ALL c)`. */
function ledger(f: MoneyFilter): Prisma.Sql {
  return Prisma.sql`(${Prisma.join(KINDS_OF_TYPE[f.type].map((k) => branch(k, f)), " UNION ALL ")})`;
}

export interface MovementCounts {
  total: number;
  payments: number;
  refunds: number;
  payouts: number;
}

/** How many movements the filter holds, in total and by kind. One query. */
export async function countMovements(f: MoneyFilter): Promise<MovementCounts> {
  const rows = await prisma.$queryRaw<{ kind: string; n: bigint }[]>`SELECT m.kind, COUNT(*) AS n FROM ${ledger(f)} m GROUP BY m.kind`;
  const by = (kind: string) => Number(rows.find((r) => r.kind === kind)?.n ?? 0);
  const counts = { payments: by("payment"), refunds: by("refund"), payouts: by("payout") };
  return { total: counts.payments + counts.refunds + counts.payouts, ...counts };
}

/**
 * One page of movements. Newest first for the page, oldest first for the CSV file; ties are broken by kind and id so a page boundary
 * never repeats or skips a row. One query.
 */
export async function readMovements(f: MoneyFilter, o: { limit: number; offset: number; order: "desc" | "asc" }): Promise<MovementRecord[]> {
  const direction = o.order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const rows = await prisma.$queryRaw<MovementSqlRow[]>`
    SELECT m.* FROM ${ledger(f)} m
    ORDER BY m.moved_at ${direction}, m.kind ASC, m.id ASC
    LIMIT ${o.limit} OFFSET ${o.offset}`;
  return rows.map((r) => ({
    kind: r.kind as MovementKind,
    id: r.id,
    at: r.moved_at,
    amountMinor: Number(r.amount_minor),
    feeMinor: r.fee_minor === null ? null : Number(r.fee_minor),
    currency: r.currency,
    rawStatus: r.status,
    needsRefund: r.needs_refund,
    influencerId: r.influencer_id,
    influencerSlug: r.influencer_slug,
    influencerName: r.influencer_name,
    serviceTitle: r.service_title,
    customerName: r.kind === "payout" ? null : r.customer_redacted ? "(erased)" : r.customer_name,
    bookingId: r.booking_id,
    paymentId: r.payment_id,
    payoutId: r.payout_id,
    providerPaymentId: r.provider_payment_id,
    providerRefundId: r.provider_refund_id,
    utr: r.utr,
    destination: r.destination,
    approvedBy: r.approved_by,
    paidBy: r.paid_by,
  }));
}

/* ---------- Totals (the Reports figures) ---------- */

export interface MoneyTotals {
  currency: string;
  /** Payments CAPTURED or REFUNDED in the range (Reports: Gross). */
  moneyInMinor: number;
  paymentCount: number;
  /** Refunds pending or processed in the range (Reports: Refunds). */
  refundsOutMinor: number;
  refundCount: number;
  /** The net amount of payouts marked as sent in the range (Reports: Paid out). */
  payoutsOutMinor: number;
  payoutCount: number;
  /** The platform fee on those payouts (Reports: Platform fees). */
  feesKeptMinor: number;
  /** Held for influencers right now, before the fee (Reports: Held for influencers). Not limited to the range. */
  stillHeldMinor: number;
}

/**
 * The cards: the range figures and the held balance of lib/admin/reports.ts, computed by those very functions (narrowed to one influencer
 * when asked), one entry per currency with anything in it. Six queries, two at a time (each function runs its three one after the other).
 * The `type` of the filter does not narrow them.
 */
export async function moneyTotals(f: Pick<MoneyFilter, "from" | "to" | "influencerId">): Promise<MoneyTotals[]> {
  const scope = { influencerId: f.influencerId };
  const [range, balances] = await Promise.all([rangeFigures(f.from, f.to, scope), balanceFigures(scope)]);
  const by = new Map<string, MoneyTotals>();
  const get = (currency: string) => {
    let t = by.get(currency);
    if (!t) by.set(currency, (t = { currency, moneyInMinor: 0, paymentCount: 0, refundsOutMinor: 0, refundCount: 0, payoutsOutMinor: 0, payoutCount: 0, feesKeptMinor: 0, stillHeldMinor: 0 }));
    return t;
  };
  for (const r of range) {
    Object.assign(get(r.currency), {
      moneyInMinor: r.grossMinor,
      paymentCount: r.paymentCount,
      refundsOutMinor: r.refundsMinor,
      refundCount: r.refundCount,
      payoutsOutMinor: r.payoutsPaidNetMinor,
      payoutCount: r.payoutsPaidCount,
      feesKeptMinor: r.feesEarnedMinor,
    });
  }
  for (const b of balances) if (b.heldForInfluencersMinor !== 0) get(b.currency).stillHeldMinor = b.heldForInfluencersMinor;
  return [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/* ---------- Scheduled payouts ---------- */

export interface ScheduledPayoutRecord {
  id: string;
  createdAt: Date;
  influencerId: string;
  influencerName: string;
  netMinor: number;
  feeMinor: number;
  currency: string;
  destination: string;
  approvedAt: Date | null;
  approvedBy: string | null;
}

export interface ScheduledPayouts {
  /** Every payout that is PENDING (created, not marked as sent), however old. */
  total: number;
  /** The net amount still to be sent, per currency. */
  sums: { currency: string; netMinor: number; count: number }[];
  /** The newest MONEY_SCHEDULED_CAP of them. */
  rows: ScheduledPayoutRecord[];
}

/** Payouts that are created and not yet sent, whatever the date range. Two queries. */
export async function scheduledPayouts(influencerId: string | null): Promise<ScheduledPayouts> {
  const where: Prisma.PayoutWhereInput = { status: "PENDING", ...(influencerId ? { influencerId } : {}) };
  const sums = await prisma.payout.groupBy({ by: ["currency"], where, _sum: { netMinor: true }, _count: { _all: true }, orderBy: { currency: "asc" } });
  const rows = await prisma.payout.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: MONEY_SCHEDULED_CAP,
    select: {
      id: true,
      createdAt: true,
      netMinor: true,
      feeMinor: true,
      currency: true,
      destination: true,
      approvedAt: true,
      approvedByEmail: true,
      influencer: { select: { id: true, name: true } },
    },
  });
  return {
    total: sums.reduce((n, s) => n + s._count._all, 0),
    sums: sums.map((s) => ({ currency: s.currency, netMinor: s._sum.netMinor ?? 0, count: s._count._all })),
    rows: rows.map((p) => ({
      id: p.id,
      createdAt: p.createdAt,
      influencerId: p.influencer.id,
      influencerName: p.influencer.name,
      netMinor: p.netMinor,
      feeMinor: p.feeMinor,
      currency: p.currency,
      destination: p.destination,
      approvedAt: p.approvedAt,
      approvedBy: p.approvedByEmail,
    })),
  };
}

/** The most recent payout of an influencer that was marked as sent (by `paid_at`), or null. One query. */
export async function lastPaidPayout(influencerId: string): Promise<{ paidAt: Date; netMinor: number; currency: string } | null> {
  const p = await prisma.payout.findFirst({
    where: { influencerId, status: "PAID", paidAt: { not: null } },
    orderBy: [{ paidAt: "desc" }, { id: "asc" }],
    select: { paidAt: true, netMinor: true, currency: true },
  });
  return p && p.paidAt ? { paidAt: p.paidAt, netMinor: p.netMinor, currency: p.currency } : null;
}

/* ---------- The influencer list of the filter ---------- */

/** The influencers the filter offers, by name (at most MONEY_INFLUENCER_CHOICES), and whether there are more. One query. */
export async function influencerChoices(): Promise<{ options: { id: string; name: string }[]; truncated: boolean }> {
  const rows = await prisma.influencer.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }], take: MONEY_INFLUENCER_CHOICES + 1, select: { id: true, name: true } });
  return { options: rows.slice(0, MONEY_INFLUENCER_CHOICES), truncated: rows.length > MONEY_INFLUENCER_CHOICES };
}
