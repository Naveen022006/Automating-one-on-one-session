// Integration test of the customer-facing view endpoints the SPA's booking pages read (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise):
//   P1 GET /api/public/profiles/:slug   P2 GET /api/pay/:token   P3 GET /api/manage/:token
// Only `next/headers` is replaced (the cookies a request carries are chosen per call). Every body goes through
// assertNoSecretKeys, and the exact key set of each DTO is pinned, so adding a field is a deliberate act.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { BookingStatus, PaymentStatus, RefundPolicy } from "../generated/prisma/client";
import { prisma } from "../lib/db";
import { BRAND_NAME } from "../lib/brand";
import { formatMoney, formatSessionTime } from "../lib/format";
import { matchRouteRule } from "../lib/rate-limit/policies";
import { describeRefundPolicy } from "../lib/refund-policy";
import { BOOKING_PAY_PURPOSE, SELF_SERVICE_PURPOSE, verifyBookingPollToken, verifySelfServiceToken } from "../lib/self-service";
import { signToken } from "../lib/signing";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// The variables `before` sets, with the values they had when this file started: `after` puts those back (a developer's own
// RATE_LIMIT_STORE, APP_URL or READINESS_REQUIRED must not be deleted by a test run).
const ENV_KEYS = ["RATE_LIMIT_STORE", "APP_URL", "READINESS_REQUIRED"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]])) as Record<(typeof ENV_KEYS)[number], string | undefined>;

const jar = new Map<string, string>();
type Ctx<K extends string> = { params: Promise<Record<K, string>> };
let profileRoute: (req: Request, ctx: Ctx<"slug">) => Promise<Response>;
let payRoute: (req: Request, ctx: Ctx<"token">) => Promise<Response>;
let manageRoute: (req: Request, ctx: Ctx<"token">) => Promise<Response>;
let authLib: typeof import("../lib/auth/session");

// Rows created by this file (all deleted in `after`). Ids are noted in `created` the moment they exist, and every slug and
// email is known up front, so a `before` that fails half way still leaves nothing behind.
const created = { influencers: new Set<string>(), users: new Set<string>() };
let liveId = "";
let ownerInfluencerId = "";
let ownerUserId = "";
let otherInfluencerId = "";
let otherUserId = "";
let hiddenServiceId = "";
let hostId = "";
// Services of the host that bookings are seeded on (pay and manage tests).
const svc: Record<"full" | "notice" | "none" | "group" | "plain", string> = { full: "", notice: "", none: "", group: "", plain: "" };
const hostSlug = `spa-host-${run}`;
const HOST_TZ = "Asia/Kolkata";
const liveSlug = `spa-live-${run}`;
const ownerSlug = `spa-owner-${run}`;
const otherSlug = `spa-other-${run}`;
const liveEmail = `spa-live-${run}@example.com`;
const accountEmail = (who: "owner" | "other") => `spa-${who}-${run}@example.com`;

interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function answer(res: Response): Promise<Answer> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

async function getProfile(slug: string, cookies: Record<string, string> = {}): Promise<Answer> {
  jar.clear();
  for (const [k, v] of Object.entries(cookies)) jar.set(k, v);
  return answer(await profileRoute(new Request(`http://localhost/api/public/profiles/${slug}`), { params: Promise.resolve({ slug }) }));
}
const getPay = async (token: string) => answer(await payRoute(new Request("http://localhost/api/pay/x"), { params: Promise.resolve({ token }) }));
const getManage = async (token: string) => answer(await manageRoute(new Request("http://localhost/api/manage/x"), { params: Promise.resolve({ token }) }));
const keys = (o: unknown) => Object.keys(o as object).sort();

let seq = 0;
interface SeedOptions {
  status: BookingStatus;
  /** Session start, in ms from now (default: three days ahead). */
  startIn?: number;
  holdExpiresAt?: Date | null;
  customerTz?: string | null;
  redactedAt?: Date | null;
  meetLink?: string | null;
  sessionMeetLink?: string | null;
  refundPolicy?: RefundPolicy | null;
  payment?: PaymentStatus;
  /** The payment is flagged for a refund (a late capture, or a cancellation the policy refunds). */
  needsRefund?: boolean;
  refundedMinor?: number;
  customerName?: string;
  /** Attach to an existing session (group sessions) instead of creating one. */
  sessionId?: string;
}

