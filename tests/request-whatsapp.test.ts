// The booking-request flow on WhatsApp (doc/16-request-whatsapp-flow.md), end to end against a real database, with every provider faked:
//   hold (route) -> request-received -> approve (route) -> request-approved with the payment link -> checkout -> payment captured
//   -> meeting -> booking-confirmation with the Meet link; decline (route) -> request-declined; expiry -> request-expired.
// The queue is a recorder (no Redis: REDIS_URL is removed), the linked number is the scriptable fake, the official WhatsApp and SMS are
// fakes, Google is a fake client, Razorpay is a stand-in, e-mail goes to a recorder. Nothing reaches a provider. Rows are timestamped and
// deleted in `after`, every step on its own so one failure cannot leave the rest behind. Passes with MESSAGING_DRY_RUN=true in the
// environment (it is set to false inside, so the injected senders are the ones used).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";
import { addDays, formatDateTime, istDayStart, istToday } from "../lib/india";
import { customerMessageRoute as customerRoute } from "../lib/message-route";
import { NO_MESSAGE_ROUTE_REASON, reportMessageFailure, sendMessageForBooking, type MessagingDeps } from "../lib/messaging";
import { NoMessageRouteError, type SendResult } from "../lib/sms";
import { setActiveSender, type WhatsAppWebSendRequest, type WhatsAppWebSendResult } from "../lib/whatsapp-web/send";
import { FakeTransport } from "../lib/whatsapp-web/fake-transport";
import { harness, ManualClock, settle, want } from "./helpers/whatsapp-web";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PHONE = "+919876543210";
const MEET = "https://meet.google.com/abc-defg-hij";
const ENV_KEYS = [
  "REDIS_URL", "RATE_LIMIT_STORE", "READINESS_REQUIRED", "READINESS_BYPASS", "MESSAGING_DRY_RUN", "WHATSAPP_QR_ENABLED", "WHATSAPP_QR_FAKE", "APP_URL", "EMAIL_PROVIDER", "ADMIN_ALERT_EMAILS",
  // The delivery route reads these (lib/message-route.ts): every test starts with no SMS and no official WhatsApp unless it sets them.
  "SMS_PROVIDER", "SMS_API_KEY", "SMS_API_URL", "MSG91_TEMPLATE_DEFAULT", "MSG91_TEMPLATE_REQUEST_APPROVED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "TWILIO_MESSAGING_SERVICE_SID", "WHATSAPP_PLATFORM_FALLBACK", "WHATSAPP_DISABLED",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;

type Ctx = { params: Promise<{ id: string }> };
type Answer = { status: number; body: Record<string, unknown> };
const jar = new Map<string, string>();

let authLib: typeof import("../lib/auth/session");
let holdRoute: { POST: (req: Request) => Promise<Response> };
let decisionRoute: { POST: (req: Request, ctx: Ctx) => Promise<Response> };
let requestMessages: typeof import("../lib/request-messages");
let approvalLib: typeof import("../lib/booking-approval");
let checkoutLib: typeof import("../lib/checkout");
let webhookLib: typeof import("../lib/payment-webhook");
let meetingLib: typeof import("../lib/meeting");
let selfServiceLib: typeof import("../lib/self-service");
let guardLib: typeof import("../lib/whatsapp-web/booking-guard");
let emailLib: typeof import("../lib/email");

let influencerId = "";
let slug = "";
let userId = "";
let ownerCookie = "";
let approvalServiceId = "";
let plainServiceId = "";
let userEmail = "";
let dayCounter = 3;
let emailCounter = 0;
let orderCounter = 0;

/** Every job the code asked the queue for (a fake `enqueueSendMessage` with BullMQ's "same job id twice is one job"). */
const jobs: { bookingId: string; template: string; suffix?: string }[] = [];
const jobIds = new Set<string>();
const sentEmails: { to: { email: string }; subject: string; html: string; text: string }[] = [];
/** Everything written to the console while the tests ran. */
const logged: string[] = [];
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };

const jobsFor = (bookingId: string, template?: string) => jobs.filter((j) => j.bookingId === bookingId && (template === undefined || j.template === template));

async function answer(res: Response): Promise<Answer> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const asOwner = () => {
  jar.clear();
  jar.set(authLib.sessionCookieName(), ownerCookie);
};

/** A slot of the approval service at 11:00 IST, `day` days from today (every weekday has rules from 10:00 to 13:00). */
function slotAt(day: number, minutes = 0): Date {
  return new Date(istDayStart(addDays(istToday(), day)).getTime() + (11 * 60 + minutes) * 60_000);
}
const nextSlot = () => slotAt(dayCounter++);

