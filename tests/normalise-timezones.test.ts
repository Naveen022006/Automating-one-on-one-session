import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import { applyPlans, describeAction, loadPlans, parseNormaliseArgs, planInfluencer, planRule, type RuleInput } from "../lib/normalise-timezones";
import { generateSlots } from "../lib/slots";

const NOW = new Date("2026-10-18T00:00:00Z");
const rule = (timezone: string, startTime: string, endTime: string, weekday = 1): RuleInput => ({ id: `r-${timezone}-${startTime}`, weekday, startTime, endTime, timezone });

test("a rule already in IST is left alone", () => {
  assert.deepEqual(planRule(rule("Asia/Kolkata", "10:00", "12:00"), NOW), { kind: "already-ist" });
});

test("zones without daylight saving convert exactly (the offset difference is added to both ends)", () => {
  assert.deepEqual(planRule(rule("Asia/Dubai", "10:00", "12:00"), NOW), { kind: "convert", startTime: "11:30", endTime: "13:30", offsetMinutes: 240, shiftMinutes: 90 });
  assert.deepEqual(planRule(rule("Asia/Singapore", "09:00", "17:00"), NOW), { kind: "convert", startTime: "06:30", endTime: "14:30", offsetMinutes: 480, shiftMinutes: -150 });
  assert.deepEqual(planRule(rule("UTC", "10:00", "12:00"), NOW), { kind: "convert", startTime: "15:30", endTime: "17:30", offsetMinutes: 0, shiftMinutes: 330 });
  assert.deepEqual(planRule(rule("Asia/Kathmandu", "10:00", "11:00"), NOW), { kind: "convert", startTime: "09:45", endTime: "10:45", offsetMinutes: 345, shiftMinutes: -15 });
  assert.deepEqual(planRule(rule("Asia/Calcutta", "10:00", "11:00"), NOW), { kind: "convert", startTime: "10:00", endTime: "11:00", offsetMinutes: 330, shiftMinutes: 0 }, "an alias of IST");
});

test("zones with daylight saving are refused: one fixed IST rule cannot say 'ten in New York'", () => {
  for (const zone of ["Europe/London", "America/New_York", "Australia/Sydney", "Europe/Berlin", "America/Los_Angeles"]) {
    const a = planRule(rule(zone, "10:00", "12:00"), NOW);
    assert.equal(a.kind, "refuse", zone);
    if (a.kind === "refuse") assert.equal(a.reason, "dst-zone", zone);
  }
});

test("a window that would leave its weekday is refused", () => {
  for (const [zone, start, end] of [
    ["UTC", "20:00", "22:00"], // 01:30-03:30 the next day
    ["UTC", "18:00", "19:00"], // 23:30-00:30
    ["UTC", "23:00", "23:59"],
    ["Asia/Singapore", "00:00", "02:00"], // -150 min: 21:30 the day before
  ] as const) {
    const a = planRule(rule(zone, start, end), NOW);
    assert.equal(a.kind, "refuse", `${zone} ${start}-${end}`);
    if (a.kind === "refuse") assert.equal(a.reason, "crosses-midnight", `${zone} ${start}-${end}`);
  }
  // The edge that still fits: 18:29 UTC + 330 = 23:59.
  assert.equal(planRule(rule("UTC", "17:00", "18:29"), NOW).kind, "convert");
});

test("an unknown zone and a broken window are refused with the reason", () => {
  const unknown = planRule(rule("Not/AZone", "10:00", "12:00"), NOW);
  assert.equal(unknown.kind === "refuse" && unknown.reason, "unknown-zone");
  const bad = planRule(rule("Asia/Dubai", "12:00", "10:00"), NOW);
  assert.equal(bad.kind === "refuse" && bad.reason, "bad-time");
});

test("what is converted produces exactly the same instants as before, across a whole year", () => {
  const from = new Date("2026-10-18T00:00:00Z");
  const to = new Date("2027-10-18T00:00:00Z");
  for (const [zone, start, end, weekday, duration] of [
    ["Asia/Dubai", "10:00", "13:00", 3, 30],
    ["Asia/Singapore", "09:00", "17:00", 1, 45],
    ["UTC", "04:00", "12:30", 6, 60],
    ["Asia/Kathmandu", "10:00", "12:00", 5, 30],
  ] as const) {
    const old = rule(zone, start, end, weekday);
    const action = planRule(old, NOW);
    assert.equal(action.kind, "convert", zone);
    if (action.kind !== "convert") continue;
    const before = generateSlots([old], duration, from, to).map((d) => d.toISOString());
    const after = generateSlots([{ ...old, startTime: action.startTime, endTime: action.endTime, timezone: "Asia/Kolkata" }], duration, from, to).map((d) => d.toISOString());
    assert.ok(before.length > 100, zone);
    assert.deepEqual(after, before, zone);
  }
});