/** A booking in an exact state, written straight to the database (the states are what is under test, not how they come about). */
async function seed(serviceId: string, o: SeedOptions) {
  const n = ++seq;
  const start = new Date(Math.floor((Date.now() + (o.startIn ?? 3 * DAY)) / 1000) * 1000 + n * 1000);
  const session =
    o.sessionId !== undefined
      ? await prisma.session.findUniqueOrThrow({ where: { id: o.sessionId } })
      : await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000), meetLink: o.sessionMeetLink ?? null } });
  const booking = await prisma.booking.create({
    data: {
      sessionId: session.id,
      status: o.status,
      holdExpiresAt: o.holdExpiresAt ?? null,
      customerName: o.customerName ?? `Customer ${n} ${run}`,
      customerEmail: `customer-${n}-${run}@example.com`,
      whatsappE164: `+9198765${String(10000 + n).slice(-5)}`,
      customerTz: o.customerTz ?? null,
      redactedAt: o.redactedAt ?? null,
      meetLink: o.meetLink ?? null,
      refundPolicy: o.refundPolicy ?? null,
    },
  });
  if (o.payment) {
    await prisma.payment.create({
      data: {
        bookingId: booking.id,
        providerOrderId: `order_spa_${run}_${n}`,
        amountMinor: 49900,
        currency: "INR",
        status: o.payment,
        needsRefund: o.needsRefund ?? false,
        refundAmountMinor: o.refundedMinor ?? null,
      },
    });
  }
  return { booking, session, start: session.startTime, customerEmail: booking.customerEmail, customerName: booking.customerName, whatsapp: booking.whatsappE164 };
}
const payToken = (bookingId: string, ttlSec = 3600) => signToken(BOOKING_PAY_PURPOSE, { b: bookingId }, ttlSec);
const selfServiceToken = (bookingId: string, ttlSec = 3600) => signToken(SELF_SERVICE_PURPOSE, { b: bookingId }, ttlSec);

before(async () => {
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.APP_URL ||= "http://localhost:3000";
  // No connection is required for a page to be live in this file: it only needs onboarding and a verified email.
  process.env.READINESS_REQUIRED = "";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  authLib = await import("../lib/auth/session");
  profileRoute = (await import("../app/api/public/profiles/[slug]/route")).GET;
  payRoute = (await import("../app/api/pay/[token]/route")).GET;
  manageRoute = (await import("../app/api/manage/[token]/route")).GET;

  // A live page: onboarded, no login of its own (like a profile that predates accounts), three services of which one is hidden.
  const live = await prisma.influencer.create({
    data: { slug: liveSlug, name: `Spa Live ${run}`, email: liveEmail, bio: "Line one\nLine two", timezone: "Asia/Kolkata", onboardedAt: new Date() },
  });
  liveId = live.id;
  created.influencers.add(liveId);
  await prisma.service.create({
    data: {
      influencerId: liveId,
      title: "Portfolio review",
      description: "A focused review",
      durationMin: 30,
      priceMinor: 49900,
      refundPolicy: "NOTICE_24H",
      prepNotes: "Bring your portfolio link",
      intakeQuestions: [{ id: "q1", label: "Your goal", type: "text", required: true }],
    },
  });
  await prisma.service.create({
    data: { influencerId: liveId, title: "Small group clinic", durationMin: 60, priceMinor: 19900, type: "GROUP", capacity: 5, requiresApproval: true },
  });
  hiddenServiceId = (await prisma.service.create({ data: { influencerId: liveId, title: "Retired offer", durationMin: 15, priceMinor: 100, active: false } })).id;

  // Two real accounts whose pages are not live (not onboarded, email not verified): only the owner may preview.
  const accounts = await import("../lib/auth/accounts");
  for (const [slug, who] of [[ownerSlug, "owner"], [otherSlug, "other"]] as const) {
    const registered = await accounts.registerAccount({
      name: `Spa ${who} ${run}`,
      email: accountEmail(who),
      password: "a long passphrase for the spa test",
      slug,
      timezone: "Asia/Kolkata",
      acceptTerms: true,
    });
    created.users.add(registered.userId);
    if (who === "owner") ownerUserId = registered.userId;
    else otherUserId = registered.userId;
    const influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: registered.userId } })).influencerId;
    created.influencers.add(influencerId);
    if (who === "owner") ownerInfluencerId = influencerId;
    else otherInfluencerId = influencerId;
  }
  await prisma.service.create({ data: { influencerId: ownerInfluencerId, title: "Draft service", durationMin: 30, priceMinor: 25000 } });

  // The host the pay and manage tests seed bookings on.
  hostId = (await prisma.influencer.create({ data: { slug: hostSlug, name: `Spa Host ${run}`, email: `spa-host-${run}@example.com`, timezone: HOST_TZ, onboardedAt: new Date() } })).id;
  created.influencers.add(hostId);
  const service = async (key: keyof typeof svc, data: { title: string; refundPolicy?: RefundPolicy; type?: "GROUP"; capacity?: number; prepNotes?: string }) => {
    svc[key] = (await prisma.service.create({ data: { influencerId: hostId, durationMin: 30, priceMinor: 49900, ...data } })).id;
  };
  await service("full", { title: "Full refund session", refundPolicy: "FULL", prepNotes: "Bring a laptop" });
  await service("notice", { title: "Notice session", refundPolicy: "NOTICE_24H" });
  await service("none", { title: "Final sale session", refundPolicy: "NONE" });
  await service("group", { title: "Group clinic", refundPolicy: "FULL", type: "GROUP", capacity: 5 });
  await service("plain", { title: "Plain session", refundPolicy: "FULL" });
});

