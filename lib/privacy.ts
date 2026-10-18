import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requestContactPrune } from "@/lib/whatsapp-web/prune-requests";

/**
 * The ONE definition of "this booking still has a session to deliver": its status holds a seat (a pending request, a hold, a payment
 * in progress, a paid or scheduled session) and the session is not over yet. Such a booking is NOT erased (the session would break; the
 * customer or host cancels it first). The customer portal (lib/customer-portal.ts) imports this list, so the host's Erase button and the
 * customer's cannot disagree; tests/customer-portal.test.ts pins that.
 */
export const KEPT_BOOKING_STATUSES: readonly string[] = ["REQUESTED", "HELD", "PENDING_PAYMENT", "PAID", "SCHEDULED"];

export function isKeptBooking(b: { status: string; session: { endTime: Date } }, now: Date): boolean {
  return KEPT_BOOKING_STATUSES.includes(b.status) && b.session.endTime > now;
}

/**
 * Erases a customer's personal data (name, email, phone, timezone) from one influencer's bookings, on the
 * customer's request. Payment rows are kept (amounts, provider ids) because they are accounting records; the
 * booking keeps its id, status and times so earnings stay correct. Bookings that are still upcoming and live are
 * NOT erased (the session would break); they must be cancelled first.
 *
 * Retention note (also in the privacy policy): booking contact details are needed to deliver the session; after
 * the session they are kept for support and accounting until the customer or influencer asks for erasure.
 */
export async function eraseCustomerData(
  influencerId: string,
  emailInput: string,
  now = new Date(),
): Promise<{ found: number; erased: number; blocked: number }> {
  const email = emailInput.trim().toLowerCase();
  const bookings = await prisma.booking.findMany({
    where: { customerEmail: email, redactedAt: null, session: { service: { influencerId } } },
    select: { id: true, status: true, whatsappE164: true, session: { select: { endTime: true } } },
  });
  const erasable = bookings.filter((b) => !isKeptBooking(b, now));

  let erased = 0;
  for (const b of erasable) {
    // Conditional on the booking still being un-erased, and counted only when this call changed it: two simultaneous erasures
    // (two tabs, or the host and the customer) never both report, audit or e-mail the same booking.
    const changed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.booking.updateMany({
        where: { id: b.id, redactedAt: null },
        data: {
          customerName: "Erased customer",
          customerEmail: `erased+${b.id}@invalid.invalid`,
          whatsappE164: "",
          whatsappOptIn: false,
          customerTz: null,
          lastError: null,
          intakeAnswers: Prisma.DbNull,
          redactedAt: now,
        },
      });
      if (count === 0) return 0;
      await tx.message.updateMany({ where: { bookingId: b.id }, data: { error: null } });
      return count;
    });
    erased += changed;
  }
  // The linked WhatsApp (if the influencer has one) keeps per-contact keys named after the customer's phone number: ask the worker to
  // forget them. Best effort and never part of the erasure's outcome; the worker also clears every contact without a booking every few hours.
  if (erased > 0) await requestContactPrune(influencerId, erasable.map((b) => b.whatsappE164));
  return { found: bookings.length, erased, blocked: bookings.length - erasable.length };
}