test("an influencer is 'fully IST' only when no rule is refused", () => {
  const ok = planInfluencer({ id: "i1", slug: "a", timezone: "Asia/Dubai", rules: [rule("Asia/Dubai", "10:00", "12:00"), rule("Asia/Kolkata", "13:00", "14:00")] }, NOW);
  assert.equal(ok.fullyIst, true);
  const mixed = planInfluencer({ id: "i2", slug: "b", timezone: "America/New_York", rules: [rule("Asia/Dubai", "10:00", "12:00"), rule("America/New_York", "10:00", "12:00")] }, NOW);
  assert.equal(mixed.fullyIst, false);
  assert.match(describeAction(mixed.rules[1].rule, mixed.rules[1].action), /REFUSE \(dst-zone\)/);
  assert.match(describeAction(mixed.rules[0].rule, mixed.rules[0].action), /CONVERT to 11:30-13:30 Asia\/Kolkata \(shift \+90 min\)/);
});

test("the command line: dry run by default, --apply needs --confirm", () => {
  assert.deepEqual(parseNormaliseArgs([]), { apply: false, confirm: null, help: false, unknown: [] });
  assert.deepEqual(parseNormaliseArgs(["--apply", "--confirm=NORMALISE-TIMEZONES"]), { apply: true, confirm: "NORMALISE-TIMEZONES", help: false, unknown: [] });
  assert.deepEqual(parseNormaliseArgs(["--wat"]).unknown, ["--wat"]);
});

/* ---------- against the database ---------- */

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
const ids: string[] = [];

before(async () => {
  if (skip) return;
  const make = async (tag: string, timezone: string, rules: { weekday: number; startTime: string; endTime: string; timezone: string }[]) => {
    const inf = await prisma.influencer.create({ data: { slug: `normtz-${tag}-${run}`, name: `Normtz ${tag}`, email: `normtz-${tag}-${run}@example.com`, timezone, rules: { create: rules } } });
    ids.push(inf.id);
    return inf.id;
  };
  await make("a", "Asia/Dubai", [
    { weekday: 1, startTime: "10:00", endTime: "12:00", timezone: "Asia/Dubai" },
    { weekday: 2, startTime: "09:00", endTime: "10:00", timezone: "Asia/Kolkata" },
  ]);
  await make("b", "America/New_York", [
    { weekday: 1, startTime: "10:00", endTime: "12:00", timezone: "America/New_York" },
    { weekday: 3, startTime: "10:00", endTime: "12:00", timezone: "Asia/Dubai" },
  ]);
  await make("c", "Asia/Kolkata", [{ weekday: 1, startTime: "10:00", endTime: "12:00", timezone: "Asia/Kolkata" }]);
});

after(async () => {
  if (!skip) await prisma.influencer.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

test("loadPlans finds only influencers with a rule outside IST; applyPlans writes the exact ones and leaves the refused alone", { skip }, async () => {
  const plans = await loadPlans(prisma, NOW, ids);
  assert.deepEqual(plans.map((p) => p.slug).sort(), [`normtz-a-${run}`, `normtz-b-${run}`]);
  const result = await applyPlans(prisma, plans);
  assert.deepEqual(result, { written: 2, skipped: 0 });

  const a = await prisma.influencer.findUniqueOrThrow({ where: { slug: `normtz-a-${run}` }, include: { rules: { orderBy: { weekday: "asc" } } } });
  assert.equal(a.timezone, "Asia/Kolkata", "all of its rules are IST now, so the profile zone follows");
  assert.deepEqual(a.rules.map((r) => [r.weekday, r.startTime, r.endTime, r.timezone]), [
    [1, "11:30", "13:30", "Asia/Kolkata"],
    [2, "09:00", "10:00", "Asia/Kolkata"],
  ]);

  const b = await prisma.influencer.findUniqueOrThrow({ where: { slug: `normtz-b-${run}` }, include: { rules: { orderBy: { weekday: "asc" } } } });
  assert.equal(b.timezone, "America/New_York", "a refused rule keeps the profile zone as it was");
  assert.deepEqual(b.rules.map((r) => [r.weekday, r.startTime, r.endTime, r.timezone]), [
    [1, "10:00", "12:00", "America/New_York"],
    [3, "11:30", "13:30", "Asia/Kolkata"],
  ]);

  // A second run has nothing left to convert for A, and still refuses B's New York rule.
  const again = await loadPlans(prisma, NOW, ids);
  assert.deepEqual(again.map((p) => p.slug), [`normtz-b-${run}`]);
  assert.deepEqual(await applyPlans(prisma, again), { written: 0, skipped: 0 });
});

test("a rule edited between the plan and the write is not overwritten", { skip }, async () => {
  const inf = await prisma.influencer.create({
    data: { slug: `normtz-d-${run}`, name: "Normtz d", email: `normtz-d-${run}@example.com`, timezone: "Asia/Dubai", rules: { create: [{ weekday: 4, startTime: "10:00", endTime: "12:00", timezone: "Asia/Dubai" }] } },
    include: { rules: true },
  });
  ids.push(inf.id);
  const plans = await loadPlans(prisma, NOW, [inf.id]);
  // The influencer changes the hours after the plan was read.
  await prisma.availabilityRule.update({ where: { id: inf.rules[0].id }, data: { startTime: "14:00", endTime: "16:00" } });
  assert.deepEqual(await applyPlans(prisma, plans), { written: 0, skipped: 1 });
  const rule = await prisma.availabilityRule.findUniqueOrThrow({ where: { id: inf.rules[0].id } });
  assert.deepEqual([rule.startTime, rule.endTime, rule.timezone], ["14:00", "16:00", "Asia/Dubai"]);
});
