import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";
import { rearmMessage, sendMessageForBooking, type MessagingDeps } from "../lib/messaging";
import type { SendResult } from "../lib/sms";
import { createDeliveryHandler } from "../lib/whatsapp-web/delivery";
import { setActiveSender, type WhatsAppWebSendRequest, type WhatsAppWebSendResult } from "../lib/whatsapp-web/send";
import { harness, ManualClock, settle, want, type Harness } from "./helpers/whatsapp-web";

// The message path with the optional QR-linked WhatsApp as the first channel: which channel carries each message, that a retry never
// sends twice, what is recorded, and one end-to-end pass through the real manager with the scriptable fake transport. The official
// WhatsApp, SMS and the QR sender are always injected, so no provider and no socket is ever contacted. Rows are timestamped and
// deleted in `after`.

const skip = process.env.DATABASE_URL && process.env.APP_SECRET ? false : "DATABASE_URL / APP_SECRET not set";
const run = Date.now();
const PHONE = "+919876543210";
const saved = { qr: process.env.WHATSAPP_QR_ENABLED, dry: process.env.MESSAGING_DRY_RUN, fake: process.env.WHATSAPP_QR_FAKE, appUrl: process.env.APP_URL };

const slotStart = new Date(Date.now() + 11 * 86_400_000);
slotStart.setUTCMinutes(0, 0, 0);

let influencerId = "";
let otherInfluencerId = "";
let serviceId = "";
let n = 0;
const bookings: string[] = [];

async function booking(opts: { status?: string; phone?: string; optIn?: boolean } = {}): Promise<string> {
  const start = new Date(slotStart.getTime() + ++n * 3_600_000);
  const hold = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Web Tester",
    customerEmail: `waw${run}_${n}@example.com`,
    whatsappE164: PHONE,
    whatsappOptIn: opts.optIn ?? true,
  });
  await prisma.booking.update({
    where: { id: hold.id },
    data: { status: (opts.status ?? "SCHEDULED") as never, meetLink: "https://meet.google.com/abc-defg-hij", ...(opts.phone ? { whatsappE164: opts.phone } : {}) },
  });
  bookings.push(hold.id);
  return hold.id;
}

async function setSession(status: "NOT_LINKED" | "PENDING_QR" | "LINKED" | "RECONNECTING" | "SUSPENDED" | "LOGGED_OUT", wantLinked = true, id = influencerId) {
  await prisma.whatsAppWebSession.upsert({
    where: { influencerId: id },
    create: { influencerId: id, status, wantLinked, phoneE164: "+919876500001" },
    update: { status, wantLinked, phoneE164: "+919876500001" },
  });
}

interface Fakes {
  deps: Partial<MessagingDeps>;
  calls: string[];
  qrSends: WhatsAppWebSendRequest[];
  ctl: { ready: boolean; qr: (req: WhatsAppWebSendRequest) => WhatsAppWebSendResult | Promise<WhatsAppWebSendResult>; official: "ok" | "fail" | "not-connected"; sms: "ok" | "fail" };
}

function fakes(): Fakes {
  const calls: string[] = [];
  const qrSends: WhatsAppWebSendRequest[] = [];
  const ctl: Fakes["ctl"] = { ready: true, qr: (req) => ({ ok: true, providerMessageId: `QR-${req.key}` }), official: "ok", sms: "ok" };
  const deps: Partial<MessagingDeps> = {
    sendWhatsApp: async (): Promise<SendResult> => {
      calls.push("whatsapp");
      if (ctl.official === "fail") throw new Error("whatsapp down");
      return { providerMessageId: "wa-123" };
    },
    sendSMS: async (): Promise<SendResult> => {
      calls.push("sms");
      if (ctl.sms === "fail") throw new Error("sms down");
      return { providerMessageId: "sms-456" };
    },
    alert: async () => {},
    qr: {
      isReady: () => ctl.ready,
      send: async (req) => {
        calls.push("qr");
        qrSends.push(req);
        return ctl.qr(req);
      },
    },
  };
  return { deps, calls, qrSends, ctl };
}

const row = (bookingId: string, channel: "WHATSAPP" | "WHATSAPP_WEB" | "SMS", template = "booking-confirmation") =>
  prisma.message.findUnique({ where: { bookingId_channel_template: { bookingId, channel, template } } });

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({ data: { slug: `waw-${run}`, name: "Asha Web", email: `waw${run}@example.com` } });
  influencerId = inf.id;
  otherInfluencerId = (await prisma.influencer.create({ data: { slug: `wawo-${run}`, name: "Other Web", email: `wawo${run}@example.com` } })).id;
  serviceId = (await prisma.service.create({ data: { influencerId, title: "Career call", durationMin: 30, priceMinor: 49900 } })).id;
});

