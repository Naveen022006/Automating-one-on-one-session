import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Prisma } from "../generated/prisma/client";
import { listInfluencers } from "../lib/admin/data";
import { prisma } from "../lib/db";
import { GMAIL_SEND_SCOPE } from "../lib/google";
import { BLOCKED_TEMPLATE_STATUSES, KNOWN_TEMPLATES, TEMPLATE_STATUS_LABELS, templateState } from "../lib/message-templates";
import {
  approvalRequired,
  buildPublicInfluencerWhere,
  evaluateReadiness,
  isLiveBlocker,
  loadReadiness,
  readinessInput,
  requiredConnections,
  WHATSAPP_BADGE,
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
  suspended: null,
  approved: true,
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
  for (const [state, expected] of [["none", "todo"], ["pending", "done"], ["ready", "done"], ["rejected", "attention"], ["not-submitted", "attention"], ["error", "attention"]] as const) {
    assert.equal(ev({ whatsapp: state }).items.find((i) => i.key === "whatsapp")?.state, expected, `whatsapp ${state}`);
  }
  for (const [state, expected] of [["none", "todo"], ["pending", "done"], ["verified", "done"], ["rejected", "attention"]] as const) {
    assert.equal(ev({ payout: state }).items.find((i) => i.key === "payout")?.state, expected, `payout ${state}`);
  }
  const all = ev({ google: "active", gmailSend: true, whatsapp: "ready", payout: "verified" });
  assert.equal(all.ready, true);
  assert.equal(all.blockers.length, 0);
});

test("the WhatsApp checklist item says what is actually wrong: in review, rejected, never submitted", () => {
  const detail = (whatsapp: ReadinessInput["whatsapp"]) => evaluateReadiness({ ...none, whatsapp }, ["whatsapp"]).items.find((i) => i.key === "whatsapp")!.detail;
  const pending = detail("pending");
  const rejected = detail("rejected");
  const notSubmitted = detail("not-submitted");
  assert.match(pending, /Meta is reviewing/);
  assert.match(rejected, /rejected, paused or disabled/);
  assert.match(notSubmitted, /never sent to Meta/);
  assert.match(notSubmitted, /Check template status/, "says how to fix it");
  assert.doesNotMatch(rejected, /reviewing/, "rejected templates are not 'being reviewed'");
  assert.doesNotMatch(notSubmitted, /reviewing/, "templates that were never submitted are not 'being reviewed'");
  assert.equal(new Set([pending, rejected, notSubmitted, detail("error"), detail("ready"), detail("none")]).size, 6, "every state has its own wording");
});

test("rejected or unsent templates flag the item but never block going live, like the database filter", () => {
  for (const whatsapp of ["rejected", "not-submitted"] as const) {
    const r = evaluateReadiness({ ...none, google: "active", payout: "verified", whatsapp }, ["google", "payout", "whatsapp"]);
    assert.equal(r.items.find((i) => i.key === "whatsapp")?.state, "attention");
    assert.equal(r.ready, true, `${whatsapp}: the connection is ACTIVE, which is all buildPublicInfluencerWhere asks for`);
    assert.deepEqual(r.blockers, []);
  }
  // A connection that stopped working, or none at all, still blocks when WhatsApp is required.
  for (const whatsapp of ["error", "none"] as const) {
    assert.deepEqual(evaluateReadiness({ ...none, google: "active", payout: "verified", whatsapp }, ["google", "payout", "whatsapp"]).blockers.map((b) => b.key), ["whatsapp"], whatsapp);
  }
});