async function postHold(start: Date, over: Record<string, unknown> = {}, serviceId = approvalServiceId): Promise<Answer> {
  jar.clear();
  const body = { serviceId, startTime: start.toISOString(), name: "Req Customer", email: `rqw-${run}-${++emailCounter}@example.com`, whatsapp: freshPhone(), whatsappOptIn: true, ...over };
  return answer(await holdRoute.POST(new Request("http://localhost/api/bookings/hold", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })));
}
const decide = async (bookingId: string, body: unknown): Promise<Answer> => {
  asOwner();
  return answer(
    await decisionRoute.POST(new Request(`http://localhost/api/dashboard/bookings/${bookingId}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id: bookingId }),
    }),
  );
};

/** The customer was sent "request received" (the rule for "request expired" needs that). */
async function markReceivedDelivered(bookingId: string): Promise<void> {
  await prisma.message.create({ data: { bookingId, channel: "WHATSAPP_WEB", template: "request-received", status: "SENT", providerMessageId: `QR-${bookingId}`, sentAt: new Date() } });
}

/** A REQUESTED booking made straight in the database (the hold route is exercised by its own test). */
async function requestBooking(over: { optIn?: boolean; serviceId?: string; requestApproval?: boolean } = {}): Promise<string> {
  const start = nextSlot();
  const hold = await createHold({
    serviceId: over.serviceId ?? approvalServiceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Direct Customer",
    customerEmail: `rqw-${run}-${++emailCounter}@example.com`,
    whatsappE164: PHONE,
    whatsappOptIn: over.optIn ?? true,
    requestApproval: over.requestApproval ?? true,
  });
  return hold.id;
}

interface Fakes {
  deps: Partial<MessagingDeps>;
  calls: string[];
  qrSends: WhatsAppWebSendRequest[];
  official: { template: string; components: unknown[] | undefined }[];
  sms: { body: string; template?: string; variables?: string[] }[];
  ctl: { ready: boolean; official: "ok" | "fail"; sms: "ok" | "fail"; qr: (req: WhatsAppWebSendRequest) => WhatsAppWebSendResult };
}
/** The linked number, the official WhatsApp and SMS as recorders. */
function fakes(): Fakes {
  const calls: string[] = [];
  const qrSends: WhatsAppWebSendRequest[] = [];
  const official: Fakes["official"] = [];
  const sms: Fakes["sms"] = [];
  const ctl: Fakes["ctl"] = { ready: true, official: "ok", sms: "ok", qr: (req) => ({ ok: true, providerMessageId: `QR-${req.key}` }) };
  const deps: Partial<MessagingDeps> = {
    sendWhatsApp: async (input): Promise<SendResult> => {
      calls.push("whatsapp");
      official.push({ template: input.template, components: input.components });
      if (ctl.official === "fail") throw new Error("whatsapp down");
      return { providerMessageId: "wa-1" };
    },
    sendSMS: async (input): Promise<SendResult> => {
      calls.push("sms");
      sms.push({ body: input.body, template: input.template, variables: input.variables });
      if (ctl.sms === "fail") throw new Error("sms down");
      return { providerMessageId: "sms-1" };
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
  return { deps, calls, qrSends, official, sms, ctl };
}

/** What the approval flow gets from the queue when a message is on its way / when nothing is (the real thing is `queueRequestMessage`). */
const queuedOk = { queueMessage: async () => ({ route: "whatsapp-linked" as const, queued: true }) };
const queuedNo = { queueMessage: async () => ({ route: "none" as const, queued: false }) };

const row = (bookingId: string, channel: "WHATSAPP" | "WHATSAPP_WEB" | "SMS", template: string) =>
  prisma.message.findUnique({ where: { bookingId_channel_template: { bookingId, channel, template } } });

/** The payment link in a piece of text, or null. */
const payLinkIn = (text: string) => /https?:\/\/[^\s]+\/pay\/[^\s]+/.exec(text)?.[0] ?? null;

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  envSaved = true;
  for (const k of ENV_KEYS) delete process.env[k]; // a clean slate: no queue, no SMS, no official WhatsApp (set again below or per test)
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.READINESS_REQUIRED = ""; // a page is live without Google and payout details (read when lib/public.ts is first imported)
  process.env.READINESS_BYPASS = "true";
  process.env.MESSAGING_DRY_RUN = "false";
  process.env.WHATSAPP_QR_ENABLED = "true";
  delete process.env.WHATSAPP_QR_FAKE;
  process.env.APP_URL = "http://localhost:3000";
  process.env.EMAIL_PROVIDER = "log";
  delete process.env.ADMIN_ALERT_EMAILS;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => void logged.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(" "));
  }

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  // The queue: only the send-message producer is replaced; a job id already seen is one job, as in BullMQ.
  const realQueue = await import("../lib/queue");
  mock.module("@/lib/queue", {
    namedExports: {
      ...realQueue,
      enqueueSendMessage: async (bookingId: string, template = "booking-confirmation", suffix?: string) => {
        const id = `send-message-${template}-${bookingId}${suffix ? `-${suffix}` : ""}`;
        if (jobIds.has(id)) return;
        jobIds.add(id);
        jobs.push({ bookingId, template, ...(suffix ? { suffix } : {}) });
      },
    },
  });
  // Razorpay is never called: the order is made by this stand-in.
  const realPayments = await import("../lib/payments");
  mock.module("@/lib/payments", {
    namedExports: {
      ...realPayments,
      razorpayKeyId: () => "rzp_test_request_flow",
      createOrder: async (input: { amountMinor: number; currency: string }) => ({ id: `order_rqw_${run}_${++orderCounter}`, amount: input.amountMinor, currency: input.currency, status: "created" }),
    },
  });

  authLib = await import("../lib/auth/session");
  emailLib = await import("../lib/email");
  emailLib.setEmailSender(async (m) => {
    sentEmails.push(m as never);
    return { providerMessageId: null };
  });
  holdRoute = await import("../app/api/bookings/hold/route");
  decisionRoute = await import("../app/api/dashboard/bookings/[id]/decision/route");
  requestMessages = await import("../lib/request-messages");
  approvalLib = await import("../lib/booking-approval");
  checkoutLib = await import("../lib/checkout");
  webhookLib = await import("../lib/payment-webhook");
  meetingLib = await import("../lib/meeting");
  selfServiceLib = await import("../lib/self-service");
  guardLib = await import("../lib/whatsapp-web/booking-guard");
  const { saveGoogleToken } = await import("../lib/google-tokens");

  slug = `rqw-${run}`;
  userEmail = `rqw-owner-${run}@example.com`;
  influencerId = (await prisma.influencer.create({ data: { slug, name: `Asha Rao ${run}`, email: `rqw-inf-${run}@example.com`, onboardedAt: new Date() } })).id;
  userId = (await prisma.user.create({ data: { email: userEmail, passwordHash: "not-a-real-hash", emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), influencerId } })).id;
  ownerCookie = await authLib.createSession(userId);
  approvalServiceId = (await prisma.service.create({ data: { influencerId, title: "Portfolio review", durationMin: 30, priceMinor: 49900, requiresApproval: true } })).id;
  plainServiceId = (await prisma.service.create({ data: { influencerId, title: "Plain call", durationMin: 30, priceMinor: 19900 } })).id;
  await prisma.availabilityRule.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ influencerId, weekday, startTime: "10:00", endTime: "13:00", timezone: "Asia/Kolkata" })) });
  await saveGoogleToken(influencerId, "fake-refresh-token", "https://www.googleapis.com/auth/calendar.events", `rqw-cal-${run}@example.com`);
});

beforeEach(async () => {
  if (skip) return;
  process.env.MESSAGING_DRY_RUN = "false";
  process.env.WHATSAPP_QR_ENABLED = "true";
  setActiveSender(null);
  await prisma.whatsAppWebSession.upsert({
    where: { influencerId },
    create: { influencerId, status: "LINKED", wantLinked: true, phoneE164: "+919876500001" },
    update: { status: "LINKED", wantLinked: true, phoneE164: "+919876500001" },
  });
});

after(async () => {
  setActiveSender(null);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) console[level] = realConsole[level];
  // Every step on its own, so one failure (a pool timeout on a slow network) cannot leave the rest behind; the pool is always closed.
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[request-whatsapp] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      await step("webhook events", () => prisma.$executeRaw`DELETE FROM webhook_events WHERE event_id LIKE ${`evt_rqw_${run}%`}`);
      await step("user", () => prisma.user.deleteMany({ where: { email: userEmail } }));
      await step("influencer", () => prisma.influencer.deleteMany({ where: { slug: { startsWith: "rqw-", endsWith: run } } }));
    }
  } finally {
    try {
      emailLib?.setEmailSender(null);
    } catch {
      /* nothing to restore */
    }
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

// ---- 1. a request is made -----------------------------------------------------------------------------------------------------

test("hold of an approval service: one request-received job (booking id and template only), the text goes out once from the linked number, a retry sends nothing more", { skip }, async () => {
  const start = nextSlot();
  const res = await postHold(start, { whatsapp: PHONE }); // the number every other test uses for its direct bookings; its request stays open
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.requiresApproval, true);
  const bookingId = String(res.body.bookingId);

  assert.deepEqual(jobsFor(bookingId), [{ bookingId, template: "request-received" }], "one job, naming only the booking and the message");
  assert.ok(sentEmails.some((m) => /Request sent/i.test(m.subject) && m.to.email.startsWith(`rqw-${run}-`)), "the e-mail receipt still goes out");

  const f = fakes();
  assert.equal(await sendMessageForBooking(bookingId, "request-received", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr"]);
  const sent = f.qrSends[0];
  assert.equal(sent.kind, "request-received");
  assert.equal(sent.toE164, PHONE);
  assert.equal(sent.key, `${bookingId}:request-received:0`);
  assert.ok(sent.deadlineAtMs! >= Date.now() + 29 * 60_000 && sent.deadlineAtMs! <= Date.now() + 31 * 60_000, "30 minutes in the queue at most");
  const when = formatDateTime(start);
  assert.match(sent.text, /^Your booking request was received\./);
  for (const part of ["Portfolio review", `Requested time: ${when}`, "has 2 days to answer", "Nothing has been charged", "payment link will be sent to you here", "Your booking: http://localhost:3000/manage/"]) {
    assert.ok(sent.text.includes(part), `the text says "${part}":\n${sent.text}`);
  }
  assert.ok(!sent.text.includes("/pay/"), "no payment link before the host has answered");
  assert.equal((await row(bookingId, "WHATSAPP_WEB", "request-received"))?.status, "SENT");

  // The job runs again (a retry, or the same hold enqueued twice): nothing goes out a second time, on any channel.
  assert.equal(await sendMessageForBooking(bookingId, "request-received", f.deps), "already-sent");
  assert.deepEqual(f.calls, ["qr"]);
  await requestMessages.queueRequestMessage({ id: bookingId, influencerId, whatsappOptIn: true, whatsappE164: PHONE, redactedAt: null }, "request-received");
  assert.equal(jobsFor(bookingId, "request-received").length, 1, "the same job id is one job");
});

/** A request booking put in the state in which `kind` is otherwise allowed (so a skip can only be about the customer). */
async function inStateFor(kind: string, over: { optIn?: boolean } = {}): Promise<string> {
  const id = await requestBooking(over);
  const noop = queuedNo;
  if (kind === "request-approved") await approvalLib.approveRequest(influencerId, id, new Date(), noop);
  if (kind === "request-declined") await approvalLib.declineRequest(influencerId, id, null, new Date(), noop);
  if (kind === "request-expired") {
    await markReceivedDelivered(id);
    await prisma.booking.update({ where: { id }, data: { status: "EXPIRED" } });
  }
  return id;
}

test("a customer who did not opt in, has no number or was erased gets nothing: no job, no send", { skip }, async () => {
  const jobsBefore = jobs.length;
  const queue = requestMessages.queueRequestMessage;
  const nobody = { route: "none", queued: false };
  assert.deepEqual(await queue({ id: "x1", influencerId, whatsappOptIn: false, whatsappE164: PHONE, redactedAt: null }, "request-approved"), nobody);
  assert.deepEqual(await queue({ id: "x2", influencerId, whatsappOptIn: true, whatsappE164: "", redactedAt: null }, "request-approved"), nobody);
  assert.deepEqual(await queue({ id: "x3", influencerId, whatsappOptIn: true, whatsappE164: PHONE, redactedAt: new Date() }, "request-approved"), nobody);
  assert.equal(jobs.length, jobsBefore);

  // A job that exists anyway (queued before the customer asked to be forgotten, or an opt-in that was withdrawn) is skipped when it runs.
  for (const kind of ["request-received", "request-approved", "request-declined", "request-expired"]) {
    const control = fakes();
    assert.equal(await sendMessageForBooking(await inStateFor(kind), kind, control.deps), "sent", `${kind}: the same booking state sends when the customer is reachable`);
    const noOptIn = await inStateFor(kind, { optIn: false });
    const erased = await inStateFor(kind);
    await prisma.booking.update({ where: { id: erased }, data: { redactedAt: new Date() } });
    for (const id of [noOptIn, erased]) {
      const f = fakes();
      assert.equal(await sendMessageForBooking(id, kind, f.deps), "skipped", kind);
      assert.deepEqual(f.calls, [], `${kind}: no channel was tried`);
    }
  }
});

test("the hold route queues nothing for a service that does not need approval", { skip }, async () => {
  const res = await postHold(nextSlot(), {}, plainServiceId);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.requiresApproval, undefined);
  assert.deepEqual(jobsFor(String(res.body.bookingId)), [], "today's flow: pay at once, the confirmation follows the payment");
});

// ---- 2. the host accepts ------------------------------------------------------------------------------------------------------

let approvedBookingId = "";
let approvedPayBy: Date;

test("approve through the decision route: the route and the queued job, one request-approved job, and the text built at send time carries a working payment link, the amount in rupees, the IST deadline", { skip }, async () => {
  const start = nextSlot();
  const hold = await postHold(start);
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const bookingId = String(hold.body.bookingId);
  const emailsBefore = sentEmails.length;

  const res = await decide(bookingId, { action: "approve" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body).sort(), ["emailed", "messageQueued", "messageRoute", "ok", "payBy"], "payLink is only returned when nobody else will deliver it");
  assert.equal(res.body.ok, true);
  assert.equal(res.body.emailed, true);
  assert.equal(res.body.messageRoute, "whatsapp-linked", "the number is linked and wanted");
  assert.equal(res.body.messageQueued, true);
  assert.deepEqual(jobsFor(bookingId, "request-approved"), [{ bookingId, template: "request-approved" }], "the job holds no payment link");
  assert.ok(sentEmails.slice(emailsBefore).some((m) => /Approved: pay to confirm/.test(m.subject) && m.html.includes("/pay/")), "the e-mail with the payment link still goes out");

  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(booking.status, "HELD");
  const payBy = booking.holdExpiresAt!;
  const f = fakes();
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr"]);
  const sent = f.qrSends[0];
  assert.equal(sent.kind, "request-approved");
  assert.equal(sent.deadlineAtMs, payBy.getTime(), "the linked-number queue drops it after the time to pay");

  const link = payLinkIn(sent.text)!;
  assert.ok(link, `a payment link is in the text:\n${sent.text}`);
  assert.ok(link.startsWith("http://localhost:3000/pay/"));
  const token = decodeURIComponent(link.split("/pay/")[1]);
  assert.equal(selfServiceLib.verifyPayToken(token), bookingId, "the link is a valid payment link for THIS booking");
  const exp = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")).exp as number;
  assert.ok(Math.abs(exp - payBy.getTime() / 1000) <= 3, "built when the message was sent, valid until the pay-by time");
  assert.ok(sent.text.includes("Amount to pay: ₹499.00"), sent.text);
  assert.ok(sent.text.includes(`Pay by: ${formatDateTime(payBy)}.`) && formatDateTime(payBy).endsWith(" IST"), sent.text);
  assert.match(sent.text, /If it is not paid by then, the time is released\./);
  assert.ok(sent.text.includes(`When: ${formatDateTime(start)}`));
  assert.match(sent.text, /Your booking: http:\/\/localhost:3000\/manage\//);
  assert.match(sent.text, /^Good news: your booking request was accepted\./);

  // Retried: the same message is not sent again.
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", f.deps), "already-sent");
  assert.equal(f.qrSends.length, 1);
  approvedBookingId = bookingId;
  approvedPayBy = payBy;
});

test("without the linked number the official WhatsApp carries request-approved with seven parameters, and SMS falls back with the same values", { skip }, async () => {
  const bookingId = await requestBooking();
  await approvalLib.approveRequest(influencerId, bookingId, new Date(), queuedOk);
  const payBy = (await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).holdExpiresAt!;

  const f = fakes();
  f.ctl.ready = false; // the linked number is not connected
  f.ctl.official = "fail"; // and the official connection refuses, so SMS carries it
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", f.deps), "sent");
  assert.deepEqual(f.calls, ["whatsapp", "sms"]);
  const params = (f.official[0].components?.[0] as { parameters: { text: string }[] }).parameters.map((p) => p.text);
  assert.equal(params.length, 7);
  assert.deepEqual(params.slice(0, 2), ["Portfolio review", `Asha Rao ${run}`]);
  assert.equal(params[3], "₹499.00");
  assert.equal(params[4], formatDateTime(payBy));
  assert.equal(selfServiceLib.verifyPayToken(decodeURIComponent(params[5].split("/pay/")[1])), bookingId);
  assert.ok(params[6].startsWith("http://localhost:3000/manage/"));
  assert.equal(f.official[0].template, "request-approved");

  assert.equal(f.sms[0].template, "request-approved");
  assert.deepEqual(f.sms[0].variables, params, "SMS gets the same values in the same order as the template");
  for (const part of ["Request accepted", "₹499.00", formatDateTime(payBy), params[5]]) assert.ok(f.sms[0].body.includes(part), `SMS says ${part}: ${f.sms[0].body}`);
  assert.equal((await row(bookingId, "SMS", "request-approved"))?.status, "SENT");
  assert.equal((await row(bookingId, "WHATSAPP", "request-approved"))?.status !== "SENT", true, "the failed official attempt is not recorded as sent");
});

test("with no official connection for this influencer the request messages go straight to SMS, as the other messages do (nothing is tried that cannot work)", { skip }, async () => {
  const bookingId = await requestBooking();
  await approvalLib.approveRequest(influencerId, bookingId, new Date(), queuedOk);
  // The DEFAULT official sender resolves the influencer's own connection; none exists here, so it refuses before any network call.
  const f = fakes();
  f.ctl.ready = false;
  const { sendWhatsApp: _unused, ...withoutOfficial } = f.deps;
  void _unused;
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", withoutOfficial), "sent");
  assert.deepEqual(f.calls, ["sms"]);
  assert.equal((await row(bookingId, "SMS", "request-approved"))?.status, "SENT");
  assert.equal(await row(bookingId, "WHATSAPP", "request-approved"), null, "no failed WhatsApp row for something that was never tried");
});

// ---- 3. the customer pays: the confirmation with the Meet link ----------------------------------------------------------------

test("pay: checkout, the captured payment, the meeting, then the confirmation with the Google Meet link on WhatsApp (an approved request ends like any booking)", { skip }, async () => {
  const bookingId = approvedBookingId;
  assert.ok(bookingId, "the approval test above ran");

  const checkout = await checkoutLib.startCheckout(bookingId);
  assert.equal(checkout.amountMinor, 49900);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "PENDING_PAYMENT");

  const meetingJobs: string[] = [];
  const outcome = await webhookLib.handleRazorpayEvent(
    `evt_rqw_${run}_pay`,
    { event: "payment.captured", payload: { payment: { entity: { id: `pay_rqw_${run}`, order_id: checkout.orderId, amount: 49900, currency: "INR" } } } },
    async (id) => void meetingJobs.push(id),
  );
  assert.equal(outcome, "processed");
  assert.deepEqual(meetingJobs, [bookingId], "the create-meeting job is queued once");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "PAID");

  // The payment link message is no longer wanted once the booking is paid: the confirmation follows.
  const late = fakes();
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", late.deps), "skipped" as const);
  assert.deepEqual(late.calls, [], "a booking that became PAID before the approved message ran gets nothing from it");

  const confirmations: string[] = [];
  const google = {
    refreshAccessToken: async () => "fake-access-token",
    insertEvent: async (_t: string, ev: { id: string }) => ({ id: ev.id, status: "confirmed", meetLink: MEET, conferenceStatus: "success" as const }),
    getEvent: async () => null,
    addAttendee: async () => {
      throw new Error("not used");
    },
    updateEvent: async () => {
      throw new Error("not used");
    },
    removeAttendee: async () => ({ remaining: 0 }),
    deleteEvent: async () => {},
  };
  const meeting = await meetingLib.createMeetingForBooking(bookingId, {
    google,
    enqueueSendMessage: async (id) => void confirmations.push(id),
    enqueueReminders: async () => {},
    sendBookingEmail: (async () => {}) as never,
    alert: async () => {},
    sleep: async () => {},
  });
  assert.equal(meeting, "scheduled");
  assert.deepEqual(confirmations, [bookingId], "the confirmation job is queued once the meeting exists");
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
  assert.equal(booking.status, "SCHEDULED");
  assert.equal(booking.meetLink, MEET);

  const f = fakes();
  assert.equal(await sendMessageForBooking(bookingId, "booking-confirmation", f.deps), "sent");
  assert.deepEqual(f.calls, ["qr"]);
  assert.match(f.qrSends[0].text, /^Your booking is confirmed\./);
  assert.ok(f.qrSends[0].text.includes(`Join link: ${MEET}`), f.qrSends[0].text);
  assert.ok(f.qrSends[0].text.includes("To reschedule or cancel: http://localhost:3000/manage/"));
  assert.ok(!f.qrSends[0].text.includes("/pay/"), "the confirmation does not repeat the payment link");
  assert.equal((await row(bookingId, "WHATSAPP_WEB", "booking-confirmation"))?.status, "SENT");

  // The same booking, through the official path: the existing template and its four parameters.
  const g = fakes();
  g.ctl.ready = false;
  await prisma.message.deleteMany({ where: { bookingId, template: "booking-confirmation", channel: "WHATSAPP_WEB" } });
  assert.equal(await sendMessageForBooking(bookingId, "booking-confirmation", g.deps), "sent");
  assert.deepEqual(g.official.map((o) => o.template), ["booking-confirmation"]);
  assert.equal(((g.official[0].components?.[0] as { parameters: { text: string }[] }).parameters[0] as { text: string }).text, MEET);
});

test("a request-approved message is not sent once the time to pay has passed, and not while the booking is still a request", { skip }, async () => {
  const bookingId = await requestBooking();
  const f = fakes();
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", f.deps), "skipped", "a REQUESTED booking has nothing to pay yet");

  await approvalLib.approveRequest(influencerId, bookingId, new Date(), queuedOk);
  await prisma.booking.update({ where: { id: bookingId }, data: { holdExpiresAt: new Date(Date.now() - 1_000) } });
  assert.equal(await sendMessageForBooking(bookingId, "request-approved", f.deps), "skipped", "the pay-by time has gone: no link to a page that refuses payment");
  assert.deepEqual(f.calls, []);
  assert.equal(await guardLib.bookingAllowsMessage(influencerId, { bookingId, toE164: PHONE, kind: "request-approved" }), "not-sendable", "and the linked number's queue refuses it too");
});

// ---- 4. the host declines -----------------------------------------------------------------------------------------------------

test("decline through the route: the route and the queued job, one request-declined job, the text carries the host's note, nothing charged, and the booking page to pick another time", { skip }, async () => {
  const hold = await postHold(nextSlot());
  const bookingId = String(hold.body.bookingId);
  const emailsBefore = sentEmails.length;
  const res = await decide(bookingId, { action: "decline", reason: "  I am away that week  " });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, messageRoute: "whatsapp-linked", messageQueued: true });
  assert.deepEqual(jobsFor(bookingId, "request-declined"), [{ bookingId, template: "request-declined" }]);
  assert.ok(sentEmails.slice(emailsBefore).some((m) => /was not accepted/i.test(m.subject)), "the e-mail still goes out");

  const f = fakes();
  assert.equal(await sendMessageForBooking(bookingId, "request-declined", f.deps), "sent");
  const sent = f.qrSends[0];
  assert.match(sent.text, /^Your booking request was not accepted\./);
  assert.ok(sent.text.includes("Note from Asha Rao"), sent.text);
  assert.ok(sent.text.includes("I am away that week"));
  assert.ok(sent.text.includes("You were not charged anything."));
  assert.ok(sent.text.includes(`To pick another time: http://localhost:3000/${slug}`));
  assert.ok(!sent.text.includes("/pay/"));
  assert.ok(sent.deadlineAtMs! >= Date.now() + 5.9 * 3_600_000 && sent.deadlineAtMs! <= Date.now() + 6.1 * 3_600_000, "6 hours in the queue at most");

  // Official path: the template's five parameters, the note among them.
  const g = fakes();
  g.ctl.ready = false;
  await prisma.message.deleteMany({ where: { bookingId } });
  await sendMessageForBooking(bookingId, "request-declined", g.deps);
  const params = (g.official[0].components?.[0] as { parameters: { text: string }[] }).parameters.map((p) => p.text);
  assert.equal(params.length, 5);
  assert.equal(params[3], 'Their note: "I am away that week".');
  assert.equal(params[4], `http://localhost:3000/${slug}`);

  // A decline with no note says there was none; nothing is made up.
  const plain = await requestBooking();
  assert.deepEqual(await approvalLib.declineRequest(influencerId, plain, null, new Date(), queuedOk), { messageRoute: "whatsapp-linked", messageQueued: true });
  const h = fakes();
  await sendMessageForBooking(plain, "request-declined", h.deps);
  assert.ok(!h.qrSends[0].text.includes("Note from"), h.qrSends[0].text);
  // The official template and the SMS say so in a sentence, never an empty quote.
  const noNote = fakes();
  noNote.ctl.ready = false;
  noNote.ctl.official = "fail";
  await prisma.message.deleteMany({ where: { bookingId: plain } });
  await sendMessageForBooking(plain, "request-declined", noNote.deps);
  assert.equal(((noNote.official[0].components?.[0] as { parameters: { text: string }[] }).parameters[3] as { text: string }).text, "No reason was given.");
  assert.ok(noNote.sms[0].body.includes("No reason was given. You were not charged.") && !/note|\(none\)/i.test(noNote.sms[0].body), noNote.sms[0].body);
});

test("declining or approving a customer who did not opt in queues nothing and says so (no route, nothing queued)", { skip }, async () => {
  const noOptIn = await requestBooking({ optIn: false });
  const before = jobs.length;
  const res = await decide(noOptIn, { action: "approve" });
  assert.equal(res.status, 200);
  assert.equal(res.body.messageRoute, "none");
  assert.equal(res.body.messageQueued, false);
  const other = await requestBooking({ optIn: false });
  const declined = await decide(other, { action: "decline" });
  assert.deepEqual(declined.body, { ok: true, messageRoute: "none", messageQueued: false });
  assert.equal(jobs.length, before, "nothing was queued for either");
});

test("a queue that is down never breaks the answer: approve and decline still work, nothing is queued, and the failure is logged without any link", { skip }, async () => {
  const bookingId = await requestBooking();
  const down = {
    queueMessage: (b: Parameters<typeof requestMessages.queueRequestMessage>[0], t: Parameters<typeof requestMessages.queueRequestMessage>[1]) =>
      requestMessages.queueRequestMessage(b, t, {
        route: async () => "whatsapp-linked",
        enqueue: async () => {
          throw new Error("Redis is down");
        },
      }),
  };
  const approved = await approvalLib.approveRequest(influencerId, bookingId, new Date(), down);
  assert.equal(approved.messageQueued, false);
  assert.equal(approved.messageRoute, "whatsapp-linked", "a route existed; the queue did not take the job");
  assert.equal(approved.emailed, true);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } })).status, "HELD");
  const other = await requestBooking();
  assert.deepEqual(await approvalLib.declineRequest(influencerId, other, "no", new Date(), down), { messageRoute: "whatsapp-linked", messageQueued: false });
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: other } })).status, "CANCELLED");
  assert.ok(logged.some((l) => l.includes(`could not queue "request-approved" for booking ${bookingId}: Redis is down`)));
});

