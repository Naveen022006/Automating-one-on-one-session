import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { countFailedMessages } from "@/lib/failed-messages";
import { isEntityId } from "@/lib/http";
import { approvalRequired, buildPublicInfluencerWhere, evaluateReadiness, isLiveBlocker, readinessInput, type ReadinessInput } from "@/lib/readiness";

export const PAGE_SIZE = 25;

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageCount: number;
}

function paged<T>(rows: T[], total: number, page: number): Paged<T> {
  return { rows, total, page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

export function parsePage(value: string | undefined): number {
  const n = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(n) && n > 0 && n < 10_000 ? n : 1;
}

export interface MoneyByCurrency {
  currency: string;
  amountMinor: number;
}

export interface Overview {
  influencers: { total: number; onboarded: number };
  bookingsByStatus: Record<string, number>;
  /** Captured payment totals (gross, before refunds), per currency. */
  captured: MoneyByCurrency[];
  /** Refunds that are pending or processed, per currency. */
  refunded: MoneyByCurrency[];
  attention: { needsRefund: number; mismatched: number; googleReconnect: number; failedMessages7d: number };
}

/**
 * A captured payment whose booking never reached a paid state is the classic reconciliation break: the money is
 * with us but the customer has no session. These booking statuses should not coexist with a captured payment.
 */
export const MISMATCH_BOOKING_STATUSES = ["HELD", "PENDING_PAYMENT", "EXPIRED", "FAILED"] as const;

export const mismatchWhere: Prisma.PaymentWhereInput = {
  status: "CAPTURED",
  booking: { status: { in: [...MISMATCH_BOOKING_STATUSES] } },
};

export async function getOverview(): Promise<Overview> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [total, onboarded, byStatus, captured, refunds, needsRefund, mismatched, googleReconnect, failedMessages] =
    await Promise.all([
      prisma.influencer.count(),
      prisma.influencer.count({ where: { onboardedAt: { not: null } } }),
      prisma.booking.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.payment.groupBy({ by: ["currency"], where: { status: { in: ["CAPTURED", "REFUNDED"] } }, _sum: { amountMinor: true } }),
      prisma.$queryRaw<{ currency: string; amount: bigint }[]>`
        SELECT p.currency, COALESCE(SUM(r.amount_minor), 0) AS amount
        FROM refunds r JOIN payments p ON p.id = r.payment_id
        WHERE r.status IN ('pending', 'processed')
        GROUP BY p.currency`,
      prisma.payment.count({ where: { needsRefund: true, status: "CAPTURED" } }),
      prisma.payment.count({ where: mismatchWhere }),
      prisma.googleToken.count({ where: { status: "RECONNECT_NEEDED" } }),
      countFailedMessages(weekAgo),
    ]);

  return {
    influencers: { total, onboarded },
    bookingsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    captured: captured.map((r) => ({ currency: r.currency, amountMinor: r._sum.amountMinor ?? 0 })),
    refunded: refunds.map((r) => ({ currency: r.currency, amountMinor: Number(r.amount) })),
    attention: { needsRefund, mismatched, googleReconnect, failedMessages7d: failedMessages },
  };
}

export interface InfluencerRow {
  id: string;
  slug: string;
  name: string;
  email: string;
  onboarded: boolean;
  /** Taking bookings: onboarding done, email verified and every required connection in place. */
  live: boolean;
  /** Why it is not live (empty when live). */
  blockers: string[];
  /** Platform moderation: suspended wins; "awaiting-approval" only while the approval gate is on and a finished page is unapproved. */
  accountStatus: AccountStatus;
  emailVerified: boolean;
  google: "connected" | "reconnect" | "none";
  payout: "none" | "pending" | "verified" | "rejected";
  whatsapp: ReadinessInput["whatsapp"];
  services: number;
  bookings: number;
  grossMinor: number;
  createdAt: Date;
}

export type AccountStatus = "active" | "suspended" | "awaiting-approval";

export const INFLUENCER_STATUS_FILTERS = ["all", "live", "not-live", "suspended", "awaiting-approval"] as const;
export type InfluencerStatusFilter = (typeof INFLUENCER_STATUS_FILTERS)[number];

/** An unknown or missing filter means "all". */
export function parseInfluencerStatusFilter(value: string | null | undefined): InfluencerStatusFilter {
  return (INFLUENCER_STATUS_FILTERS as readonly string[]).includes(value ?? "") ? (value as InfluencerStatusFilter) : "all";
}

/** Suspension wins over everything. A page is "awaiting approval" only when the gate is on, the page is finished and nobody approved it. */
export function accountStatusOf(row: { suspendedAt: Date | null; approvedAt: Date | null; onboardedAt: Date | null }, approvalOn: boolean): AccountStatus {
  if (row.suspendedAt) return "suspended";
  if (approvalOn && row.approvedAt === null && row.onboardedAt !== null) return "awaiting-approval";
  return "active";
}

/** The Prisma form of `accountStatusOf` / "live", so the tabs and the counts agree with the rows. */
export function influencerStatusWhere(status: InfluencerStatusFilter, env: NodeJS.ProcessEnv = process.env): Prisma.InfluencerWhereInput {
  switch (status) {
    case "suspended":
      return { suspendedAt: { not: null } };
    case "awaiting-approval":
      // approvalRequired() is false with the gate off, and then nothing is ever awaiting approval.
      return approvalRequired(env) ? { suspendedAt: null, approvedAt: null, onboardedAt: { not: null } } : { id: { in: [] } };
    case "live":
      return buildPublicInfluencerWhere(env);
    case "not-live":
      return { NOT: buildPublicInfluencerWhere(env) };
    default:
      return {};
  }
}

/** Totals for the two moderation tabs (not narrowed by the search text). */
export async function influencerModerationCounts(): Promise<{ suspended: number; awaitingApproval: number }> {
  const [suspended, awaitingApproval] = await Promise.all([
    prisma.influencer.count({ where: influencerStatusWhere("suspended") }),
    prisma.influencer.count({ where: influencerStatusWhere("awaiting-approval") }),
  ]);
  return { suspended, awaitingApproval };
}

export async function listInfluencers(page: number, q?: string, status: InfluencerStatusFilter = "all"): Promise<Paged<InfluencerRow>> {
  const term = q?.trim();
  const search: Prisma.InfluencerWhereInput = term
    ? {
        OR: [
          { name: { contains: term, mode: "insensitive" } },
          { email: { contains: term, mode: "insensitive" } },
          { slug: { contains: term, mode: "insensitive" } },
        ],
      }
    : {};
  const where: Prisma.InfluencerWhereInput = status === "all" ? search : { AND: [search, influencerStatusWhere(status)] };
  const approvalOn = approvalRequired();
  const [total, rows] = await Promise.all([
    prisma.influencer.count({ where }),
    prisma.influencer.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        onboardedAt: true,
        createdAt: true,
        suspendedAt: true,
        suspendedReason: true,
        approvedAt: true,
        user: { select: { emailVerifiedAt: true } },
        googleToken: { select: { status: true, scope: true } },
        payoutAccount: { select: { status: true } },
        whatsappConnection: { select: { status: true, templates: true } },
        _count: { select: { services: { where: { active: true } }, rules: true } },
      },
    }),
  ]);

  const ids = rows.map((r) => r.id);
  const money = ids.length
    ? await prisma.$queryRaw<{ influencer_id: string; bookings: bigint; gross: bigint }[]>`
        SELECT s.influencer_id,
               COUNT(DISTINCT b.id) AS bookings,
               COALESCE(SUM(p.amount_minor) FILTER (WHERE p.status IN ('CAPTURED', 'REFUNDED')), 0) AS gross
        FROM services s
        JOIN sessions se ON se.service_id = s.id
        JOIN bookings b ON b.session_id = se.id
        LEFT JOIN payments p ON p.booking_id = b.id
        WHERE s.influencer_id = ANY(${ids}::text[])
        GROUP BY s.influencer_id`
    : [];
  const byId = new Map(money.map((m) => [m.influencer_id, m]));

  return paged(
    rows.map((r) => {
      const input = readinessInput(r, r.user?.emailVerifiedAt != null || !r.user);
      const readiness = evaluateReadiness(input);
      const connectionBlockers = readiness.blockers.filter((b) => isLiveBlocker(b.key));
      const live = r.onboardedAt !== null && connectionBlockers.length === 0;
      return {
      live,
      accountStatus: accountStatusOf(r, approvalOn),
      blockers: r.onboardedAt === null ? ["Finish onboarding", ...connectionBlockers.map((b) => b.label)] : connectionBlockers.map((b) => b.label),
      id: r.id,
      slug: r.slug,
      name: r.name,
      email: r.email,
      onboarded: r.onboardedAt !== null,
      emailVerified: r.user?.emailVerifiedAt != null,
      google: !r.googleToken ? "none" : r.googleToken.status === "ACTIVE" ? "connected" : "reconnect",
      payout: !r.payoutAccount ? "none" : r.payoutAccount.status === "VERIFIED" ? "verified" : r.payoutAccount.status === "REJECTED" ? "rejected" : "pending",
      whatsapp: input.whatsapp, // the same state the influencer's own checklist shows
      services: r._count.services,
      bookings: Number(byId.get(r.id)?.bookings ?? 0),
      grossMinor: Number(byId.get(r.id)?.gross ?? 0),
      createdAt: r.createdAt,
      };
    }),
    total,
    page,
  );
}

