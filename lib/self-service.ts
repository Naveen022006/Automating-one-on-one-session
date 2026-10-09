import { signToken, verifyToken } from "@/lib/signing";

/**
 * Signed, expiring link that lets a customer manage their OWN booking (reschedule / cancel) without a login.
 * The purpose string is DISTINCT from the influencer dashboard link (DASHBOARD_LINK_PURPOSE in lib/dashboard.ts)
 * and the Google connect link, so a token minted for one use can never authorise another. The payload carries
 * the booking id. Kept in its own module (no DB/email imports) so lib/email.ts can embed the link in the
 * confirmation without an import cycle through lib/manage.ts.
 */
export const SELF_SERVICE_PURPOSE = "customer-self-service";

export function buildSelfServiceUrl(bookingId: string, ttlSec = 30 * 86_400): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");
  const t = signToken(SELF_SERVICE_PURPOSE, { b: bookingId }, ttlSec);
  return `${appUrl.replace(/\/$/, "")}/manage/${encodeURIComponent(t)}`;
}

/** Returns the booking id a valid, unexpired self-service token points at, or null. */
export function verifySelfServiceToken(token: string | null | undefined): string | null {
  const data = verifyToken<{ b: string }>(SELF_SERVICE_PURPOSE, token);
  return data?.b ?? null;
}

/**
 * Short-lived token handed to the browser that created a hold, so only that browser's confirmation page receives
 * the self-service link from GET /api/bookings/[id] (the booking id alone is shown as a reference and may be
 * shared with support). Distinct purpose, so it can never be used as a self-service token itself.
 */
export const BOOKING_POLL_PURPOSE = "booking-confirmation-poll";

export function signBookingPollToken(bookingId: string, ttlSec = 2 * 3_600): string {
  return signToken(BOOKING_POLL_PURPOSE, { b: bookingId }, ttlSec);
}

export function verifyBookingPollToken(bookingId: string, token: string | null | undefined): boolean {
  return verifyToken<{ b: string }>(BOOKING_POLL_PURPOSE, token)?.b === bookingId;
}

/**
 * Link sent to a customer once the influencer approves their request: it opens the payment page for that booking.
 * Distinct purpose, so it cannot be used as a self-service or poll token. It expires with the payment window.
 */
export const BOOKING_PAY_PURPOSE = "booking-pay";

export function buildPayUrl(bookingId: string, ttlSec: number): string {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error("APP_URL is not set");
  const t = signToken(BOOKING_PAY_PURPOSE, { b: bookingId }, Math.max(60, Math.floor(ttlSec)));
  return `${appUrl.replace(/\/$/, "")}/pay/${encodeURIComponent(t)}`;
}

export function verifyPayToken(token: string | null | undefined): string | null {
  return verifyToken<{ b: string }>(BOOKING_PAY_PURPOSE, token)?.b ?? null;
}