test("the stored template statuses map to the right WhatsApp state", () => {
  const all = (status: string, over: Record<string, string> = {}) =>
    Object.fromEntries(KNOWN_TEMPLATES.map((k) => [k, { status: over[k] ?? status, language: "en" }]));
  const row = (templates: unknown, status = "ACTIVE") => ({
    suspendedAt: null,
    suspendedReason: null,
    approvedAt: null,
    googleToken: null,
    payoutAccount: null,
    whatsappConnection: { status, templates },
    _count: { rules: 1, services: 1 },
  });
  const state = (templates: unknown, status?: string) => readinessInput(row(templates, status), true).whatsapp;

  assert.equal(state(all("APPROVED")), "ready");
  assert.equal(state(all("PENDING")), "pending");
  assert.equal(state(all("APPROVED", { reschedule: "PENDING" })), "pending", "one still in review");
  assert.equal(state(all("IN_APPEAL")), "pending");
  assert.equal(state(all("APPROVED", { reschedule: "REJECTED" })), "rejected");
  assert.equal(state(all("APPROVED", { cancellation: "PAUSED" })), "rejected");
  assert.equal(state(all("APPROVED", { cancellation: "DISABLED" })), "rejected");
  assert.equal(state(null), "not-submitted", "nothing was ever submitted");
  assert.equal(state({ reschedule: { status: "APPROVED" } }), "not-submitted", "some never reached Meta");
  assert.equal(state({ ...all("PENDING"), cancellation: undefined }), "not-submitted", "submitted ones are pending, the missing one is not submitted");
  assert.equal(state(all("PENDING", { reschedule: "REJECTED" })), "rejected", "rejected wins over pending");
  assert.equal(state({ reschedule: { status: "REJECTED" } }), "rejected", "rejected wins over not submitted");
  assert.equal(state(all("APPROVED"), "ERROR"), "error", "a dead connection is an error whatever the templates say");
  assert.equal(readinessInput({ ...row(null), whatsappConnection: null }, true).whatsapp, "none");

  // The same rule on bare statuses (the settings card in the browser uses it too).
  assert.equal(templateState(["APPROVED", "APPROVED"]), "ready");
  assert.equal(templateState(["APPROVED", "PENDING"]), "pending");
  assert.equal(templateState(["PENDING", "NOT_SUBMITTED"]), "not-submitted");
  assert.equal(templateState(["NOT_SUBMITTED", "REJECTED"]), "rejected");
});

test("every template status the state logic knows has its own label on the settings card (none is shown as 'Not submitted')", () => {
  const known = ["APPROVED", "FLAGGED", "PENDING", "IN_APPEAL", "NOT_SUBMITTED", ...BLOCKED_TEMPLATE_STATUSES];
  for (const status of known) assert.ok(TEMPLATE_STATUS_LABELS[status], `${status} has a label`);
  for (const status of known) {
    if (status !== "NOT_SUBMITTED") assert.notEqual(TEMPLATE_STATUS_LABELS[status].label, "Not submitted", `${status} must not read as never submitted`);
  }
  for (const status of ["DELETED", "PENDING_DELETION", "LIMIT_EXCEEDED"]) assert.equal(TEMPLATE_STATUS_LABELS[status].tone, "danger", status);
  assert.deepEqual(
    new Set(["DELETED", "PENDING_DELETION", "LIMIT_EXCEEDED"].map((s) => TEMPLATE_STATUS_LABELS[s].label)).size,
    3,
    "each has its own accurate label",
  );
});

test("the basics are always required, with or without connections", () => {
  const r = evaluateReadiness({ ...none, emailVerified: false, activeServices: 0, availabilityRules: 0 }, []);
  assert.deepEqual(r.blockers.map((b) => b.key), ["email", "service", "availability"]);
  assert.equal(evaluateReadiness(none, []).ready, true, "no required connections: the basics are enough");
});

test("the database filter requires exactly the connections the checklist requires", () => {
  const and = (e: Record<string, string>) => (buildPublicInfluencerWhere(env(e)).AND as object[]).length;
  assert.equal(and({}), 5, "onboarded + email + not suspended + google + payout");
  assert.equal(and({ READINESS_REQUIRED: "google,gmail,whatsapp,payout" }), 7);
  assert.equal(and({ READINESS_REQUIRED: "" }), 3);
  assert.equal(and({ READINESS_BYPASS: "true" }), 3, "the bypass skips connections, never the suspension filter");
  assert.equal(and({ READINESS_REQUIRED: "google,payout,approval" }), 6, "the approval gate adds approvedAt");
  assert.equal(and({ READINESS_REQUIRED: "google,payout,approval", READINESS_BYPASS: "true" }), 3, "the bypass skips the approval gate in development");
});

