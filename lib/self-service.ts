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