beforeEach(async () => {
  if (skip) return;
  process.env.WHATSAPP_QR_ENABLED = "true";
  delete process.env.WHATSAPP_QR_FAKE;
  process.env.MESSAGING_DRY_RUN = "false";
  process.env.APP_URL = "http://localhost:3000";
  setActiveSender(null);
  await setSession("LINKED");
});

after(async () => {
  setActiveSender(null);
  for (const [k, v] of [["WHATSAPP_QR_ENABLED", saved.qr], ["MESSAGING_DRY_RUN", saved.dry], ["WHATSAPP_QR_FAKE", saved.fake], ["APP_URL", saved.appUrl]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: [influencerId, otherInfluencerId].filter(Boolean) } } });
  } catch (e) {
    console.error("cleanup failed", e instanceof Error ? e.message : e);
  } finally {
    await prisma.$disconnect();
  }
});

// ---- channel precedence --------------------------------------------------------------------------------------------------------

test("a linked number is the first channel: one send, recorded on the WHATSAPP_WEB row, no official WhatsApp, no SMS", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr"]);
  const sent = f.qrSends[0];
  assert.equal(sent.influencerId, influencerId);
  assert.equal(sent.toE164, PHONE);
  assert.equal(sent.bookingId, id);
  assert.equal(sent.key, `${id}:booking-confirmation:0`, "the key is deterministic");
  assert.match(sent.text, /^Your booking is confirmed\./);
  assert.ok(sent.text.includes("Career call") && sent.text.includes("Asha Web") && sent.text.includes("https://meet.google.com/abc-defg-hij"));
  assert.match(sent.text, /To reschedule or cancel: http:\/\/localhost:3000\/manage\//);
  assert.ok(sent.text.endsWith("- Asha Web"));
  const r = await row(id, "WHATSAPP_WEB");
  assert.equal(r?.status, "SENT");
  assert.equal(r?.providerMessageId, `QR-${sent.key}`);
  assert.equal(r?.error, null);
  assert.ok(r?.sentAt);
  assert.equal(await row(id, "WHATSAPP"), null);
  assert.equal(await row(id, "SMS"), null);
});

test("each of the five booking events has its own text through the linked number", { skip }, async () => {
  const heads: Record<string, RegExp> = {
    "booking-confirmation": /^Your booking is confirmed/,
    "reminder-24h": /^Reminder: your session is tomorrow/,
    "reminder-15m": /^Your session starts in 15 minutes/,
    reschedule: /^Your session was rescheduled/,
    cancellation: /^Your session was cancelled/,
  };
  for (const [template, head] of Object.entries(heads)) {
    const id = await booking({ status: template === "cancellation" ? "CANCELLED" : "SCHEDULED" });
    const f = fakes();
    assert.equal(await sendMessageForBooking(id, template, f.deps), "sent", template);
    assert.match(f.qrSends[0].text, head, template);
    assert.equal(f.qrSends[0].key, `${id}:${template}:0`);
  }
});

test("not used when the session is not LINKED (suspended, logged out, reconnecting, waiting for a scan, not wanted): the official connection carries it", { skip }, async () => {
  for (const [status, want] of [["SUSPENDED", true], ["LOGGED_OUT", false], ["RECONNECTING", true], ["PENDING_QR", true], ["NOT_LINKED", false], ["LINKED", false]] as const) {
    await setSession(status, want);
    const id = await booking();
    const f = fakes(); // the manager claims it is ready: the stored status still decides
    assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent", `${status}/${want}`);
    assert.deepEqual(f.calls, ["whatsapp"], `${status}/${want}`);
    assert.equal((await row(id, "WHATSAPP"))?.status, "SENT");
    assert.equal(await row(id, "WHATSAPP_WEB"), null, "no trace of an attempt that was never made");
  }
});