test("buildPublicInfluencerWhere always excludes suspended accounts and asks for approval only when the gate is on", () => {
  const has = (e: Record<string, string>, clause: object) => (buildPublicInfluencerWhere(env(e)).AND as object[]).some((c) => JSON.stringify(c) === JSON.stringify(clause));
  assert.equal(has({}, { suspendedAt: null }), true);
  assert.equal(has({ READINESS_BYPASS: "true" }, { suspendedAt: null }), true, "never bypassed");
  assert.equal(has({ READINESS_REQUIRED: "" }, { suspendedAt: null }), true);
  assert.equal(has({}, { approvedAt: { not: null } }), false, "gate off: approval is not asked for");
  assert.equal(has({ READINESS_REQUIRED: "payout,approval" }, { approvedAt: { not: null } }), true);
  assert.equal(has({ READINESS_REQUIRED: "payout,approval", NODE_ENV: "production", READINESS_BYPASS: "true" }, { approvedAt: { not: null } }), true, "the bypass is ignored in production");
});

test("approvalRequired: off by default, on with the approval keyword, bypassed in development only", () => {
  assert.equal(approvalRequired(env({})), false);
  assert.equal(approvalRequired(env({ READINESS_REQUIRED: "google,payout" })), false);
  assert.equal(approvalRequired(env({ READINESS_REQUIRED: "payout, Approval" })), true);
  assert.equal(approvalRequired(env({ READINESS_REQUIRED: "approval" })), true, "approval alone: no connections required, still gated");
  assert.equal(approvalRequired(env({ READINESS_REQUIRED: "approval", READINESS_BYPASS: "true" })), false);
  assert.equal(approvalRequired(env({ READINESS_REQUIRED: "approval", READINESS_BYPASS: "true", NODE_ENV: "production" })), true);
  assert.deepEqual(requiredConnections(env({ READINESS_REQUIRED: "payout,approval" })), ["payout"], "approval is not a connection");
});

test("a suspended account is a live blocker that no setting bypasses; a normal account sees exactly the usual items", () => {
  const normal = evaluateReadiness(none, [], { approvalRequired: false });
  assert.equal(normal.items.some((i) => i.key === "account"), false, "no account item when it does not apply");
  assert.deepEqual(normal.items.map((i) => i.key), ["email", "service", "availability", "google", "gmail", "whatsapp", "payout"]);

  const suspended = evaluateReadiness({ ...none, suspended: { reason: "Chargeback investigation" } }, [], { approvalRequired: false });
  assert.equal(suspended.ready, false);
  assert.deepEqual(suspended.blockers.map((b) => b.key), ["account"]);
  const item = suspended.items.find((i) => i.key === "account")!;
  assert.equal(item.label, "Account in good standing");
  assert.equal(item.state, "attention");
  assert.equal(item.required, true);
  assert.equal(item.href, "/contact");
  assert.match(item.detail, /^Suspended by the platform: Chargeback investigation\. Contact \S+@\S+ to resolve it\.$/);
  // A reason that already ends with a full stop (or spaces) does not give "..".
  for (const reason of ["Chargeback.", "Chargeback. ", "Chargeback..."]) {
    const detail = evaluateReadiness({ ...none, suspended: { reason } }, [], { approvalRequired: false }).items.find((i) => i.key === "account")!.detail;
    assert.match(detail, /^Suspended by the platform: Chargeback\. Contact /, reason);
    assert.ok(!detail.includes(".."), reason);
  }
  // Suspension wins over a missing approval: one item, the more serious one.
  const both = evaluateReadiness({ ...none, approved: false, suspended: { reason: "Abuse reports" } }, [], { approvalRequired: true });
  assert.equal(both.items.filter((i) => i.key === "account").length, 1);
  assert.equal(both.items.find((i) => i.key === "account")!.state, "attention");
});

