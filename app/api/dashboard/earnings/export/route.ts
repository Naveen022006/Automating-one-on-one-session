import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { toCsv } from "@/lib/dashboard";
import { prisma } from "@/lib/db";
import { EARNINGS_ROW_CAP, parseReportDay } from "@/lib/views/dashboard-params";

// The same day rules as the Earnings page: a real calendar day from 2000-01-01 to 2100-12-31, else that end of the range is open.
function parseDay(value: string | null): Date | null {
  const day = parseReportDay(value);
  return day ? new Date(`${day}T00:00:00.000Z`) : null;
}

// GET /api/dashboard/earnings/export?from=YYYY-MM-DD&to=YYYY-MM-DD -> CSV of captured/refunded payments.
export async function GET(req: Request) {
  const auth = await requireApiAuth();
  if (auth instanceof NextResponse) return auth;
  const params = new URL(req.url).searchParams;
  const from = parseDay(params.get("from"));
  const toDay = parseDay(params.get("to"));
  const to = toDay ? new Date(toDay.getTime() + 86_400_000) : null;

  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ["CAPTURED", "REFUNDED"] },
      booking: { session: { service: { influencerId: auth.influencerId } } },
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: EARNINGS_ROW_CAP,
    include: { booking: { select: { id: true, customerName: true, redactedAt: true, session: { select: { startTime: true, service: { select: { title: true } } } } } } },
  });

  const rows: (string | number | null)[][] = [
    ["paid_at", "booking_id", "customer", "service", "session_start_utc", "currency", "amount", "refunded", "net", "status", "payment_reference"],
    ...payments.map((p) => {
      const refunded = p.refundAmountMinor ?? (p.status === "REFUNDED" ? p.amountMinor : 0);
      return [
        p.createdAt.toISOString(),
        p.booking.id,
        p.booking.redactedAt ? "(erased)" : p.booking.customerName,
        p.booking.session.service.title,
        p.booking.session.startTime.toISOString(),
        p.currency,
        (p.amountMinor / 100).toFixed(2),
        (refunded / 100).toFixed(2),
        ((p.amountMinor - refunded) / 100).toFixed(2),
        p.status,
        p.providerPaymentId,
      ];
    }),
  ];
  const name = `earnings-${parseReportDay(params.get("from")) ?? "all"}-to-${parseReportDay(params.get("to")) ?? "now"}.csv`;
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