test("not used when the platform flag is off, when no session row exists, or when the manager is not ready", { skip }, async () => {
  process.env.WHATSAPP_QR_ENABLED = "false";
  let id = await booking();
  let f = fakes();
  await sendMessageForBooking(id, "booking-confirmation", f.deps);
  assert.deepEqual(f.calls, ["whatsapp"], "flag off");

  process.env.WHATSAPP_QR_ENABLED = "true";
  id = await booking();
  f = fakes();
  f.ctl.ready = false;
  await sendMessageForBooking(id, "booking-confirmation", f.deps);
  assert.deepEqual(f.calls, ["whatsapp"], "not ready (no open socket)");

  await prisma.whatsAppWebSession.delete({ where: { influencerId } });
  id = await booking();
  f = fakes();
  await sendMessageForBooking(id, "booking-confirmation", f.deps);
  assert.deepEqual(f.calls, ["whatsapp"], "never linked");
});

test("not used for a destination that is not a valid E.164 number", { skip }, async () => {
  for (const phone of ["9876543210", "+0123456789", "+91 98765 43210", "+12345", "+9198765432101234567"]) {
    const id = await booking({ phone });
    const f = fakes();
    await sendMessageForBooking(id, "booking-confirmation", f.deps);
    assert.deepEqual(f.calls, ["whatsapp"], phone);
  }
});

test("nothing is sent this way without a real booking: unknown, erased, opted-out, cancelled-for-a-confirmation and another influencer's bookings never reach the sender", { skip }, async () => {
  const f = fakes();
  assert.equal(await sendMessageForBooking("does-not-exist", "booking-confirmation", f.deps), "skipped");
  assert.equal(await sendMessageForBooking(await booking({ optIn: false }), "booking-confirmation", f.deps), "skipped");
  assert.equal(await sendMessageForBooking(await booking({ status: "CANCELLED" }), "reminder-15m", f.deps), "skipped");
  const erased = await booking();
  await prisma.booking.update({ where: { id: erased }, data: { redactedAt: new Date() } });
  assert.equal(await sendMessageForBooking(erased, "booking-confirmation", f.deps), "skipped");
  assert.deepEqual(f.calls, []);

  // Another influencer's session being LINKED does not make this influencer's message go out from it.
  await setSession("LINKED", true, otherInfluencerId);
  await prisma.whatsAppWebSession.update({ where: { influencerId }, data: { status: "SUSPENDED" } });
  const id = await booking();
  const g = fakes();
  await sendMessageForBooking(id, "booking-confirmation", g.deps);
  assert.deepEqual(g.calls, ["whatsapp"]);
});

test("a template that is not one of the five is never sent through the linked number", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  await sendMessageForBooking(id, "receipt", f.deps);
  assert.deepEqual(f.calls, ["whatsapp"]);
  assert.equal(f.qrSends.length, 0);
});

// ---- fall-through ---------------------------------------------------------------------------------------------------------------

test("every refusal of the linked number, retryable or not, falls straight through to the official connection", { skip }, async () => {
  const refusals: [string, boolean][] = [["queue-full", true], ["busy", true], ["not-connected", true], ["circuit-open", false], ["daily-cap", false], ["no-booking", false], ["not-on-whatsapp", false], ["limits-unavailable", true], ["expired", false]];
  for (const [reason, retryable] of refusals) {
    const id = await booking();
    const f = fakes();
    f.ctl.qr = () => ({ ok: false, reason, retryable });
    assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent", reason);
    assert.deepEqual(f.calls, ["qr", "whatsapp"], `${reason}: one try, then the next channel at once`);
    // Nothing was attempted from the linked number, so nothing failed: no row at all (the official route writes none either).
    assert.equal(await row(id, "WHATSAPP_WEB"), null, `${reason}: no failure is recorded for something that was never tried`);
    assert.equal((await row(id, "WHATSAPP"))?.status, "SENT", "the channel that delivered is the one recorded as SENT");
  }
});

test("a send that was really attempted and failed keeps a FAILED row with the reason, and the message goes the next way", { skip }, async () => {
  for (const reason of ["send-failed", "number-check-failed", "no-message-id"]) {
    const id = await booking();
    const f = fakes();
    f.ctl.qr = () => ({ ok: false, reason, retryable: true });
    assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent", reason);
    assert.deepEqual(f.calls, ["qr", "whatsapp"]);
    const web = await row(id, "WHATSAPP_WEB");
    assert.equal(web?.status, "FAILED", "not a false 'pending' in the Messages view");
    assert.match(web?.error ?? "", /; sent another way\.$/);
    assert.ok(!/in-flight/.test(web?.error ?? ""));
  }
});

