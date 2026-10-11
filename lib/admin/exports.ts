import { prisma } from "@/lib/db";
import { parseReportDay } from "@/lib/views/dashboard-params";

/**
 * Administrator CSV exports (payments, bookings, payouts, audit). One function per kind returns the whole file as rows (a header row
 * first); the route turns them into CSV with `toCsv`, which neutralises spreadsheet formulas (a cell starting with = + - @ tab or CR).
 *
 * What goes in a file is decided here, column by column, from a `select` of exactly those columns: never a spread row, so a column that
 * is added to a table later cannot leak into an export. No phone numbers, intake answers, Meet links, tokens, hashes, encrypted values
 * or full bank numbers (a payout's destination is the masked label stored with it). Money is written as decimals (minor / 100, the
 * convention of the influencer earnings export), timestamps as ISO 8601 UTC, an erased customer as "(erased)" with no e-mail.
 */

/** The most rows one export may hold. Over it the request is refused (an honest 400), never silently cut. */
export const ADMIN_EXPORT_ROW_CAP = 20_000;
/** The longest date range one export may cover, in days (both ends included). */
export const ADMIN_EXPORT_MAX_DAYS = 366;

export const EXPORT_KINDS = ["payments", "bookings", "payouts", "audit"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: string): value is ExportKind {
  return (EXPORT_KINDS as readonly string[]).includes(value);
}

export type ExportRow = (string | number | null)[];

export class ExportTooLargeError extends Error {
  constructor(cap: number) {
    super(`More than ${cap.toLocaleString("en-US")} rows. Choose a shorter range.`);
  }
}

const DAY_MS = 86_400_000;

export interface ExportRange {
  /** YYYY-MM-DD, both ends included. */
  from: string;
  to: string;
  /** `from` at 00:00 UTC (inclusive) and the day after `to` at 00:00 UTC (exclusive): the bounds of `createdAt`. */
  start: Date;
  end: Date;
}

/**
 * `?from=` / `?to=` of an export. Missing: the 1st of the month of `to` (or of today) up to today (UTC). Present but not a real
 * calendar day (parseReportDay), `from` after `to`, or more than 366 days: a message for a 400.
 */
export function parseExportRange(params: URLSearchParams, now: Date = new Date()): { ok: true; range: ExportRange } | { ok: false; error: string } {
  const today = now.toISOString().slice(0, 10);
  const rawFrom = params.get("from");
  const rawTo = params.get("to");
  const to = rawTo === null || rawTo === "" ? today : parseReportDay(rawTo);
  if (!to) return { ok: false, error: "Enter the end date as YYYY-MM-DD." };
  const from = rawFrom === null || rawFrom === "" ? `${to.slice(0, 7)}-01` : parseReportDay(rawFrom);
  if (!from) return { ok: false, error: "Enter the start date as YYYY-MM-DD." };
  const start = new Date(`${from}T00:00:00.000Z`);
  const last = new Date(`${to}T00:00:00.000Z`);
  if (start.getTime() > last.getTime()) return { ok: false, error: "The start date is after the end date." };
  const days = Math.round((last.getTime() - start.getTime()) / DAY_MS) + 1;
  if (days > ADMIN_EXPORT_MAX_DAYS) return { ok: false, error: `Choose a range of at most ${ADMIN_EXPORT_MAX_DAYS} days.` };
  return { ok: true, range: { from, to, start, end: new Date(last.getTime() + DAY_MS) } };
}

export function exportFilename(kind: ExportKind, range: Pick<ExportRange, "from" | "to">): string {
  return `${kind}-${range.from}-to-${range.to}.csv`;
}

const money = (minor: number) => (minor / 100).toFixed(2);
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "");
const yesNo = (v: boolean) => (v ? "yes" : "no");
/** An erased customer's name is replaced by a marker (the stored placeholder name is not exported). */
const customerName = (b: { redactedAt: Date | null; customerName: string }) => (b.redactedAt ? "(erased)" : b.customerName);

