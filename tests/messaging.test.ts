import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";
import { sendMessageForBooking, type MessagingDeps } from "../lib/messaging";
import type { SendResult } from "../lib/sms";

// Integration tests: need a migrated Postgres at DATABASE_URL (skipped otherwise). The senders and the
// alert hook are always injected as fakes, so no real WhatsApp/SMS provider is ever contacted.
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

const slotStart = new Date(Date.now() + 11 * 86_400_000);
slotStart.setUTCMinutes(0, 0, 0);

let influencerId: string;
let serviceId: string;
const run = Date.now();
let n = 0;

async function booking(opts: { optIn?: boolean; status?: string } = {}) {
  const start = new Date(slotStart.getTime() + ++n * 3_600_000);
  const hold = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Msg Tester",
    customerEmail: `msg${run}_${n}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: opts.optIn ?? true,
  });
  await prisma.booking.update({
    where: { id: hold.id },
    data: { status: (opts.status ?? "PAID") as never, meetLink: "https://meet.google.com/abc-defg-hij" },
  });
  return hold.id;
}

/** A deps object whose senders record calls and behave per the test's instructions. */
function fakes(behaviour: { whatsapp?: "ok" | "fail"; sms?: "ok" | "fail" } = {}) {
  const calls: string[] = [];
  const alerts: string[] = [];
  const deps: Partial<MessagingDeps> = {
    sendWhatsApp: async (): Promise<SendResult> => {
      calls.push("whatsapp");
      if (behaviour.whatsapp === "fail") throw new Error("whatsapp down");
      return { providerMessageId: "wa-123" };
    },
    sendSMS: async (): Promise<SendResult> => {
      calls.push("sms");
      if (behaviour.sms === "fail") throw new Error("sms down");
      return { providerMessageId: "sms-456" };
    },
    alert: async (_id, a) => void alerts.push(a.kind),
  };
  return { deps, calls, alerts };
}

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: { slug: `msg-${run}`, name: "Msg Test", email: `msgtest${run}@example.com` },
  });
  influencerId = inf.id;
  serviceId = (
    await prisma.service.create({ data: { influencerId, title: "1:1", durationMin: 30, priceMinor: 49900 } })
  ).id;
});

after(async () => {
  if (!skip && influencerId) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

test("WhatsApp success records SENT with the provider id", { skip }, async () => {
  const id = await booking();
  const { deps, calls } = fakes({ whatsapp: "ok" });
  const outcome = await sendMessageForBooking(id, "booking-confirmation", deps);
  assert.equal(outcome, "sent");
  assert.deepEqual(calls, ["whatsapp"]);
  const row = await prisma.message.findUniqueOrThrow({
    where: { bookingId_channel_template: { bookingId: id, channel: "WHATSAPP", template: "booking-confirmation" } },
  });
  assert.equal(row.status, "SENT");
  assert.equal(row.channel, "WHATSAPP");
  assert.equal(row.providerMessageId, "wa-123");
});

test("WhatsApp failure falls back to SMS and records SENT", { skip }, async () => {
  const id = await booking();
  const { deps, calls } = fakes({ whatsapp: "fail", sms: "ok" });
  const outcome = await sendMessageForBooking(id, "booking-confirmation", deps);
  assert.equal(outcome, "sent");
  assert.deepEqual(calls, ["whatsapp", "sms"]);
  const row = await prisma.message.findUniqueOrThrow({
    where: { bookingId_channel_template: { bookingId: id, channel: "SMS", template: "booking-confirmation" } },
  });
  assert.equal(row.status, "SENT");
  assert.equal(row.channel, "SMS");
  assert.equal(row.providerMessageId, "sms-456");
  // The WhatsApp attempt left its own row recording the failure (not SENT).
  const waRow = await prisma.message.findUniqueOrThrow({
    where: { bookingId_channel_template: { bookingId: id, channel: "WHATSAPP", template: "booking-confirmation" } },
  });
  assert.notEqual(waRow.status, "SENT");
});

test("both channels failing throws (retryable) and does not mark SENT", { skip }, async () => {
  const id = await booking();
  const { deps, calls } = fakes({ whatsapp: "fail", sms: "fail" });
  await assert.rejects(sendMessageForBooking(id, "booking-confirmation", deps));
  assert.deepEqual(calls, ["whatsapp", "sms"]);
  const smsRow = await prisma.message.findUnique({
    where: { bookingId_channel_template: { bookingId: id, channel: "SMS", template: "booking-confirmation" } },
  });
  assert.notEqual(smsRow?.status, "SENT");
  const waRow = await prisma.message.findUnique({
    where: { bookingId_channel_template: { bookingId: id, channel: "WHATSAPP", template: "booking-confirmation" } },
  });
  assert.notEqual(waRow?.status, "SENT");
});

test("a cancelled booking is skipped without sending", { skip }, async () => {
  const id = await booking({ status: "CANCELLED" });
  const { deps, calls } = fakes({ whatsapp: "ok" });
  const outcome = await sendMessageForBooking(id, "booking-confirmation", deps);
  assert.equal(outcome, "skipped");
  assert.deepEqual(calls, []);
});

test("an opted-out booking is skipped without sending", { skip }, async () => {
  const id = await booking({ optIn: false });
  const { deps, calls } = fakes({ whatsapp: "ok" });
  const outcome = await sendMessageForBooking(id, "booking-confirmation", deps);
  assert.equal(outcome, "skipped");
  assert.deepEqual(calls, []);
});

test("re-running after a SENT message does not send again", { skip }, async () => {
  const id = await booking();
  const first = fakes({ whatsapp: "ok" });
  await sendMessageForBooking(id, "booking-confirmation", first.deps);
  const second = fakes({ whatsapp: "ok" });
  const outcome = await sendMessageForBooking(id, "booking-confirmation", second.deps);
  assert.equal(outcome, "already-sent");
  assert.deepEqual(second.calls, []);
});

test("every customer message says the time in IST, whatever zone the booking row carries (confirmation, both reminders, reschedule, cancellation)", { skip }, async () => {
  const { formatSessionTime } = await import("../lib/format");
  for (const template of ["booking-confirmation", "reminder-24h", "reminder-15m", "reschedule", "cancellation"]) {
    const id = await booking({ status: template === "cancellation" ? "CANCELLED" : "PAID" });
    // A booking made before the India-only change may carry the customer's own zone: it must no longer change the text.
    await prisma.booking.update({ where: { id }, data: { customerTz: "America/New_York" } });
    const start = (await prisma.booking.findUniqueOrThrow({ where: { id }, include: { session: true } })).session.startTime;
    const expected = formatSessionTime(start);
    assert.match(expected, / IST$/);

    let whatsappParams: string[] = [];
    let smsBody = "";
    const deps: Partial<MessagingDeps> = {
      sendWhatsApp: async (input): Promise<SendResult> => {
        const body = (input.components?.[0] ?? { parameters: [] }) as { parameters: { text: string }[] };
        whatsappParams = body.parameters.map((p) => p.text);
        throw new Error("force the SMS fallback so both texts are seen");
      },
      sendSMS: async (input): Promise<SendResult> => {
        smsBody = input.body;
        return { providerMessageId: "sms-ist" };
      },
      alert: async () => undefined,
    };
    assert.equal(await sendMessageForBooking(id, template, deps), "sent", template);
    assert.ok(whatsappParams.includes(expected), `${template}: the WhatsApp variable is "${expected}", got ${JSON.stringify(whatsappParams)}`);
    assert.ok(smsBody.includes(expected), `${template}: the SMS says "${expected}": ${smsBody}`);
    assert.doesNotMatch(smsBody, /New York|EDT|EST|GMT-/);
  }
});
