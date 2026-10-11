import { prisma } from "@/lib/db";
import { formatMoney, formatSessionTime } from "@/lib/format";
import { buildSelfServiceUrl, signBookingPollToken, verifyPayToken } from "@/lib/self-service";
import { decodeSpaParam } from "@/lib/spa/routes";

/**
 * The page behind the payment link emailed after an influencer approves a booking request. One function, two callers:
 * the old Next page (app/pay/[token]/page.tsx) and GET /api/pay/:token for the SPA, so they cannot disagree.
 *
 * The signed link only identifies the booking; what can be done depends on the booking's state when the page loads, so
 * the answer is a union by `state` and is always a normal 200 (an invalid link is a screen, not an HTTP error). The
 * texts that depend on the server's locale and the customer's time zone (`whenText`, `amountText`, `payByText`) are
 * formatted here, exactly as the page always did. Nothing about the customer (name, email, phone) is part of it.
 */
export type PayView =
  | { state: "invalid" }
  | { state: "not-found" }
  | { state: "booked"; serviceTitle: string; hostName: string; whenText: string; manageUrl: string | null }
  | { state: "requested"; hostName: string; serviceTitle: string }
  | { state: "declined"; hostName: string; hostSlug: string }
  | { state: "expired"; hostSlug: string }
  | {
      state: "payable";
      bookingId: string;
      /** Lets the browser that opens this page poll the booking after payment (the same token the booking flow gets). */
      pollToken: string;
      hostName: string;
      serviceTitle: string;
      whenText: string;
      amountText: string;
      payByText: string;
      prepNotes: string | null;
    };

/** `token` as it appears in the URL path (still percent-encoded, or already decoded: both work). */
export async function loadPayView(token: string): Promise<PayView> {
  const bookingId = verifyPayToken(decodeSpaParam(token));
  if (!bookingId) return { state: "invalid" };
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: { session: { include: { service: { include: { influencer: { select: { name: true, slug: true, timezone: true } } } } } } },
  });
  // A booking erased on request is as good as missing here too (as in the manage view): its customer asked to be forgotten, and
  // the "already booked" answer would mint a fresh 30-day manage link for it.
  if (!booking || booking.redactedAt) return { state: "not-found" };
  const { service } = booking.session;
  const host = service.influencer;
  const tz = booking.customerTz ?? host.timezone;
  const when = formatSessionTime(booking.session.startTime, tz);
  const now = new Date();

  if (["PAID", "SCHEDULED", "COMPLETED"].includes(booking.status)) {
    let manageUrl: string | null = null;
    try {
      manageUrl = buildSelfServiceUrl(booking.id);
    } catch {
      manageUrl = null;
    }
    return { state: "booked", serviceTitle: service.title, hostName: host.name, whenText: when, manageUrl };
  }
  if (booking.status === "REQUESTED") return { state: "requested", hostName: host.name, serviceTitle: service.title };
  if (booking.status === "CANCELLED") return { state: "declined", hostName: host.name, hostSlug: host.slug };
  const payable = (booking.status === "HELD" || booking.status === "PENDING_PAYMENT") && booking.holdExpiresAt !== null && booking.holdExpiresAt > now;
  if (!payable) return { state: "expired", hostSlug: host.slug };

  return {
    state: "payable",
    bookingId: booking.id,
    pollToken: signBookingPollToken(booking.id),
    hostName: host.name,
    serviceTitle: service.title,
    whenText: when,
    amountText: formatMoney(service.priceMinor, service.currency),
    payByText: formatSessionTime(booking.holdExpiresAt!, tz),
    prepNotes: service.prepNotes,
  };
}