after(async () => {
  try {
    if (!skip) {
      // Services, sessions, bookings and payments go with their influencer (cascade). By slug as well as by the ids noted in
      // `before`, and the accounts by email: whatever `before` managed to create before it failed is removed too.
      await prisma.influencer.deleteMany({ where: { OR: [{ slug: { in: [liveSlug, ownerSlug, otherSlug, hostSlug] } }, { id: { in: [...created.influencers] } }] } });
      await prisma.user.deleteMany({ where: { OR: [{ email: { in: [accountEmail("owner"), accountEmail("other")] } }, { id: { in: [...created.users] } }] } });
    }
  } finally {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await prisma.$disconnect();
  }
});

test("P1 GET /api/public/profiles/:slug: a live page is public, with exactly the hand-picked fields and only active services", { skip }, async () => {
  const out = await getProfile(liveSlug);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), ["bio", "blockers", "name", "photoUrl", "preview", "services", "slug"]);
  assert.equal(out.body.slug, liveSlug);
  assert.equal(out.body.name, `Spa Live ${run}`);
  assert.equal(out.body.bio, "Line one\nLine two");
  assert.ok(!("timezone" in out.body), "there is no time zone to show: everything is IST");
  assert.equal(out.body.preview, false);
  assert.deepEqual(out.body.blockers, [], "what is still missing is only for the owner's preview");

  const services = out.body.services as Array<Record<string, unknown>>;
  assert.deepEqual(services.map((s) => s.title), ["Portfolio review", "Small group clinic"], "the retired service is hidden, order is creation order");
  assert.ok(!JSON.stringify(out.body).includes(hiddenServiceId));
  for (const s of services) {
    assert.deepEqual(keys(s), [
      "capacity", "currency", "description", "durationMin", "id", "intakeQuestions", "maxAdvanceDays", "minNoticeHours",
      "prepNotes", "priceMinor", "refundPolicy", "refundText", "requiresApproval", "title", "type",
    ]);
  }
  assert.equal(services[0].refundPolicy, "NOTICE_24H");
  assert.equal(services[0].prepNotes, "Bring your portfolio link");
  assert.deepEqual(services[0].intakeQuestions, [{ id: "q1", label: "Your goal", type: "text", required: true }]);
  assert.equal(services[1].type, "GROUP");
  assert.equal(services[1].requiresApproval, true);

  assertNoSecretKeys(out.body);
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes(liveEmail), "the host's email address is never part of the public profile");
  assert.ok(!text.includes(liveId), "no influencer id");
});

test("P1: a page that is not live is a 404 for strangers and other hosts, and a preview only for its owner", { skip }, async () => {
  const stranger = await getProfile(ownerSlug);
  assert.equal(stranger.status, 404);
  assert.deepEqual(stranger.body, { error: "Not found" });
  assert.equal(stranger.headers.get("cache-control"), "private, no-store", "a 404 for one viewer must not be cached for the owner");

  const otherToken = await authLib.createSession(otherUserId);
  const otherHost = await getProfile(ownerSlug, { [authLib.sessionCookieName()]: otherToken });
  assert.equal(otherHost.status, 404, "being signed in as a different host does not unlock someone else's draft");
  assert.equal((await getProfile(ownerSlug, { [authLib.sessionCookieName()]: "not-a-real-session" })).status, 404);

  const ownerToken = await authLib.createSession(ownerUserId);
  const owner = await getProfile(ownerSlug, { [authLib.sessionCookieName()]: ownerToken });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.preview, true);
  assert.equal(owner.body.slug, ownerSlug);
  assert.ok(Array.isArray(owner.body.blockers) && (owner.body.blockers as string[]).length > 0, "the preview lists what is still to do");
  assert.ok((owner.body.blockers as unknown[]).every((b) => typeof b === "string"));
  assert.deepEqual(keys(owner.body), ["bio", "blockers", "name", "photoUrl", "preview", "services", "slug"]);
  assert.equal((owner.body.services as unknown[]).length, 1);
  assertNoSecretKeys(owner.body);
  const text = JSON.stringify(owner.body);
  assert.ok(!text.includes(ownerToken) && !text.includes(`spa-owner-${run}@example.com`), "neither the session token nor the owner's email is echoed");

  // The same cookie opens nothing on a live page that is not its own either: a live page is simply public.
  assert.equal((await getProfile(liveSlug, { [authLib.sessionCookieName()]: ownerToken })).body.preview, false);
});

