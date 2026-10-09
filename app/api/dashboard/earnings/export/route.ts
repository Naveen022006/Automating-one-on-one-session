import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/session";
import { toCsv } from "@/lib/dashboard";
import { prisma } from "@/lib/db";

function parseDay(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
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
    take: 10_000,
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
  const name = `earnings-${params.get("from") ?? "all"}-to-${params.get("to") ?? "now"}.csv`.replace(/[^a-z0-9._-]/gi, "_");
  return new NextResponse(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
