// The server side of the India-only change (doc/14-india-localisation.md), through the real route handlers and a real database
// (skipped without DATABASE_URL, TOKEN_ENCRYPTION_KEY and APP_SECRET):
//   - a client-supplied time zone is accepted for old clients but never stored as another zone (register, profile, availability, hold);
//     a string that is not a time zone is a 400 with a clear message;
//   - availability rules are written in Asia/Kolkata; a rule saved earlier in another zone can be re-saved only with both times;
//   - services are in INR only (400 otherwise);
//   - slots and slot days are IST days, whatever `tz` an old client sends;
//   - the booking hold takes Indian mobile numbers only and stores +91XXXXXXXXXX.
// Only `next/headers` is replaced (the cookie a request carries is chosen per call). No test sends anything.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { CURRENCY_ERROR, INDIAN_MOBILE_ERROR, istDayStart, addDays, istToday } from "../lib/india";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "a long passphrase for the india test";

type Handler = (req: Request) => Promise<Response>;
const jar = new Map<string, string>();
let authLib: typeof import("../lib/auth/session");
let emailLib: typeof import("../lib/email");
let routes: Record<"register" | "profile" | "availability" | "availabilityPatch" | "services" | "servicesPatch" | "slots" | "slotDays" | "hold", Handler>;
let emailSenderSet = false;
let influencerId = "";
let cookie = "";
let serviceId = "";
const extraInfluencerIds: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV = ["RATE_LIMIT_STORE", "READINESS_REQUIRED", "READINESS_BYPASS", "ADMIN_REQUIRE_2FA"];

async function call(handler: Handler, init: { cookie?: string; method?: string; query?: string; body?: unknown } = {}) {
  jar.clear();
  if (init.cookie !== undefined) jar.set(authLib.sessionCookieName(), init.cookie);
  const res = await handler(
    new Request(`http://localhost/api/x${init.query ?? ""}`, {
      method: init.method ?? "GET",
      headers: init.body !== undefined ? { "content-type": "application/json" } : {},
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  if (skip) return;
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.READINESS_REQUIRED = ""; // a page is live without Google and payout details (read when lib/public.ts is first imported)
  delete process.env.REDIS_URL;
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  authLib = await import("../lib/auth/session");
  emailLib = await import("../lib/email");
  emailLib.setEmailSender(async () => ({ providerMessageId: null }));
  emailSenderSet = true;
  routes = {
    register: (await import("../app/api/auth/register/route")).POST as Handler,
    profile: (await import("../app/api/dashboard/profile/route")).PATCH as Handler,
    availability: (await import("../app/api/dashboard/availability/route")).POST as Handler,
    availabilityPatch: (await import("../app/api/dashboard/availability/route")).PATCH as Handler,
    services: (await import("../app/api/dashboard/services/route")).POST as Handler,
    servicesPatch: (await import("../app/api/dashboard/services/route")).PATCH as Handler,
    slots: (await import("../app/api/slots/route")).GET as Handler,
    slotDays: (await import("../app/api/slots/days/route")).GET as Handler,
    hold: (await import("../app/api/bookings/hold/route")).POST as Handler,
  };

  // The account under test is made through the real registration (which also pins that a zone sent by an old client is not kept).
  const accounts = await import("../lib/auth/accounts");
  const registered = await accounts.registerAccount({ name: `India ${run}`, email: `india-${run}@example.com`, password: PASSWORD, slug: `india-${run}`, timezone: "Asia/Kolkata", acceptTerms: true });
  influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: registered.userId } })).influencerId!;
  cookie = await authLib.createSession(registered.userId);
  await prisma.user.update({ where: { id: registered.userId }, data: { emailVerifiedAt: new Date() } });
  await prisma.influencer.update({ where: { id: influencerId }, data: { onboardedAt: new Date() } });
});

