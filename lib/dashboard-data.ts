import { parseAnswers } from "@/lib/intake";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { PLATFORM_CANCEL_PREFIX } from "@/lib/refunds";
import { aggregateEarnings, type EarningsPaymentInput, type EarningsSummary } from "@/lib/dashboard";
import { getGoogleStatus, type GoogleConnectionStatus } from "@/lib/google-tokens";

/**
 * Server-side queries behind the dashboard pages. Every query is scoped to one influencer id taken from the login
 * session, never from the request, so one influencer can never read another's data.
 */

const VISIBLE_BOOKING_STATUSES = ["REQUESTED", "PAID", "SCHEDULED", "COMPLETED", "CANCELLED", "FAILED"] as const;
const LIVE = new Set(["PAID", "SCHEDULED", "COMPLETED"]);

export interface MessageView {
  channel: string;
  template: string;
  status: string;
  error: string | null;
  at: string;
}
export interface BookingRow {
  id: string;
  customerName: string;
  customerEmail: string;
  status: string;
  meetLink: string | null;
  lastError: string | null;
  redacted: boolean;
  latestByChannel: MessageView[];
  payment: { status: string; amountMinor: number; currency: string; needsRefund: boolean } | null;
}
export interface SessionRow {
  id: string;
  serviceId: string;
  serviceTitle: string;
  serviceType: "ONE_TO_ONE" | "GROUP";
  durationMin: number;
  startTime: string;
  endTime: string;
  capacity: number;
  seatsFilled: number;
  meetLink: string | null;
  bookings: BookingRow[];
}

function latestPerChannel(messages: { channel: string; template: string; status: string; error: string | null; updatedAt: Date }[]): MessageView[] {
  const seen = new Set<string>();
  const out: MessageView[] = [];
  for (const m of [...messages].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())) {
    if (seen.has(m.channel)) continue;
    seen.add(m.channel);
    out.push({ channel: m.channel, template: m.template, status: m.status, error: m.error, at: m.updatedAt.toISOString() });
  }
  return out;
}

const sessionInclude = {
  service: { select: { id: true, title: true, capacity: true, type: true, durationMin: true } },
  bookings: {
    where: { status: { in: [...VISIBLE_BOOKING_STATUSES] } },
    orderBy: { createdAt: "asc" as const },
    include: {
      messages: { orderBy: { updatedAt: "desc" as const }, take: 30 },
      payments: { orderBy: { createdAt: "desc" as const }, take: 1 },
    },
  },
} satisfies Prisma.SessionInclude;

type SessionWithBookings = Prisma.SessionGetPayload<{ include: typeof sessionInclude }>;

function toSessionRow(s: SessionWithBookings): SessionRow {
  return {
    id: s.id,
    serviceId: s.service.id,
    serviceTitle: s.service.title,
    serviceType: s.service.type,
    durationMin: s.service.durationMin,
    startTime: s.startTime.toISOString(),
    endTime: s.endTime.toISOString(),
    capacity: s.service.capacity,
    seatsFilled: s.bookings.filter((b) => LIVE.has(b.status)).length,
    meetLink: s.meetLink,
    bookings: s.bookings.map((b) => {
      const p = b.payments[0];
      return {
        id: b.id,
        customerName: b.customerName,
        customerEmail: b.customerEmail,
        status: b.status,
        meetLink: b.meetLink ?? s.meetLink,
        lastError: b.lastError,
        redacted: b.redactedAt !== null,
        latestByChannel: latestPerChannel(b.messages),
        payment: p ? { status: p.status, amountMinor: p.amountMinor, currency: p.currency, needsRefund: p.needsRefund } : null,
      };
    }),
  };
}

export type SessionView = "requests" | "upcoming" | "past" | "cancelled" | "attention";

