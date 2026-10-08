import { prisma } from "@/lib/db";
import { PAYMENT_WINDOW_MINUTES } from "@/lib/holds";
import { createOrder, razorpayKeyId } from "@/lib/payments";

export class BookingNotFoundError extends Error {}
/** The booking is not in a state where it can be paid (hold expired, already paid, cancelled...). */
export class NotPayableError extends Error {}

export interface CheckoutResult {
  bookingId: string;
  keyId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  holdExpiresAt: Date;
  customer: { name: string; email: string; contact: string };
}

/**
 * Starts (or resumes) payment for a held booking. The booking row is locked so a double click cannot
 * create two orders; a second call returns the existing open order.
 */
export async function startCheckout(bookingId: string): Promise<CheckoutResult> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
      if (locked.length === 0) throw new BookingNotFoundError("Booking not found");

      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { session: { include: { service: true } } },
      });
      const now = new Date();
      const payable =
        (booking.status === "HELD" || booking.status === "PENDING_PAYMENT") &&
        booking.holdExpiresAt !== null &&
        booking.holdExpiresAt > now;
      if (!payable) throw new NotPayableError("This hold has expired or the booking is already processed");

      const service = booking.session.service;
      const customer = { name: booking.customerName, email: booking.customerEmail, contact: booking.whatsappE164 };

      // Extend (never shorten) the hold so the seat stays reserved while the customer pays.
      const windowEnd = new Date(now.getTime() + PAYMENT_WINDOW_MINUTES * 60_000);
      const holdExpiresAt = booking.holdExpiresAt! > windowEnd ? booking.holdExpiresAt! : windowEnd;
      await tx.booking.update({ where: { id: bookingId }, data: { status: "PENDING_PAYMENT", holdExpiresAt } });

      const open = await tx.payment.findFirst({
        where: { bookingId, status: "CREATED" },
        orderBy: { createdAt: "desc" },
      });
      if (open) {
        return {
          bookingId,
          keyId: razorpayKeyId(),
          orderId: open.providerOrderId,
          amountMinor: open.amountMinor,
          currency: open.currency,
          holdExpiresAt,
          customer,
        };
      }

      // The amount always comes from the service row, never from the client.
      const order = await createOrder({
        amountMinor: service.priceMinor,
        currency: service.currency,
        receipt: bookingId,
        notes: { bookingId },
      });
      await tx.payment.create({
        data: {
          bookingId,
          providerOrderId: order.id,
          amountMinor: service.priceMinor,
          currency: service.currency,
        },
      });
      return {
        bookingId,
        keyId: razorpayKeyId(),
        orderId: order.id,
        amountMinor: service.priceMinor,
        currency: service.currency,
        holdExpiresAt,
        customer,
      };
    },
    { timeout: 15_000 },
  );
}