after(async () => {
  try {
    if (!skip) {
      const slugs = [`india-${run}`, `india-reg-a-${run}`, `india-reg-b-${run}`];
      await prisma.influencer.deleteMany({ where: { OR: [{ id: { in: [influencerId, ...extraInfluencerIds].filter(Boolean) } }, { slug: { in: slugs } }] } });
      await prisma.user.deleteMany({ where: { email: { in: [`india-${run}@example.com`, `india-reg-a-${run}@example.com`, `india-reg-b-${run}@example.com`] } } });
    }
  } finally {
    if (emailSenderSet) emailLib.setEmailSender(null);
    for (const k of ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("registration: a browser time zone from an old client is accepted and never stored; a non-zone is a 400", { skip }, async () => {
  const reg = (tag: string, timezone?: string) => ({ name: `Reg ${tag} ${run}`, email: `india-reg-${tag}-${run}@example.com`, password: PASSWORD, slug: `india-reg-${tag}-${run}`, acceptTerms: true, ...(timezone !== undefined ? { timezone } : {}) });
  const a = await call(routes.register, { method: "POST", body: reg("a", "America/New_York") });
  assert.equal(a.status, 201);
  assert.equal((await prisma.influencer.findUniqueOrThrow({ where: { slug: `india-reg-a-${run}` } })).timezone, "Asia/Kolkata");
  const bad = await call(routes.register, { method: "POST", body: reg("b", "Not/AZone") });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "timezone");
  assert.match(String(bad.body.error), /Invalid time zone/);
  assert.equal(await prisma.influencer.count({ where: { slug: `india-reg-b-${run}` } }), 0);
  const none = await call(routes.register, { method: "POST", body: { ...reg("b"), timezone: undefined } });
  assert.equal(none.status, 201, "no zone at all (the new form) works");
  assert.equal((await prisma.influencer.findUniqueOrThrow({ where: { slug: `india-reg-b-${run}` } })).timezone, "Asia/Kolkata");
});

test("profile: a zone sent by an old client is saved as IST; a non-zone is a 400 and changes nothing", { skip }, async () => {
  await prisma.influencer.update({ where: { id: influencerId }, data: { timezone: "Europe/London" } }); // a legacy profile
  const bad = await call(routes.profile, { cookie, method: "PATCH", body: { timezone: "Mars/Olympus" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.field, "timezone");
  assert.equal((await prisma.influencer.findUniqueOrThrow({ where: { id: influencerId } })).timezone, "Europe/London");
  const ok = await call(routes.profile, { cookie, method: "PATCH", body: { name: `India ${run}`, timezone: "America/Los_Angeles" } });
  assert.equal(ok.status, 200);
  assert.equal((await prisma.influencer.findUniqueOrThrow({ where: { id: influencerId } })).timezone, "Asia/Kolkata");
});

test("availability: new hours are saved in IST whatever zone the client names; a non-zone is a 400", { skip }, async () => {
  const body = (extra: object) => ({ weekday: 1, startTime: "09:00", endTime: "10:00", ...extra });
  const withZone = await call(routes.availability, { cookie, method: "POST", body: body({ timezone: "Europe/London" }) });
  assert.equal(withZone.status, 201);
  const noZone = await call(routes.availability, { cookie, method: "POST", body: body({ weekday: 2 }) });
  assert.equal(noZone.status, 201, "the new editor sends no zone");
  const bad = await call(routes.availability, { cookie, method: "POST", body: body({ weekday: 3, timezone: "Not/AZone" }) });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /Invalid time zone/);
  const rules = await prisma.availabilityRule.findMany({ where: { influencerId }, orderBy: { weekday: "asc" } });
  assert.deepEqual(rules.map((r) => [r.weekday, r.startTime, r.endTime, r.timezone]), [[1, "09:00", "10:00", "Asia/Kolkata"], [2, "09:00", "10:00", "Asia/Kolkata"]]);
  await prisma.availabilityRule.deleteMany({ where: { influencerId } });
});

test("availability: a rule saved earlier in another zone is re-saved only with both of its times, and then in IST", { skip }, async () => {
  const legacy = await prisma.availabilityRule.create({ data: { influencerId, weekday: 4, startTime: "10:00", endTime: "12:00", timezone: "America/New_York" } });
  const partial = await call(routes.availabilityPatch, { cookie, method: "PATCH", body: { ruleId: legacy.id, weekday: 5 } });
  assert.equal(partial.status, 400);
  assert.match(String(partial.body.error), /another time zone/);
  assert.equal((await prisma.availabilityRule.findUniqueOrThrow({ where: { id: legacy.id } })).timezone, "America/New_York", "refused: unchanged");
  const full = await call(routes.availabilityPatch, { cookie, method: "PATCH", body: { ruleId: legacy.id, startTime: "11:00", endTime: "13:00", timezone: "America/New_York" } });
  assert.equal(full.status, 200);
  const row = await prisma.availabilityRule.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.deepEqual([row.startTime, row.endTime, row.timezone], ["11:00", "13:00", "Asia/Kolkata"]);
  // An IST rule can be moved to another weekday on its own.
  const moved = await call(routes.availabilityPatch, { cookie, method: "PATCH", body: { ruleId: legacy.id, weekday: 6 } });
  assert.equal(moved.status, 200);
  assert.equal((await prisma.availabilityRule.findUniqueOrThrow({ where: { id: legacy.id } })).weekday, 6);
  await prisma.availabilityRule.deleteMany({ where: { influencerId } });
});

test("services: INR only. Another currency is a 400 with a clear message on create and on update; INR (any case) and no currency work", { skip }, async () => {
  const base = { title: `India call ${run}`, durationMin: 30, priceMinor: 49900 };
  for (const currency of ["USD", "EUR", "GBP", "AED", "SGD", "XXX"]) {
    const r = await call(routes.services, { cookie, method: "POST", body: { ...base, currency } });
    assert.equal(r.status, 400, currency);
    assert.equal(r.body.error, CURRENCY_ERROR, currency);
  }
  assert.equal(await prisma.service.count({ where: { influencerId } }), 0, "nothing was created");
  const created = await call(routes.services, { cookie, method: "POST", body: { ...base, currency: "inr" } });
  assert.equal(created.status, 201);
  serviceId = created.body.serviceId as string;
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).currency, "INR");
  const noCurrency = await call(routes.services, { cookie, method: "POST", body: { ...base, title: `India call two ${run}` } });
  assert.equal(noCurrency.status, 201);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: noCurrency.body.serviceId as string } })).currency, "INR");

  const upd = await call(routes.servicesPatch, { cookie, method: "PATCH", body: { serviceId, currency: "USD" } });
  assert.equal(upd.status, 400);
  assert.equal(upd.body.error, CURRENCY_ERROR);
  assert.equal((await prisma.service.findUniqueOrThrow({ where: { id: serviceId } })).currency, "INR");
  assert.equal((await call(routes.servicesPatch, { cookie, method: "PATCH", body: { serviceId, priceMinor: 59900 } })).status, 200, "an update that names no currency is unaffected");
  assert.equal((await call(routes.servicesPatch, { cookie, method: "PATCH", body: { serviceId, currency: "INR", priceMinor: 59900 } })).status, 200);
});