test("P1: an unknown slug is a 404 with a JSON error", { skip }, async () => {
  const out = await getProfile(`no-such-profile-${run}`);
  assert.equal(out.status, 404);
  assert.deepEqual(out.body, { error: "Not found" });
});

// ---- P2: GET /api/pay/:token ----

/** Nothing about the customer, and nothing but the fields the page renders, may be in a pay answer. */
function assertNoCustomer(out: Answer, who: { customerEmail: string; customerName: string; whatsapp: string }) {
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes(who.customerEmail) && !text.includes(who.customerName) && !text.includes(who.whatsapp), "no customer data in the pay view");
  assertNoSecretKeys(out.body, ["pollToken"]);
}

test("P2 GET /api/pay/:token: every kind of bad link is a normal 200 saying `invalid`", { skip }, async () => {
  const b = await seed(svc.plain, { status: "HELD", holdExpiresAt: new Date(Date.now() + HOUR) });
  const good = payToken(b.booking.id);
  const cases: Array<[string, string]> = [
    ["garbage", "not-a-token"],
    ["empty halves", "."],
    ["tampered", `${good}x`],
    ["expired", payToken(b.booking.id, -10)],
    ["a self-service token is not a pay token", selfServiceToken(b.booking.id)],
    ["a malformed percent escape must not throw", "%E0%A4%A"],
  ];
  for (const [label, token] of cases) {
    const out = await getPay(token);
    assert.equal(out.status, 200, label);
    assert.deepEqual(out.body, { state: "invalid" }, label);
    assert.equal(out.headers.get("cache-control"), "private, no-store", label);
    assert.equal(out.headers.get("access-control-allow-origin"), null, label);
  }
});

test("P2: a valid link for a booking that does not exist is `not-found`", { skip }, async () => {
  const out = await getPay(payToken(`no-such-booking-${run}`));
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { state: "not-found" });
});

test("P2: a paid booking is `booked`, with the time in IST whatever zone the booking row carries and a working manage link", { skip }, async () => {
  for (const status of ["PAID", "SCHEDULED", "COMPLETED"] as const) {
    // A booking made before the India-only change may still carry the customer's own zone: it is no longer used for the text.
    const b = await seed(svc.full, { status, customerTz: "America/New_York" });
    const out = await getPay(payToken(b.booking.id));
    assert.equal(out.status, 200, status);
    assert.deepEqual(keys(out.body), ["hostName", "manageUrl", "serviceTitle", "state", "whenText"], status);
    assert.equal(out.body.state, "booked");
    assert.equal(out.body.hostName, `Spa Host ${run}`);
    assert.equal(out.body.serviceTitle, "Full refund session");
    assert.equal(out.body.whenText, formatSessionTime(b.start), "Indian Standard Time, not the zone stored on the row");
    assert.match(out.body.whenText as string, / IST$/);
    const manageUrl = out.body.manageUrl as string;
    assert.ok(manageUrl.startsWith(`${process.env.APP_URL!.replace(/\/$/, "")}/manage/`));
    assert.equal(verifySelfServiceToken(decodeURIComponent(manageUrl.split("/manage/")[1])), b.booking.id, "the link opens THIS booking");
    assertNoCustomer(out, b);
  }

  // Without a time zone of its own the text is the same: IST.
  const b = await seed(svc.full, { status: "PAID" });
  assert.equal((await getPay(payToken(b.booking.id))).body.whenText, formatSessionTime(b.start));

  // No APP_URL (a link cannot be built): the page simply has no "Manage your booking" link.
  const appUrl = process.env.APP_URL;
  delete process.env.APP_URL;
  try {
    const out = await getPay(payToken(b.booking.id));
    assert.equal(out.body.state, "booked");
    assert.equal(out.body.manageUrl, null);
  } finally {
    process.env.APP_URL = appUrl;
  }
});

