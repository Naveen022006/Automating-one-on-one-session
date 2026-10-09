import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openSlots } from "../lib/availability";
import { windowBounds, windowProblem, withinWindow } from "../lib/booking-window";
import { prisma } from "../lib/db";
import { createHold } from "../lib/holds";
import {
  intakeQuestionsInput,
  MAX_QUESTIONS,
  parseAnswers,
  parseQuestions,
  validateAnswers,
  type IntakeQuestion,
} from "../lib/intake";

const questions: IntakeQuestion[] = [
  { id: "goal", label: "What do you want to work on?", type: "longtext", required: true },
  { id: "level", label: "Experience level", type: "select", required: true, options: ["Beginner", "Intermediate", "Advanced"] },
  { id: "link", label: "Portfolio link", type: "text", required: false },
];

test("questions: valid input gets stable ids; bad input is rejected", () => {
  const ok = intakeQuestionsInput.safeParse([
    { label: "First question here", type: "text", required: true },
    { id: "q1", label: "Second question here", type: "longtext" },
    { label: "Pick one please", type: "select", options: ["A", "B"] },
  ]);
  assert.equal(ok.success, true);
  if (ok.success) {
    const ids = ok.data.map((q) => q.id);
    assert.equal(new Set(ids).size, 3, "ids are unique");
    assert.ok(ids.includes("q1"), "an explicit id is kept");
    assert.equal(ok.data[1].required, false, "required defaults to false");
  }
  const bad = (input: unknown) => intakeQuestionsInput.safeParse(input).success;
  assert.equal(bad([{ label: "ab", type: "text" }]), false, "label too short");
  assert.equal(bad([{ label: "Pick one please", type: "select" }]), false, "select needs options");
  assert.equal(bad([{ label: "Pick one please", type: "select", options: ["Only"] }]), false, "at least two options");
  assert.equal(bad([{ label: "Pick one please", type: "select", options: ["A", "a"] }]), false, "options must differ");
  assert.equal(bad([{ label: "A text question", type: "text", options: ["A", "B"] }]), false, "only select has options");
  assert.equal(bad([{ id: "x", label: "First question", type: "text" }, { id: "x", label: "Second question", type: "text" }]), false, "duplicate ids");
  assert.equal(bad(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => ({ label: `Question number ${i}`, type: "text" }))), false, "too many questions");
});

test("answers: required, choices, lengths and unknown ids", () => {
  const good = validateAnswers(questions, { goal: "  Land a PM role\r\nin 3 months ", level: "Beginner", extra: "ignored" });
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.deepEqual(good.answers.map((a) => a.id), ["goal", "level"], "optional blank is skipped; unknown id never stored");
    assert.equal(good.answers[0].answer, "Land a PM role\nin 3 months");
    assert.equal(good.answers[0].label, "What do you want to work on?", "question text is copied in");
  }
  const missing = validateAnswers(questions, { level: "Advanced" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.deepEqual(Object.keys(missing.errors), ["goal"]);
  const wrongChoice = validateAnswers(questions, { goal: "x", level: "Expert" });
  assert.equal(wrongChoice.ok, false);
  const tooLong = validateAnswers(questions, { goal: "a".repeat(1001), level: "Beginner" });
  assert.equal(tooLong.ok, false);
  const multiline = validateAnswers(questions, { goal: "x", level: "Beginner", link: "a\nb" });
  assert.equal(multiline.ok, false, "a short answer must be a single line");
  assert.equal(validateAnswers([], undefined).ok, true, "no questions, nothing to answer");
  assert.equal(validateAnswers(questions, ["not", "an", "object"]).ok, false, "garbage input fails required questions");
  assert.deepEqual(validateAnswers(questions, { goal: 42, level: null }).ok, false, "non-strings are ignored");
});

test("stored JSON is read defensively", () => {
  assert.deepEqual(parseQuestions(null), []);
  assert.deepEqual(parseQuestions("nope"), []);
  assert.equal(parseQuestions([...questions, { broken: true }]).length, 3, "malformed entries are dropped");
  assert.deepEqual(parseAnswers([{ id: "a", label: "L", answer: "A" }, { nope: 1 }, null]), [{ id: "a", label: "L", answer: "A" }]);
});

test("booking window: earliest and latest start", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const rule = { minNoticeHours: 24, maxAdvanceDays: 30 };
  const b = windowBounds(rule, now);
  assert.equal(b.earliest.toISOString(), "2026-10-21T12:00:00.000Z");
  assert.equal(b.latest.toISOString(), "2026-11-19T12:00:00.000Z");
  assert.equal(withinWindow(new Date("2026-10-21T11:59:00Z"), rule, now), false);
  assert.equal(withinWindow(new Date("2026-10-21T12:00:00Z"), rule, now), true);
  assert.equal(withinWindow(new Date("2026-11-19T12:00:00Z"), rule, now), true);
  assert.equal(withinWindow(new Date("2026-11-19T12:01:00Z"), rule, now), false);
  assert.match(windowProblem(new Date("2026-10-20T13:00:00Z"), rule, now)!, /1 day\(s\) notice/);
  assert.match(windowProblem(new Date("2026-10-20T13:00:00Z"), { minNoticeHours: 6, maxAdvanceDays: 30 }, now)!, /6 hour/);
  assert.match(windowProblem(new Date("2027-01-01T12:00:00Z"), rule, now)!, /30 days ahead/);
  assert.equal(windowProblem(new Date("2026-10-25T12:00:00Z"), rule, now), null);
  assert.equal(withinWindow(new Date("2026-10-20T12:00:01Z"), { minNoticeHours: 0, maxAdvanceDays: 1 }, now), true, "no minimum notice");
});