test("slots: the day is an IST day, a `tz` from an old client is ignored, a non-zone is a 400", { skip }, async () => {
  // Hours 00:00-01:00 IST on every weekday: the slots of an IST day D start at 18:30Z on D-1.
  await prisma.availabilityRule.createMany({ data: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ influencerId, weekday, startTime: "00:00", endTime: "01:00", timezone: "Asia/Kolkata" })) });
  const day = addDays(istToday(), 5);
  const expected = [istDayStart(day), new Date(istDayStart(day).getTime() + 30 * 60_000)].map((d) => d.toISOString());
  for (const tz of [undefined, "Asia/Kolkata", "America/New_York", "Pacific/Auckland", "UTC"]) {
    const q = `?serviceId=${serviceId}&date=${day}${tz ? `&tz=${encodeURIComponent(tz)}` : ""}`;
    const r = await call(routes.slots, { cookie, query: q });
    assert.equal(r.status, 200, String(tz));
    assert.deepEqual((r.body.slots as { start: string }[]).map((s) => s.start), expected, `the same two slots whatever tz=${tz}`);
  }
  const bad = await call(routes.slots, { cookie, query: `?serviceId=${serviceId}&date=${day}&tz=Not/AZone` });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /Invalid time zone/);

  // The calendar's highlighted days: the first slot of IST day D is still on D, although it is the previous day in UTC.
  const next = addDays(day, 1);
  const days = await call(routes.slotDays, { cookie, query: `?serviceId=${serviceId}&from=${day}&to=${next}&tz=America/New_York` });
  assert.equal(days.status, 200);
  assert.deepEqual(days.body.days, [day, next]);
  const badDays = await call(routes.slotDays, { cookie, query: `?serviceId=${serviceId}&from=${day}&to=${next}&tz=Not/AZone` });
  assert.equal(badDays.status, 400);
});

test("hold: Indian mobile numbers only, stored as +91XXXXXXXXXX; the time zone sent by an old client is stored as IST", { skip }, async () => {
  const day = addDays(istToday(), 3);
  const startTime = new Date(istDayStart(day).getTime()).toISOString(); // 00:00 IST
  const hold = (over: object) => ({ serviceId, startTime, name: "Asha Rao", email: `india-cust-${run}@example.com`, whatsapp: "98765 43210", whatsappOptIn: true, ...over });

  // A new e-mail address each time: the hold route limits holds per address (it is not what is tested here).
  let n = 0;
  for (const whatsapp of ["+14155552671", "+442071838750", "12345", "5876543210", "98765 4321", "not a number", "+91 5876543210"]) {
    const r = await call(routes.hold, { method: "POST", body: hold({ whatsapp, email: `india-bad-${n++}-${run}@example.com` }) });
    assert.equal(r.status, 400, whatsapp);
    assert.equal(r.body.error, INDIAN_MOBILE_ERROR, whatsapp);
  }
  const zone = await call(routes.hold, { method: "POST", body: hold({ tz: "Not/AZone", email: `india-zone-${run}@example.com` }) });
  assert.equal(zone.status, 400);
  assert.match(String(zone.body.error), /Invalid time zone/);

  const ok = await call(routes.hold, { method: "POST", body: hold({ whatsapp: "09876543210", tz: "America/New_York", email: `india-ok-${run}@example.com` }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const booking = await prisma.booking.findUniqueOrThrow({ where: { id: ok.body.bookingId as string } });
  assert.equal(booking.whatsappE164, "+919876543210");
  assert.equal(booking.customerTz, "Asia/Kolkata", "never the zone the client sent");
  const second = await call(routes.hold, { method: "POST", body: hold({ email: `india-cust2-${run}@example.com`, startTime: new Date(istDayStart(day).getTime() + 30 * 60_000).toISOString(), whatsapp: "+91-98765-43211" }) });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: second.body.bookingId as string } })).whatsappE164, "+919876543211");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: second.body.bookingId as string } })).customerTz, "Asia/Kolkata", "no zone sent: still IST");
});