test("a group session's reminders that went by SMS because the linked number was busy leave no failure behind, and a FAILED attempt whose message was delivered another way is not counted as 'not delivered'", { skip }, async () => {
  const { countFailedMessages } = await import("../lib/failed-messages");
  const { listMessages } = await import("../lib/dashboard-data");
  const since = new Date(Date.now() - 60_000);
  const before = await countFailedMessages(since, influencerId);
  // 6 seats: the linked number was busy for all of them; SMS delivered.
  for (let i = 0; i < 6; i++) {
    const id = await booking();
    const f = fakes();
    f.ctl.qr = () => ({ ok: false, reason: "busy", retryable: true });
    f.ctl.official = "fail";
    await sendMessageForBooking(id, "reminder-15m", f.deps);
    assert.deepEqual(f.calls, ["qr", "whatsapp", "sms"]);
  }
  assert.equal(await countFailedMessages(since, influencerId), before, "nothing failed");

  // The linked number tried and failed, and SMS delivered: the attempt is history, not an undelivered message.
  const delivered = await booking();
  const f1 = fakes();
  f1.ctl.qr = () => ({ ok: false, reason: "send-failed", retryable: true });
  f1.ctl.official = "fail";
  await sendMessageForBooking(delivered, "booking-confirmation", f1.deps);
  assert.equal((await row(delivered, "WHATSAPP_WEB"))?.status, "FAILED");
  assert.equal((await row(delivered, "SMS"))?.status, "SENT");
  assert.equal(await countFailedMessages(since, influencerId), before);

  // Nothing else delivered it: that one IS a message not delivered, and it is counted and listed.
  const lost = await booking();
  const f2 = fakes();
  f2.ctl.qr = () => ({ ok: false, reason: "send-failed", retryable: true });
  f2.ctl.official = "fail";
  f2.ctl.sms = "fail";
  await assert.rejects(sendMessageForBooking(lost, "booking-confirmation", f2.deps));
  await prisma.message.updateMany({ where: { bookingId: lost, channel: "SMS" }, data: { status: "FAILED" } });
  assert.equal(await countFailedMessages(since, influencerId), before + 2, "the SMS row and the linked-number row of the lost message");
  const listed = await listMessages(influencerId, { status: "FAILED", pageSize: 200 });
  const ids = new Set(listed.messages.map((m) => m.bookingId));
  assert.ok(ids.has(lost), "the lost message is listed");
  assert.ok(!listed.messages.some((m) => m.bookingId === delivered), "the superseded attempt is not listed");
  assert.equal(listed.total, listed.messages.length);
});

test("a sender that throws is a refusal; with the official connection down too, SMS carries it", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  f.ctl.qr = () => {
    throw new Error("boom");
  };
  f.ctl.official = "fail";
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr", "whatsapp", "sms"]);
  assert.equal((await row(id, "SMS"))?.status, "SENT");
  assert.equal((await row(id, "WHATSAPP_WEB"))?.status, "FAILED", "a sender that blew up is an attempt that failed");
  assert.match((await row(id, "WHATSAPP_WEB"))?.error ?? "", /could not send it; sent another way/);
});

test("every channel failing is a retryable failure; the retry tries the linked number again and, when it works this time, sends once", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  f.ctl.qr = () => ({ ok: false, reason: "not-connected", retryable: true });
  f.ctl.official = "fail";
  f.ctl.sms = "fail";
  await assert.rejects(sendMessageForBooking(id, "booking-confirmation", f.deps));
  assert.deepEqual(f.calls, ["qr", "whatsapp", "sms"]);

  f.calls.length = 0;
  f.ctl.qr = (req) => ({ ok: true, providerMessageId: `QR-${req.key}` });
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr"], "the second attempt went through the linked number and stopped there");
  assert.equal((await row(id, "WHATSAPP_WEB"))?.status, "SENT");
});

// ---- waiting, deadlines and unknown outcomes ----------------------------------------------------------------------------------

test("each message goes to the queue with its kind and its deadline: a 15-minute reminder until the session starts, a 24-hour one until 12 h before, the rest 30 minutes", { skip }, async () => {
  const id = await booking();
  const startOf = (await prisma.booking.findUniqueOrThrow({ where: { id }, select: { session: { select: { startTime: true } } } })).session.startTime.getTime();
  for (const template of ["reminder-15m", "reminder-24h", "booking-confirmation"]) {
    const f = fakes();
    const before = Date.now();
    await sendMessageForBooking(id, template, f.deps);
    const sent = f.qrSends[0];
    assert.equal(sent.kind, template);
    if (template === "reminder-15m") assert.equal(sent.deadlineAtMs, startOf);
    else if (template === "reminder-24h") assert.equal(sent.deadlineAtMs, startOf - 12 * 3_600_000);
    else assert.ok(sent.deadlineAtMs! >= before + 30 * 60_000 && sent.deadlineAtMs! <= Date.now() + 30 * 60_000);
    await prisma.message.deleteMany({ where: { bookingId: id } });
  }
});