/** Runs `fn` with the e-mail transport that refuses (doc/15: no platform e-mail, no Gmail), so the customer is never e-mailed. */
async function withoutEmail<T>(fn: () => Promise<T>): Promise<T> {
  process.env.EMAIL_PROVIDER = "none";
  emailLib.setEmailSender(null); // the recorder would hide that: use the real (refusing) transport of the environment
  try {
    return await fn();
  } finally {
    process.env.EMAIL_PROVIDER = "log";
    emailLib.setEmailSender(async (m) => {
      sentEmails.push(m as never);
      return { providerMessageId: null };
    });
  }
}

/** Puts the world in the state of one delivery route and returns a function that puts it back. */
async function arrangeRoute(route: "whatsapp-linked" | "whatsapp-official" | "sms" | "none"): Promise<() => Promise<void>> {
  const undo: (() => Promise<void> | void)[] = [];
  const setEnv = (name: (typeof ENV_KEYS)[number], value: string) => {
    const before = process.env[name];
    process.env[name] = value;
    undo.push(() => (before === undefined ? void delete process.env[name] : void (process.env[name] = before)));
  };
  if (route !== "whatsapp-linked") {
    setEnv("WHATSAPP_QR_ENABLED", "false");
  }
  if (route === "whatsapp-official") {
    await prisma.whatsAppConnection.create({
      data: { influencerId, wabaId: `waba-${run}`, phoneNumberId: `pn-${run}`, tokenEnc: "not-a-token", status: "ACTIVE", templates: { "request-approved": { status: "APPROVED", language: "en" }, "request-declined": { status: "APPROVED", language: "en" }, "request-received": { status: "APPROVED", language: "en" } } },
    });
    undo.push(async () => {
      await prisma.whatsAppConnection.deleteMany({ where: { influencerId } });
    });
  }
  if (route === "sms") {
    setEnv("SMS_PROVIDER", "generic");
    setEnv("SMS_API_URL", "https://sms.invalid/send");
    setEnv("SMS_API_KEY", "not-a-key");
  }
  return async () => {
    for (const fn of undo.reverse()) await fn();
  };
}

