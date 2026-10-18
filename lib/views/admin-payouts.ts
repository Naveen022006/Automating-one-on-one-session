import { activeAdminCount, PAGE_SIZE, parsePage } from "@/lib/admin/data";
import { prisma } from "@/lib/db";
import { isEntityId } from "@/lib/http";
import { fourEyesEnabled, flaggedPaymentCounts, formatFeePercent, payoutApprovalView, postPayoutRefunds, recentUnapprovedFor } from "@/lib/payouts";

/**
 * The admin Payouts page's data, for GET /api/admin/payouts. The caller has already passed the admin
 * gate (`requireAdminMfa()`).
 *
 * The approval fields of every row are computed HERE, for the administrator who is asking (`viewerEmail`): the creator of a
 * payout cannot approve it, a second administrator can. The browser never decides that; it only shows what it is given.
 */

/** The filter tabs; "PENDING" ("To send") is the default. Any other `?status=` is treated as "PENDING". */
export const PAYOUT_FILTERS = ["PENDING", "PAID", "CANCELLED", "all"] as const;
export type PayoutFilter = (typeof PAYOUT_FILTERS)[number];

export function parsePayoutFilter(value: string | null | undefined): PayoutFilter {
  return PAYOUT_FILTERS.find((f) => f === value) ?? "PENDING";
}

export interface AdminPayoutRow {
  id: string;
  createdAt: Date;
  /** `suspended`: the platform suspended this influencer; approving or paying their payout needs an explicit "pay anyway". */
  influencer: { id: string; name: string; suspended: boolean };
  /** Where the money goes, already masked when the payout was created. */
  destination: string;
  /** The "Gross" column: what the customers paid, less the refunds made before the payout was created. */
  grossAfterRefundsMinor: number;
  feeMinor: number;
  /** For example "10%"; formatted on the server so the browser needs no payout code. */
  feePercentText: string;
  netMinor: number;
  currency: string;
  status: string;
  /** The bank reference (UTR) recorded when it was marked as paid. */
  reference: string | null;
  /** Refunded since it was paid: money the influencer received that should come back. 0 for anything but a paid payout. */
  owedMinor: number;
  /** A PENDING payout that contains a payment flagged for a refund (or on a cancelled booking): it cannot be approved or paid; cancel and recreate it. */
  hasFlaggedPayment: boolean;
  /** What the viewing administrator may do with it (see the note at the top of the file). */
  approval: {
    required: boolean;
    approved: boolean;
    approvedByEmail: string | null;
    canApprove: boolean;
    createdByViewer: boolean;
    canMarkPaid: boolean;
  };
}

export interface AdminPayoutsView {
  status: PayoutFilter;
  /**
   * `?id=` asked for ONE payout (the Money page links to the payout it shows): `rows` holds that payout, whatever its status, or nothing when no
   * payout has the id. The tabs and counts are the usual ones.
   */
  single: boolean;
  page: number;
  pageCount: number;
  /** The number on each tab. */
  counts: { PENDING: number; PAID: number; CANCELLED: number; all: number };
  /** Four-eyes approval is on but only one administrator can sign in, so nobody can approve a payout they created. */
  onlyOneAdmin: boolean;
  rows: AdminPayoutRow[];
}

export async function loadAdminPayoutsView(
  params: { status?: string | null; page?: string | null; id?: string | null },
  viewerEmail: string,
): Promise<AdminPayoutsView> {
  const status = parsePayoutFilter(params.status);
  // `?id=` (not empty) shows that one payout, in any status; an id that is not shaped like one matches nothing (it is never turned into the list).
  const idParam = (params.id ?? "").trim();
  const single = idParam !== "";
  const page = single ? 1 : parsePage(params.page ?? undefined);
  const where = single ? { id: isEntityId(idParam) ? idParam : "" } : status === "all" ? {} : { status };
  const [total, rows, counts] = await Promise.all([
    prisma.payout.count({ where }),
    prisma.payout.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { influencer: { select: { id: true, name: true, suspendedAt: true } } } }),
    prisma.payout.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const owed = new Map(await Promise.all(rows.filter((r) => r.status === "PAID").map(async (r) => [r.id, await postPayoutRefunds(r.id)] as const)));
  const recentUnapproved = await recentUnapprovedFor(rows);
  const flagged = await flaggedPaymentCounts(rows.filter((r) => r.status === "PENDING").map((r) => r.id));
  const countOf = (k: string) => (k === "all" ? counts.reduce((n, c) => n + c._count._all, 0) : (counts.find((c) => c.status === k)?._count._all ?? 0));
  const onlyOneAdmin = fourEyesEnabled() && (await activeAdminCount()) < 2;

  return {
    status,
    single,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { PENDING: countOf("PENDING"), PAID: countOf("PAID"), CANCELLED: countOf("CANCELLED"), all: countOf("all") },
    onlyOneAdmin,
    rows: rows.map((p) => {
      const approval = payoutApprovalView(p, viewerEmail, process.env, recentUnapproved.get(p.id) ?? 0);
      return {
        id: p.id,
        createdAt: p.createdAt,
        influencer: { id: p.influencer.id, name: p.influencer.name, suspended: p.influencer.suspendedAt !== null },
        destination: p.destination,
        grossAfterRefundsMinor: p.grossMinor - p.refundsMinor,
        feeMinor: p.feeMinor,
        feePercentText: formatFeePercent(p.feeBps),
        netMinor: p.netMinor,
        currency: p.currency,
        status: p.status,
        reference: p.reference,
        owedMinor: owed.get(p.id) ?? 0,
        hasFlaggedPayment: (flagged.get(p.id) ?? 0) > 0,
        approval: {
          required: approval.required,
          approved: approval.approved,
          // This page names the approver only on a payout still to send ("Approved by ..."): it sends what an ACTION needs, and another
          // administrator's address is not needed on a payout that is done. The Money page (lib/views/admin-money.ts) deliberately differs: it is
          // a ledger of what happened, so a PAID payout there says who approved it and who marked it as sent. That is no new disclosure: the
          // Audit log already shows those addresses to every administrator who has passed the second factor.
          approvedByEmail: p.status === "PENDING" ? approval.approvedByEmail : null,
          canApprove: approval.canApprove,
          createdByViewer: approval.createdByViewer,
          canMarkPaid: approval.canMarkPaid,
        },
      };
    }),
  };
}