/** Counts first, then reads at most one row more than the cap, so a row added in between still cannot push a file over it. */
async function capped<T>(count: () => Promise<number>, read: (take: number) => Promise<T[]>, cap: number): Promise<T[]> {
  if ((await count()) > cap) throw new ExportTooLargeError(cap);
  const rows = await read(cap + 1);
  if (rows.length > cap) throw new ExportTooLargeError(cap);
  return rows;
}

const PAYMENT_HEADER = [
  "created_at", "payment_id", "provider_payment_id", "provider_order_id", "status", "amount", "refunded", "currency", "needs_refund",
  "refund_status", "reconciled_at", "reconciled_by", "payout_id", "booking_id", "booking_status", "influencer_slug", "influencer_name",
  "service_title", "session_start", "customer_name",
];

export async function exportPayments(range: ExportRange, cap = ADMIN_EXPORT_ROW_CAP): Promise<ExportRow[]> {
  const where = { createdAt: { gte: range.start, lt: range.end } };
  const payments = await capped(
    () => prisma.payment.count({ where }),
    (take) =>
      prisma.payment.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          createdAt: true,
          providerPaymentId: true,
          providerOrderId: true,
          status: true,
          amountMinor: true,
          refundAmountMinor: true,
          currency: true,
          needsRefund: true,
          refundStatus: true,
          reconciledAt: true,
          reconciledByEmail: true,
          payoutId: true,
          booking: {
            select: {
              id: true,
              status: true,
              customerName: true,
              redactedAt: true,
              session: { select: { startTime: true, service: { select: { title: true, influencer: { select: { slug: true, name: true } } } } } },
            },
          },
        },
      }),
    cap,
  );
  return [
    PAYMENT_HEADER,
    // A payment deleted together with its booking (a cascade) while the file is being read has no relations any more: it is left out.
    ...payments
      .filter((p) => p.booking?.session?.service?.influencer)
      .map((p) => {
        const refunded = p.refundAmountMinor ?? (p.status === "REFUNDED" ? p.amountMinor : 0);
        const svc = p.booking.session.service;
        return [
          iso(p.createdAt),
          p.id,
          p.providerPaymentId,
          p.providerOrderId,
          p.status,
          money(p.amountMinor),
          money(refunded),
          p.currency,
          yesNo(p.needsRefund),
          p.refundStatus,
          iso(p.reconciledAt),
          p.reconciledByEmail,
          p.payoutId,
          p.booking.id,
          p.booking.status,
          svc.influencer.slug,
          svc.influencer.name,
          svc.title,
          iso(p.booking.session.startTime),
          customerName(p.booking),
        ];
      }),
  ];
}

const BOOKING_HEADER = [
  "created_at", "booking_id", "status", "influencer_slug", "service_title", "service_type", "session_start", "customer_name",
  "customer_email", "paid", "refunded", "currency", "meet_link_created",
];

export async function exportBookings(range: ExportRange, cap = ADMIN_EXPORT_ROW_CAP): Promise<ExportRow[]> {
  const where = { createdAt: { gte: range.start, lt: range.end } };
  const bookings = await capped(
    () => prisma.booking.count({ where }),
    (take) =>
      prisma.booking.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          createdAt: true,
          status: true,
          customerName: true,
          customerEmail: true,
          redactedAt: true,
          meetLink: true,
          session: { select: { startTime: true, meetLink: true, service: { select: { title: true, type: true, currency: true, influencer: { select: { slug: true } } } } } },
          payments: { where: { status: { in: ["CAPTURED", "REFUNDED"] } }, select: { status: true, amountMinor: true, refundAmountMinor: true } },
        },
      }),
    cap,
  );
  return [
    BOOKING_HEADER,
    ...bookings
      .filter((b) => b.session?.service?.influencer)
      .map((b) => {
        const svc = b.session.service;
        const paid = b.payments.reduce((n, p) => n + p.amountMinor, 0);
        const refunded = b.payments.reduce((n, p) => n + (p.refundAmountMinor ?? (p.status === "REFUNDED" ? p.amountMinor : 0)), 0);
        return [
          iso(b.createdAt),
          b.id,
          b.status,
          svc.influencer.slug,
          svc.title,
          svc.type,
          iso(b.session.startTime),
          customerName(b),
          b.redactedAt ? "" : b.customerEmail,
          money(paid),
          money(refunded),
          svc.currency,
          // Whether a Meet link exists (the booking's own, or the shared one of a group session). Never the URL.
          yesNo(Boolean(b.meetLink || b.session.meetLink)),
        ];
      }),
  ];
}