test("each delivery route decides what is queued and what the host is told; with no route nothing is queued and the host gets the payment link", { skip }, async () => {
  const cases = [
    { route: "whatsapp-linked", queued: true },
    { route: "whatsapp-official", queued: true },
    { route: "sms", queued: true },
    { route: "none", queued: false },
  ] as const;
  for (const c of cases) {
    const restore = await arrangeRoute(c.route);
    try {
      const bookingId = await requestBooking();
      const jobsBefore = jobs.length;
      // The customer could not be e-mailed, so the host's answer shows whether anything else will reach them.
      const approved = await withoutEmail(() => approvalLib.approveRequest(influencerId, bookingId));
      assert.equal(approved.emailed, false, c.route);
      assert.equal(approved.messageRoute, c.route);
      assert.equal(approved.messageQueued, c.queued, c.route);
      assert.equal(jobs.length - jobsBefore, c.queued ? 1 : 0, `${c.route}: ${c.queued ? "one job" : "no job at all"}`);
      if (c.queued) assert.equal(approved.payUrl, null, `${c.route}: a message is on its way, the host is not asked to send the link`);
      else assert.match(String(approved.payUrl), /^http:\/\/localhost:3000\/pay\//, "no route: the link goes to the host's screen (never logged)");

      const declined = await requestBooking();
      const out = await approvalLib.declineRequest(influencerId, declined, null);
      assert.deepEqual(out, { messageRoute: c.route, messageQueued: c.queued }, c.route);
    } finally {
      await restore();
    }
  }
});

test("the decision route with no way to reach the customer: the red 'send it yourself' answer, the link for the host, and no job", { skip }, async () => {
  const restore = await arrangeRoute("none");
  try {
    const hold = await postHold(nextSlot());
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    const bookingId = String(hold.body.bookingId);
    assert.deepEqual(jobsFor(bookingId), [], "no route: the request-received message was not even queued");

    const res = await withoutEmail(() => decide(bookingId, { action: "approve" }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(Object.keys(res.body).sort(), ["emailed", "messageQueued", "messageRoute", "ok", "payBy", "payLink"]);
    assert.equal(res.body.emailed, false);
    assert.equal(res.body.messageRoute, "none");
    assert.equal(res.body.messageQueued, false);
    assert.match(String(res.body.payLink), /^http:\/\/localhost:3000\/pay\//);
    assert.deepEqual(jobsFor(bookingId), [], "and nothing was queued for the payment link");
    const customerLink = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    assert.equal(customerLink.status, "HELD", "approved all the same");
  } finally {
    await restore();
  }
});

test("a template Meta has not approved yet is not a route: the official connection counts only with the template approved", { skip }, async () => {
  const restore = await arrangeRoute("none");
  try {
    const connection = await prisma.whatsAppConnection.create({
      data: { influencerId, wabaId: `waba-p-${run}`, phoneNumberId: `pn-p-${run}`, tokenEnc: "not-a-token", status: "ACTIVE", templates: { "request-approved": { status: "PENDING", language: "en" } } },
    });
    const routeFor = (template: string) => customerRoute(influencerId, template);
    assert.equal(await routeFor("request-approved"), "none", "PENDING at Meta: the message would only fall through to SMS, which is not set up");
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { templates: { "request-approved": { status: "REJECTED", language: "en" } } } });
    assert.equal(await routeFor("request-approved"), "none");
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { templates: { "request-approved": { status: "APPROVED", language: "en" } } } });
    assert.equal(await routeFor("request-approved"), "whatsapp-official");
    assert.equal(await routeFor("request-declined"), "none", "another template's approval says nothing about this one");
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { templates: { "request-approved": { status: "FLAGGED", language: "en" } } } });
    assert.equal(await routeFor("request-approved"), "whatsapp-official", "Meta keeps delivering a flagged template, as the sender does");
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { status: "ERROR" } });
    assert.equal(await routeFor("request-approved"), "none", "a connection that needs renewing is not a route");
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { status: "ACTIVE" } });
    // The linked number comes first when there is one.
    process.env.WHATSAPP_QR_ENABLED = "true";
    assert.equal(await routeFor("request-approved"), "whatsapp-linked");
    process.env.WHATSAPP_QR_ENABLED = "false";
    await prisma.whatsAppConnection.deleteMany({ where: { influencerId } });
  } finally {
    await restore();
  }
});

