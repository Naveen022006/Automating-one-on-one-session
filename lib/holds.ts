import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

export const HOLD_MINUTES = 10;
/** How long a booking REQUEST keeps its seat while the influencer decides. */
export const REQUEST_TTL_HOURS = 48;
/** After approval, how long the customer has to pay (never past the session start). */
export const APPROVED_PAY_HOURS = 24;
/** When checkout starts, the hold is pushed out to at least this long so a payment in progress keeps its seat. */
export const PAYMENT_WINDOW_MINUTES = 20;

/** Statuses that occupy a seat regardless of hold expiry. */
export const SEAT_STATUSES = ["PAID", "SCHEDULED", "COMPLETED"] as const;

/** Statuses that occupy a seat only until `holdExpiresAt`. */
export const TIMED_SEAT_STATUSES = ["REQUESTED", "HELD", "PENDING_PAYMENT"] as const;

/** Where-clause for bookings that currently occupy a seat. Unpaid bookings only count until their hold expires. */
export function activeSeatWhere(now: Date): Prisma.BookingWhereInput {
  return {
    OR: [
      { status: { in: [...SEAT_STATUSES] } },
      { status: { in: [...TIMED_SEAT_STATUSES] }, holdExpiresAt: { gt: now } },
    ],
  };
}

type Db = Prisma.TransactionClient;

/**
 * Serialises every change to one influencer's calendar (holds, late captures, reschedules) for the rest of the transaction.
 * The session row lock below only covers ONE session, but an influencer can be booked through several services (and
 * overlapping rules), so two holds for overlapping times would lock two different rows. Take this before any session lock.
 */
export async function lockInfluencerSchedule(tx: Db, influencerId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"schedule:" + influencerId}, 0))`;
}

/**
 * The influencer is in only one session at a time: true when another of their sessions (any service, including the same
 * service at another start) overlaps [start, end) and has a booking that occupies a seat (activeSeatWhere). The session
 * `excludeSessionId` is the one being booked or moved; its own seats are counted against its capacity instead.
 */
export async function hasOverlappingBusySession(
  db: Db,
  args: { influencerId: string; start: Date; end: Date; excludeSessionId?: string; now: Date },
): Promise<boolean> {
  const clash = await db.session.findFirst({
    where: {
      ...(args.excludeSessionId ? { id: { not: args.excludeSessionId } } : {}),
      service: { influencerId: args.influencerId },
      startTime: { lt: args.end },
      endTime: { gt: args.start },
      bookings: { some: activeSeatWhere(args.now) },
    },
    select: { id: true },
  });
  return clash !== null;
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
  /** The service needs approval: create a REQUESTED booking (long hold, nothing to pay yet) instead of HELD. */
  requestApproval?: boolean;
}

/**
 * Atomically takes a seat. The influencer's schedule lock and the session row lock (SELECT ... FOR UPDATE) make concurrent
 * holds serialize, so neither the capacity check nor the overlap check (one session at a time per influencer) can be raced.
 */
export async function createHold(input: HoldInput) {
  const now = new Date();
  const holdExpiresAt = new Date(now.getTime() + (input.requestApproval ? REQUEST_TTL_HOURS * 3_600_000 : HOLD_MINUTES * 60_000));

  return prisma.$transaction(async (tx) => {
    const owner = await tx.service.findUniqueOrThrow({ where: { id: input.serviceId }, select: { influencerId: true } });
    await lockInfluencerSchedule(tx, owner.influencerId);

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
    // Another of the influencer's sessions at an overlapping time (another service, or the same one at another start).
    if (
      await hasOverlappingBusySession(tx, {
        influencerId: owner.influencerId,
        start: input.startTime,
        end: input.endTime,
        excludeSessionId: sessionId,
        now,
      })
    ) {
      throw new SlotUnavailableError("Slot is no longer available");
    }

    const duplicate = await tx.booking.count({
      where: { sessionId, customerEmail: input.customerEmail, ...activeSeatWhere(now) },
    });
    if (duplicate > 0) throw new DuplicateBookingError("You already have a booking for this slot");

    return tx.booking.create({
      data: {
        sessionId,
        status: input.requestApproval ? "REQUESTED" : "HELD",
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

/**
 * Marks timed-out unpaid bookings (requested, held or awaiting payment) EXPIRED. Availability never depends on this running (expired
 * holds are ignored); it keeps data tidy. This is the plain database step. The worker calls `expireStaleHoldsAndNotify`
 * (lib/request-messages.ts), which expires the unanswered REQUESTED bookings first, in batches, so it can tell their customers, and then
 * calls this with `includeRequests: false` for everything else. `scope` narrows the sweep to some bookings (a test uses it to leave
 * every other booking in a shared database alone); the worker never passes it.
 */
export async function expireStaleHolds(now = new Date(), opts: { includeRequests?: boolean; scope?: Prisma.BookingWhereInput } = {}): Promise<number> {
  const statuses = opts.includeRequests === false ? TIMED_SEAT_STATUSES.filter((s) => s !== "REQUESTED") : [...TIMED_SEAT_STATUSES];
  const { count } = await prisma.booking.updateMany({
    where: { status: { in: statuses }, holdExpiresAt: { lte: now }, ...(opts.scope ? { AND: [opts.scope] } : {}) },
    data: { status: "EXPIRED" },
  });
  return count;
}
