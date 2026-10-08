import { prisma } from "@/lib/db";

/**
 * Thin recording helpers for the Message log. Phase 4 (WhatsApp/SMS) and Phase 5 (reminders) will add a real
 * delivery worker; until then these rows are written by the structured-log senders (lib/email.ts, the
 * confirmation enqueue in lib/meeting.ts) so the dashboard can show whether, and how, a customer was contacted.
 *
 * Every helper is best-effort and never throws: recording that we told a customer must not fail or retry the
 * booking/meeting job that produced the message. On error we log and return null (createMessage) or do nothing.
 */

export type MessageChannel = "email" | "whatsapp" | "sms" | "log";
export type MessageStatus = "queued" | "sent" | "failed";

export interface CreateMessageInput {
  bookingId: string;
  channel: MessageChannel;
  template: string;
  /** Defaults to "queued"; pass "sent" to record a message that was already delivered (e.g. the log sender). */
  status?: MessageStatus;
}

/** Records a new outbound message. Returns the row id, or null if recording failed. */
export async function createMessage(input: CreateMessageInput): Promise<string | null> {
  try {
    const status = input.status ?? "queued";
    const row = await prisma.message.create({
      data: {
        bookingId: input.bookingId,
        channel: input.channel,
        template: input.template,
        status,
        sentAt: status === "sent" ? new Date() : null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    console.error("[messages] failed to record message", e);
    return null;
  }
}

/** Marks a previously-recorded message delivered. No-op if the id is null or the update fails. */
export async function markMessageSent(messageId: string | null): Promise<void> {
  if (!messageId) return;
  try {
    await prisma.message.update({
      where: { id: messageId },
      data: { status: "sent", error: null, sentAt: new Date() },
    });
  } catch (e) {
    console.error("[messages] failed to mark message sent", e);
  }
}

/** Marks a previously-recorded message failed with a (truncated) reason. No-op if the id is null. */
export async function markMessageFailed(messageId: string | null, error: string): Promise<void> {
  if (!messageId) return;
  try {
    await prisma.message.update({
      where: { id: messageId },
      data: { status: "failed", error: error.slice(0, 500) },
    });
  } catch (e) {
    console.error("[messages] failed to mark message failed", e);
  }
}
