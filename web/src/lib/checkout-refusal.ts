/**
 * What the booking page should show when POST /api/checkout refused with 409 ("This hold has expired or the booking is
 * already processed"), decided from what GET /api/bookings/<id> says now (QA-13, doc/10-react-migration-qa-customer.md).
 * The 409 alone is ambiguous: the hold may have ended (clock skew, the expiry job) or the booking may have been paid in
 * another tab. Pure, so it is tested without a browser.
 */
export type CheckoutRefusalOutcome = "paid" | "hold-ended" | "failed" | "unknown";

const PAID = new Set(["PAID", "SCHEDULED", "COMPLETED"]);
const WAITING = new Set(["HELD", "PENDING_PAYMENT"]);

export function checkoutRefusalOutcome(
  status: { status?: unknown; holdExpiresAt?: unknown } | null | undefined,
  now: number,
): CheckoutRefusalOutcome {
  const s = typeof status?.status === "string" ? status.status : null;
  if (!s) return "unknown";
  if (PAID.has(s)) return "paid";
  if (s === "FAILED") return "failed";
  if (s === "EXPIRED" || s === "CANCELLED") return "hold-ended";
  if (WAITING.has(s)) {
    const ends = typeof status?.holdExpiresAt === "string" ? Date.parse(status.holdExpiresAt) : NaN;
    // Still waiting but the hold is over (the expiry job has not run yet): the seat is no longer held.
    if (Number.isNaN(ends) || ends <= now) return "hold-ended";
  }
  return "unknown";
}