test("SMS is a route only when the provider is set up for that message", { skip }, async () => {
  const restore = await arrangeRoute("none");
  const env = (pairs: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(pairs)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  try {
    const routeFor = (template: string) => customerRoute(influencerId, template);
    env({ SMS_PROVIDER: "msg91", SMS_API_KEY: "k" });
    assert.equal(await routeFor("request-approved"), "none", "MSG91 without a flow id for this message cannot send it");
    env({ MSG91_TEMPLATE_REQUEST_APPROVED: "flow-approved" });
    assert.equal(await routeFor("request-approved"), "sms");
    assert.equal(await routeFor("request-declined"), "none", "its own flow id, not another message's");
    env({ MSG91_TEMPLATE_DEFAULT: "flow-default" });
    assert.equal(await routeFor("request-declined"), "sms", "the default flow carries any message");
    env({ SMS_API_KEY: undefined });
    assert.equal(await routeFor("request-approved"), "none", "no key");
    env({ SMS_PROVIDER: "twilio", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t" });
    assert.equal(await routeFor("request-received"), "none", "Twilio without a sender");
    env({ TWILIO_FROM: "+15550001111" });
    assert.equal(await routeFor("request-received"), "sms");
    env({ SMS_PROVIDER: "generic", SMS_API_URL: "https://sms.invalid/x", SMS_API_KEY: "k" });
    assert.equal(await routeFor("request-expired"), "sms");
    env({ SMS_API_URL: undefined });
    assert.equal(await routeFor("request-expired"), "none");
    // A dry run only logs: the official route is reported (nothing is sent, nothing can fail).
    env({ MESSAGING_DRY_RUN: "true" });
    assert.equal(await routeFor("request-expired"), "whatsapp-official");
    env({ MESSAGING_DRY_RUN: "false" });
    env({ WHATSAPP_DISABLED: "true", SMS_API_URL: "https://sms.invalid/x" });
    assert.equal(await routeFor("request-expired"), "sms");
  } finally {
    for (const k of ["SMS_PROVIDER", "SMS_API_KEY", "SMS_API_URL", "MSG91_TEMPLATE_DEFAULT", "MSG91_TEMPLATE_REQUEST_APPROVED", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "WHATSAPP_DISABLED"]) delete process.env[k];
    await restore();
  }
});

test("a host suspended between the approval and the send: the payment link is not sent (its page says 'unavailable'); a decline is still told", { skip }, async () => {
  const approved = await requestBooking();
  await approvalLib.approveRequest(influencerId, approved, new Date(), queuedOk);
  const declined = await requestBooking();
  await approvalLib.declineRequest(influencerId, declined, "no", new Date(), queuedOk);
  await prisma.influencer.update({ where: { id: influencerId }, data: { suspendedAt: new Date(), suspendedReason: "test" } });
  try {
    const f = fakes();
    assert.equal(await sendMessageForBooking(approved, "request-approved", f.deps), "skipped");
    assert.deepEqual(f.calls, [], "no channel was tried");
    assert.equal(await guardLib.bookingAllowsMessage(influencerId, { bookingId: approved, toE164: PHONE, kind: "request-approved" }), "not-sendable");
    assert.equal(await sendMessageForBooking(declined, "request-declined", f.deps), "sent", "the customer is still told that the request was not accepted");
  } finally {
    await prisma.influencer.update({ where: { id: influencerId }, data: { suspendedAt: null, suspendedReason: null } });
  }
  const g = fakes();
  assert.equal(await sendMessageForBooking(approved, "request-approved", g.deps), "sent", "reinstated: the same message goes out");
});

test("a payment link that is too late is dropped on EVERY channel: the linked number's 'expired' is final for request-approved, and the clock is checked again before the official route", { skip }, async () => {
  // The linked number's queue says the message waited past its deadline (the pay-by time): not sent anywhere.
  const a = await requestBooking();
  await approvalLib.approveRequest(influencerId, a, new Date(), queuedOk);
  const f = fakes();
  f.ctl.qr = () => ({ ok: false, reason: "expired", retryable: false });
  assert.equal(await sendMessageForBooking(a, "request-approved", f.deps), "skipped");
  assert.deepEqual(f.calls, ["qr"], "no official WhatsApp, no SMS, with a link and a pay-by time that are now in the past");
  assert.equal(await row(a, "WHATSAPP_WEB", "request-approved"), null, "no row left behind");
  assert.equal(await row(a, "WHATSAPP", "request-approved"), null);
  assert.equal(await row(a, "SMS", "request-approved"), null);

  // Other messages are as before: a decline that waited too long still goes out by the next channel.
  const d = await requestBooking();
  await approvalLib.declineRequest(influencerId, d, null, new Date(), queuedOk);
  const g = fakes();
  g.ctl.qr = () => ({ ok: false, reason: "expired", retryable: false });
  assert.equal(await sendMessageForBooking(d, "request-declined", g.deps), "sent");
  assert.deepEqual(g.calls, ["qr", "whatsapp"]);

  // The pay-by time passes while the linked number holds the message, and the linked number then refuses for another reason (busy):
  // the official route and SMS must not send the link built at the start of the run.
  const b = await requestBooking();
  await approvalLib.approveRequest(influencerId, b, new Date(), queuedOk);
  await prisma.booking.update({ where: { id: b }, data: { holdExpiresAt: new Date(Date.now() + 6_000) } });
  const h = fakes();
  const realQr = h.deps.qr!;
  h.deps.qr = {
    isReady: realQr.isReady,
    send: async (req) => {
      await new Promise((r) => setTimeout(r, 7_000)); // the message waits in the linked number's queue until the time to pay is over
      return realQr.send(req);
    },
  };
  h.ctl.qr = () => ({ ok: false, reason: "busy", retryable: true });
  assert.equal(await sendMessageForBooking(b, "request-approved", h.deps), "skipped");
  assert.deepEqual(h.calls, ["qr"], "not by the official route, not by SMS");
  assert.equal(await row(b, "SMS", "request-approved"), null);
});

// ---- 5a. no route at all: no retries, no alerts for the request messages ------------------------------------------------------------

/** The world with no way to reach the customer: the number is not linked, no official connection, and SMS says it is not set up. */
async function withNoRoute(): Promise<{ deps: Partial<MessagingDeps>; calls: string[]; alerts: string[] }> {
  await prisma.whatsAppWebSession.update({ where: { influencerId }, data: { status: "NOT_LINKED", wantLinked: false } });
  const f = fakes();
  f.ctl.ready = false;
  const alerts: string[] = [];
  const calls: string[] = [];
  const { sendWhatsApp: _official, ...rest } = f.deps; // the DEFAULT official sender: this influencer has no connection, so it refuses before any network call
  void _official;
  return {
    deps: {
      ...rest,
      sendSMS: async () => {
        calls.push("sms");
        throw new NoMessageRouteError("SMS is not set up (SMS_API_KEY is missing)");
      },
      alert: async (_id, a) => void alerts.push(a.kind),
    },
    calls,
    alerts,
  };
}

test("no route at all: a request message records ONE plain FAILED row and is done (no retry, no alert, no booking error); the five booking events keep today's retries and alerts", { skip }, async () => {
  for (const kind of ["request-received", "request-approved", "request-declined", "request-expired"]) {
    const id = await inStateFor(kind);
    const w = await withNoRoute();
    assert.equal(await sendMessageForBooking(id, kind, w.deps), "skipped", `${kind}: finished, not failed (a thrown error would be retried five times)`);
    assert.deepEqual(w.calls, ["sms"], "SMS was asked once");
    const rows = await prisma.message.findMany({ where: { bookingId: id, template: kind } });
    assert.deepEqual(rows.map((r) => [r.channel, r.status, r.error]), [["SMS", "FAILED", "No WhatsApp or SMS route for this message"]], `${kind}: one row, one plain reason`);
    assert.equal(NO_MESSAGE_ROUTE_REASON, "No WhatsApp or SMS route for this message");
    assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id } })).lastError, null, `${kind}: no booking error`);
    assert.deepEqual(w.alerts, [], `${kind}: the host is not alerted`);
    // Run again (a duplicate job): still one row, still done.
    assert.equal(await sendMessageForBooking(id, kind, w.deps), "skipped");
    assert.equal(await prisma.message.count({ where: { bookingId: id, template: kind } }), 1);
    await prisma.whatsAppWebSession.update({ where: { influencerId }, data: { status: "LINKED", wantLinked: true } });
  }

  // A paid customer who is missing the Meet link must still alert the host: same situation, the existing message.
  const paid = await requestBooking();
  await prisma.booking.update({ where: { id: paid }, data: { status: "SCHEDULED", meetLink: MEET, holdExpiresAt: null } });
  const w = await withNoRoute();
  await assert.rejects(sendMessageForBooking(paid, "booking-confirmation", w.deps), NoMessageRouteError, "today's behaviour: the job fails and is retried");
  const row0 = await row(paid, "SMS", "booking-confirmation");
  assert.match(row0?.error ?? "", /SMS is not set up/);
  assert.notEqual(row0?.status, "SENT");
  await reportMessageFailure(paid, "booking-confirmation", "SMS is not set up (SMS_API_KEY is missing)", async (_id, a) => void w.alerts.push(a.kind));
  assert.deepEqual(w.alerts, ["message-delivery-failed"], "the host is alerted, as before");
  assert.match((await prisma.booking.findUniqueOrThrow({ where: { id: paid } })).lastError ?? "", /Could not deliver "booking-confirmation"/);
});

