import {
  countMovements,
  influencerChoices,
  KINDS_OF_TYPE,
  lastPaidPayout,
  maskTail,
  MONEY_PAGE_SIZE,
  moneyTotals,
  movementDirection,
  movementStatus,
  parseMoneyType,
  readMovements,
  scheduledPayouts,
  type MoneyFilter,
  type MoneyType,
  type MovementRecord,
} from "@/lib/admin/money";
import { prisma } from "@/lib/db";
import { isEntityId } from "@/lib/http";
import { formatFeePercent, influencerPayoutSummary } from "@/lib/payouts";
import { parseReportsRange } from "./admin-reports";
import { parsePageParam } from "./dashboard-params";

/**
 * The admin Money page's data, for GET /api/admin/money. The caller has already passed the admin gate (`requireAdminMfa()`).
 *
 * One chronological ledger of every money movement (customer payments in; refunds and payouts out), the totals of the range, the
 * payouts that are created but not sent yet, and, when one influencer is chosen, their payout summary. The definitions of the dates and
 * of the totals are at the top of lib/admin/money.ts; the totals ARE the figures of the Reports page for the same range.
 *
 * Nothing secret is sent: a Razorpay payment id and a bank reference (UTR) are shown by their last four characters only, a payout's
 * destination is the masked label stored with it, and no phone, e-mail of a customer or token leaves. The e-mail of the administrator who
 * approved or sent a payout does (the Audit log shows the same to every administrator).
 */

export interface AdminMoneyRow {
  /** Unique within the page: `payment:<id>`, `refund:<id>` or `payout:<id>`. */
  key: string;
  kind: "payment" | "refund" | "payout";
  /** "in" for a customer payment, "out" for a refund and a payout. */
  direction: "in" | "out";
  /** When it happened: payment = checkout began, refund = recorded, payout = marked as sent (lib/admin/money.ts). */
  at: Date;
  amountMinor: number;
  /** Payouts only: the platform fee kept (the amount is what was sent, after it). */
  feeMinor: number | null;
  currency: string;
  /** payment: paid | refunded | flagged (flagged for a refund); refund: pending | processed | failed; payout: paid. */
  status: string;
  influencer: { id: string; name: string };
  /** Payments and refunds. */
  serviceTitle: string | null;
  /** Payments and refunds; "(erased)" for a customer whose data was erased. */
  customerName: string | null;
  /** Payments and refunds: the booking (the page links to the Bookings search by this id). */
  bookingId: string | null;
  /** The Razorpay payment id (payments, refunds) or the bank reference (payouts), as "****" and its last four characters. */
  referenceTail: string | null;
  /** Payouts: the masked label stored with the payout, for example "UPI ****1234". */
  destination: string | null;
  /** Payouts: who approved it and who marked it as sent (administrator e-mail addresses). */
  approvedBy: string | null;
  paidBy: string | null;
  /** Payouts: the payout, for the link to the Payouts page. */
  payoutId: string | null;
}

export interface AdminMoneyView {
  /** The range actually used, YYYY-MM-DD (IST). */
  from: string;
  to: string;
  type: MoneyType;
  /** The influencer the page was filtered by, null for everybody (and when the id matches nobody). */
  influencer: { id: string; name: string } | null;
  /** An influencer id was asked for and nobody has it: the page is empty on purpose. */
  influencerUnknown: boolean;
  generatedAt: Date;
  /** Movements of the filter: page (1-based, never beyond the last), size, the number of pages, the number of movements and their kinds. */
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  counts: { payments: number; refunds: number; payouts: number };
  /** The cards: per currency, for the range (and the influencer), the figures of the Reports page. `stillHeldMinor` is right now. */
  totals: {
    currency: string;
    moneyInMinor: number;
    paymentCount: number;
    refundsOutMinor: number;
    refundCount: number;
    payoutsOutMinor: number;
    payoutCount: number;
    feesKeptMinor: number;
    stillHeldMinor: number;
  }[];
  /** The chosen influencer's payout summary (lib/payouts.ts influencerPayoutSummary), or null. */
  summary: {
    feePercentText: string;
    currencies: { currency: string; paidOutMinor: number; payableMinor: number; heldMinor: number; pendingMinor: number }[];
    lastPayout: { paidAt: Date; netMinor: number; currency: string } | null;
  } | null;
  rows: AdminMoneyRow[];
  /** Payouts created and not yet marked as sent, whatever the range. `shown` is false when the type is "in" or "refunds". */
  scheduled: {
    shown: boolean;
    total: number;
    sums: { currency: string; netMinor: number; count: number }[];
    rows: {
      id: string;
      createdAt: Date;
      influencer: { id: string; name: string };
      netMinor: number;
      feeMinor: number;
      currency: string;
      destination: string;
      approved: boolean;
      approvedBy: string | null;
    }[];
  };
  /** The influencers the filter offers (by name), and whether the list was cut. */
  influencers: { options: { id: string; name: string }[]; truncated: boolean };
}

export type MoneyQuery = { ok: true; filter: MoneyFilter; page: number } | { ok: false; error: string };

/**
 * `?from=&to=&type=&influencerId=&page=`. The dates follow the Reports page exactly (parseReportsRange: an odd value falls back to the
 * default, a start after the end or more than 366 days is refused). `type` falls back to "all". An influencer id that is not shaped like
 * an id is refused (silently ignoring it would show everybody's money while it looked filtered); a well-formed id nobody has is NOT an
 * error, the page is empty. An empty id means everybody.
 */