test("the approval gate adds a Platform review blocker only when it is on and the page is not approved", () => {
  const gateOn = evaluateReadiness({ ...none, approved: false }, [], { approvalRequired: true });
  assert.equal(gateOn.ready, false);
  const item = gateOn.items.find((i) => i.key === "account")!;
  assert.deepEqual({ label: item.label, state: item.state, required: item.required, href: item.href }, { label: "Platform review", state: "todo", required: true, href: "/dashboard" });
  assert.equal(item.detail, "We review new booking pages before they go live. You will get an e-mail.");
  assert.equal(evaluateReadiness({ ...none, approved: true }, [], { approvalRequired: true }).ready, true, "approved: live");
  const gateOff = evaluateReadiness({ ...none, approved: false }, [], { approvalRequired: false });
  assert.equal(gateOff.ready, true, "gate off: an unapproved page is not blocked");
  assert.equal(gateOff.items.some((i) => i.key === "account"), false);
});

test("isLiveBlocker: the email, the account and every connection keep a page offline; services and hours do not", () => {
  for (const key of ["email", "account", "google", "gmail", "whatsapp", "payout"] as const) assert.equal(isLiveBlocker(key), true, key);
  for (const key of ["service", "availability"] as const) assert.equal(isLiveBlocker(key), false, key);
});