test("a reminder that waited past its time is dropped: nothing is sent anywhere, no row is left", { skip }, async () => {
  for (const template of ["reminder-15m", "reminder-24h"]) {
    const id = await booking();
    const f = fakes();
    f.ctl.qr = () => ({ ok: false, reason: "expired", retryable: false });
    assert.equal(await sendMessageForBooking(id, template, f.deps), "skipped", template);
    assert.deepEqual(f.calls, ["qr"], "no official WhatsApp, no SMS");
    assert.equal(await row(id, "WHATSAPP_WEB", template), null);
  }
});

test("a booking cancelled, failed or erased while its message waited gets nothing, on any channel", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  f.ctl.qr = () => ({ ok: false, reason: "not-sendable", retryable: false });
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "skipped");
  assert.deepEqual(f.calls, ["qr"]);
  assert.equal(await row(id, "WHATSAPP_WEB"), null);
  assert.equal(await row(id, "WHATSAPP"), null);
});

test("a confirmation that waited too long still goes out, by the next channel", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  f.ctl.qr = () => ({ ok: false, reason: "expired", retryable: false });
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr", "whatsapp"]);
  assert.equal(await row(id, "WHATSAPP_WEB"), null, "too late is not a failure");
});

test("a send that gets no answer in time is UNKNOWN: recorded as sent but not confirmed, never repeated, never sent another way", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  f.ctl.qr = () => ({ ok: false, reason: "unknown-delivery", retryable: false });
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr"], "no official WhatsApp, no SMS");
  const r = await row(id, "WHATSAPP_WEB");
  assert.equal(r?.status, "SENT");
  assert.equal(r?.error, "unknown-delivery");
  assert.equal(r?.providerMessageId, null);
  assert.equal(await row(id, "WHATSAPP"), null);
  assert.equal(await row(id, "SMS"), null);
  // A retry, or the repair job coming round again, finds it delivered-or-unknown and stops.
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "already-sent");
  assert.deepEqual(f.calls, ["qr"]);
});

// ---- idempotency ---------------------------------------------------------------------------------------------------------------

test("a repeated run after a send does nothing; a message delivered on any channel is not sent again on another", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "already-sent");
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "already-sent");
  assert.equal(f.qrSends.length, 1);

  // The same holds when the link drops afterwards (the official connection must not repeat what the linked number delivered).
  f.ctl.ready = false;
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "already-sent");
  assert.deepEqual(f.calls, ["qr"]);
});

test("a send whose outcome was never recorded (the process died after handing it over) is not repeated through the linked number", { skip }, async () => {
  const id = await booking();
  await prisma.message.create({ data: { bookingId: id, channel: "WHATSAPP_WEB", template: "booking-confirmation", status: "PENDING", error: "in-flight" } });
  const f = fakes();
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["whatsapp"], "the next channel, not a second try that could double-send on the same chat");
  assert.equal((await row(id, "WHATSAPP_WEB"))?.error, "in-flight", "the mark stays until a deliberate re-arm");
});

test("a deliberate re-send (re-arm) sends again with a different key; a plain retry keeps the same key", { skip }, async () => {
  const id = await booking();
  const f = fakes();
  await sendMessageForBooking(id, "booking-confirmation", f.deps);
  await new Promise((r) => setTimeout(r, 15));
  await rearmMessage(id, "booking-confirmation");
  const rearmed = await row(id, "WHATSAPP_WEB");
  assert.equal(rearmed?.status, "PENDING");
  assert.equal(rearmed?.providerMessageId, null);
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", f.deps), "sent");
  assert.equal(f.qrSends.length, 2);
  assert.notEqual(f.qrSends[1].key, f.qrSends[0].key, "the queue's short memory of the first send cannot swallow the second");
  assert.equal(f.qrSends[0].key, `${id}:booking-confirmation:0`);
  assert.ok(f.qrSends[1].key.startsWith(`${id}:booking-confirmation:`));
});