test("a send that really failed, or a linked number that is expected back, is still retried (only 'nothing could even be tried' is final)", { skip }, async () => {
  // The official connection was tried and failed, and SMS is not set up: a real failure, retried as before.
  const a = await inStateFor("request-approved");
  await prisma.whatsAppWebSession.update({ where: { influencerId }, data: { status: "NOT_LINKED", wantLinked: false } });
  const f = fakes();
  f.ctl.ready = false;
  f.deps.sendWhatsApp = async () => {
    throw new Error("Meta said no");
  };
  f.deps.sendSMS = async () => {
    throw new NoMessageRouteError("SMS is not set up");
  };
  await assert.rejects(sendMessageForBooking(a, "request-approved", f.deps), NoMessageRouteError);
  assert.equal((await row(a, "WHATSAPP", "request-approved"))?.error, "Meta said no", "the real attempt is recorded");

  // The linked number is linked and wanted but busy right now (retryable), and nothing else routes: try again later.
  await prisma.whatsAppWebSession.update({ where: { influencerId }, data: { status: "LINKED", wantLinked: true } });
  const b = await inStateFor("request-declined");
  const busy = await withNoRoute();
  await prisma.whatsAppWebSession.update({ where: { influencerId }, data: { status: "LINKED", wantLinked: true } });
  const g = fakes();
  g.ctl.qr = () => ({ ok: false, reason: "busy", retryable: true });
  await assert.rejects(sendMessageForBooking(b, "request-declined", { ...busy.deps, qr: g.deps.qr }), NoMessageRouteError, "busy now, expected back: the job is retried");
  assert.equal(await row(b, "SMS", "request-declined").then((r) => r?.error === NO_MESSAGE_ROUTE_REASON), false, "not recorded as 'no route'");

  // The same linked number reconnecting (the worker's socket is not open, the stored status says linked): also later.
  const c = await inStateFor("request-declined");
  const h = fakes();
  h.ctl.ready = false;
  await assert.rejects(sendMessageForBooking(c, "request-declined", { ...busy.deps, qr: h.deps.qr }), NoMessageRouteError);

  // A refusal that is final for this message (the daily limit) is not a reason to wait: no route, done.
  const d = await inStateFor("request-declined");
  const cap = fakes();
  cap.ctl.qr = () => ({ ok: false, reason: "daily-cap", retryable: false });
  assert.equal(await sendMessageForBooking(d, "request-declined", { ...busy.deps, qr: cap.deps.qr }), "skipped");
  assert.equal((await row(d, "SMS", "request-declined"))?.error, NO_MESSAGE_ROUTE_REASON);
});

// ---- 5. the request expires ---------------------------------------------------------------------------------------------------

