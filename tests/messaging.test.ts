import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RetryableMessageError,
  sendBookingMessage,
  type MessagingPrisma,
  type SendBookingMessageDeps,
} from "../lib/messaging";

interface FakeMessageRow {
  id: string;
  bookingId: string;
  channel: "WHATSAPP" | "SMS";
  template: string;
  status: "PENDING" | "SENT" | "FAILED";
  providerMessageId: string | null;
  error: string | null;
}

interface FakeBooking {
  status: string;
  whatsappE164: string;
  whatsappOptIn: boolean;
  meetLink: string | null;
}

// Tiny in-memory fake for the prisma delegates the job uses, so this runs with no DB/Redis/network.
function makeFakePrisma(booking: FakeBooking | null): { prisma: MessagingPrisma; rows: FakeMessageRow[] } {
  const rows: FakeMessageRow[] = [];
  let seq = 0;
  const prisma: MessagingPrisma = {
    booking: {
      async findUnique() {
        return booking
          ? {
              status: booking.status,
              whatsappE164: booking.whatsappE164,
              whatsappOptIn: booking.whatsappOptIn,
              meetLink: booking.meetLink,
            }
          : null;
      },
    },
    message: {
      async create({ data }) {
        const row: FakeMessageRow = {
          id: `msg_${++seq}`,
          bookingId: data.bookingId,
          channel: data.channel,
          template: data.template,
          status: data.status,
          providerMessageId: null,
          error: null,
        };
        rows.push(row);
        return { id: row.id };
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("row not found");
        if (data.status !== undefined) row.status = data.status;
        if (data.providerMessageId !== undefined) row.providerMessageId = data.providerMessageId;
        if (data.error !== undefined) row.error = data.error;
        return row;
      },
    },
  };
  return { prisma, rows };
}

const optedIn: FakeBooking = {
  status: "PAID",
  whatsappE164: "+919876543210",
  whatsappOptIn: true,
  meetLink: "https://meet.example.com/abc",
};

test("WhatsApp success marks a WHATSAPP message SENT", async () => {
  const { prisma, rows } = makeFakePrisma(optedIn);
  const deps: SendBookingMessageDeps = {
    prisma,
    sendWhatsApp: async () => ({ providerMessageId: "wamid.1" }),
    sendSMS: async () => assert.fail("SMS should not be called on WhatsApp success"),
  };

  const result = await sendBookingMessage("b1", deps);
  assert.equal(result.channel, "WHATSAPP");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, "WHATSAPP");
  assert.equal(rows[0].status, "SENT");
  assert.equal(rows[0].providerMessageId, "wamid.1");
});

test("WhatsApp failure falls back to SMS: FAILED WHATSAPP row + SENT SMS row", async () => {
  const { prisma, rows } = makeFakePrisma(optedIn);
  const deps: SendBookingMessageDeps = {
    prisma,
    sendWhatsApp: async () => {
      throw new Error("whatsapp down");
    },
    sendSMS: async () => ({ providerMessageId: "sms.1" }),
  };

  const result = await sendBookingMessage("b1", deps);
  assert.equal(result.channel, "SMS");
  assert.equal(rows.length, 2);

  const wa = rows.find((r) => r.channel === "WHATSAPP");
  const sms = rows.find((r) => r.channel === "SMS");
  assert.ok(wa && sms);
  assert.equal(wa.status, "FAILED");
  assert.match(wa.error ?? "", /whatsapp down/);
  assert.equal(sms.status, "SENT");
  assert.equal(sms.providerMessageId, "sms.1");
});

test("opt-out is not messaged and records nothing", async () => {
  const { prisma, rows } = makeFakePrisma({ ...optedIn, whatsappOptIn: false });
  const deps: SendBookingMessageDeps = {
    prisma,
    sendWhatsApp: async () => assert.fail("should not send"),
    sendSMS: async () => assert.fail("should not send"),
  };

  const result = await sendBookingMessage("b1", deps);
  assert.equal(result.skipped, true);
  assert.equal(result.channel, null);
  assert.equal(rows.length, 0);
});

test("missing meetLink throws a retryable error (Phase 3 gap)", async () => {
  const { prisma, rows } = makeFakePrisma({ ...optedIn, meetLink: null });
  const deps: SendBookingMessageDeps = {
    prisma,
    sendWhatsApp: async () => assert.fail("should not send"),
    sendSMS: async () => assert.fail("should not send"),
  };

  await assert.rejects(sendBookingMessage("b1", deps), (e: unknown) => {
    assert.ok(e instanceof RetryableMessageError);
    assert.equal((e as RetryableMessageError).retryable, true);
    return true;
  });
  assert.equal(rows.length, 0);
});

test("both channels failing throws (so BullMQ retries) and records both FAILED", async () => {
  const { prisma, rows } = makeFakePrisma(optedIn);
  const deps: SendBookingMessageDeps = {
    prisma,
    sendWhatsApp: async () => {
      throw new Error("wa down");
    },
    sendSMS: async () => {
      throw new Error("sms down");
    },
  };

  await assert.rejects(sendBookingMessage("b1", deps), /Both WhatsApp and SMS failed/);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.status === "FAILED"));
});