test("P2: `requested`, `declined` and `expired` carry only the names and the slug the notices need", { skip }, async () => {
  const requested = await seed(svc.plain, { status: "REQUESTED", holdExpiresAt: new Date(Date.now() + DAY) });
  const r = await getPay(payToken(requested.booking.id));
  assert.deepEqual(r.body, { state: "requested", hostName: `Spa Host ${run}`, serviceTitle: "Plain session" });
  assertNoCustomer(r, requested);

  const declined = await seed(svc.plain, { status: "CANCELLED" });
  const d = await getPay(payToken(declined.booking.id));
  assert.deepEqual(d.body, { state: "declined", hostName: `Spa Host ${run}`, hostSlug });
  assertNoCustomer(d, declined);

  // QA-6 / M2: a booking with money behind it is never "declined, you have not been charged", and never "expired, request again".
  const cancelledCases: Array<[string, SeedOptions, "issued" | "on-its-way" | "none"]> = [
    // a payment that arrived after the booking was cancelled: flagged for a full refund
    ["CANCELLED + late capture (flagged)", { status: "CANCELLED", payment: "CAPTURED", needsRefund: true }, "on-its-way"],
    // the customer cancelled from the manage link and the policy refunds: flagged, or already partly refunded
    ["CANCELLED + refund pending (partial)", { status: "CANCELLED", payment: "CAPTURED", refundedMinor: 10000 }, "on-its-way"],
    ["CANCELLED + refunded", { status: "CANCELLED", payment: "REFUNDED" }, "issued"],
    // the policy gives no refund: neither flagged nor refunded
    ["CANCELLED + captured, policy refunds nothing", { status: "CANCELLED", payment: "CAPTURED" }, "none"],
  ];
  for (const [label, options, refund] of cancelledCases) {
    const b = await seed(svc.plain, options);
    const c = await getPay(payToken(b.booking.id));
    assert.deepEqual(c.body, { state: "cancelled", hostName: `Spa Host ${run}`, hostSlug, refund }, label);
    assertNoCustomer(c, b);
  }
  // an unpaid attempt (payment still CREATED or FAILED) stays "declined"
  for (const payment of ["CREATED", "FAILED"] as const) {
    const unpaid = await seed(svc.plain, { status: "CANCELLED", payment });
    assert.equal((await getPay(payToken(unpaid.booking.id))).body.state, "declined", payment);
  }
  // M2: money taken, booking FAILED (amount mismatch, paid after the hold ended and the slot was taken, paid after the session started,
  // calendar rejected the event): own state, no ids, no pay button data, never "expired".
  for (const [label, options] of [
    ["FAILED + captured and flagged (refuseAndFail)", { status: "FAILED", payment: "CAPTURED", needsRefund: true }],
    ["FAILED + captured, not flagged (calendar rejection of a PAID booking)", { status: "FAILED", payment: "CAPTURED" }],
    ["FAILED + refunded", { status: "FAILED", payment: "REFUNDED" }],
    ["FAILED + captured, hold time still in the future", { status: "FAILED", payment: "CAPTURED", needsRefund: true, holdExpiresAt: new Date(Date.now() + HOUR) }],
  ] as Array<[string, SeedOptions]>) {
    const b = await seed(svc.plain, options);
    const out = await getPay(payToken(b.booking.id));
    assert.deepEqual(out.body, { state: "not-completed" }, label);
    assertNoCustomer(out, b);
  }
  // ... and the same booking without a captured payment is still just `expired`
  const failedUnpaid = await seed(svc.plain, { status: "FAILED", payment: "CREATED" });
  assert.deepEqual((await getPay(payToken(failedUnpaid.booking.id))).body, { state: "expired", hostSlug });
  // A booking that is paid is `booked`, whatever else is true of its payment row.
  const paidAndFlagged = await seed(svc.plain, { status: "PAID", payment: "CAPTURED", needsRefund: true });
  assert.equal((await getPay(payToken(paidAndFlagged.booking.id))).body.state, "booked");

  // Everything that is neither paid, requested, cancelled nor still inside its hold is `expired`.
  const past = new Date(Date.now() - 60_000);
  const future = new Date(Date.now() + HOUR);
  const lapsed: Array<[string, SeedOptions]> = [
    ["held, hold over", { status: "HELD", holdExpiresAt: past }],
    ["payment pending, hold over", { status: "PENDING_PAYMENT", holdExpiresAt: past }],
    ["held without a hold time", { status: "HELD", holdExpiresAt: null }],
    ["status EXPIRED", { status: "EXPIRED", holdExpiresAt: future }],
    ["status FAILED", { status: "FAILED", holdExpiresAt: future }],
  ];
  for (const [label, options] of lapsed) {
    const b = await seed(svc.plain, options);
    const out = await getPay(payToken(b.booking.id));
    assert.deepEqual(out.body, { state: "expired", hostSlug }, label);
    assertNoCustomer(out, b);
  }
});

