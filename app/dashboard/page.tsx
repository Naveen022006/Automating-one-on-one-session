import { prisma } from "@/lib/db";
import { DASHBOARD_LINK_PURPOSE, aggregateEarnings, type EarningsPaymentInput } from "@/lib/dashboard";
import { verifyToken } from "@/lib/signing";
import {
  Dashboard,
  type DashboardData,
  type RuleView,
  type ServiceAdminView,
  type SessionView,
} from "./Dashboard";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>;
}) {
  const { t } = await searchParams;
  // Gate before anything is loaded or shown: an invalid/expired token is a 403, matching the connect route.
  const link = verifyToken<{ i: string }>(DASHBOARD_LINK_PURPOSE, t);
  if (!link) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p className="error" role="alert">
          This dashboard link is invalid or has expired (403).
        </p>
      </main>
    );
  }

  const influencer = await prisma.influencer.findUnique({
    where: { id: link.i },
    select: { id: true, name: true, timezone: true },
  });
  if (!influencer) {
    return (
      <main>
        <h1>Dashboard</h1>
        <p className="error" role="alert">
          Influencer not found (404).
        </p>
      </main>
    );
  }

  // Statuses that occupy a seat / represent a real customer for the dashboard. Holds and dead-ends are hidden.
  const VISIBLE_BOOKING_STATUSES = ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED"] as const;

  const sessions = await prisma.session.findMany({
    where: { service: { influencerId: influencer.id } },
    include: {
      service: { select: { id: true, title: true, capacity: true, type: true, currency: true } },
      bookings: {
        where: { status: { in: [...VISIBLE_BOOKING_STATUSES] } },
        orderBy: { createdAt: "asc" },
        include: {
          // Load recent messages newest-first and reduce to the latest row PER CHANNEL below, so a later
          // 'queued' whatsapp row cannot visually mask an earlier 'failed' email row on the same booking.
          messages: { orderBy: { createdAt: "desc" }, take: 20 },
        },
      },
    },
    orderBy: { startTime: "asc" },
  });

  // CAPTURED payments drive earnings. One query, aggregated by the pure helper.
  const payments = await prisma.payment.findMany({
    where: {
      status: "CAPTURED",
      booking: { session: { service: { influencerId: influencer.id } } },
    },
    include: {
      booking: { select: { session: { select: { service: { select: { id: true, title: true } } } } } },
    },
  });

  const earningsInput: EarningsPaymentInput[] = payments.map((p) => ({
    amountMinor: p.amountMinor,
    currency: p.currency,
    serviceId: p.booking.session.service.id,
    serviceTitle: p.booking.session.service.title,
  }));

  // Everything the management UI needs: the influencer's services, weekly availability rules and blocked days.
  const [services, rules, blockedDates] = await Promise.all([
    prisma.service.findMany({ where: { influencerId: influencer.id }, orderBy: { createdAt: "asc" } }),
    prisma.availabilityRule.findMany({ where: { influencerId: influencer.id }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] }),
    prisma.blockedDate.findMany({ where: { influencerId: influencer.id }, orderBy: { date: "asc" } }),
  ]);

  const serviceViews: ServiceAdminView[] = services.map((s) => ({
    id: s.id,
    title: s.title,
    description: s.description,
    durationMin: s.durationMin,
    priceMinor: s.priceMinor,
    currency: s.currency,
    type: s.type,
    capacity: s.capacity,
    active: s.active,
  }));
  const ruleViews: RuleView[] = rules.map((r) => ({
    id: r.id,
    weekday: r.weekday,
    startTime: r.startTime,
    endTime: r.endTime,
    timezone: r.timezone,
  }));
  const blockedViews = blockedDates.map((b) => ({
    id: b.id,
    date: b.date.toISOString().slice(0, 10),
    reason: b.reason,
  }));

  // Reduce a booking's messages (ordered newest-first) to the latest row per channel, so each channel's true
  // current status is shown rather than only the single most recent row across all channels.
  const latestPerChannel = (
    messages: { channel: string; template: string; status: string }[],
  ): { channel: string; template: string; status: string }[] => {
    const seen = new Set<string>();
    const out: { channel: string; template: string; status: string }[] = [];
    for (const m of messages) {
      if (seen.has(m.channel)) continue;
      seen.add(m.channel);
      out.push({ channel: m.channel, template: m.template, status: m.status });
    }
    return out;
  };

  const now = Date.now();
  const toView = (s: (typeof sessions)[number]): SessionView => {
    const seatsFilled = s.bookings.filter((b) => b.status !== "CANCELLED" && b.status !== "FAILED").length;
    return {
      id: s.id,
      serviceTitle: s.service.title,
      serviceType: s.service.type,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime.toISOString(),
      capacity: s.service.capacity,
      seatsFilled,
      meetLink: s.meetLink,
      bookings: s.bookings.map((b) => ({
        id: b.id,
        customerName: b.customerName,
        status: b.status,
        meetLink: b.meetLink,
        lastError: b.lastError,
        // One row per channel (the latest for that channel), newest channel first. messages are already
        // ordered createdAt desc, so the first time a channel is seen is its latest status.
        messages: latestPerChannel(b.messages),
      })),
    };
  };

  const upcoming = sessions.filter((s) => s.endTime.getTime() >= now).map(toView);
  const past = sessions
    .filter((s) => s.endTime.getTime() < now)
    .map(toView)
    .reverse(); // most recent first

  const data: DashboardData = {
    influencerName: influencer.name,
    // The signed token is passed through so FEAT-004 can attach manual actions (resend/cancel/reschedule)
    // to the client component without re-minting or restructuring. Read-only in this feature.
    token: t ?? "",
    upcoming,
    past,
    earnings: aggregateEarnings(earningsInput),
    services: serviceViews,
    rules: ruleViews,
    blockedDates: blockedViews,
    influencerTimezone: influencer.timezone,
  };

  return <Dashboard data={data} />;
}