test("readinessInput maps the suspension and the approval", () => {
  const base = { googleToken: null, payoutAccount: null, whatsappConnection: null, _count: { rules: 1, services: 1 } };
  const at = new Date();
  const off = readinessInput({ ...base, suspendedAt: null, suspendedReason: null, approvedAt: null }, true);
  assert.deepEqual([off.suspended, off.approved], [null, false]);
  const on = readinessInput({ ...base, suspendedAt: at, suspendedReason: "Abuse reports", approvedAt: at }, true);
  assert.deepEqual([on.suspended, on.approved], [{ reason: "Abuse reports" }, true]);
  assert.deepEqual(readinessInput({ ...base, suspendedAt: at, suspendedReason: null, approvedAt: null }, true).suspended, { reason: "No reason was recorded" });
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

test("a suspension and the approval gate flip a page offline and online in the database exactly as the checklist says", { skip }, async () => {
  // Needs a live page first: google + payout from the test above are still in place.
  assert.equal(await isLive({}), true);
  const accountBlocker = async () => (await loadReadiness(id, true)).blockers.find((b) => b.key === "account");

  await prisma.influencer.update({ where: { id }, data: { suspendedAt: new Date(), suspendedReason: "Chargeback investigation", suspendedByEmail: "admin@example.com" } });
  assert.equal(await isLive({}), false, "suspended: offline");
  assert.equal(await isLive({ READINESS_BYPASS: "true" }), false, "the development bypass never lifts a suspension");
  assert.match((await accountBlocker())?.detail ?? "", /Chargeback investigation/);

  await prisma.influencer.update({ where: { id }, data: { suspendedAt: null, suspendedReason: null, suspendedByEmail: null } });
  assert.equal(await isLive({}), true, "reinstated: live again");
  assert.equal(await accountBlocker(), undefined);

  // The approval gate: not approved -> offline; approved -> live; gate off -> approval is irrelevant.
  const gate = { READINESS_REQUIRED: "google,payout,approval" };
  assert.equal(await isLive(gate), false, "the gate is on and nobody approved this page");
  assert.equal(await isLive({}), true, "gate off: unaffected");
  const savedRequired = process.env.READINESS_REQUIRED;
  process.env.READINESS_REQUIRED = gate.READINESS_REQUIRED;
  try {
    assert.equal((await accountBlocker())?.label, "Platform review");
    await prisma.influencer.update({ where: { id }, data: { approvedAt: new Date(), approvedByEmail: "admin@example.com" } });
    assert.equal(await isLive(gate), true);
    assert.equal(await accountBlocker(), undefined);
    assert.equal(await isLive({ ...gate, READINESS_BYPASS: "true" }), true);
  } finally {
    if (savedRequired === undefined) delete process.env.READINESS_REQUIRED;
    else process.env.READINESS_REQUIRED = savedRequired;
  }
  const row = (await listInfluencers(1, `rd-${run}`)).rows.find((r) => r.id === id);
  assert.equal(row?.accountStatus, "active");
});

test("readinessInput maps the stored rows", { skip }, async () => {
  const row = await prisma.influencer.findUniqueOrThrow({
    where: { id },
    select: {
      suspendedAt: true,
      suspendedReason: true,
      approvedAt: true,
      googleToken: { select: { status: true, scope: true } },
      payoutAccount: { select: { status: true } },
      whatsappConnection: { select: { status: true, templates: true } },
      _count: { select: { rules: true, services: { where: { active: true } } } },
    },
  });
  const input = readinessInput(row, true);
  assert.equal(input.google, "active");
  assert.equal(input.gmailSend, true);
  assert.equal(input.whatsapp, "not-submitted", "connected, but no template was ever submitted (the row has none stored)");
  assert.equal(input.payout, "verified");
  assert.equal(input.activeServices, 1);
  assert.equal(input.availabilityRules, 1);
});

test("the admin console shows the same WhatsApp state as the influencer's checklist, not 'in review' for everything", { skip }, async () => {
  const all = (status: string, over: Record<string, string> = {}) => Object.fromEntries(KNOWN_TEMPLATES.map((k) => [k, { status: over[k] ?? status, language: "en" }]));
  const adminSays = async () => (await listInfluencers(1, `rd-${run}`)).rows.find((r) => r.id === id)?.whatsapp;
  const checklistSays = async () =>
    readinessInput(
      await prisma.influencer.findUniqueOrThrow({
        where: { id },
        select: {
          suspendedAt: true,
          suspendedReason: true,
          approvedAt: true,
          googleToken: { select: { status: true, scope: true } },
          payoutAccount: { select: { status: true } },
          whatsappConnection: { select: { status: true, templates: true } },
          _count: { select: { rules: true, services: { where: { active: true } } } },
        },
      }),
      true,
    ).whatsapp;

  const cases: [string, unknown, "ACTIVE" | "ERROR", ReadinessInput["whatsapp"]][] = [
    ["nothing was ever submitted", null, "ACTIVE", "not-submitted"],
    ["in review", all("PENDING"), "ACTIVE", "pending"],
    ["one rejected", all("APPROVED", { reschedule: "REJECTED" }), "ACTIVE", "rejected"],
    ["one has a name clash", all("APPROVED", { cancellation: "CONFLICT" }), "ACTIVE", "rejected"],
    ["all approved", all("APPROVED"), "ACTIVE", "ready"],
    ["flagged is still sent", all("APPROVED", { "reminder-15m": "FLAGGED" }), "ACTIVE", "ready"],
    ["the connection stopped working", all("APPROVED"), "ERROR", "error"],
  ];
  for (const [name, templates, status, expected] of cases) {
    await prisma.whatsAppConnection.update({ where: { influencerId: id }, data: { templates: templates === null ? Prisma.DbNull : (templates as object), status } });
    assert.equal(await adminSays(), expected, `admin: ${name}`);
    assert.equal(await checklistSays(), expected, `checklist: ${name}`);
  }
  for (const state of ["none", "ready", "pending", "rejected", "not-submitted", "error"] as const) assert.ok(WHATSAPP_BADGE[state].label, `a badge for ${state}`);
  assert.notEqual(WHATSAPP_BADGE.rejected.label, WHATSAPP_BADGE.pending.label);
  assert.notEqual(WHATSAPP_BADGE["not-submitted"].label, WHATSAPP_BADGE.pending.label);
});