test("P2: a booking that can still be paid is `payable`, with exactly the fields PayNow needs", { skip }, async () => {
  for (const status of ["HELD", "PENDING_PAYMENT"] as const) {
    const holdExpiresAt = new Date(Date.now() + 2 * HOUR);
    const b = await seed(svc.full, { status, holdExpiresAt, customerTz: "Europe/London" });
    const out = await getPay(payToken(b.booking.id));
    assert.equal(out.status, 200, status);
    assert.deepEqual(keys(out.body), ["amountText", "bookingId", "hostName", "payByText", "pollToken", "prepNotes", "serviceTitle", "state", "whenText"], status);
    assert.equal(out.body.state, "payable");
    assert.equal(out.body.bookingId, b.booking.id);
    assert.equal(out.body.hostName, `Spa Host ${run}`);
    assert.equal(out.body.serviceTitle, "Full refund session");
    assert.equal(out.body.amountText, formatMoney(49900, "INR"), "the price comes from the service row");
    assert.equal(out.body.whenText, formatSessionTime(b.start));
    assert.equal(out.body.payByText, formatSessionTime(holdExpiresAt));
    assert.match(out.body.payByText as string, / IST$/);
    assert.equal(out.body.prepNotes, "Bring a laptop");
    assert.ok(verifyBookingPollToken(b.booking.id, out.body.pollToken as string), "the poll token is valid for this booking");
    assert.ok(!verifyBookingPollToken("another-booking", out.body.pollToken as string), "and for no other");
    assertNoCustomer(out, b);
    assert.ok(!JSON.stringify(out.body).includes(b.session.id), "no session id");
  }
  const noNotes = await seed(svc.plain, { status: "HELD", holdExpiresAt: new Date(Date.now() + HOUR) });
  assert.equal((await getPay(payToken(noNotes.booking.id))).body.prepNotes, null);
});

test("P2: the token is decoded from the URL path, exactly as the old page did", { skip }, async () => {
  const b = await seed(svc.plain, { status: "HELD", holdExpiresAt: new Date(Date.now() + HOUR) });
  const token = payToken(b.booking.id);
  assert.ok(token.includes("."));
  // `.` written as %2E is what a proxy or an email client may produce; the raw and the encoded form open the same booking.
  const encoded = token.replace(".", "%2E");
  assert.notEqual(encoded, token);
  assert.equal((await getPay(encoded)).body.state, "payable");
  assert.equal((await getPay(encodeURIComponent(token))).body.state, "payable");
  assert.equal((await getPay(token)).body.state, "payable");
});

test("P2: an erased booking is `not-found` in every state, and no manage link is minted for it", { skip }, async () => {
  const erasedAt = new Date();
  const future = new Date(Date.now() + HOUR);
  const cases: Array<[string, SeedOptions]> = [
    ["paid", { status: "PAID", payment: "CAPTURED" }],
    ["scheduled", { status: "SCHEDULED", payment: "CAPTURED" }],
    ["requested", { status: "REQUESTED", holdExpiresAt: future }],
    ["payable", { status: "HELD", holdExpiresAt: future }],
    ["declined", { status: "CANCELLED" }],
    ["lapsed", { status: "HELD", holdExpiresAt: new Date(Date.now() - 60_000) }],
  ];
  for (const [label, options] of cases) {
    const b = await seed(svc.plain, { ...options, redactedAt: erasedAt, customerName: "Erased Customer" });
    const out = await getPay(payToken(b.booking.id));
    assert.equal(out.status, 200, label);
    assert.deepEqual(out.body, { state: "not-found" }, `${label}: an erased booking is shown as missing`);
    assert.ok(!JSON.stringify(out.body).includes("/manage/"), `${label}: no manage link`);
  }
  // The flag is the only difference: the same booking that was not erased gets its normal answer.
  const kept = await seed(svc.plain, { status: "PAID", payment: "CAPTURED" });
  assert.equal((await getPay(payToken(kept.booking.id))).body.state, "booked");
});

// ---- P3: GET /api/manage/:token ----

const MANAGE_KEYS = [
  "bookingId", "canManage", "canReschedule", "cancelRefundText", "customerName", "durationMin", "hostSuspended", "influencerName", "meetLink",
  "receipt", "refundPolicyText", "serviceId", "serviceTitle", "serviceType", "startTime", "status", "token",
];

/** The answer is the booking's owner's own page: their name is theirs to see, their email and number never are sent back. */
function assertManageSafe(out: Answer, who: { customerEmail: string; whatsapp: string }) {
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes(who.customerEmail) && !text.includes(who.whatsapp), "no email or phone in the manage view");
  assertNoSecretKeys(out.body, ["token"]);
}