test("expiry: each unanswered request is expired and queued once for request-expired; an approved hold that lapsed unpaid, a plain hold, and a customer who did not opt in are not messaged", { skip }, async () => {
  const mine = { session: { service: { influencerId } } };
  const enqueued: { id: string; template: string }[] = [];
  const enqueue = async (id: string, template: string) => void enqueued.push({ id, template });
  // Holds that earlier tests of this file let lapse are expired first, so the counts below are only about this test's bookings.
  await requestMessages.expireStaleHoldsAndNotify(new Date(), { enqueue: async () => {}, scope: mine });

  const lapsed = await requestBooking();
  await markReceivedDelivered(lapsed);
  const lapsedNoOptIn = await requestBooking({ optIn: false });
  const approvedLapsed = await requestBooking();
  await approvalLib.approveRequest(influencerId, approvedLapsed, new Date(), queuedOk);
  const plainHold = await requestBooking({ serviceId: plainServiceId, requestApproval: false });
  const stillOpen = await requestBooking();
  const past = new Date(Date.now() - 60_000);
  await prisma.booking.updateMany({ where: { id: { in: [lapsed, lapsedNoOptIn, approvedLapsed, plainHold] } }, data: { holdExpiresAt: past } });

  const now = new Date();
  const result = await requestMessages.expireStaleHoldsAndNotify(now, { enqueue, scope: mine });
  assert.deepEqual(result, { expired: 4, requests: 2, queued: 1 }, JSON.stringify(result));
  assert.deepEqual(enqueued, [{ id: lapsed, template: "request-expired" }]);
  const status = async (id: string) => (await prisma.booking.findUniqueOrThrow({ where: { id } })).status;
  assert.equal(await status(lapsed), "EXPIRED");
  assert.equal(await status(lapsedNoOptIn), "EXPIRED");
  assert.equal(await status(approvedLapsed), "EXPIRED", "expired as before");
  assert.equal(await status(plainHold), "EXPIRED", "expired as before");
  assert.equal(await status(stillOpen), "REQUESTED", "a request that is still open is left alone");

  // A second sweep finds nothing new: no second message.
  assert.deepEqual(await requestMessages.expireStaleHoldsAndNotify(new Date(), { enqueue, scope: mine }), { expired: 0, requests: 0, queued: 0 });
  assert.equal(enqueued.length, 1);

  // The message itself.
  const f = fakes();
  assert.equal(await sendMessageForBooking(lapsed, "request-expired", f.deps), "sent");
  const sent = f.qrSends[0];
  assert.match(sent.text, /^Your booking request was not confirmed in time\./);
  assert.ok(sent.text.includes("so the time was released. You were not charged anything."));
  assert.ok(sent.text.includes(`To request a time again: http://localhost:3000/${slug}`));
  assert.ok(sent.deadlineAtMs! >= Date.now() + 5.9 * 3_600_000 && sent.deadlineAtMs! <= Date.now() + 6.1 * 3_600_000);
  assert.equal(await sendMessageForBooking(lapsed, "request-expired", f.deps), "already-sent");

  // Out of scope here, recorded in doc/16: the approved request nobody paid. Even a job queued for it by mistake sends nothing, and neither does a plain hold.
  for (const id of [approvedLapsed, plainHold, lapsedNoOptIn]) {
    const g = fakes();
    assert.equal(await sendMessageForBooking(id, "request-expired", g.deps), "skipped", id);
    assert.deepEqual(g.calls, []);
  }
  // A request answered meanwhile is not contradicted: a declined one is not "expired", an approved one is not either.
  const g = fakes();
  assert.equal(await sendMessageForBooking(stillOpen, "request-expired", g.deps), "skipped");
});

test("expiry: a queue that is down does not stop the sweep (the requests are expired, the loss is logged once, no link in it)", { skip }, async () => {
  const mine = { session: { service: { influencerId } } };
  const a = await requestBooking();
  const b = await requestBooking();
  await prisma.booking.updateMany({ where: { id: { in: [a, b] } }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
  let attempts = 0;
  const result = await requestMessages.expireStaleHoldsAndNotify(new Date(), {
    scope: mine,
    enqueue: async () => {
      attempts += 1;
      throw new Error("Redis is down");
    },
  });
  assert.equal(result.requests, 2);
  assert.equal(result.queued, 0);
  assert.equal(attempts, 1, "one failure is enough: no waiting on a dead queue for every request");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: a } })).status, "EXPIRED");
  assert.ok(logged.some((l) => l.includes('2 "request expired" message(s) could not be queued') || l.includes('1 "request expired" message(s) could not be queued')));
});

// ---- 5b. abuse: a stranger's number cannot be made to receive messages on demand ------------------------------------------------

/** A phone number only this test uses (an Indian mobile: ten digits, the first 6-9). */
let phoneCounter = 0;
const freshPhone = () => `+919${String(100_000_000 + Number(String(run).slice(-6)) * 10 + ++phoneCounter).slice(-9)}`;

test("one phone number: one request waiting per host, three requests a day; a flood of requests to one number stops, other numbers and ordinary bookings are not affected", { skip }, async () => {
  const { IDENTITY_RULES } = await import("../lib/rate-limit/policies");
  assert.deepEqual([IDENTITY_RULES.holdPhone.name, IDENTITY_RULES.holdPhone.limit, IDENTITY_RULES.holdPhone.windowMs], ["hold-phone", 3, 24 * 3_600_000]);

  const victim = freshPhone();
  const first = await postHold(nextSlot(), { whatsapp: victim });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstId = String(first.body.bookingId);
  assert.equal(jobsFor(firstId, "request-received").length, 1, "the first request messages the number");

  // A second request for the same number and host while the first waits: refused, nothing queued, nothing created.
  const bookingsBefore = await prisma.booking.count({ where: { whatsappE164: victim } });
  const second = await postHold(nextSlot(), { whatsapp: victim });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(String(second.body.error), /already have a request waiting for this host/);
  assert.equal(await prisma.booking.count({ where: { whatsappE164: victim } }), bookingsBefore, "no booking was made");
  assert.equal(jobsFor(firstId).length, 1, "and no second message was queued for it");

  // Another number is not affected, and neither is an ordinary booking with the first number.
  const other = await postHold(nextSlot(), { whatsapp: freshPhone() });
  assert.equal(other.status, 201, JSON.stringify(other.body));
  const plain = await postHold(nextSlot(), { whatsapp: victim }, plainServiceId);
  assert.equal(plain.status, 201, "a service without approval sends nothing before payment: not limited by this rule");
  assert.deepEqual(jobsFor(String(plain.body.bookingId)), []);

  // Once the host has answered, the number may ask again (this was attempt 2 of 3 today)...
  assert.equal((await decide(firstId, { action: "decline" })).status, 200);
  const third = await postHold(nextSlot(), { whatsapp: victim });
  assert.equal(third.status, 201, JSON.stringify(third.body));
  // ...but not a fourth time within the day, whatever the host does.
  assert.equal((await decide(String(third.body.bookingId), { action: "decline" })).status, 200);
  const jobsBeforeFourth = jobs.length;
  const fourth = await postHold(nextSlot(), { whatsapp: victim });
  assert.equal(fourth.status, 429, JSON.stringify(fourth.body));
  assert.match(String(fourth.body.error), /already been used for several booking requests today/);
  assert.equal(await prisma.booking.count({ where: { whatsappE164: victim, status: "REQUESTED" } }), 0);
  assert.equal(jobs.length, jobsBeforeFourth, "nothing was queued");
});

test("the open-request limit is race free: two requests at the same moment for one number make one booking", { skip }, async () => {
  const phone = freshPhone();
  const mk = (start: Date) =>
    createHold({
      serviceId: approvalServiceId,
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60_000),
      capacity: 1,
      customerName: "Racer",
      customerEmail: `rqw-${run}-${++emailCounter}@example.com`,
      whatsappE164: phone,
      whatsappOptIn: true,
      requestApproval: true,
      maxOpenRequestsPerNumber: 1,
    });
  const results = await Promise.allSettled([mk(nextSlot()), mk(nextSlot()), mk(nextSlot())]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof Error && /already have a request waiting/.test(r.reason.message), String(r.reason));
  // Callers that do not pass the limit (tests, tools) are not limited.
  const start = nextSlot();
  const free = await createHold({ serviceId: approvalServiceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), capacity: 1, customerName: "Free", customerEmail: `rqw-${run}-${++emailCounter}@example.com`, whatsappE164: phone, whatsappOptIn: true, requestApproval: true });
  assert.equal(free.status, "REQUESTED");
});

test("'request expired' goes only to a customer who was really told about the request", { skip }, async () => {
  const told = await requestBooking();
  const strangerNumber = await requestBooking();
  await markReceivedDelivered(told);
  await prisma.booking.updateMany({ where: { id: { in: [told, strangerNumber] } }, data: { status: "EXPIRED" } });

  const f = fakes();
  assert.equal(await sendMessageForBooking(strangerNumber, "request-expired", f.deps), "skipped", "nothing was ever delivered to this number about the request");
  assert.deepEqual(f.calls, []);
  assert.equal(await guardLib.bookingAllowsMessage(influencerId, { bookingId: strangerNumber, toE164: PHONE, kind: "request-expired" }), "not-sendable");
  assert.equal(await guardLib.bookingAllowsMessage(influencerId, { bookingId: told, toE164: PHONE, kind: "request-expired" }), true);
  assert.equal(await sendMessageForBooking(told, "request-expired", f.deps), "sent");

  // A "request received" that failed or is still pending does not count as delivered.
  const failedFirst = await requestBooking();
  await prisma.message.create({ data: { bookingId: failedFirst, channel: "SMS", template: "request-received", status: "FAILED", error: "No WhatsApp or SMS route for this message" } });
  await prisma.message.create({ data: { bookingId: failedFirst, channel: "WHATSAPP_WEB", template: "request-received", status: "PENDING", error: "in-flight" } });
  await prisma.booking.update({ where: { id: failedFirst }, data: { status: "EXPIRED" } });
  assert.equal(await sendMessageForBooking(failedFirst, "request-expired", f.deps), "skipped");
  // Delivered by any customer channel counts (official WhatsApp, SMS, the linked number; delivered and read too).
  for (const [channel, status] of [["WHATSAPP", "SENT"], ["SMS", "DELIVERED"], ["WHATSAPP_WEB", "READ"]] as const) {
    const id = await requestBooking();
    await prisma.message.create({ data: { bookingId: id, channel, template: "request-received", status, sentAt: new Date() } });
    await prisma.booking.update({ where: { id }, data: { status: "EXPIRED" } });
    assert.equal(await sendMessageForBooking(id, "request-expired", fakes().deps), "sent", `${channel}/${status}`);
  }
});