export async function getInfluencerDetail(id: string) {
  const influencer = await prisma.influencer.findUnique({
    where: { id },
    include: {
      user: { select: { emailVerifiedAt: true, createdAt: true } },
      googleToken: { select: { status: true, googleEmail: true, connectedAt: true, reconnectReason: true, scope: true } },
      whatsappConnection: { select: { status: true, displayPhone: true, verifiedName: true, templates: true, lastError: true } },
      services: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!influencer) return null;
  const bookings = await prisma.booking.findMany({
    where: { session: { service: { influencerId: id } } },
    orderBy: { createdAt: "desc" },
    take: 15,
    include: { session: { include: { service: { select: { title: true, currency: true } } } }, payments: { select: { status: true, amountMinor: true } } },
  });
  return { influencer, bookings };
}

export interface PaymentFilter {
  view?: "needs-refund" | "mismatch" | "captured" | "unpaid" | "unreconciled";
}

export function paymentWhere(filter: PaymentFilter): Prisma.PaymentWhereInput {
  switch (filter.view) {
    case "needs-refund":
      return { needsRefund: true, status: "CAPTURED" };
    case "mismatch":
      return mismatchWhere;
    case "captured":
      return { status: { in: ["CAPTURED", "REFUNDED"] } };
    case "unreconciled":
      return { status: "CAPTURED", reconciledAt: null, payoutId: null };
    case "unpaid":
      return { status: { in: ["CREATED", "FAILED"] } };
    default:
      return {};
  }
}

export async function listPayments(page: number, filter: PaymentFilter) {
  const where = paymentWhere(filter);
  const [total, rows] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        booking: {
          select: {
            id: true,
            status: true,
            customerName: true,
            session: { select: { startTime: true, service: { select: { title: true, influencer: { select: { id: true, name: true } } } } } },
          },
        },
      },
    }),
  ]);
  return paged(rows, total, page);
}

