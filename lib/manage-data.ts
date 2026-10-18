import { prisma } from "@/lib/db";
import { verifySelfServiceToken } from "@/lib/self-service";

/**
 * Customer data export and erasure through the signed manage link (doc/15, 4.12). The "find your bookings" portal proves control of a
 * mailbox by e-mailing a link, which a platform without e-mail cannot do. The manage link already proves the holder was given that
 * booking's link, so with the platform's e-mail off it is the customer's way to the same two things the portal offers: the booking
 * customer's data (keyed by the booking's customer e-mail, exactly as the portal's export and erasure are, lib/customer-portal.ts) and its
 * erasure (lib/privacy.ts rules: upcoming sessions stay until cancelled, payment records stay for accounting).
 *
 * Only the signed manage token is accepted (never a portal token, never a booking id), and both answers are the same generic ones the
 * manage page gives: 403 `expired` for a link that is invalid or expired, 404 `gone` for a booking that is missing or was erased.
 */
export type ManageCustomer = { state: "expired" } | { state: "gone" } | { state: "ok"; email: string };

export async function resolveManageCustomer(token: string | null | undefined): Promise<ManageCustomer> {
  const bookingId = typeof token === "string" ? verifySelfServiceToken(token) : null;
  if (!bookingId) return { state: "expired" };
  const booking = await prisma.booking.findUnique({ where: { id: bookingId }, select: { customerEmail: true, redactedAt: true } });
  if (!booking || booking.redactedAt || !booking.customerEmail) return { state: "gone" };
  return { state: "ok", email: booking.customerEmail.trim().toLowerCase() };
}