test("P3 GET /api/manage/:token: a link that is invalid or expired is a 403 `expired`", { skip }, async () => {
  const b = await seed(svc.plain, { status: "PAID", payment: "CAPTURED" });
  const cases: Array<[string, string]> = [
    ["garbage", "not-a-token"],
    ["tampered", `${selfServiceToken(b.booking.id)}x`],
    ["expired", selfServiceToken(b.booking.id, -10)],
    ["a pay token is not a self-service token", payToken(b.booking.id)],
  ];
  for (const [label, token] of cases) {
    const out = await getManage(token);
    assert.equal(out.status, 403, label);
    assert.deepEqual(out.body, { state: "expired" }, label);
    assert.equal(out.headers.get("cache-control"), "private, no-store", label);
    assert.equal(out.headers.get("access-control-allow-origin"), null, label);
  }
});

test("P3: a valid link whose booking is gone, or was erased on request, is a 404 `not-found`", { skip }, async () => {
  const gone = await getManage(selfServiceToken(`no-such-booking-${run}`));
  assert.equal(gone.status, 404);
  assert.deepEqual(gone.body, { state: "not-found" });

  const erased = await seed(svc.plain, { status: "PAID", payment: "CAPTURED", redactedAt: new Date(), customerName: "Erased Customer" });
  const out = await getManage(selfServiceToken(erased.booking.id));
  assert.equal(out.status, 404);
  assert.deepEqual(out.body, { state: "not-found" }, "an erased booking is shown as missing, not as a page about a person who asked to be forgotten");
});

test("P3: a paid booking is `ok` with exactly the fields the manage page needs", { skip }, async () => {
  const b = await seed(svc.full, { status: "PAID", payment: "CAPTURED", meetLink: "https://meet.google.com/abc-defg-hij", customerName: "Asha Rao" });
  const token = selfServiceToken(b.booking.id);
  const out = await getManage(token);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(out.body), ["booking", "state"]);
  assert.equal(out.body.state, "ok");
  const booking = out.body.booking as Record<string, unknown>;
  assert.deepEqual(keys(booking), MANAGE_KEYS);
  // The receipt of a paid booking (WP-D): pinned field by field here; lib/receipts.ts has the pure cases.
  const { receipt, ...rest } = booking;
  assert.deepEqual(keys(receipt), ["amountMinor", "currency", "hostName", "issuedTo", "paidAt", "paymentReference", "reference", "refundedMinor", "seller", "serviceTitle", "sessionStart", "statusText"]);
  assert.deepEqual(receipt, {
    reference: b.booking.id,
    issuedTo: "Asha Rao",
    seller: BRAND_NAME,
    hostName: `Spa Host ${run}`,
    serviceTitle: "Full refund session",
    sessionStart: b.start.toISOString(),
    paidAt: (receipt as { paidAt: string }).paidAt,
    amountMinor: 49900,
    currency: "INR",
    paymentReference: null,
    refundedMinor: 0,
    statusText: "Paid",
  });
  assert.ok(!Number.isNaN(Date.parse((receipt as { paidAt: string }).paidAt)));
  assert.deepEqual(rest, {
    token,
    bookingId: b.booking.id,
    serviceId: svc.full,
    serviceTitle: "Full refund session",
    serviceType: "ONE_TO_ONE",
    durationMin: 30,
    influencerName: `Spa Host ${run}`,
    customerName: "Asha Rao",
    status: "PAID",
    startTime: b.start.toISOString(),
    meetLink: "https://meet.google.com/abc-defg-hij",
    canManage: true,
    canReschedule: true,
    hostSuspended: false,
    refundPolicyText: describeRefundPolicy("FULL"),
    cancelRefundText: "If you cancel now, you will be refunded in full to your original payment method.",
  });
  assertManageSafe(out, b);
  assert.ok(!JSON.stringify(out.body).includes(hostId), "no influencer id");
  assert.ok(!JSON.stringify(out.body).includes(b.session.id), "no session id");
});

