import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * "Messages not delivered": the FAILED `messages` rows the influencer's dashboard and the admin overview count and list.
 *
 * A FAILED row of the linked WhatsApp number (channel WHATSAPP_WEB) is a record that the number TRIED to send and failed; the same
 * message normally went out the next way (the official connection, SMS) and that row says SENT. Such a row is history, not a message that
 * was not delivered, so it is left out of the counts and of the "Failed" filter whenever another channel's row for the same booking and
 * template is SENT, DELIVERED or READ. (When nothing else delivered it, it stays: that really is a message not delivered.)
 */

/** Ids of the WHATSAPP_WEB rows that failed but whose message was delivered on another channel. Scoped to one influencer and/or a time window. */
export async function supersededWebFailureIds(opts: { influencerId?: string; since?: Date } = {}): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT m.id
    FROM messages m
    JOIN bookings b ON b.id = m.booking_id
    JOIN sessions s ON s.id = b.session_id
    JOIN services sv ON sv.id = s.service_id
    WHERE m.status = 'FAILED'
      AND m.channel = 'WHATSAPP_WEB'
      ${opts.influencerId ? Prisma.sql`AND sv.influencer_id = ${opts.influencerId}` : Prisma.empty}
      ${opts.since ? Prisma.sql`AND m.updated_at >= ${opts.since}` : Prisma.empty}
      AND EXISTS (
        SELECT 1 FROM messages o
        WHERE o.booking_id = m.booking_id
          AND o.template = m.template
          AND o.channel <> 'WHATSAPP_WEB'
          AND o.status IN ('SENT', 'DELIVERED', 'READ')
      )`);
  return rows.map((r) => r.id);
}

/** FAILED messages since `since` (optionally one influencer's), without the superseded linked-number rows. */
export async function countFailedMessages(since: Date, influencerId?: string): Promise<number> {
  const superseded = await supersededWebFailureIds({ influencerId, since });
  return prisma.message.count({
    where: {
      status: "FAILED",
      updatedAt: { gte: since },
      ...(influencerId ? { booking: { session: { service: { influencerId } } } } : {}),
      ...(superseded.length > 0 ? { id: { notIn: superseded } } : {}),
    },
  });
}
