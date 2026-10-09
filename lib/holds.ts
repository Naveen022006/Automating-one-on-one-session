import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export const HOLD_MINUTES = 10;
/** When checkout starts, the hold is pushed out to at least this long so a payment in progress keeps its seat. */
export const PAYMENT_WINDOW_MINUTES = 20;

/** Statuses that occupy a seat regardless of hold expiry. */
export const SEAT_STATUSES = ["PAID", "SCHEDULED", "COMPLETED"] as const;

/** Statuses that occupy a seat only until `holdExpiresAt`. */
export const TIMED_SEAT_STATUSES = ["HELD", "PENDING_PAYMENT"] as const;

/** Where-clause for bookings that currently occupy a seat. Unpaid bookings only count until their hold expires. */
export function activeSeatWhere(now: Date): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: [...SEAT_STATUSES] } },
      { status: { in: [...TIMED_SEAT_STATUSES] }, holdExpiresAt: { gt: now } },
    ],
  };
}

export class SlotUnavailableError extends Error {}
export class DuplicateBookingError extends Error {}

export interface HoldInput {
  serviceId: string;
  startTime: Date;
  endTime: Date;
  capacity: number;
  customerName: string;
  customerEmail: string;
  whatsappE164: string;
  whatsappOptIn: boolean;
  customerTz?: string;
  /** Snapshot of the service's cancellation policy at booking time. */
  refundPolicy?: "FULL" | "NOTICE_24H" | "NONE";
  /** Validated answers to the service's intake questions (question text included). */
  intakeAnswers?: { id: string; label: string; answer: string }[];
}

/**
 * Atomically takes a seat. The session row is locked (SELECT ... FOR UPDATE) so concurrent
 * holds for the same slot serialize and the capacity check cannot be raced.
 */
export async function createHold(input: HoldInput) {
  const now = new Date();
  const holdExpiresAt = new Date(now.getTime() + HOLD_MINUTES * 60_000);

  return prisma.$transaction(async (tx) => {
    // Idempotent create: the (service_id, start_time) unique constraint makes this race-safe.
    await tx.$executeRaw`
      INSERT INTO sessions (id, service_id, start_time, end_time, created_at)
      VALUES (${"s_" + crypto.randomUUID()}, ${input.serviceId}, ${input.startTime}, ${input.endTime}, now())
      ON CONFLICT (service_id, start_time) DO NOTHING`;

    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM sessions
      WHERE service_id = ${input.serviceId} AND start_time = ${input.startTime}
      FOR UPDATE`;
    const sessionId = rows[0].id;

    const taken = await tx.booking.count({ where: { sessionId, ...activeSeatWhere(now) } });
    if (taken >= input.capacity) throw new SlotUnavailableError("Slot is no longer available");

    const duplicate = await tx.booking.count({
      where: { sessionId, customerEmail: input.customerEmail, ...activeSeatWhere(now) },
    });
    if (duplicate > 0) throw new DuplicateBookingError("You already have a booking for this slot");

    return tx.booking.create({
      data: {
        sessionId,
        status: "HELD",
        holdExpiresAt,
        customerName: input.customerName,
        customerEmail: input.customerEmail,
        whatsappE164: input.whatsappE164,
        whatsappOptIn: input.whatsappOptIn,
        customerTz: input.customerTz,
        refundPolicy: input.refundPolicy,
        ...(input.intakeAnswers && input.intakeAnswers.length ? { intakeAnswers: input.intakeAnswers } : {}),
      },
    });
  });
}

/** Marks timed-out unpaid bookings (held or awaiting payment) EXPIRED. Availability never depends on this running (expired holds are ignored); it keeps data tidy. */
export async function expireStaleHolds(now = new Date()): Promise<number> {
  const { count } = await prisma.booking.updateMany({
    where: { status: { in: [...TIMED_SEAT_STATUSES] }, holdExpiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return count;
}