// ---- Integration (skipped without a database) ----
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
let influencerId: string;
let serviceId: string;

before(async () => {
  if (skip) return;
  const inf = await prisma.influencer.create({
    data: {
      slug: `cs-${run}`,
      name: "Custom",
      email: `cs-${run}@example.com`,
      onboardedAt: new Date(),
      rules: { create: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:30", timezone: "UTC" })) },
    },
  });
  influencerId = inf.id;
  serviceId = (
    await prisma.service.create({
      data: { influencerId, title: "Custom", durationMin: 30, priceMinor: 1000, minNoticeHours: 48, maxAdvanceDays: 5, intakeQuestions: questions },
    })
  ).id;
});

after(async () => {
  if (!skip && influencerId) await prisma.influencer.delete({ where: { id: influencerId } });
  await prisma.$disconnect();
});

test("slots are limited to the booking window for customers, not for the owner", { skip }, async () => {
  const service = {
    id: serviceId,
    influencerId,
    durationMin: 30,
    capacity: 1,
    timezone: "UTC",
    rules: await prisma.availabilityRule.findMany({ where: { influencerId } }),
    minNoticeHours: 48,
    maxAdvanceDays: 5,
  };
  const now = new Date();
  const wide = { from: new Date(now.getTime()), to: new Date(now.getTime() + 20 * 86_400_000) };
  const customer = await openSlots(service, wide.from, wide.to, now);
  assert.ok(customer.length > 0);
  const { earliest, latest } = windowBounds(service, now);
  for (const s of customer) {
    const t = new Date(s.start).getTime();
    assert.ok(t >= earliest.getTime() && t <= latest.getTime(), `${s.start} is inside the window`);
  }
  const owner = await openSlots(service, wide.from, wide.to, now, { ignoreWindow: true });
  assert.ok(owner.length > customer.length, "the owner preview is not window-limited");
  assert.deepEqual(await openSlots(service, new Date(now.getTime()), new Date(now.getTime() + 3_600_000), now), [], "nothing inside the notice period");
});

test("answers are stored with the booking and erased with the customer's data", { skip }, async () => {
  const start = new Date(Date.now() + 3 * 86_400_000);
  start.setUTCMinutes(0, 0, 0);
  const answered = validateAnswers(questions, { goal: "Switch careers", level: "Intermediate" });
  assert.ok(answered.ok);
  const hold = await createHold({
    serviceId,
    startTime: start,
    endTime: new Date(start.getTime() + 30 * 60_000),
    capacity: 1,
    customerName: "Answerer",
    customerEmail: `a-${run}@example.com`,
    whatsappE164: "+919876543210",
    whatsappOptIn: true,
    intakeAnswers: answered.ok ? answered.answers : [],
  });
  const row = await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } });
  const stored = parseAnswers(row.intakeAnswers);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].label, "What do you want to work on?");

  // A service edit afterwards must not rewrite what this customer was asked.
  await prisma.service.update({ where: { id: serviceId }, data: { intakeQuestions: [{ id: "goal", label: "Totally different", type: "text", required: false }] } });
  assert.equal(parseAnswers((await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } })).intakeAnswers)[0].label, "What do you want to work on?");

  await prisma.booking.update({ where: { id: hold.id }, data: { status: "CANCELLED" } });
  const { eraseCustomerData } = await import("../lib/privacy");
  const result = await eraseCustomerData(influencerId, `a-${run}@example.com`);
  assert.equal(result.erased, 1);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: hold.id } })).intakeAnswers, null);
});