// ---- 6. the linked number's booking check --------------------------------------------------------------------------------------

test("the linked number's queue asks the same question as the sender for the four request messages", { skip }, async () => {
  const requested = await requestBooking();
  const approved = await requestBooking();
  await approvalLib.approveRequest(influencerId, approved, new Date(), queuedOk);
  const declined = await requestBooking();
  await approvalLib.declineRequest(influencerId, declined, "no", new Date(), queuedOk);
  const expired = await requestBooking();
  await markReceivedDelivered(expired);
  await prisma.booking.update({ where: { id: expired }, data: { status: "EXPIRED" } });
  const paid = await requestBooking();
  await approvalLib.approveRequest(influencerId, paid, new Date(), queuedOk);
  await prisma.booking.update({ where: { id: paid }, data: { status: "PAID", holdExpiresAt: null } });

  const kinds = ["request-received", "request-approved", "request-declined", "request-expired"];
  const expectedAllowed: Record<string, string> = { [requested]: "request-received", [approved]: "request-approved", [declined]: "request-declined", [expired]: "request-expired" };
  for (const [bookingId, allowedKind] of [...Object.entries(expectedAllowed), [paid, ""]] as [string, string][]) {
    for (const kind of kinds) {
      const queue = await guardLib.bookingAllowsMessage(influencerId, { bookingId, toE164: PHONE, kind });
      const f = fakes();
      f.ctl.ready = false;
      const sender = await sendMessageForBooking(bookingId, kind, f.deps);
      const senderAllows = sender !== "skipped";
      assert.equal(queue === true, kind === allowedKind, `queue: ${kind} for a booking that allows only "${allowedKind}"`);
      assert.equal(senderAllows, kind === allowedKind, `sender: ${kind} for a booking that allows only "${allowedKind}"`);
      await prisma.message.deleteMany({ where: { bookingId } });
      if (bookingId === expired) await markReceivedDelivered(expired);
    }
  }
  // Someone else's number or influencer: false, as before.
  assert.equal(await guardLib.bookingAllowsMessage(influencerId, { bookingId: requested, toE164: "+919876500124", kind: "request-received" }), false);
  assert.equal(await guardLib.bookingAllowsMessage("no-such-influencer", { bookingId: requested, toE164: PHONE, kind: "request-received" }), false);
});

test("end to end through the real manager and the fake transport: the accepted message, with the payment link, goes out from the linked number once", { skip, timeout: 120_000 }, async () => {
  const bookingId = await requestBooking();
  await approvalLib.approveRequest(influencerId, bookingId, new Date(), queuedOk);
  const h = harness({ config: { minGapMs: 0 }, clock: new ManualClock(Date.now()) });
  want(h, influencerId);
  await h.tick();
  const t: FakeTransport = h.last(influencerId);
  t.emitQr("SECRET-QR-PAYLOAD");
  await settle();
  t.emitOpen({ phoneE164: "+919876500001", deviceLabel: "Chrome (Mac OS)" });
  await settle();
  setActiveSender({ isReady: (id) => h.manager.isReady(id), send: (req) => h.manager.send(req) });
  try {
    const { qr: _drop, ...rest } = fakes().deps;
    void _drop;
    assert.equal(await sendMessageForBooking(bookingId, "request-approved", rest), "sent");
    assert.equal(t.sent.length, 1);
    assert.equal(t.sent[0].to, PHONE);
    assert.match(t.sent[0].text, /^Good news: your booking request was accepted\./);
    assert.ok(payLinkIn(t.sent[0].text), "the payment link reached the transport");
    assert.deepEqual(h.guardCalls, [{ influencerId, bookingId, toE164: PHONE }]);
    assert.equal((await row(bookingId, "WHATSAPP_WEB", "request-approved"))?.status, "SENT");
    assert.equal(await sendMessageForBooking(bookingId, "request-approved", rest), "already-sent");
    assert.equal(t.sent.length, 1);
  } finally {
    setActiveSender(null);
    await h.manager.shutdown();
  }
});

// ---- 7. the payment link is a bearer link: it is not in logs, rows, alerts or errors ------------------------------------------------

test("neither the payment link nor the manage link reaches a log line, a stored error, an alert or a failed job's reason, however a provider spells it back", { skip }, async () => {
  const bookingId = await requestBooking();
  await approvalLib.approveRequest(influencerId, bookingId, new Date(), queuedOk);
  const spellings = [
    (u: string) => u,
    (u: string) => u.replace(/\//g, "\\/"), // JSON-escaped slashes, as MSG91 and Graph error bodies may write them
    (u: string) => encodeURIComponent(u), // inside a query string
    (u: string) => u.slice(u.lastIndexOf("/") + 1), // the bare token
  ];
  for (const [round, spell] of spellings.entries()) {
    const alerts: string[] = [];
    const f = fakes();
    f.ctl.ready = false;
    const echoed: string[] = [];
    f.deps.sendWhatsApp = async (input) => {
      const params = (input.components?.[0] as { parameters: { text: string }[] }).parameters.map((p) => p.text);
      echoed.push(...params.filter((p) => p.includes("/pay/") || p.includes("/manage/")));
      throw new Error(`Meta rejected the message: parameters were ${params.filter((p) => p.includes("/")).map(spell).join(" and ")}`);
    };
    f.deps.sendSMS = async (input) => {
      echoed.push(payLinkIn(input.body)!);
      throw new Error(`SMS refused: ${JSON.stringify({ body: spell(input.body) })} / ${spell(payLinkIn(input.body)!)} / ${spell(/https?:\/\/\S+\/manage\/\S+/.exec(input.body)?.[0] ?? "https://none.invalid/manage/none")}`);
    };
    f.deps.alert = async (_id, a) => void alerts.push(a.detail ?? "");
    await prisma.message.deleteMany({ where: { bookingId } });

    const failure = await sendMessageForBooking(bookingId, "request-approved", f.deps).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(failure instanceof Error, "every channel failed");
    const payTokenText = payLinkIn(echoed[0])!.split("/pay/")[1];
    assert.ok(echoed.length >= 2 && payTokenText.length > 20, `round ${round}: the fakes saw the real links`);
    // What leaves the function: the thrown error (BullMQ keeps its message as the failed reason).
    for (const text of [failure.message, failure.stack ?? ""]) {
      assert.ok(!/\/pay\/|\\\/pay\\\/|%2Fpay%2F|\/manage\/|%2Fmanage%2F/i.test(text), `round ${round}: the thrown error carries a link: ${text}`);
      assert.ok(!text.includes(payTokenText), `round ${round}: nor the bare token`);
    }
    // What is stored.
    for (const r of await prisma.message.findMany({ where: { bookingId } })) {
      assert.ok(!/\/pay\/|\/manage\/|%2Fpay|%2Fmanage/i.test(r.error ?? "") && !(r.error ?? "").includes(payTokenText), `round ${round}: a stored error carries a link: ${r.error}`);
    }
    // The final failure of the job: the row, the booking and the alert.
    await reportMessageFailure(bookingId, "request-approved", failure.message, async (_id, a) => void alerts.push(a.detail ?? ""));
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    assert.ok(after.lastError && !/\/pay\/|\/manage\//.test(after.lastError) && !after.lastError.includes(payTokenText), `booking.lastError: ${after.lastError}`);
    assert.ok(alerts.length >= 1);
    for (const a of alerts) assert.ok(!/\/pay\/|\/manage\//.test(a) && !a.includes(payTokenText), `an alert carries a link: ${a}`);
    for (const r of await prisma.message.findMany({ where: { bookingId } })) assert.ok(!(r.error ?? "").includes(payTokenText), r.error ?? "");
  }
});

test("nothing logged during this whole file contains a payment link", { skip }, async () => {
  const offenders = logged.filter((l) => /\/pay\/[A-Za-z0-9_-]{8,}/.test(l));
  assert.deepEqual(offenders, [], "no console line shows a payment link");
  assert.ok(logged.length > 0, "and the spy really saw the code run");
});
