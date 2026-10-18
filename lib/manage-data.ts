import { recordAudit } from "@/lib/admin/audit";
import { buildBookingExport, type PortalExport } from "@/lib/customer-portal";
import { prisma } from "@/lib/db";
import { platformEmailEnabled } from "@/lib/email/providers";
import { reportError } from "@/lib/observability";
import { eraseCustomerData } from "@/lib/privacy";
import { verifySelfServiceToken } from "@/lib/self-service";

/**
 * Data export and erasure of ONE booking through the signed manage link (doc/15, 4.12), for a platform that sends no e-mail.
 *
 * Why only one booking: the manage link is a forwardable bearer link, valid for 30 days, and the e-mail on a booking is never verified
 * (anybody can book with anybody's address). The "find your bookings" portal proves control of a MAILBOX before it shows or erases
 * everything stored about an address with every host; the manage link proves nothing like that, so it must never reach further than the
 * one booking it was issued for: no other bookings of the address, no other hosts. Export is that booking's data with the portal
 * export's field policy; erasure redacts that booking only, honouring the same kept-booking rule as the host's Erase button (an upcoming
 * live session is kept until it is cancelled or over).
 *
 * Where the portal exists (the platform sends e-mail) these endpoints do not: they answer a generic 404, so they cannot be used to get
 * around the mailbox check. Only the signed manage token is accepted (never a portal token, never a booking id); the answers are the
 * generic ones the manage page gives: 403 `expired` for an invalid or expired link, 404 `gone` for a booking that is missing or erased.
 */
export type ManageBookingAccess = { state: "expired" } | { state: "gone" } | { state: "ok"; bookingId: string; email: string; influencerId: string };

export async function resolveManageBooking(token: string | null | undefined): Promise<ManageBookingAccess> {
  // Where the platform sends e-mail the portal is the way; nothing here. Checked first and the same as "no such booking".
  if (platformEmailEnabled()) return { state: "gone" };
  const bookingId = typeof token === "string" ? verifySelfServiceToken(token) : null;
  if (!bookingId) return { state: "expired" };
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { customerEmail: true, redactedAt: true, session: { select: { service: { select: { influencerId: true } } } } },
  });
  if (!booking || booking.redactedAt || !booking.customerEmail) return { state: "gone" };
  return { state: "ok", bookingId, email: booking.customerEmail.trim().toLowerCase(), influencerId: booking.session.service.influencerId };
}

/** The portal export's fields for this one booking. */
export function exportManagedBooking(access: { bookingId: string; email: string }, now: Date = new Date()): Promise<PortalExport> {
  return buildBookingExport(access.bookingId, access.email, now);
}

/** Erases this booking only (never the address's other bookings, at this host or another). `blocked` is 1 when it is an upcoming live session. */
export async function eraseManagedBooking(access: { bookingId: string; email: string; influencerId: string }, now: Date = new Date()): Promise<{ erased: number; blocked: number }> {
  const { erased, blocked } = await eraseCustomerData(access.influencerId, access.email, now, access.bookingId);
  if (erased > 0) {
    try {
      await recordAudit({ adminId: null, email: "system:customer-request" }, { action: "customer.erased", detail: { erased, blocked } });
    } catch (e) {
      reportError(e, { where: "manage-erase-audit" });
    }
  }
  return { erased, blocked };
}
