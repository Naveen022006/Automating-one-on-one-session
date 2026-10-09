import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

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
    select: { id: true, status: true, session: { select: { endTime: true } } },
  });
  const live = (b: (typeof bookings)[number]) =>
    ["HELD", "PENDING_PAYMENT", "PAID", "SCHEDULED"].includes(b.status) && b.session.endTime > now;
  const erasable = bookings.filter((b) => !live(b));

  for (const b of erasable) {
    await prisma.$transaction([
      prisma.booking.update({
        where: { id: b.id },
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
      }),
      prisma.message.updateMany({ where: { bookingId: b.id }, data: { error: null } }),
    ]);
  }
  return { found: bookings.length, erased: erasable.length, blocked: bookings.length - erasable.length };
}