export async function paymentViewCounts() {
  const [all, needsRefund, mismatch, captured, unpaid, unreconciled] = await Promise.all([
    prisma.payment.count(),
    prisma.payment.count({ where: paymentWhere({ view: "needs-refund" }) }),
    prisma.payment.count({ where: paymentWhere({ view: "mismatch" }) }),
    prisma.payment.count({ where: paymentWhere({ view: "captured" }) }),
    prisma.payment.count({ where: paymentWhere({ view: "unpaid" }) }),
    prisma.payment.count({ where: paymentWhere({ view: "unreconciled" }) }),
  ]);
  return { all, needsRefund, mismatch, captured, unpaid, unreconciled };
}

/** Longest booking search text taken from a URL. */
export const BOOKING_SEARCH_MAX = 120;

/**
 * The search part of the Bookings page: `q` (trimmed, at most 120 characters) matches a booking id exactly when it has the shape of one,
 * and in every case it is a case-insensitive "contains" on the customer's e-mail or name. Empty: no search.
 */
export function bookingSearchWhere(q: string | undefined): Prisma.BookingWhereInput | null {
  const term = q?.trim().slice(0, BOOKING_SEARCH_MAX);
  if (!term) return null;
  return {
    OR: [
      ...(isEntityId(term) ? [{ id: term }] : []),
      { customerEmail: { contains: term.toLowerCase(), mode: "insensitive" as const } },
      { customerName: { contains: term, mode: "insensitive" as const } },
    ],
  };
}

export async function listBookings(page: number, status?: string, q?: string) {
  const valid = ["REQUESTED", "HELD", "PENDING_PAYMENT", "PAID", "SCHEDULED", "COMPLETED", "EXPIRED", "CANCELLED", "FAILED"];
  const where: Prisma.BookingWhereInput = {
    ...(status && valid.includes(status) ? { status: status as never } : {}),
    ...(bookingSearchWhere(q) ?? {}),
  };
  const [total, rows] = await Promise.all([
    prisma.booking.count({ where }),
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        session: { select: { startTime: true, service: { select: { title: true, currency: true, influencer: { select: { id: true, name: true } } } } } },
        payments: { select: { status: true, amountMinor: true } },
      },
    }),
  ]);
  return paged(rows, total, page);
}

export async function listAudit(page: number) {
  const [total, rows] = await Promise.all([
    prisma.adminAuditLog.count(),
    prisma.adminAuditLog.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
  ]);
  return paged(rows, total, page);
}

export interface AdministratorRow {
  id: string;
  email: string;
  name: string;
  totpEnabled: boolean;
  lastLoginAt: Date | null;
  disabled: boolean;
}

/** Read-only list of administrator accounts (never includes secrets). */
export async function listAdministrators(): Promise<AdministratorRow[]> {
  const rows = await prisma.adminUser.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, totpEnabledAt: true, lastLoginAt: true, disabledAt: true },
  });
  return rows.map((r) => ({ id: r.id, email: r.email, name: r.name, totpEnabled: r.totpEnabledAt != null, lastLoginAt: r.lastLoginAt, disabled: r.disabledAt != null }));
}

/** How many administrators can currently sign in. With four-eyes payout approval on, fewer than two means nobody can approve. */
export async function activeAdminCount(): Promise<number> {
  return prisma.adminUser.count({ where: { disabledAt: null } });
}