test("P3: what the customer may do follows the policy, the type of session and the clock", { skip }, async () => {
  // Cancelling inside the 24-hour notice window: allowed, but not refunded, and no rescheduling either.
  const late = await seed(svc.notice, { status: "SCHEDULED", payment: "CAPTURED", startIn: 3 * HOUR });
  const lateOut = (await getManage(selfServiceToken(late.booking.id))).body.booking as Record<string, unknown>;
  assert.equal(lateOut.canManage, true);
  assert.equal(lateOut.canReschedule, false);
  assert.equal(lateOut.cancelRefundText, "If you cancel now, no refund is due under this session's policy.");

  // The same policy with plenty of notice: refundable and movable.
  const early = await seed(svc.notice, { status: "PAID", payment: "CAPTURED", startIn: 3 * DAY });
  const earlyOut = (await getManage(selfServiceToken(early.booking.id))).body.booking as Record<string, unknown>;
  assert.equal(earlyOut.canReschedule, true);
  assert.equal(earlyOut.cancelRefundText, "If you cancel now, you will be refunded in full to your original payment method.");

  // A booking carries the policy it was sold under: the service's later edits do not change it.
  const sold = await seed(svc.full, { status: "PAID", payment: "CAPTURED", refundPolicy: "NONE" });
  const soldOut = (await getManage(selfServiceToken(sold.booking.id))).body.booking as Record<string, unknown>;
  assert.equal(soldOut.refundPolicyText, describeRefundPolicy("NONE"));
  assert.equal(soldOut.cancelRefundText, "If you cancel now, no refund is due under this session's policy.");

  // Only captured money counts: with no captured payment there is nothing to say about a refund.
  const unpaid = await seed(svc.plain, { status: "PAID", payment: "CREATED" });
  assert.equal(((await getManage(selfServiceToken(unpaid.booking.id))).body.booking as Record<string, unknown>).cancelRefundText, null);
  assert.equal(((await getManage(selfServiceToken(unpaid.booking.id))).body.booking as Record<string, unknown>).receipt, null, "no receipt for a payment that was never captured");

  // Finished or cancelled bookings are shown but cannot be changed.
  const past = await seed(svc.plain, { status: "COMPLETED", payment: "CAPTURED", startIn: -2 * HOUR });
  assert.equal(((await getManage(selfServiceToken(past.booking.id))).body.booking as Record<string, unknown>).canManage, false);
  const started = await seed(svc.plain, { status: "PAID", payment: "CAPTURED", startIn: -HOUR });
  assert.equal(((await getManage(selfServiceToken(started.booking.id))).body.booking as Record<string, unknown>).canManage, false, "not after the start");
  const cancelled = await seed(svc.plain, { status: "CANCELLED", payment: "REFUNDED" });
  const cancelledOut = await getManage(selfServiceToken(cancelled.booking.id));
  assert.equal(cancelledOut.status, 200);
  assert.equal((cancelledOut.body.booking as Record<string, unknown>).status, "CANCELLED");
  assert.equal((cancelledOut.body.booking as Record<string, unknown>).canManage, false);
  assert.equal(((cancelledOut.body.booking as Record<string, unknown>).receipt as { statusText: string }).statusText, "Refunded", "the receipt of a refunded booking says so");
});

test("P3: the meeting link falls back to the shared one of a group session, which never shows another attendee", { skip }, async () => {
  const first = await seed(svc.group, { status: "PAID", payment: "CAPTURED", sessionMeetLink: "https://meet.google.com/grp-aaaa-bbb", customerName: "Group Member One" });
  const second = await seed(svc.group, { status: "PAID", payment: "CAPTURED", sessionId: first.session.id, customerName: "Group Member Two" });
  const out = await getManage(selfServiceToken(second.booking.id));
  assert.equal(out.status, 200);
  const booking = out.body.booking as Record<string, unknown>;
  assert.equal(booking.meetLink, "https://meet.google.com/grp-aaaa-bbb");
  assert.equal(booking.serviceType, "GROUP");
  assert.equal(booking.canReschedule, false, "a group session is moved by the host for everyone");
  assert.equal(booking.customerName, "Group Member Two");
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes("Group Member One") && !text.includes(first.customerEmail) && !text.includes(first.whatsapp), "another attendee's data never appears");
  assertManageSafe(out, second);
});

// ---- HEAD ----

// Next answers a HEAD request to a route handler that exports GET by running the GET handler and dropping the body, so HEAD reaches
// the database like GET does and must be limited like it. The rate rules name the method. Today (foundation `policies.ts`) they list
// GET only: HEAD then matches none of the three view rules (only the global per-IP rule counts it; on the manage path the broader
// `self-service` rule happens to catch it), and when the foundation adds HEAD to them it has to be the SAME rule as GET. The test
// passes both ways and fails for anything else (HEAD landing on an unrelated rule). No database is needed.
test("HEAD on the three view routes: the rule is the one GET gets, or none yet (passes before and after the foundation lists HEAD)", () => {
  const routes: Array<[string, string]> = [
    ["/api/public/profiles/demo", "public-profile"],
    ["/api/pay/some-token", "pay-view"],
    ["/api/manage/some-token", "self-service-view"],
  ];
  for (const [path, rule] of routes) {
    assert.equal(matchRouteRule("GET", path)?.name, rule, `GET ${path}`);
    const head = matchRouteRule("HEAD", path)?.name ?? null;
    const acceptable = [null, rule, ...(path.startsWith("/api/manage/") ? ["self-service"] : [])];
    assert.ok(acceptable.includes(head), `HEAD ${path} matched ${head}; expected ${rule} (or nothing / the broader manage rule before HEAD is listed)`);
  }
});
