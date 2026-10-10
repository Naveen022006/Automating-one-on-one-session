// Four-eyes payout approval. The configuration and view rules are pure; the ledger rules run against the database
// (skipped without DATABASE_URL). Payouts are inserted directly so no payments, bookings or Razorpay are needed.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "../lib/db";
import {
  approvalRequired,
  approvePayout,
  cancelPayout,
  fourEyesEnabled,
  fourEyesMinMinor,
  markPayoutPaid,
  payoutApprovalView,
  PayoutError,
} from "../lib/payouts";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
const ON = env({ PAYOUT_FOUR_EYES: "true" });
const OFF = env({ PAYOUT_FOUR_EYES: "false" });

test("PAYOUT_FOUR_EYES defaults to on in production and off elsewhere; the threshold defaults to always", () => {
  assert.equal(fourEyesEnabled(env({ NODE_ENV: "production" })), true);
  assert.equal(fourEyesEnabled(env({ NODE_ENV: "development" })), false);
  assert.equal(fourEyesEnabled(env({})), false);
  assert.equal(fourEyesEnabled(env({ NODE_ENV: "production", PAYOUT_FOUR_EYES: "false" })), false);
  assert.equal(fourEyesEnabled(env({ PAYOUT_FOUR_EYES: "true" })), true);
  assert.equal(fourEyesMinMinor(env({})), 0);
  assert.equal(fourEyesMinMinor(env({ PAYOUT_FOUR_EYES_MIN_MINOR: "250000" })), 250_000);
  assert.equal(fourEyesMinMinor(env({ PAYOUT_FOUR_EYES_MIN_MINOR: "-5" })), 0);
  assert.equal(fourEyesMinMinor(env({ PAYOUT_FOUR_EYES_MIN_MINOR: "abc" })), 0);
});

test("approval is needed at or above the threshold, always when it is 0, never when four-eyes is off", () => {
  const th = env({ PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "100000" });
  assert.equal(approvalRequired(99_999, th), false);
  assert.equal(approvalRequired(100_000, th), true, "at the threshold");
  assert.equal(approvalRequired(100_001, th), true);
  assert.equal(approvalRequired(1, ON), true);
  assert.equal(approvalRequired(10_000_000, OFF), false);
  assert.equal(approvalRequired(10_000_000, env({ PAYOUT_FOUR_EYES: "false", PAYOUT_FOUR_EYES_MIN_MINOR: "1" })), false);
});

test("the console view: who can approve, and when Mark as paid unlocks", () => {
  const base = { status: "PENDING", netMinor: 50_000, createdByEmail: "a@example.com", approvedAt: null, approvedByEmail: null };
  const creator = payoutApprovalView(base, "A@Example.com", ON);
  assert.deepEqual(creator, { required: true, approved: false, approvedByEmail: null, canApprove: false, createdByViewer: true, canMarkPaid: false });
  const other = payoutApprovalView(base, "b@example.com", ON);
  assert.equal(other.canApprove, true);
  assert.equal(other.canMarkPaid, false, "awaiting approval");

  const approved = payoutApprovalView({ ...base, approvedAt: new Date(), approvedByEmail: "b@example.com" }, "a@example.com", ON);
  assert.equal(approved.canMarkPaid, true);
  assert.equal(approved.canApprove, false, "already approved");
  assert.equal(approved.approvedByEmail, "b@example.com");

  const off = payoutApprovalView(base, "a@example.com", OFF);
  assert.equal(off.required, false);
  assert.equal(off.canMarkPaid, true, "no approval step when four-eyes is off");

  const paid = payoutApprovalView({ ...base, status: "PAID" }, "b@example.com", ON);
  assert.equal(paid.canApprove, false);
  assert.equal(paid.canMarkPaid, false, "nothing to do on a finished payout");
});

// ---- Integration ----
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = Date.now();
const CREATOR = `po-creator-${run}@example.com`;
const SECOND = `po-second-${run}@example.com`;
const THIRD = `po-third-${run}@example.com`;
let influencerId = "";

async function newPayout(netMinor = 45_000, createdByEmail = CREATOR) {
  return prisma.payout.create({
    data: {
      influencerId,
      currency: "INR",
      grossMinor: netMinor,
      refundsMinor: 0,
      feeBps: 0,
      feeMinor: 0,
      netMinor,
      paymentCount: 1,
      destination: "HDFC Bank XXXXXXXX9012",
      createdByEmail,
    },
  });
}
const reload = (id: string) => prisma.payout.findUniqueOrThrow({ where: { id } });
const failsWith = (status: number, pattern: RegExp) => (e: unknown) => e instanceof PayoutError && e.status === status && pattern.test(e.message);

before(async () => {
  if (skip) return;
  influencerId = (await prisma.influencer.create({ data: { slug: `po-${run}`, name: "Approval", email: `po-${run}@example.com` } })).id;
});

after(async () => {
  if (!skip && influencerId) {
    await prisma.payout.deleteMany({ where: { influencerId } });
    await prisma.influencer.delete({ where: { id: influencerId } });
  }
  await prisma.$disconnect();
});

