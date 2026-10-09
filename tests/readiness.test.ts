import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { GMAIL_SEND_SCOPE } from "../lib/google";
import {
  buildPublicInfluencerWhere,
  evaluateReadiness,
  loadReadiness,
  readinessInput,
  requiredConnections,
  type ReadinessInput,
} from "../lib/readiness";

// The local .env may bypass the connection checks for development; these tests exercise the real rules.
process.env.READINESS_BYPASS = "false";
delete process.env.READINESS_REQUIRED;

const none: ReadinessInput = {
  emailVerified: true,
  activeServices: 1,
  availabilityRules: 3,
  google: "none",
  gmailSend: false,
  whatsapp: "none",
  payout: "none",
};
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

test("required connections: defaults, configuration and the local bypass", () => {
  assert.deepEqual(requiredConnections(env({})), ["google", "payout"]);
  assert.deepEqual(requiredConnections(env({ READINESS_REQUIRED: "google, gmail ,whatsapp,payout" })), ["google", "gmail", "whatsapp", "payout"]);
  assert.deepEqual(requiredConnections(env({ READINESS_REQUIRED: "whatsapp,bogus" })), ["whatsapp"], "unknown names are ignored");
  assert.deepEqual(requiredConnections(env({ READINESS_REQUIRED: "" })), [], "an empty list requires no connections");
  assert.deepEqual(requiredConnections(env({ READINESS_BYPASS: "true" })), [], "bypass skips connections in development");
  assert.deepEqual(requiredConnections(env({ READINESS_BYPASS: "true", NODE_ENV: "production" })), ["google", "payout"], "bypass is ignored in production");
});

test("by default Google and payout details block going live; WhatsApp and Gmail only recommend", () => {
  const r = evaluateReadiness(none, ["google", "payout"]);
  assert.equal(r.ready, false);
  assert.deepEqual(r.blockers.map((b) => b.key), ["google", "payout"]);
  const byKey = Object.fromEntries(r.items.map((i) => [i.key, i]));
  assert.equal(byKey.whatsapp.required, false);
  assert.equal(byKey.gmail.required, false);
  assert.equal(byKey.google.required, true);

  const ready = evaluateReadiness({ ...none, google: "active", payout: "pending" }, ["google", "payout"]);
  assert.equal(ready.ready, true, "added (not yet verified) payout details are enough to go live");
  assert.equal(ready.items.find((i) => i.key === "whatsapp")?.state, "todo", "still shown as something to do");
});

test("every state of each connection", () => {
  const ev = (patch: Partial<ReadinessInput>, req: ("google" | "gmail" | "whatsapp" | "payout")[] = ["google", "gmail", "whatsapp", "payout"]) => evaluateReadiness({ ...none, ...patch }, req);
  assert.equal(ev({ google: "reconnect" }).items.find((i) => i.key === "google")?.state, "attention");
  assert.equal(ev({ google: "reconnect" }).ready, false, "a dead Google grant takes the page offline");
  assert.equal(ev({ google: "active", gmailSend: true }).items.find((i) => i.key === "gmail")?.state, "done");
  assert.equal(ev({ google: "reconnect", gmailSend: true }).items.find((i) => i.key === "gmail")?.state, "todo", "Gmail needs a working Google grant");
  for (const [state, expected] of [["none", "todo"], ["pending", "done"], ["ready", "done"], ["error", "attention"]] as const) {
    assert.equal(ev({ whatsapp: state }).items.find((i) => i.key === "whatsapp")?.state, expected, `whatsapp ${state}`);
  }
  for (const [state, expected] of [["none", "todo"], ["pending", "done"], ["verified", "done"], ["rejected", "attention"]] as const) {
    assert.equal(ev({ payout: state }).items.find((i) => i.key === "payout")?.state, expected, `payout ${state}`);
  }
  const all = ev({ google: "active", gmailSend: true, whatsapp: "ready", payout: "verified" });
  assert.equal(all.ready, true);
  assert.equal(all.blockers.length, 0);
});

test("the basics are always required, with or without connections", () => {
  const r = evaluateReadiness({ ...none, emailVerified: false, activeServices: 0, availabilityRules: 0 }, []);
  assert.deepEqual(r.blockers.map((b) => b.key), ["email", "service", "availability"]);
  assert.equal(evaluateReadiness(none, []).ready, true, "no required connections: the basics are enough");
});