test("dry run: a default sender is never used, whatever the manager says", { skip }, async () => {
  process.env.MESSAGING_DRY_RUN = "true";
  const sends: WhatsAppWebSendRequest[] = [];
  setActiveSender({ isReady: () => true, send: async (req) => (sends.push(req), { ok: true, providerMessageId: "X" }) });
  const id = await booking();
  const { qr: _drop, ...rest } = fakes().deps;
  void _drop;
  assert.equal(await sendMessageForBooking(id, "booking-confirmation", rest), "sent");
  assert.equal(sends.length, 0);
  assert.equal((await row(id, "WHATSAPP"))?.status, "SENT");
});

// ---- through the real manager, end to end -------------------------------------------------------------------------------------

async function openNumber(h: Harness) {
  want(h, influencerId);
  await h.tick();
  const t = h.last(influencerId);
  t.emitQr("SECRET-QR-PAYLOAD");
  await settle();
  t.emitOpen({ phoneE164: "+919876500001", deviceLabel: "Chrome (Mac OS)" });
  await settle();
  return t;
}

test("end to end: the real manager with the fake transport carries a booking message, and its delivery receipts update the row", { skip, timeout: 120_000 }, async () => {
  const h = harness({ config: { minGapMs: 0 }, clock: new ManualClock(Date.now()) }); // the deadlines are real-time, so the hand-moved clock starts now; // the spacing needs the hand-moved clock; it is tested in whatsapp-web-send-queue.test.ts
  const t = await openNumber(h);
  setActiveSender({ isReady: (id) => h.manager.isReady(id), send: (req) => h.manager.send(req) });
  try {
    const id = await booking();
    const { qr: _drop, ...rest } = fakes().deps;
    void _drop;
    assert.equal(await sendMessageForBooking(id, "booking-confirmation", rest), "sent");
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].to, PHONE);
    assert.match(t.sent[0].text, /^Your booking is confirmed\./);
    assert.deepEqual(h.guardCalls, [{ influencerId, bookingId: id, toE164: PHONE }], "the queue asked the booking guard before sending");
    const r = await row(id, "WHATSAPP_WEB");
    assert.equal(r?.status, "SENT");
    assert.equal(r?.providerMessageId, t.sent[0].providerMessageId);

    // Receipts, through the handler the worker wires in. Another influencer's receipt for the same id changes nothing.
    const handle = createDeliveryHandler({ schedule: () => {}, log: () => {} });
    await handle(otherInfluencerId, { providerMessageId: t.sent[0].providerMessageId, status: "read" });
    assert.equal((await row(id, "WHATSAPP_WEB"))?.status, "SENT");
    await handle(influencerId, { providerMessageId: t.sent[0].providerMessageId, status: "delivered" });
    assert.equal((await row(id, "WHATSAPP_WEB"))?.status, "DELIVERED");
    await handle(influencerId, { providerMessageId: t.sent[0].providerMessageId, status: "read" });
    assert.equal((await row(id, "WHATSAPP_WEB"))?.status, "READ");
    await handle(influencerId, { providerMessageId: t.sent[0].providerMessageId, status: "delivered" });
    assert.equal((await row(id, "WHATSAPP_WEB"))?.status, "READ", "never backwards");
    assert.equal(await row(id, "WHATSAPP"), null);

    // A failure report on a delivered message is recorded with plain wording.
    const id2 = await booking();
    await sendMessageForBooking(id2, "booking-confirmation", rest);
    const pid = t.sent[1].providerMessageId;
    await handle(influencerId, { providerMessageId: pid, status: "failed" });
    const failed = await row(id2, "WHATSAPP_WEB");
    assert.equal(failed?.status, "FAILED");
    assert.match(failed?.error ?? "", /not delivered/);
  } finally {
    setActiveSender(null);
    await h.manager.shutdown();
  }
});

test("end to end: the number is refused by the queue (no real booking for it), so the official connection carries the message", { skip, timeout: 120_000 }, async () => {
  const h = harness({ clock: new ManualClock(Date.now()) });
  const t = await openNumber(h);
  setActiveSender({ isReady: (id) => h.manager.isReady(id), send: (req) => h.manager.send(req) });
  try {
    h.guardAnswer.allow = false;
    const id = await booking();
    const f = fakes();
    const { qr: _drop, ...rest } = f.deps;
    void _drop;
    assert.equal(await sendMessageForBooking(id, "booking-confirmation", rest), "sent");
    assert.equal(t.sent.length, 0);
    assert.deepEqual(f.calls, ["whatsapp"]);
    assert.equal(await row(id, "WHATSAPP_WEB"), null, "refused before any attempt: no row");
  } finally {
    setActiveSender(null);
    await h.manager.shutdown();
  }
});
