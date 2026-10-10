// Integration test of the customer-facing view endpoints the SPA's booking pages read (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise):
//   P1 GET /api/public/profiles/:slug   P2 GET /api/pay/:token
// Only `next/headers` is replaced (the cookies a request carries are chosen per call). Every body goes through
// assertNoSecretKeys, and the exact key set of each DTO is pinned, so adding a field is a deliberate act.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import type { BookingStatus, PaymentStatus, RefundPolicy } from "../generated/prisma/client";
import { prisma } from "../lib/db";
import { formatMoney, formatSessionTime } from "../lib/format";
import { BOOKING_PAY_PURPOSE, SELF_SERVICE_PURPOSE, buildSelfServiceUrl, verifyBookingPollToken, verifySelfServiceToken } from "../lib/self-service";
import { signToken } from "../lib/signing";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const jar = new Map<string, string>();
type Ctx<K extends string> = { params: Promise<Record<K, string>> };
let profileRoute: (req: Request, ctx: Ctx<"slug">) => Promise<Response>;
let payRoute: (req: Request, ctx: Ctx<"token">) => Promise<Response>;
let authLib: typeof import("../lib/auth/session");

// Rows created by this file (all deleted in `after`).
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
    await prisma.payment.create({ data: { bookingId: booking.id, providerOrderId: `order_spa_${run}_${n}`, amountMinor: 49900, currency: "INR", status: o.payment } });
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

  // A live page: onboarded, no login of its own (like a profile that predates accounts), three services of which one is hidden.
  const live = await prisma.influencer.create({
    data: { slug: liveSlug, name: `Spa Live ${run}`, email: liveEmail, bio: "Line one\nLine two", timezone: "Asia/Kolkata", onboardedAt: new Date() },
  });
  liveId = live.id;
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
      email: `spa-${who}-${run}@example.com`,
      password: "a long passphrase for the spa test",
      slug,
      timezone: "Asia/Kolkata",
      acceptTerms: true,
    });
    const influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: registered.userId } })).influencerId;
    if (who === "owner") {
      ownerUserId = registered.userId;
      ownerInfluencerId = influencerId;
    } else {
      otherUserId = registered.userId;
      otherInfluencerId = influencerId;
    }
  }
  await prisma.service.create({ data: { influencerId: ownerInfluencerId, title: "Draft service", durationMin: 30, priceMinor: 25000 } });

  // The host the pay and manage tests seed bookings on.
  hostId = (await prisma.influencer.create({ data: { slug: hostSlug, name: `Spa Host ${run}`, email: `spa-host-${run}@example.com`, timezone: HOST_TZ, onboardedAt: new Date() } })).id;
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
  if (!skip) {
    // Services, sessions, bookings and payments go with their influencer (cascade).
    await prisma.influencer.deleteMany({ where: { id: { in: [liveId, ownerInfluencerId, otherInfluencerId, hostId].filter(Boolean) } } });
  }
  delete process.env.READINESS_REQUIRED;
  await prisma.$disconnect();
});

test("P1 GET /api/public/profiles/:slug: a live page is public, with exactly the hand-picked fields and only active services", { skip }, async () => {
  const out = await getProfile(liveSlug);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), ["bio", "blockers", "name", "photoUrl", "preview", "services", "slug", "timezone"]);
  assert.equal(out.body.slug, liveSlug);
  assert.equal(out.body.name, `Spa Live ${run}`);
  assert.equal(out.body.bio, "Line one\nLine two");
  assert.equal(out.body.timezone, "Asia/Kolkata");
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
  assert.deepEqual(keys(owner.body), ["bio", "blockers", "name", "photoUrl", "preview", "services", "slug", "timezone"]);
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

test("P2: a paid booking is `booked`, with the customer's time zone and a working manage link", { skip }, async () => {
  for (const status of ["PAID", "SCHEDULED", "COMPLETED"] as const) {
    const b = await seed(svc.full, { status, customerTz: "America/New_York" });
    const out = await getPay(payToken(b.booking.id));
    assert.equal(out.status, 200, status);
    assert.deepEqual(keys(out.body), ["hostName", "manageUrl", "serviceTitle", "state", "whenText"], status);
    assert.equal(out.body.state, "booked");
    assert.equal(out.body.hostName, `Spa Host ${run}`);
    assert.equal(out.body.serviceTitle, "Full refund session");
    assert.equal(out.body.whenText, formatSessionTime(b.start, "America/New_York"), "the customer's own time zone");
    const manageUrl = out.body.manageUrl as string;
    assert.ok(manageUrl.startsWith(`${process.env.APP_URL!.replace(/\/$/, "")}/manage/`));
    assert.equal(verifySelfServiceToken(decodeURIComponent(manageUrl.split("/manage/")[1])), b.booking.id, "the link opens THIS booking");
    assertNoCustomer(out, b);
  }

  // Without a time zone of its own the booking uses the host's.
  const b = await seed(svc.full, { status: "PAID" });
  assert.equal((await getPay(payToken(b.booking.id))).body.whenText, formatSessionTime(b.start, HOST_TZ));

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
    assert.equal(out.body.whenText, formatSessionTime(b.start, "Europe/London"));
    assert.equal(out.body.payByText, formatSessionTime(holdExpiresAt, "Europe/London"));
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
