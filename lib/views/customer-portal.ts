import { loadPortalBookings, resolvePortalToken, type PortalBooking } from "@/lib/customer-portal";

/**
 * The customer portal page ("your bookings"): everything one e-mail address has booked, behind the one-hour link that was e-mailed
 * to that address. Served by GET /api/customer/portal/:token (403 `expired` / 200). A token that is unknown, expired, malformed or of
 * another kind is the same `expired` answer, so the response does not say which. The DTO has no key named like a token: the manage
 * link of an upcoming booking travels as `manageUrl`.
 */
export type CustomerPortalView =
  | { state: "expired" }
  | { state: "ok"; email: string; expiresAt: string; bookings: PortalBooking[]; erasable: number; blocked: number };

export async function loadCustomerPortalView(token: string, now: Date = new Date()): Promise<CustomerPortalView> {
  const access = await resolvePortalToken(token, now);
  if (!access) return { state: "expired" };
  const { bookings, erasable, blocked } = await loadPortalBookings(access.email, now);
  return { state: "ok", email: access.email, expiresAt: access.expiresAt.toISOString(), bookings, erasable, blocked };
}