export function parseMoneyQuery(params: { from?: string | null; to?: string | null; type?: string | null; influencerId?: string | null; page?: string | null }, now = new Date()): MoneyQuery {
  const range = parseReportsRange({ from: params.from, to: params.to }, now);
  if (!range.ok) return range;
  const raw = (params.influencerId ?? "").trim();
  if (raw !== "" && !isEntityId(raw)) return { ok: false, error: "That influencer is not valid. Choose one from the list." };
  return { ok: true, filter: { from: range.from, to: range.to, type: parseMoneyType(params.type), influencerId: raw === "" ? null : raw }, page: parsePageParam(params.page) };
}

/** One movement as the DTO: field by field, the references masked. */
export function toMoneyRow(r: MovementRecord): AdminMoneyRow {
  const payout = r.kind === "payout";
  return {
    key: `${r.kind}:${r.id}`,
    kind: r.kind,
    direction: movementDirection(r.kind),
    at: r.at,
    amountMinor: r.amountMinor,
    feeMinor: r.feeMinor,
    currency: r.currency,
    status: movementStatus(r),
    influencer: { id: r.influencerId, name: r.influencerName },
    serviceTitle: r.serviceTitle,
    customerName: r.customerName,
    bookingId: r.bookingId,
    referenceTail: maskTail(payout ? r.utr : r.providerPaymentId),
    destination: r.destination,
    approvedBy: r.approvedBy,
    paidBy: r.paidBy,
    payoutId: r.kind === "payout" ? r.payoutId : null,
  };
}

export async function loadAdminMoneyView(filter: MoneyFilter, requestedPage: number, now = new Date()): Promise<AdminMoneyView> {
  // The queries run in three short stages, at most four connections at a time (the database has a small connection cap), so the page is
  // about eight round trips deep instead of seventeen.
  const showScheduled = KINDS_OF_TYPE[filter.type].includes("payout");
  const [selected, choices, scheduled] = await Promise.all([
    filter.influencerId ? prisma.influencer.findUnique({ where: { id: filter.influencerId }, select: { id: true, name: true } }) : Promise.resolve(null),
    influencerChoices(),
    showScheduled ? scheduledPayouts(filter.influencerId) : Promise.resolve({ total: 0, sums: [], rows: [] }),
  ]);
  const influencerUnknown = filter.influencerId !== null && selected === null;
  const options = selected && !choices.options.some((o) => o.id === selected.id) ? [...choices.options, selected].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) : choices.options;
  const influencers = { options, truncated: choices.truncated };

  if (influencerUnknown) {
    // Nothing can match, and the summary of an influencer that does not exist would throw: answer an empty page.
    return {
      from: filter.from,
      to: filter.to,
      type: filter.type,
      influencer: null,
      influencerUnknown: true,
      generatedAt: now,
      page: 1,
      pageSize: MONEY_PAGE_SIZE,
      pageCount: 1,
      total: 0,
      counts: { payments: 0, refunds: 0, payouts: 0 },
      totals: [],
      summary: null,
      rows: [],
      scheduled: { shown: showScheduled, total: 0, sums: [], rows: [] },
      influencers,
    };
  }

  const readPage = (p: number) => readMovements(filter, { limit: MONEY_PAGE_SIZE, offset: (p - 1) * MONEY_PAGE_SIZE, order: "desc" });
  const [counts, firstRead, totals] = await Promise.all([countMovements(filter), readPage(requestedPage), moneyTotals(filter)]);
  const pageCount = Math.max(1, Math.ceil(counts.total / MONEY_PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  // A page beyond the last is the last one (a second read, only for a URL that names a page that is not there).
  const records = page === requestedPage ? firstRead : await readPage(page);

  let summary: AdminMoneyView["summary"] = null;
  if (selected) {
    const [s, lastPayout] = await Promise.all([influencerPayoutSummary(selected.id), lastPaidPayout(selected.id)]);
    summary = {
      feePercentText: formatFeePercent(s.feeBps),
      currencies: s.currencies.map((c) => ({ currency: c.currency, paidOutMinor: c.paidOutMinor, payableMinor: c.readyMinor, heldMinor: c.waitingMinor, pendingMinor: c.pendingMinor })),
      lastPayout,
    };
  }

  return {
    from: filter.from,
    to: filter.to,
    type: filter.type,
    influencer: selected,
    influencerUnknown: false,
    generatedAt: now,
    page,
    pageSize: MONEY_PAGE_SIZE,
    pageCount,
    total: counts.total,
    counts: { payments: counts.payments, refunds: counts.refunds, payouts: counts.payouts },
    totals: totals.map((t) => ({
      currency: t.currency,
      moneyInMinor: t.moneyInMinor,
      paymentCount: t.paymentCount,
      refundsOutMinor: t.refundsOutMinor,
      refundCount: t.refundCount,
      payoutsOutMinor: t.payoutsOutMinor,
      payoutCount: t.payoutCount,
      feesKeptMinor: t.feesKeptMinor,
      stillHeldMinor: t.stillHeldMinor,
    })),
    summary,
    rows: records.map(toMoneyRow),
    scheduled: {
      shown: showScheduled,
      total: scheduled.total,
      sums: scheduled.sums.map((s) => ({ currency: s.currency, netMinor: s.netMinor, count: s.count })),
      rows: scheduled.rows.map((p) => ({
        id: p.id,
        createdAt: p.createdAt,
        influencer: { id: p.influencerId, name: p.influencerName },
        netMinor: p.netMinor,
        feeMinor: p.feeMinor,
        currency: p.currency,
        destination: p.destination,
        approved: p.approvedAt !== null,
        approvedBy: p.approvedBy,
      })),
    },
    influencers,
  };
}
