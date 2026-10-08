import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

// Integration tests against a migrated Postgres at DATABASE_URL (skipped otherwise): registration, login,
// sessions, email verification and password reset end to end, and that one influencer can never read or act on
// another influencer's bookings. Emails are captured in memory (no provider is called).
const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const sent: { to: string; text: string; subject: string }[] = [];

type Mods = {
  prisma: typeof import("../lib/db").prisma;
  accounts: typeof import("../lib/auth/accounts");
  session: typeof import("../lib/auth/session");
  data: typeof import("../lib/dashboard-data");
  privacy: typeof import("../lib/privacy");
  refunds: typeof import("../lib/refunds");
};
let m: Mods;
const ids: { userA?: string; userB?: string; infA?: string; infB?: string; bookingA?: string; paymentA?: string } = {};

function linkToken(text: string, path: string): string {
  const match = text.match(new RegExp(`${path}\\?token=([^\\s]+)`));
  if (!match) throw new Error(`expected a ${path} link in the email`);
  return decodeURIComponent(match[1]);
}

before(async () => {
  if (skip) return;
  process.env.APP_URL ??= "http://localhost:3000";
  const email = await import("../lib/email");
  email.setEmailSender(async (e) => {
    sent.push({ to: e.to.email, text: e.text, subject: e.subject });
    return { providerMessageId: null };
  });
  m = {
    prisma: (await import("../lib/db")).prisma,
    accounts: await import("../lib/auth/accounts"),
    session: await import("../lib/auth/session"),
    data: await import("../lib/dashboard-data"),
    privacy: await import("../lib/privacy"),
    refunds: await import("../lib/refunds"),
  };
});

after(async () => {
  if (skip) return;
  await m.prisma.influencer.deleteMany({ where: { id: { in: [ids.infA, ids.infB].filter(Boolean) as string[] } } });
  await m.prisma.$disconnect();
});

test("register, verify email, log in, reset password", { skip }, async () => {
  const a = await m.accounts.registerAccount({
    name: "Owner A",
    email: `Owner.A.${run}@Example.com`,
    password: "a long passphrase for A",
    slug: `owner-a-${run}`,
    timezone: "Asia/Kolkata",
    acceptTerms: true,
  });
  ids.userA = a.userId;
  const userA = await m.prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
  ids.infA = userA.influencerId;
  assert.equal(userA.email, `owner.a.${run}@example.com`, "email stored lowercased");
  assert.ok(!userA.passwordHash.includes("passphrase"), "password never stored in clear");
  assert.equal(userA.emailVerifiedAt, null);

  await assert.rejects(
    m.accounts.registerAccount({ name: "Dup", email: `owner.a.${run}@example.com`, password: "another long password", slug: `dup-${run}`, timezone: "UTC", acceptTerms: true }),
    /already exists/,
  );
  await assert.rejects(
    m.accounts.registerAccount({ name: "X", email: `x.${run}@example.com`, password: "another long password", slug: "dashboard", timezone: "UTC", acceptTerms: true }),
    /reserved/,
  );

  // Verify via the emailed single-use token.
  const verifyMail = sent.find((s) => s.to === userA.email && /Confirm/.test(s.subject))!;
  const vt = linkToken(verifyMail.text, "/verify-email");
  assert.equal(await m.accounts.verifyEmailToken(vt), a.userId);
  assert.equal(await m.accounts.verifyEmailToken(vt), null, "single use");

  // Login.
  assert.equal(await m.accounts.authenticate(userA.email, "wrong password!!"), null);
  const ok = await m.accounts.authenticate(`  OWNER.A.${run}@example.com `, "a long passphrase for A");
  assert.equal(ok?.userId, a.userId);

  // Session cookie token resolves to the influencer; only its hash is stored.
  const token = await m.session.createSession(a.userId, { userAgent: "test", ip: "127.0.0.1" });
  const ctx = await m.session.resolveSession(token);
  assert.equal(ctx?.influencerId, ids.infA);
  assert.equal(ctx?.emailVerified, true);
  const stored = await m.prisma.authSession.findFirst({ where: { userId: a.userId } });
  assert.notEqual(stored?.tokenHash, token);

  // Reset password: emailed 1-hour token, logs out every session.
  await m.accounts.requestPasswordReset(userA.email);
  const resetMail = sent.filter((s) => s.to === userA.email && /Reset/.test(s.subject)).pop()!;
  const rt = linkToken(resetMail.text, "/reset-password");
  await assert.rejects(m.accounts.resetPassword(rt, "short"), /at least 10/);
  await m.accounts.resetPassword(rt, "a brand new passphrase");
  assert.equal(await m.session.resolveSession(token), null, "old sessions revoked");
  await assert.rejects(m.accounts.resetPassword(rt, "yet another passphrase"), /invalid|used/);
  assert.ok(await m.accounts.authenticate(userA.email, "a brand new passphrase"));

  // Unknown emails get the same silent treatment.
  await m.accounts.requestPasswordReset(`nobody.${run}@example.com`);
});

test("one influencer cannot see or act on another influencer's bookings", { skip }, async () => {
  const b = await m.accounts.registerAccount({
    name: "Owner B",
    email: `owner.b.${run}@example.com`,
    password: "a long passphrase for B",
    slug: `owner-b-${run}`,
    timezone: "UTC",
    acceptTerms: true,
  });
  ids.userB = b.userId;
  ids.infB = (await m.prisma.user.findUniqueOrThrow({ where: { id: b.userId } })).influencerId;

  const service = await m.prisma.service.create({ data: { influencerId: ids.infA!, title: "A's call", durationMin: 30, priceMinor: 1000 } });
  const start = new Date(Date.now() + 5 * 86_400_000);
  const session = await m.prisma.session.create({ data: { serviceId: service.id, startTime: start, endTime: new Date(start.getTime() + 1_800_000) } });
  const booking = await m.prisma.booking.create({
    data: { sessionId: session.id, status: "SCHEDULED", customerName: "Cust", customerEmail: `cust.${run}@example.com`, whatsappE164: "+919876543210", whatsappOptIn: true },
  });
  const payment = await m.prisma.payment.create({
    data: { bookingId: booking.id, providerOrderId: `order_${run}`, providerPaymentId: `pay_${run}`, amountMinor: 1000, currency: "INR", status: "CAPTURED" },
  });
  ids.bookingA = booking.id;
  ids.paymentA = payment.id;

  assert.ok(await m.data.getBookingDetail(ids.infA!, booking.id), "owner sees it");
  assert.equal(await m.data.getBookingDetail(ids.infB!, booking.id), null, "other influencer gets nothing (404)");

  const theirs = await m.data.listSessions(ids.infB!, "upcoming");
  assert.equal(theirs.sessions.some((s) => s.id === session.id), false);
  const mine = await m.data.listSessions(ids.infA!, "upcoming");
  assert.equal(mine.sessions.some((s) => s.id === session.id), true);

  const customers = await m.data.listCustomers(ids.infB!, null);
  assert.equal(customers.some((c) => c.email === `cust.${run}@example.com`), false);

  await assert.rejects(
    m.refunds.refundPayment(payment.id, { influencerId: ids.infB! }, { createRefund: async () => assert.fail("no Razorpay call for a stranger") }),
    /not found/,
  );

  const erase = await m.privacy.eraseCustomerData(ids.infB!, `cust.${run}@example.com`);
  assert.equal(erase.found, 0, "cannot erase another influencer's customer");
  const live = await m.privacy.eraseCustomerData(ids.infA!, `cust.${run}@example.com`);
  assert.equal(live.blocked, 1, "an upcoming live booking is kept");
});
