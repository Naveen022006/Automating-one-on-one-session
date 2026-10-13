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
 * create two orders; a second call returns the existing open order and leaves the hold where the first call put it.
 * The caller (app/api/checkout/route.ts) has checked that the request carries the booking's poll token.
 */
export async function startCheckout(bookingId: string): Promise<CheckoutResult> {
  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM bookings WHERE id = ${bookingId} FOR UPDATE`;
      if (locked.length === 0) throw new BookingNotFoundError("Booking not found");
      // Share-lock the host's row before reading it: a suspension (an UPDATE of this row) either commits first, and is seen below, or
      // waits until this checkout has finished. Without it a suspension could land between the check and the order.
      await tx.$queryRaw`SELECT i.id FROM influencers i JOIN services s ON s.influencer_id = i.id JOIN sessions se ON se.service_id = s.id JOIN bookings b ON b.session_id = se.id WHERE b.id = ${bookingId} FOR SHARE OF i`;

      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { session: { include: { service: { include: { influencer: { select: { suspendedAt: true } } } } } } },
      });
      const now = new Date();
      const payable =
        (booking.status === "HELD" || booking.status === "PENDING_PAYMENT") &&
        booking.holdExpiresAt !== null &&
        booking.holdExpiresAt > now;
      if (!payable) throw new NotPayableError("This hold has expired or the booking is already processed");
      // A suspended influencer takes no new payments, not even for a hold made before the suspension. Nothing is created or
      // reused below this line. (A Razorpay order opened earlier still completes through the webhook, which is unchanged.)
      if (booking.session.service.influencer.suspendedAt) throw new NotPayableError("This booking can no longer be paid. You have not been charged.");

      const service = booking.session.service;
      const customer = { name: booking.customerName, email: booking.customerEmail, contact: booking.whatsappE164 };

      const open = await tx.payment.findFirst({
        where: { bookingId, status: "CREATED" },
        orderBy: { createdAt: "desc" },
      });
      if (open) {
        // Resuming the open order does not move the hold: the payment window started when the order was created. Extending it
        // on every call let one request every few minutes keep a seat reserved indefinitely without paying. A payment that
        // completes after the hold ended is still applied if the seat is free (lib/payment-capture.ts), refunded otherwise.
        const holdExpiresAt = booking.holdExpiresAt!;
        await tx.booking.update({ where: { id: bookingId }, data: { status: "PENDING_PAYMENT" } });
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

      // The payment window starts now: extend (never shorten) the hold so the seat stays reserved while the customer pays.
      const windowEnd = new Date(now.getTime() + PAYMENT_WINDOW_MINUTES * 60_000);
      const holdExpiresAt = booking.holdExpiresAt! > windowEnd ? booking.holdExpiresAt! : windowEnd;
      await tx.booking.update({ where: { id: bookingId }, data: { status: "PENDING_PAYMENT", holdExpiresAt } });

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