const PAYOUT_HEADER = [
  "created_at", "payout_id", "influencer_slug", "status", "currency", "gross", "refunds", "fee_bps", "fee", "net", "payment_count",
  "destination", "reference", "created_by", "approved_by", "approved_at", "paid_by", "paid_at",
];

export async function exportPayouts(range: ExportRange, cap = ADMIN_EXPORT_ROW_CAP): Promise<ExportRow[]> {
  const where = { createdAt: { gte: range.start, lt: range.end } };
  const payouts = await capped(
    () => prisma.payout.count({ where }),
    (take) =>
      prisma.payout.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: {
          id: true,
          createdAt: true,
          status: true,
          currency: true,
          grossMinor: true,
          refundsMinor: true,
          feeBps: true,
          feeMinor: true,
          netMinor: true,
          paymentCount: true,
          destination: true,
          reference: true,
          createdByEmail: true,
          approvedByEmail: true,
          approvedAt: true,
          paidByEmail: true,
          paidAt: true,
          influencer: { select: { slug: true } },
        },
      }),
    cap,
  );
  return [
    PAYOUT_HEADER,
    ...payouts
      .filter((p) => p.influencer)
      .map((p) => [
        iso(p.createdAt),
        p.id,
        p.influencer.slug,
        p.status,
        p.currency,
        money(p.grossMinor),
        money(p.refundsMinor),
        p.feeBps,
        money(p.feeMinor),
        money(p.netMinor),
        p.paymentCount,
        p.destination,
        p.reference,
        p.createdByEmail,
        p.approvedByEmail,
        iso(p.approvedAt),
        p.paidByEmail,
        iso(p.paidAt),
      ]),
  ];
}

const AUDIT_HEADER = ["created_at", "admin_email", "action", "target_type", "target_id", "ip"];

/** The audit log without its free-form `detail` column, like the audit page. */
export async function exportAudit(range: ExportRange, cap = ADMIN_EXPORT_ROW_CAP): Promise<ExportRow[]> {
  const where = { createdAt: { gte: range.start, lt: range.end } };
  const entries = await capped(
    () => prisma.adminAuditLog.count({ where }),
    (take) =>
      prisma.adminAuditLog.findMany({
        where,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take,
        select: { createdAt: true, adminEmail: true, action: true, targetType: true, targetId: true, ip: true },
      }),
    cap,
  );
  return [AUDIT_HEADER, ...entries.map((a) => [iso(a.createdAt), a.adminEmail, a.action, a.targetType, a.targetId, a.ip])];
}

/** The whole file for one kind: a header row, then the data rows. Sequential queries only (the database has a small connection cap). */
export async function buildExport(kind: ExportKind, range: ExportRange, opts: { rowCap?: number } = {}): Promise<ExportRow[]> {
  const cap = opts.rowCap ?? ADMIN_EXPORT_ROW_CAP;
  switch (kind) {
    case "payments":
      return exportPayments(range, cap);
    case "bookings":
      return exportBookings(range, cap);
    case "payouts":
      return exportPayouts(range, cap);
    case "audit":
      return exportAudit(range, cap);
  }
}
