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
  payoutNeedsApproval,
  recentUnapprovedMinor,
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
const extraInfluencers: string[] = [];

/** A fresh influencer, so tests about the 24-hour sum are not affected by other tests' payouts. */
async function freshInfluencer(): Promise<string> {
  const id = (await prisma.influencer.create({ data: { slug: `po-x${extraInfluencers.length}-${run}`, name: "Approval extra", email: `po-x${extraInfluencers.length}-${run}@example.com` } })).id;
  extraInfluencers.push(id);
  return id;
}

async function newPayout(
  netMinor = 45_000,
  createdByEmail = CREATOR,
  opts: { influencerId?: string; currency?: string; createdAt?: Date; approved?: boolean; status?: "PENDING" | "PAID" | "CANCELLED" } = {},
) {
  return prisma.payout.create({
    data: {
      influencerId: opts.influencerId ?? influencerId,
      currency: opts.currency ?? "INR",
      grossMinor: netMinor,
      refundsMinor: 0,
      feeBps: 0,
      feeMinor: 0,
      netMinor,
      paymentCount: 1,
      destination: "HDFC Bank XXXXXXXX9012",
      createdByEmail,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      ...(opts.approved ? { approvedAt: new Date(), approvedByEmail: SECOND } : {}),
      ...(opts.status ? { status: opts.status } : {}),
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
    for (const id of [influencerId, ...extraInfluencers]) {
      await prisma.payout.deleteMany({ where: { influencerId: id } });
      await prisma.influencer.delete({ where: { id } });
    }
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
  // Ask the app's own rule, not the raw variable: `cp .env.example .env` leaves PAYOUT_FOUR_EYES empty, which means "default" (off outside production).
  assert.equal(fourEyesEnabled(), false, "the test environment does not enable four-eyes");
  assert.equal((await markPayoutPaid(q.id, "UTR8888888888", CREATOR)).status, "PAID");
});

test("threshold: only payouts at or above PAYOUT_FOUR_EYES_MIN_MINOR need approval", { skip }, async () => {
  const th = env({ PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "100000" });
  // Each case has its own influencer: payouts of one influencer count together (see the split test below).
  const small = await newPayout(99_999, CREATOR, { influencerId: await freshInfluencer() });
  assert.equal((await markPayoutPaid(small.id, "UTR-SMALL-001", CREATOR, th)).status, "PAID", "below the threshold: no approval needed");

  const exactly = await newPayout(100_000, CREATOR, { influencerId: await freshInfluencer() });
  await assert.rejects(markPayoutPaid(exactly.id, "UTR-EXACT-001", CREATOR, th), failsWith(409, /second administrator/), "at the threshold: approval needed");

  const big = await newPayout(250_000, CREATOR, { influencerId: await freshInfluencer() });
  await assert.rejects(markPayoutPaid(big.id, "UTR-BIG-0001", CREATOR, th), failsWith(409, /second administrator/));
  await approvePayout(big.id, SECOND);
  assert.equal((await markPayoutPaid(big.id, "UTR-BIG-0001", CREATOR, th)).status, "PAID");
});

test("splitting one transfer into payouts under the threshold does not avoid approval", { skip }, async () => {
  const th = env({ PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "100000" });
  const inf = await freshInfluencer();

  // One administrator creates 59,000 and pays it: alone it is under the threshold, so no approval.
  const first = await newPayout(59_000, CREATOR, { influencerId: inf });
  assert.equal((await markPayoutPaid(first.id, "UTR-SPLIT-001", CREATOR, th)).status, "PAID");

  // The "second half" is created next: together with the unapproved first payout it is 118,000 >= 100,000.
  const second = await newPayout(59_000, CREATOR, { influencerId: inf });
  assert.equal(await recentUnapprovedMinor(second, new Date(), th), 59_000, "the first payout counts towards the second");
  assert.equal(await payoutNeedsApproval(second, new Date(), th), true);
  await assert.rejects(markPayoutPaid(second.id, "UTR-SPLIT-002", CREATOR, th), failsWith(409, /second administrator/), "the split part needs approval");
  assert.equal((await reload(second.id)).status, "PENDING");

  // The console shows it the same way (Awaiting approval for the creator, Approve for another administrator).
  const view = payoutApprovalView(second, SECOND, th, await recentUnapprovedMinor(second, new Date(), th));
  assert.equal(view.required, true);
  assert.equal(view.canApprove, true);
  assert.equal(view.canMarkPaid, false);

  // Several pending payouts that are each small count each other: every one of them needs approval.
  const inf2 = await freshInfluencer();
  const a = await newPayout(40_000, CREATOR, { influencerId: inf2 });
  const b = await newPayout(40_000, CREATOR, { influencerId: inf2 });
  assert.equal(await payoutNeedsApproval(a, new Date(), th), false, "80,000 in total is still below");
  const c = await newPayout(40_000, CREATOR, { influencerId: inf2 });
  for (const p of [a, b, c]) assert.equal(await payoutNeedsApproval(p, new Date(), th), true, "120,000 in total: all need approval");
  await assert.rejects(markPayoutPaid(a.id, "UTR-SPLIT-00A", CREATOR, th), failsWith(409, /second administrator/));

  // Approving one of them takes it out of the sum for the others.
  await approvePayout(c.id, SECOND);
  assert.equal(await recentUnapprovedMinor(a, new Date(), th), 40_000, "only b is left unapproved");
  assert.equal((await markPayoutPaid(a.id, "UTR-SPLIT-00A", CREATOR, th)).status, "PAID", "80,000 unapproved in total: under the threshold again");
});

test("what counts towards the threshold: same influencer, same currency, unapproved, not cancelled, last 24 hours only", { skip }, async () => {
  const th = env({ PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "100000" });
  const inf = await freshInfluencer();
  const other = await freshInfluencer();
  const target = await newPayout(10_000, CREATOR, { influencerId: inf });
  const ago = (h: number) => new Date(Date.now() - h * 3_600_000);

  await newPayout(20_000, CREATOR, { influencerId: inf }); // counts
  await newPayout(5_000, CREATOR, { influencerId: inf, status: "PAID", createdAt: ago(23) }); // counts: paid without approval, 23 h ago
  await newPayout(7_000, CREATOR, { influencerId: inf, createdAt: ago(25) }); // too old
  await newPayout(11_000, CREATOR, { influencerId: inf, currency: "USD" }); // other currency
  await newPayout(13_000, CREATOR, { influencerId: other }); // other influencer
  await newPayout(17_000, CREATOR, { influencerId: inf, approved: true }); // approved
  await newPayout(19_000, CREATOR, { influencerId: inf, status: "CANCELLED" }); // cancelled
  assert.equal(await recentUnapprovedMinor(target, new Date(), th), 25_000);
  assert.equal(await recentUnapprovedMinor(target, new Date(), env({ PAYOUT_FOUR_EYES: "true", PAYOUT_FOUR_EYES_MIN_MINOR: "0" })), 0, "no query when the threshold is 0");
  assert.equal(await recentUnapprovedMinor(target, new Date(), OFF), 0, "none when four-eyes is off");
  assert.equal(await recentUnapprovedMinor(target, new Date(Date.now() + 2 * 3_600_000), th), 20_000, "two hours later the 23-hour-old payout has left the window");
});

test("mark-paid racing approve and cancel: exactly one outcome, and an unapproved payout is never marked paid", { skip }, async () => {
  const inf = await freshInfluencer();
  const outcomes: string[] = [];
  for (let round = 0; round < 8; round++) {
    const p = await newPayout(45_000, CREATOR, { influencerId: inf });
    const settled = await Promise.allSettled([
      markPayoutPaid(p.id, `UTR-RACE-${round}-0001`, CREATOR, ON),
      approvePayout(p.id, SECOND),
      cancelPayout(p.id, "race"),
    ]);
    const row = await reload(p.id);
    const [paid, approved, cancelled] = settled.map((s) => s.status === "fulfilled");
    outcomes.push(`${row.status}${row.approvedAt ? "+approved" : ""}`);

    // The invariant: money is only ever marked paid for an approved payout.
    if (row.status === "PAID") assert.ok(row.approvedAt && row.approvedByEmail === SECOND, `round ${round}: PAID implies an approval by someone else`);
    // Terminal states exclude each other.
    assert.ok(!(paid && cancelled), `round ${round}: a payout cannot be both paid and cancelled`);
    if (row.status === "PAID") assert.equal(paid, true, `round ${round}: PAID means the paid call succeeded`);
    if (row.status === "CANCELLED") assert.equal(cancelled, true);
    if (row.status === "CANCELLED") assert.equal(paid, false, `round ${round}: nothing was marked paid on a cancelled payout`);
    if (paid) assert.equal(approved, true, `round ${round}: mark-paid only succeeded because the approval had landed`);
    assert.ok(["PAID", "CANCELLED", "PENDING"].includes(row.status));
  }
  assert.ok(outcomes.length === 8);
});

test("a payout can be approved and then paid, or cancelled instead, but never paid after it was cancelled", { skip }, async () => {
  const inf = await freshInfluencer();
  const p = await newPayout(45_000, CREATOR, { influencerId: inf });
  await approvePayout(p.id, SECOND);
  await cancelPayout(p.id, "no longer needed");
  await assert.rejects(markPayoutPaid(p.id, "UTR-AFTER-CANCEL", CREATOR, ON), failsWith(409, /not pending/));
  assert.equal((await reload(p.id)).status, "CANCELLED");
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
