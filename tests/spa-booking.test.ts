// Integration test of the customer-facing view endpoints the SPA's booking pages read (needs DATABASE_URL,
// TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise):
//   P1 GET /api/public/profiles/:slug
// Only `next/headers` is replaced (the cookies a request carries are chosen per call). Every body goes through
// assertNoSecretKeys, and the exact key set of each DTO is pinned, so adding a field is a deliberate act.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { prisma } from "../lib/db";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

const jar = new Map<string, string>();
type Ctx<K extends string> = { params: Promise<Record<K, string>> };
let profileRoute: (req: Request, ctx: Ctx<"slug">) => Promise<Response>;
let authLib: typeof import("../lib/auth/session");

// Rows created by this file (all deleted in `after`).
let liveId = "";
let ownerInfluencerId = "";
let ownerUserId = "";
let otherInfluencerId = "";
let otherUserId = "";
let hiddenServiceId = "";
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
const keys = (o: unknown) => Object.keys(o as object).sort();

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
});

after(async () => {
  if (!skip) {
    // Services, sessions, bookings and payments go with their influencer (cascade).
    await prisma.influencer.deleteMany({ where: { id: { in: [liveId, ownerInfluencerId, otherInfluencerId].filter(Boolean) } } });
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