export async function listSessions(influencerId: string, view: SessionView, opts: { page?: number; pageSize?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const pageSize = opts.pageSize ?? 25;
  const page = Math.max(1, opts.page ?? 1);
  const base = { service: { influencerId } };
  const where =
    view === "requests"
      ? { ...base, endTime: { gte: now }, bookings: { some: { status: "REQUESTED" as const, holdExpiresAt: { gt: now } } } }
      : view === "upcoming"
      ? { ...base, endTime: { gte: now }, bookings: { some: { status: { in: ["PAID", "SCHEDULED"] as ("PAID" | "SCHEDULED")[] } } } }
      : view === "past"
        ? { ...base, endTime: { lt: now }, bookings: { some: { status: { in: ["PAID", "SCHEDULED", "COMPLETED", "FAILED"] as ("PAID" | "SCHEDULED" | "COMPLETED" | "FAILED")[] } } } }
        : view === "cancelled"
          ? { ...base, bookings: { some: { status: "CANCELLED" as const } } }
          : {
              ...base,
              OR: [
                { bookings: { some: { status: { in: ["PAID", "SCHEDULED", "FAILED"] as ("PAID" | "SCHEDULED" | "FAILED")[] }, lastError: { not: null } } } },
                { bookings: { some: { payments: { some: { needsRefund: true, status: "CAPTURED" as const } } } } },
                { bookings: { some: { status: "FAILED" as const } } },
              ],
            };
  const [total, rows] = await Promise.all([
    prisma.session.count({ where }),
    prisma.session.findMany({
      where,
      include: sessionInclude,
      orderBy: { startTime: view === "upcoming" ? "asc" : "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return { total, page, pageCount: Math.max(1, Math.ceil(total / pageSize)), sessions: rows.map(toSessionRow) };
}

export interface AttentionItem {
  kind: "google" | "whatsapp" | "booking-request" | "failed-message" | "needs-refund" | "booking-error" | "verify-email";
  title: string;
  detail: string;
  href: string;
}

export interface Overview {
  upcoming: SessionRow[];
  monthEarnings: EarningsSummary;
  sessionsThisWeek: number;
  attention: AttentionItem[];
  google: GoogleConnectionStatus;
}

export async function getOverview(influencerId: string, emailVerified: boolean, now = new Date()): Promise<Overview> {
  const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [upcoming, monthPayments, google, whatsapp, failedMessages, refunds, errored, requests] = await Promise.all([
    prisma.session.findMany({
      where: { service: { influencerId }, startTime: { lt: weekAhead }, endTime: { gte: now }, bookings: { some: { status: { in: ["PAID", "SCHEDULED"] } } } },
      include: sessionInclude,
      orderBy: { startTime: "asc" },
      take: 20,
    }),
    earningsPayments(influencerId, monthStart, null),
    getGoogleStatus(influencerId),
    prisma.whatsAppConnection.findFirst({ where: { influencerId, status: "ERROR" }, select: { lastError: true } }),
    prisma.message.count({
      where: { status: "FAILED", updatedAt: { gte: new Date(now.getTime() - 14 * 86_400_000) }, booking: { session: { service: { influencerId } } } },
    }),
    prisma.payment.count({ where: { needsRefund: true, status: "CAPTURED", booking: { session: { service: { influencerId } } } } }),
    prisma.booking.count({ where: { lastError: { not: null }, status: { in: ["PAID", "SCHEDULED", "FAILED"] }, session: { service: { influencerId } } } }),
    prisma.booking.count({ where: { status: "REQUESTED", holdExpiresAt: { gt: now }, session: { service: { influencerId } } } }),
  ]);

  const attention: AttentionItem[] = [];
  if (!emailVerified) {
    attention.push({ kind: "verify-email", title: "Confirm your email", detail: "Your booking page goes live once your email is confirmed.", href: "/verify-email" });
  }
  if (google.state !== "connected") {
    attention.push({
      kind: "google",
      title: google.state === "reconnect-needed" ? "Reconnect Google Calendar" : "Connect Google Calendar",
      detail:
        google.state === "reconnect-needed"
          ? `Google stopped accepting the connection${google.reason ? `: ${google.reason.replace(/[\s.]+$/, "")}` : ""}. Paid bookings are waiting for their Meet links.`
          : "Meet links are created on your Google Calendar. Connect it before you take bookings.",
      href: "/dashboard/settings#google",
    });
  }
  if (whatsapp) {
    attention.push({
      kind: "whatsapp",
      title: "Reconnect WhatsApp",
      detail: `WhatsApp stopped accepting the connection${whatsapp.lastError ? `: ${whatsapp.lastError}` : ""}. Customer messages are going out by SMS until you reconnect.`,
      href: "/dashboard/settings#whatsapp",
    });
  }
  if (requests > 0) {
    attention.push({ kind: "booking-request", title: `${requests} booking request${requests > 1 ? "s" : ""} to review`, detail: "Customers are waiting for your answer. Approve to let them pay, or decline.", href: "/dashboard/sessions?view=requests" });
  }
  if (refunds > 0) {
    attention.push({ kind: "needs-refund", title: `${refunds} payment${refunds > 1 ? "s" : ""} to refund`, detail: "Cancelled bookings whose payment should be returned.", href: "/dashboard/sessions?view=attention" });
  }
  if (failedMessages > 0) {
    attention.push({ kind: "failed-message", title: `${failedMessages} message${failedMessages > 1 ? "s" : ""} not delivered`, detail: "In the last 14 days. Resend from the session.", href: "/dashboard/messages?status=FAILED" });
  }
  if (errored > 0) {
    attention.push({ kind: "booking-error", title: `${errored} booking${errored > 1 ? "s" : ""} need attention`, detail: "A Meet link or calendar update failed.", href: "/dashboard/sessions?view=attention" });
  }

  return {
    upcoming: upcoming.map(toSessionRow),
    monthEarnings: aggregateEarnings(monthPayments),
    sessionsThisWeek: upcoming.length,
    attention,
    google,
  };
}

/**
 * Captured (and refunded) payments in [from, to), as input for the pure earnings aggregation. `take` reads only the oldest N
 * (the earnings page uses it so a request for a huge range cannot load every payment); without it everything in the range is read.
 */
export async function earningsPayments(influencerId: string, from: Date | null, to: Date | null, opts: { take?: number } = {}): Promise<EarningsPaymentInput[]> {
  const payments = await prisma.payment.findMany({
    where: {
      status: { in: ["CAPTURED", "REFUNDED"] },
      booking: { session: { service: { influencerId } } },
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    },
    include: { booking: { select: { session: { select: { service: { select: { id: true, title: true } } } } } } },
    ...(opts.take ? { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }], take: opts.take } : {}),
  });
  return payments.map((p) => ({
    amountMinor: p.amountMinor,
    currency: p.currency,
    serviceId: p.booking.session.service.id,
    serviceTitle: p.booking.session.service.title,
    refundedMinor: p.refundAmountMinor ?? (p.status === "REFUNDED" ? p.amountMinor : 0),
  }));
}

export interface CustomerRow {
  email: string;
  name: string;
  bookings: number;
  spentByCurrency: { currency: string; amountMinor: number }[];
  lastSession: string | null;
  nextSession: string | null;
}

/**
 * Prisma's `contains` puts the text into a LIKE pattern as it is, so "%" and "_" would act as wildcards (a search for "%" listed
 * everyone) and a trailing backslash would be an invalid pattern. Escaping them makes a search match the characters typed.
 */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

/** Customers aggregated by email across the influencer's bookings (customers have no accounts). */
export async function listCustomers(influencerId: string, query: string | null, now = new Date()): Promise<CustomerRow[]> {
  const q = query?.trim().toLowerCase();
  const bookings = await prisma.booking.findMany({
    where: {
      redactedAt: null,
      status: { in: ["PAID", "SCHEDULED", "COMPLETED", "CANCELLED"] },
      session: { service: { influencerId } },
      ...(q ? { OR: [{ customerEmail: { contains: likeLiteral(q) } }, { customerName: { contains: likeLiteral(q), mode: "insensitive" as const } }] } : {}),
    },
    select: {
      customerEmail: true,
      customerName: true,
      status: true,
      session: { select: { startTime: true } },
      payments: { where: { status: "CAPTURED" }, select: { amountMinor: true, currency: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });
  const map = new Map<string, CustomerRow & { spent: Map<string, number> }>();
  for (const b of bookings) {
    const row =
      map.get(b.customerEmail) ??
      { email: b.customerEmail, name: b.customerName, bookings: 0, spentByCurrency: [], lastSession: null, nextSession: null, spent: new Map<string, number>() };
    row.bookings += 1;
    for (const p of b.payments) row.spent.set(p.currency, (row.spent.get(p.currency) ?? 0) + p.amountMinor);
    const t = b.session.startTime.toISOString();
    if (b.status !== "CANCELLED") {
      if (b.session.startTime < now) row.lastSession = !row.lastSession || t > row.lastSession ? t : row.lastSession;
      else row.nextSession = !row.nextSession || t < row.nextSession ? t : row.nextSession;
    }
    map.set(b.customerEmail, row);
  }
  return [...map.values()]
    .map(({ spent, ...r }) => ({ ...r, spentByCurrency: [...spent].map(([currency, amountMinor]) => ({ currency, amountMinor })) }))
    .sort((a, b) => (b.nextSession ?? b.lastSession ?? "").localeCompare(a.nextSession ?? a.lastSession ?? ""));
}

export async function listMessages(influencerId: string, opts: { status?: string | null; page?: number; pageSize?: number } = {}) {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(1, opts.page ?? 1);
  const statuses = ["PENDING", "SENT", "DELIVERED", "READ", "FAILED"];
  const where = {
    booking: { session: { service: { influencerId } } },
    channel: { in: ["WHATSAPP", "WHATSAPP_WEB", "SMS", "EMAIL"] as ("WHATSAPP" | "WHATSAPP_WEB" | "SMS" | "EMAIL")[] },
    ...(opts.status && statuses.includes(opts.status) ? { status: opts.status as "PENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED" } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { booking: { select: { id: true, customerName: true, session: { select: { startTime: true, service: { select: { title: true } } } } } } },
    }),
  ]);
  return {
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    messages: rows.map((m) => ({
      id: m.id,
      bookingId: m.booking.id,
      customerName: m.booking.customerName,
      serviceTitle: m.booking.session.service.title,
      sessionStart: m.booking.session.startTime.toISOString(),
      channel: m.channel,
      template: m.template,
      status: m.status,
      error: m.error,
      at: m.updatedAt.toISOString(),
    })),
  };
}

/** Full detail for the booking drawer. Null when the booking does not belong to the influencer. */
export async function getBookingDetail(influencerId: string, bookingId: string) {
  const b = await prisma.booking.findFirst({
    where: { id: bookingId, session: { service: { influencerId } } },
    include: {
      session: { include: { service: { select: { id: true, title: true, type: true, durationMin: true, refundPolicy: true, priceMinor: true, currency: true } } } },
      payments: { orderBy: { createdAt: "desc" } },
      messages: { orderBy: { updatedAt: "desc" } },
    },
  });
  if (!b) return null;
  return {
    id: b.id,
    status: b.status,
    customerName: b.customerName,
    customerEmail: b.customerEmail,
    whatsapp: b.whatsappE164,
    whatsappOptIn: b.whatsappOptIn,
    customerTz: b.customerTz,
    requestExpiresAt: b.status === "REQUESTED" ? (b.holdExpiresAt?.toISOString() ?? null) : null,
    declineReason: b.declineReason,
    intakeAnswers: parseAnswers(b.intakeAnswers),
    redacted: b.redactedAt !== null,
    meetLink: b.meetLink ?? b.session.meetLink,
    lastError: b.lastError,
    createdAt: b.createdAt.toISOString(),
    session: {
      id: b.session.id,
      serviceId: b.session.service.id,
      startTime: b.session.startTime.toISOString(),
      endTime: b.session.endTime.toISOString(),
      serviceTitle: b.session.service.title,
      serviceType: b.session.service.type,
      durationMin: b.session.service.durationMin,
      // The policy the customer booked under (snapshot), falling back to the service's for older bookings.
      refundPolicy: b.refundPolicy ?? b.session.service.refundPolicy,
    },
    payments: b.payments.map((p) => ({
      id: p.id,
      status: p.status,
      amountMinor: p.amountMinor,
      currency: p.currency,
      needsRefund: p.needsRefund,
      providerPaymentId: p.providerPaymentId,
      // The system marker of a platform cancel is not for the host to read.
      failureReason: p.failureReason?.startsWith(PLATFORM_CANCEL_PREFIX) ? p.failureReason.slice(PLATFORM_CANCEL_PREFIX.length) : p.failureReason,
      refundStatus: p.refundStatus,
      refundAmountMinor: p.refundAmountMinor,
      refundedAt: p.refundedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    messages: b.messages.map((m) => ({
      id: m.id,
      channel: m.channel,
      template: m.template,
      status: m.status,
      error: m.error,
      at: m.updatedAt.toISOString(),
    })),
  };
}

export type BookingDetail = NonNullable<Awaited<ReturnType<typeof getBookingDetail>>>;