test("the administrator who created a payout cannot approve it (any letter case)", { skip }, async () => {
  const p = await newPayout();
  await assert.rejects(approvePayout(p.id, CREATOR), failsWith(403, /different administrator/));
  await assert.rejects(approvePayout(p.id, CREATOR.toUpperCase()), failsWith(403, /different administrator/));
  const row = await reload(p.id);
  assert.equal(row.approvedAt, null);
  assert.equal(row.approvedByEmail, null);
});

test("a different administrator can approve; it is recorded once and does not touch the money", { skip }, async () => {
  const p = await newPayout();
  const at = new Date("2026-10-20T10:00:00Z");
  const approved = await approvePayout(p.id, SECOND, at);
  assert.equal(approved.approvedByEmail, SECOND);
  assert.equal(approved.approvedAt?.toISOString(), at.toISOString());
  assert.equal(approved.status, "PENDING", "approval is not payment");
  assert.equal(approved.netMinor, p.netMinor);
  assert.equal(approved.createdByEmail, CREATOR);

  await assert.rejects(approvePayout(p.id, THIRD), failsWith(409, /already approved/));
  await assert.rejects(approvePayout(p.id, SECOND), failsWith(409, /already approved/));
  assert.equal((await reload(p.id)).approvedByEmail, SECOND, "the first approval stands");
});

test("two administrators approving at once: one approval is recorded", { skip }, async () => {
  const p = await newPayout();
  const settled = await Promise.allSettled([approvePayout(p.id, SECOND), approvePayout(p.id, THIRD)]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  assert.ok([SECOND, THIRD].includes((await reload(p.id)).approvedByEmail ?? ""));
});

test("mark-as-paid is refused until a second administrator has approved (four-eyes on)", { skip }, async () => {
  const p = await newPayout();
  await assert.rejects(markPayoutPaid(p.id, "UTR1234567890", CREATOR, ON), failsWith(409, /second administrator/));
  await assert.rejects(markPayoutPaid(p.id, "UTR1234567890", SECOND, ON), failsWith(409, /second administrator/), "nobody can pay an unapproved payout, not even another admin");
  assert.equal((await reload(p.id)).status, "PENDING");

  await approvePayout(p.id, SECOND);
  const paid = await markPayoutPaid(p.id, "UTR1234567890", CREATOR, ON);
  assert.equal(paid.status, "PAID");
  assert.equal(paid.paidByEmail, CREATOR);
  assert.equal(paid.approvedByEmail, SECOND, "the approver is kept on the paid payout");
  await assert.rejects(markPayoutPaid(p.id, "UTR1234567890", CREATOR, ON), failsWith(409, /not pending/));
  await assert.rejects(approvePayout(p.id, THIRD), failsWith(409, /pending/), "a paid payout cannot be approved");
});

test("with four-eyes off a payout can be paid without approval (and the default env of the test run is off)", { skip }, async () => {
  const p = await newPayout();
  const paid = await markPayoutPaid(p.id, "UTR9999999999", CREATOR, OFF);
  assert.equal(paid.status, "PAID");
  assert.equal(paid.approvedAt, null);

  const q = await newPayout();
  assert.equal(process.env.PAYOUT_FOUR_EYES === undefined || process.env.PAYOUT_FOUR_EYES === "false", true, "the test environment does not enable four-eyes");
  assert.equal((await markPayoutPaid(q.id, "UTR8888888888", CREATOR)).status, "PAID");
});

test("threshold: only payouts at or above PAYOUT_FOUR_EYES_MIN_MINOR need approval", { skip }, async () => {
  const th = env({ PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "100000" });
  const small = await newPayout(99_999);
  assert.equal((await markPayoutPaid(small.id, "UTR-SMALL-001", CREATOR, th)).status, "PAID", "below the threshold: no approval needed");

  const exactly = await newPayout(100_000);
  await assert.rejects(markPayoutPaid(exactly.id, "UTR-EXACT-001", CREATOR, th), failsWith(409, /second administrator/), "at the threshold: approval needed");

  const big = await newPayout(250_000);
  await assert.rejects(markPayoutPaid(big.id, "UTR-BIG-0001", CREATOR, th), failsWith(409, /second administrator/));
  await approvePayout(big.id, SECOND);
  assert.equal((await markPayoutPaid(big.id, "UTR-BIG-0001", CREATOR, th)).status, "PAID");
});

test("approve edge cases: unknown payout, cancelled payout; an approved payout can still be cancelled", { skip }, async () => {
  await assert.rejects(approvePayout("does-not-exist", SECOND), failsWith(404, /not found/));

  const cancelled = await newPayout();
  await cancelPayout(cancelled.id, "mistake");
  await assert.rejects(approvePayout(cancelled.id, SECOND), failsWith(409, /pending/));

  const approved = await newPayout();
  await approvePayout(approved.id, SECOND);
  await cancelPayout(approved.id, "changed my mind");
  assert.equal((await reload(approved.id)).status, "CANCELLED");
});
