import { prisma } from "@/lib/db";

/**
 * Thin recording helpers for the Message log. The real delivery worker (WhatsApp/SMS) lives in
 * lib/messaging.ts; these helpers record best-effort rows for the OTHER channels (email, structured log)
 * and for queued WhatsApp confirmations so the dashboard can show whether, and how, a customer was contacted.
 *
 * The Message table is now the unified enum model (lib/messaging.ts + the WhatsApp status webhook share it).
 * These helpers accept the legacy lowercase channel/status vocabulary and map it onto the enum, so Phase 6
 * callers (lib/email.ts, lib/manage.ts) are unchanged. Rows are keyed on (bookingId, template) which is
 * unique, so recording is idempotent: a repeat records against the same row via upsert.
 *
 * Every helper is best-effort and never throws: recording that we told a customer must not fail or retry the
 * booking/meeting job that produced the message. On error we log and return null (createMessage) or do nothing.
 */

export type MessageChannel = "email" | "whatsapp" | "sms" | "log";
export type MessageStatus = "queued" | "sent" | "failed";

/** Maps the legacy lowercase channel vocabulary onto the Prisma MessageChannel enum. */
function toChannel(channel: MessageChannel): "EMAIL" | "WHATSAPP" | "SMS" | "LOG" {
  switch (channel) {
    case "email":
      return "EMAIL";
    case "whatsapp":
      return "WHATSAPP";
    case "sms":
      return "SMS";
    case "log":
      return "LOG";
  }
}

/** Maps the legacy lowercase status vocabulary onto the Prisma MessageStatus enum. */
function toStatus(status: MessageStatus): "PENDING" | "SENT" | "FAILED" {
  switch (status) {
    case "queued":
      return "PENDING";
    case "sent":
      return "SENT";
    case "failed":
      return "FAILED";
  }
}

export interface CreateMessageInput {
  bookingId: string;
  channel: MessageChannel;
  template: string;
  /** Defaults to "queued"; pass "sent" to record a message that was already delivered (e.g. the log sender). */
  status?: MessageStatus;
}

/**
 * Records a new outbound message. Returns the row id, or null if recording failed. Upserts on the unique
 * (bookingId, template) key so a repeat (e.g. a resend) records against the same row instead of violating
 * the constraint.
 */
export async function createMessage(input: CreateMessageInput): Promise<string | null> {
  try {
    const status = toStatus(input.status ?? "queued");
    const channel = toChannel(input.channel);
    const sentAt = status === "SENT" ? new Date() : null;
    const row = await prisma.message.upsert({
      where: {
        bookingId_channel_template: { bookingId: input.bookingId, channel, template: input.template },
      },
      create: { bookingId: input.bookingId, channel, template: input.template, status, sentAt },
      update: { status, sentAt },
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
      data: { status: "SENT", error: null, sentAt: new Date() },
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
      data: { status: "FAILED", error: error.slice(0, 500) },
    });
  } catch (e) {
    console.error("[messages] failed to mark message failed", e);
  }
}