test("the database filter requires exactly the connections the checklist requires", () => {
  const and = (e: Record<string, string>) => (buildPublicInfluencerWhere(env(e)).AND as object[]).length;
  assert.equal(and({}), 4, "onboarded + email + google + payout");
  assert.equal(and({ READINESS_REQUIRED: "google,gmail,whatsapp,payout" }), 6);
  assert.equal(and({ READINESS_REQUIRED: "" }), 2);
  assert.equal(and({ READINESS_BYPASS: "true" }), 2);
});

/* ---------- Against the database: the filter and the checklist agree ---------- */

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
let id: string;

const isLive = async (e: Record<string, string>) => (await prisma.influencer.count({ where: { id, AND: [buildPublicInfluencerWhere(env(e))] } })) === 1;

before(async () => {
  if (skip) return;
  id = (
    await prisma.influencer.create({
      data: {
        slug: `rd-${run}`,
        name: "Ready",
        email: `rd-${run}@example.com`,
        onboardedAt: new Date(),
        services: { create: { title: "S", durationMin: 30, priceMinor: 1000 } },
        rules: { create: { weekday: 1, startTime: "10:00", endTime: "17:00", timezone: "UTC" } },
      },
    })
  ).id;
});

after(async () => {
  if (!skip && id) await prisma.influencer.delete({ where: { id } });
  await prisma.$disconnect();
});

test("a page goes live in the database exactly when the checklist says so", { skip }, async () => {
  const strict = { READINESS_REQUIRED: "google,gmail,whatsapp,payout" };

  const readyNow = async () => (await loadReadiness(id, true)).blockers.filter((b) => ["google", "payout"].includes(b.key)).length === 0;
  assert.equal(await isLive({}), false);
  assert.equal(await readyNow(), false);

  await prisma.payoutAccount.create({ data: { influencerId: id, accountHolderName: "R", method: "UPI", upiIdMasked: "ab***@upi", upiIdEnc: "x" } });
  assert.equal(await isLive({}), false, "payout details alone are not enough");

  await prisma.googleToken.create({ data: { influencerId: id, refreshTokenEnc: "x", scope: "calendar", googleEmail: "r@gmail.com" } });
  assert.equal(await isLive({}), true, "Google + payout details: live by default");
  assert.equal(await readyNow(), true);
  assert.equal(await isLive(strict), false, "strict mode also wants Gmail and WhatsApp");
  assert.equal(await isLive({ READINESS_BYPASS: "true" }), true);

  await prisma.googleToken.update({ where: { influencerId: id }, data: { scope: `calendar ${GMAIL_SEND_SCOPE}` } });
  assert.equal(await isLive({ READINESS_REQUIRED: "google,gmail,payout" }), true);

  await prisma.whatsAppConnection.create({ data: { influencerId: id, wabaId: "1".repeat(8), phoneNumberId: String(run), tokenEnc: "x" } });
  assert.equal(await isLive(strict), true, "everything connected");

  await prisma.googleToken.update({ where: { influencerId: id }, data: { status: "RECONNECT_NEEDED" } });
  assert.equal(await isLive({}), false, "a dead Google grant takes the page offline");
  assert.equal(await readyNow(), false);
  await prisma.googleToken.update({ where: { influencerId: id }, data: { status: "ACTIVE" } });

  await prisma.payoutAccount.update({ where: { influencerId: id }, data: { status: "REJECTED" } });
  assert.equal(await isLive({}), false, "rejected payout details do not count");
  await prisma.payoutAccount.update({ where: { influencerId: id }, data: { status: "VERIFIED" } });
  assert.equal(await isLive({}), true);
});

test("readinessInput maps the stored rows", { skip }, async () => {
  const row = await prisma.influencer.findUniqueOrThrow({
    where: { id },
    select: {
      googleToken: { select: { status: true, scope: true } },
      payoutAccount: { select: { status: true } },
      whatsappConnection: { select: { status: true, templates: true } },
      _count: { select: { rules: true, services: { where: { active: true } } } },
    },
  });
  const input = readinessInput(row, true);
  assert.equal(input.google, "active");
  assert.equal(input.gmailSend, true);
  assert.equal(input.whatsapp, "pending", "connected but templates are not approved yet");
  assert.equal(input.payout, "verified");
  assert.equal(input.activeServices, 1);
  assert.equal(input.availabilityRules, 1);
});
