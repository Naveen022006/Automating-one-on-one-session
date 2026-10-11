import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  applyProblems,
  classifyAdmin,
  classifyInfluencer,
  CONFIRM_VALUE,
  emailDomain,
  hasTimestamp,
  isProtectedAdminEmail,
  isProtectedInfluencerSlug,
  isTestAdminEmail,
  isTestCustomerEmail,
  isTestInfluencerSlug,
  isTestWebhookEventId,
  parseCleanupArgs,
  TABLES,
} from "../lib/test-data-cleanup";

// ---- Pure classifier tests (no database) ------------------------------------------------------------------------------

const TS = "1791659329353"; // a millisecond timestamp (October 2026)

test("hasTimestamp: a standalone 13 to 16 digit run that reads as a plausible epoch in ms", () => {
  assert.equal(hasTimestamp(`x-${TS}`), true);
  assert.equal(hasTimestamp(`x-${TS}123`), true); // run + 3 random digits, as the QA tests build it
  assert.equal(hasTimestamp("x-9999999999999"), false); // year 2286
  assert.equal(hasTimestamp("x-1234567890123"), false); // 2009
  assert.equal(hasTimestamp("x-17916593293531234567"), false); // 20 digits: not a timestamp run
  assert.equal(hasTimestamp("x-179165932935"), false); // 12 digits
  assert.equal(hasTimestamp("+919876543210"), false); // a phone number
});

test("isTestAdminEmail / isTestCustomerEmail: the shapes this repo's tests and QA runs generate", () => {
  for (const e of [
    `routes-x-${TS}@example.com`,
    `routes-y-${TS}@example.com`,
    `routes-q-${TS}@example.com`,
    `routes-z-${TS}@example.com`,
    `lock-${TS}@example.com`,
    `mfa-a-${TS}@example.com`,
    `mfa-b-${TS}@example.com`,
    `mfa-race-${TS}-3@example.com`,
    `core-c1-${TS}@example.com`,
    `rec${TS}_3@example.com`,
    `hs${TS}@example.com`,
    `c1-${TS}@example.com`,
    `cust.${TS}123@example.com`,
    `qa-console-${TS}@example.com`,
    "qa-clean-cust-90a@example.com",
    "qacust-1@example.com",
    "spa-parity-3@example.com",
  ]) {
    assert.equal(isTestAdminEmail(e), true, e);
    assert.equal(isTestCustomerEmail(e), true, e);
  }
});

test("adversarial near-misses are NOT test data", () => {
  for (const e of [
    "admin@example.com",
    "admin1@example.com",
    "admin2@example.com",
    "ADMIN@EXAMPLE.COM",
    "Admin1@Example.com",
    "demo@example.com",
    "DEMO@example.com",
    "admin7@example.com", // a unit-test fixture, no timestamp
    "ops@example.com",
    "a@example.com",
    "qa@example.com", // no dash after qa
    "qac@example.com",
    "priya.sharma@gmail.com", // a real-looking customer
    "priya.sharma@example.com",
    `priya${TS}@gmail.com`, // timestamp but not example.com
    `routes-x-${TS}@example.org`,
    `routes-x-${TS}@example.com.evil.io`,
    `routes-x-${TS}@sub.example.com`,
    `routes-x-${TS}@xexample.com`,
    `ROUTES-X-${TS}@example.com`, // uppercase variant: stored addresses are lowercase, an uppercase one is not ours
    ` routes-x-${TS}@example.com`, // padded
    `routes-x-${TS}@example.com `,
    `user-9999999999999@example.com`,
    `user-12345@example.com`,
    `user-${TS}${TS}@example.com`, // a 26-digit run
    `@example.com`,
    "",
    "not an email",
    `${TS}@`,
  ]) {
    assert.equal(isTestAdminEmail(e), false, JSON.stringify(e));
    assert.equal(isTestCustomerEmail(e), false, JSON.stringify(e));
  }
});

test("protected admin e-mails are protected in any case or padding, and never test data", () => {
  for (const e of ["admin@example.com", "admin1@example.com", "admin2@example.com", " ADMIN2@Example.com ", "Admin@EXAMPLE.com"]) {
    assert.equal(isProtectedAdminEmail(e), true, e);
    assert.equal(classifyAdmin(e), "protected", e);
  }
  for (const e of ["admin3@example.com", "admin@example.org", "xadmin@example.com", "admin1@example.com.au", "demo@example.com"]) {
    assert.equal(isProtectedAdminEmail(e), false, e);
  }
  assert.equal(classifyAdmin(`routes-x-${TS}@example.com`), "test");
  assert.equal(classifyAdmin("ops@example.com"), "unmatched");
});

test("isTestInfluencerSlug: documented prefixes need a timestamp; qa-style slugs and spa-parity-<n> do not", () => {
  for (const s of [
    `ap-${TS}`, `ap2-${TS}`, `pay-${TS}`, `hs-${TS}`, `rd-${TS}`, `rec-${TS}`, `core-a-${TS}`, `routes-po-${TS}`, `po-x1-${TS}`,
    `qac5-x-${TS}`, `qac18-${TS}123`, `owner-a-${TS}123`, `spa-owner-${TS}`, `mp-wa-${TS}-ab12cd`, `cleanup-${TS}`, `wa-s-${TS}`,
    "spa-parity-1179", "spa-parity-6358", "qa-clean-90a", "qacon-a-renamed", "qacust-reg-1",
  ]) {
    assert.equal(isTestInfluencerSlug(s), true, s);
  }
  for (const s of [
    "demo", "DEMO", "Demo", "demo-1", `demo-${TS}`, "pat", "priya", "asha", "host", "a", "dashboard",
    "ap-priya", "ap-12345", `ap${TS}`, // no dash after the prefix
    `unknown-${TS}`, `coach-${TS}`, `core-A-${TS}`, `CORE-a-${TS}`, `core_a_${TS}`, ` core-a-${TS}`,
    "qa", "qa-", "qac", "QA-clean", "spa-parity-", "spa-parity-x", "spa-1", "routes-x", "-", "",
  ]) {
    assert.equal(isTestInfluencerSlug(s), false, JSON.stringify(s));
  }
});

test("protected slugs win over every pattern, including extra protected ones", () => {
  assert.equal(isProtectedInfluencerSlug("demo"), true);
  assert.equal(isProtectedInfluencerSlug(" Demo "), true);
  assert.equal(isProtectedInfluencerSlug("demo2"), false);
  assert.equal(isTestInfluencerSlug(`cleanup-${TS}`, [`cleanup-${TS}`]), false);
  assert.equal(isTestInfluencerSlug(`cleanup-${TS}`, [`CLEANUP-${TS}`]), false);
  assert.equal(isTestInfluencerSlug(`cleanup-${TS}`, ["other"]), true);
});

test("classifyInfluencer: two independent signals, protection first, one signal is ambiguous", () => {
  const ok = classifyInfluencer({ slug: `ap-${TS}`, email: `ap-${TS}@example.com`, userEmail: `ap-${TS}@example.com` });
  assert.equal(ok.kind, "test");
  assert.equal(classifyInfluencer({ slug: `ap-${TS}`, email: `ap-${TS}@example.com` }).kind, "test"); // no login
  assert.equal(classifyInfluencer({ slug: "spa-parity-3", email: "whoever@example.com" }).kind, "test");
  assert.equal(classifyInfluencer({ slug: "demo", email: "demo@example.com", userEmail: "demo@example.com" }).kind, "protected");
  assert.equal(classifyInfluencer({ slug: "demo", email: `ap-${TS}@example.com` }).kind, "protected");
  assert.equal(classifyInfluencer({ slug: `ap-${TS}`, email: "demo@example.com" }).kind, "protected"); // uses the demo address
  assert.equal(classifyInfluencer({ slug: `ap-${TS}`, email: `ap-${TS}@example.com`, userEmail: "DEMO@example.com" }).kind, "protected");
  // slug matches but the address is a real one: ambiguous, kept
  assert.equal(classifyInfluencer({ slug: `ap-${TS}`, email: "real.person@gmail.com" }).kind, "ambiguous");
  // the login is a real address: ambiguous, kept
  assert.equal(classifyInfluencer({ slug: `ap-${TS}`, email: `ap-${TS}@example.com`, userEmail: "real.person@gmail.com" }).kind, "ambiguous");
  // address matches, slug does not
  assert.equal(classifyInfluencer({ slug: "coach", email: `ap-${TS}@example.com` }).kind, "ambiguous");
  // test address and a timestamped (unlisted) slug: two signals
  assert.equal(classifyInfluencer({ slug: `newprefix-${TS}`, email: `newprefix-${TS}@example.com` }).kind, "test");
  assert.equal(classifyInfluencer({ slug: "coach", email: "coach@gmail.com" }).kind, "unmatched");
});

test("isTestWebhookEventId: only the shapes the tests write, or the recovery id of a deleted payment", () => {
  for (const id of [`evt_${TS}_a`, `evt_${TS}123_c`, `evt_rec_${TS}_race3`, `evt_rec_${TS}_wf`, `recovery:pay_order_rec_${TS}_1`, `recovery:pay_order_${TS}_1`, "evt_qa_one", "evt_qa-two"]) {
    assert.equal(isTestWebhookEventId(id), true, id);
  }
  for (const id of ["evt_Hq7xAbCdEf12345", "evt_", "evt_9999999999999_a", "recovery:pay_Abc123", "payment.captured", "EVT_1791659329353_a", `xevt_${TS}_a`, `evt_${TS}`.toUpperCase(), ""]) {
    assert.equal(isTestWebhookEventId(id), false, id);
  }
  assert.equal(isTestWebhookEventId("recovery:pay_Abc123", new Set(["pay_Abc123"])), true);
  assert.equal(isTestWebhookEventId("recovery:pay_Abc123", new Set(["pay_Other"])), false);
  assert.equal(isTestWebhookEventId("evt_pay_Abc123", new Set(["pay_Abc123"])), false); // only the recovery: form is linked
});

test("emailDomain keeps only the domain", () => {
  assert.equal(emailDomain("Someone.Real@Gmail.com"), "gmail.com");
  assert.equal(emailDomain("no-at-sign"), "(no domain)");
  assert.equal(emailDomain("trailing@"), "(no domain)");
});

test("applyProblems: needs the typed confirmation, a non-production process and a local APP_URL", () => {
  const good = { NODE_ENV: "development", APP_URL: "http://localhost:3000" };
  assert.deepEqual(applyProblems(good, CONFIRM_VALUE), []);
  assert.deepEqual(applyProblems({ APP_URL: "http://127.0.0.1:3000" }, CONFIRM_VALUE), []); // NODE_ENV unset is fine
  assert.deepEqual(applyProblems({ NODE_ENV: "test", APP_URL: "http://[::1]:3000" }, CONFIRM_VALUE), []);
  assert.deepEqual(applyProblems({ NODE_ENV: "development", APP_URL: "http://app.localhost:3000" }, CONFIRM_VALUE), []);
  assert.equal(applyProblems(good, null).length, 1);
  assert.equal(applyProblems(good, "delete-test-data").length, 1);
  assert.equal(applyProblems(good, `${CONFIRM_VALUE} `).length, 1);
  assert.equal(applyProblems({ ...good, NODE_ENV: "production" }, CONFIRM_VALUE).length, 1);
  assert.equal(applyProblems({ ...good, NODE_ENV: "Production" }, CONFIRM_VALUE).length, 1);
  assert.equal(applyProblems({ NODE_ENV: "development" }, CONFIRM_VALUE).length, 1); // APP_URL unset is not local
  assert.equal(applyProblems({ ...good, APP_URL: "https://app.example.com" }, CONFIRM_VALUE).length, 1);
  assert.equal(applyProblems({ ...good, APP_URL: "http://localhost.evil.com" }, CONFIRM_VALUE).length, 1);
  assert.equal(applyProblems({ ...good, APP_URL: "http://localhost@evil.com" }, CONFIRM_VALUE).length, 1);
  assert.equal(applyProblems({ ...good, VERCEL: "1" }, CONFIRM_VALUE).length, 1);
  assert.equal(applyProblems({ NODE_ENV: "production", APP_URL: "https://x.com" }, null).length, 3);
});

test("parseCleanupArgs: dry run unless --apply; unknown flags are reported", () => {
  assert.deepEqual(parseCleanupArgs([]), { apply: false, confirm: null, help: false, unknown: [] });
  assert.deepEqual(parseCleanupArgs(["--apply", `--confirm=${CONFIRM_VALUE}`]), { apply: true, confirm: CONFIRM_VALUE, help: false, unknown: [] });
  assert.equal(parseCleanupArgs(["--apply"]).confirm, null);
  assert.deepEqual(parseCleanupArgs(["--force", "--confirm", "x"]).unknown, ["--force", "--confirm", "x"]);
  assert.equal(parseCleanupArgs(["--help"]).help, true);
});

// ---- Database test: its own rows only (skipped without DATABASE_URL) ----------------------------------------------------

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const run = `${Date.now()}${String(Math.floor(Math.random() * 1000)).padStart(3, "0")}`;
const SAFE_ENV = { NODE_ENV: "test", APP_URL: "http://localhost:3000" };

type Prisma = typeof import("../lib/db").prisma;
let prisma: Prisma;
let lib: typeof import("../lib/test-data-cleanup");

const slugT = `cleanup-${run}`;
const slugControl = `cleanup-keep-${run}`;
const slugProtected = `cleanup-prot-${run}`;
const adminTestEmail = `cleanup-adm-${run}@example.com`;
const adminControlEmail = `cleanup-keep-${run}@example.org`;
const phoneId = `cleanup-pn-${run}`;
const eventTest = `evt_${run}_cleanup`;
const eventControl = `evt_live_${run}_x`;
const testCustomer = `cleanup-cust-${run}@example.com`;
const realCustomer = `real.person.${run}@gmail.com`;
const ids: Record<string, string> = {};
const protectedOptions = () => ({ mustContain: run, extraProtectedSlugs: [slugProtected] });

before(async () => {
  if (skip) return;
  ({ prisma } = await import("../lib/db"));
  lib = await import("../lib/test-data-cleanup");
  const start = (days: number) => new Date(Date.now() + days * 86_400_000);
  const slot = (days: number) => ({ startTime: start(days), endTime: new Date(start(days).getTime() + 30 * 60_000) });
  const customer = (email: string) => ({ customerName: "Cleanup Test", customerEmail: email, whatsappE164: "+919876543210" });

  // A. the test influencer with a full tree of dependent rows
  const inf = await prisma.influencer.create({ data: { slug: slugT, name: "Cleanup Test", email: `cleanup-${run}@example.com` } });
  ids.inf = inf.id;
  const user = await prisma.user.create({ data: { email: `cleanup-user-${run}@example.com`, passwordHash: "x", termsAcceptedAt: new Date(), influencerId: inf.id } });
  ids.user = user.id;
  await prisma.authSession.create({ data: { tokenHash: `cleanup-as-${run}`, userId: user.id, expiresAt: start(1) } });
  await prisma.passwordResetToken.create({ data: { tokenHash: `cleanup-pr-${run}`, userId: user.id, expiresAt: start(1) } });
  await prisma.emailVerificationToken.create({ data: { tokenHash: `cleanup-ev-${run}`, userId: user.id, expiresAt: start(1) } });
  await prisma.availabilityRule.create({ data: { influencerId: inf.id, weekday: 1, startTime: "10:00", endTime: "12:00", timezone: "UTC" } });
  await prisma.blockedDate.create({ data: { influencerId: inf.id, date: new Date("2031-01-01T00:00:00Z") } });
  await prisma.googleToken.create({ data: { influencerId: inf.id, refreshTokenEnc: "x", scope: "s" } });
  await prisma.payoutAccount.create({ data: { influencerId: inf.id, accountHolderName: "Cleanup" } });
  await prisma.whatsAppConnection.create({ data: { influencerId: inf.id, wabaId: `cleanup-waba-${run}`, phoneNumberId: phoneId, tokenEnc: "x" } });
  await prisma.whatsAppRegistrationPin.create({ data: { phoneNumberId: phoneId, pinEnc: "x" } });
  const svc = await prisma.service.create({ data: { influencerId: inf.id, title: "Cleanup", durationMin: 30, priceMinor: 1000 } });
  const sess = await prisma.session.create({ data: { serviceId: svc.id, ...slot(30) } });
  const book = await prisma.booking.create({ data: { sessionId: sess.id, status: "PAID", ...customer(testCustomer) } });
  ids.booking = book.id;
  const payout = await prisma.payout.create({
    data: { influencerId: inf.id, currency: "INR", grossMinor: 1000, refundsMinor: 0, feeBps: 0, feeMinor: 0, netMinor: 1000, paymentCount: 1, destination: "x", createdByEmail: adminTestEmail },
  });
  const pay = await prisma.payment.create({
    data: { bookingId: book.id, providerOrderId: `order_cleanup_${run}`, providerPaymentId: `pay_cleanup_${run}`, amountMinor: 1000, currency: "INR", status: "CAPTURED", payoutId: payout.id },
  });
  await prisma.refund.create({ data: { paymentId: pay.id, providerRefundId: `rfnd_cleanup_${run}`, amountMinor: 100, status: "processed" } });
  await prisma.message.create({ data: { bookingId: book.id, channel: "EMAIL", template: "cleanup" } });

  // B. a test administrator with a session, a recovery code and an audit row (which must survive)
  const admin = await prisma.adminUser.create({ data: { email: adminTestEmail, name: "Cleanup Admin", passwordHash: "x" } });
  ids.admin = admin.id;
  await prisma.adminSession.create({ data: { tokenHash: `cleanup-ads-${run}`, adminId: admin.id, expiresAt: start(1) } });
  await prisma.adminRecoveryCode.create({ data: { adminId: admin.id, codeHash: `cleanup-rc-${run}` } });
  await prisma.adminAuditLog.create({ data: { adminId: admin.id, adminEmail: adminTestEmail, action: "cleanup.test" } });

  // C. webhook events: one test-shaped, one real-shaped (a look-alike that must stay)
  await prisma.webhookEvent.create({ data: { provider: "razorpay", eventId: eventTest, type: "payment.captured" } });
  await prisma.webhookEvent.create({ data: { provider: "razorpay", eventId: eventControl, type: "payment.captured" } });

  // D. control rows that look like test data but are not positively identified
  const control = await prisma.influencer.create({ data: { slug: slugControl, name: "Control", email: `real-${run}@gmail.com` } });
  ids.control = control.id;
  const cSvc = await prisma.service.create({ data: { influencerId: control.id, title: "Control", durationMin: 30, priceMinor: 1000 } });
  const cSess = await prisma.session.create({ data: { serviceId: cSvc.id, ...slot(31) } });
  ids.controlBooking = (await prisma.booking.create({ data: { sessionId: cSess.id, status: "PAID", ...customer(`cleanup-cust-ctl-${run}@example.com`) } })).id;
  ids.controlAdmin = (await prisma.adminUser.create({ data: { email: adminControlEmail, name: "Control Admin", passwordHash: "x" } })).id;

  // E. a PROTECTED look-alike (its slug matches a test pattern): its test-made bookings go, its other bookings stay
  const prot = await prisma.influencer.create({ data: { slug: slugProtected, name: "Protected", email: `cleanup-prot-${run}@example.com` } });
  ids.prot = prot.id;
  const pSvc = await prisma.service.create({ data: { influencerId: prot.id, title: "Protected", durationMin: 30, priceMinor: 1000 } });
  const s1 = await prisma.session.create({ data: { serviceId: pSvc.id, ...slot(32) } }); // only a test booking: becomes empty
  const s2 = await prisma.session.create({ data: { serviceId: pSvc.id, ...slot(33) } }); // one test, one real
  ids.s1 = s1.id;
  ids.s2 = s2.id;
  const pb1 = await prisma.booking.create({ data: { sessionId: s1.id, status: "PAID", ...customer(`cleanup-pcust1-${run}@example.com`) } });
  const pb2 = await prisma.booking.create({ data: { sessionId: s2.id, status: "PAID", ...customer(`cleanup-pcust2-${run}@example.com`) } });
  ids.realBooking = (await prisma.booking.create({ data: { sessionId: s2.id, status: "PAID", ...customer(realCustomer) } })).id;
  ids.pb1 = pb1.id;
  ids.pb2 = pb2.id;
  await prisma.payment.create({ data: { bookingId: pb1.id, providerOrderId: `order_cleanup_p1_${run}`, amountMinor: 1000, currency: "INR" } });
});

after(async () => {
  if (skip || !prisma) return;
  // Everything below is scoped to this run's unique id and each step is allowed to fail on its own.
  const step = async (label: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      console.error(`[cleanup-test-data.test] after: ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const infs = (await prisma.influencer.findMany({ where: { slug: { contains: run } }, select: { id: true } }).catch(() => [])).map((i) => i.id);
  await step("payments", () => prisma.payment.updateMany({ where: { booking: { session: { service: { influencerId: { in: infs } } } } }, data: { payoutId: null } }));
  await step("payouts", () => prisma.payout.deleteMany({ where: { influencerId: { in: infs } } }));
  await step("influencers", () => prisma.influencer.deleteMany({ where: { id: { in: infs } } }));
  await step("pins", () => prisma.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: { contains: run } } }));
  await step("audit", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: { contains: run } } }));
  await step("admins", () => prisma.adminUser.deleteMany({ where: { email: { contains: run } } }));
  await step("webhooks", () => prisma.webhookEvent.deleteMany({ where: { eventId: { contains: run } } }));
  await step("disconnect", () => prisma.$disconnect());
});

async function exists() {
  const [inf, user, svc, sess, book, pay, refund, msg, payout, adm, evt, pin, wa, pa, gt, bd, ar, as_, prt] = await Promise.all([
    prisma.influencer.count({ where: { id: ids.inf } }),
    prisma.user.count({ where: { id: ids.user } }),
    prisma.service.count({ where: { influencerId: ids.inf } }),
    prisma.session.count({ where: { service: { influencerId: ids.inf } } }),
    prisma.booking.count({ where: { id: ids.booking } }),
    prisma.payment.count({ where: { providerOrderId: `order_cleanup_${run}` } }),
    prisma.refund.count({ where: { providerRefundId: `rfnd_cleanup_${run}` } }),
    prisma.message.count({ where: { bookingId: ids.booking } }),
    prisma.payout.count({ where: { influencerId: ids.inf } }),
    prisma.adminUser.count({ where: { id: ids.admin } }),
    prisma.webhookEvent.count({ where: { eventId: eventTest } }),
    prisma.whatsAppRegistrationPin.count({ where: { phoneNumberId: phoneId } }),
    prisma.whatsAppConnection.count({ where: { influencerId: ids.inf } }),
    prisma.payoutAccount.count({ where: { influencerId: ids.inf } }),
    prisma.googleToken.count({ where: { influencerId: ids.inf } }),
    prisma.blockedDate.count({ where: { influencerId: ids.inf } }),
    prisma.availabilityRule.count({ where: { influencerId: ids.inf } }),
    prisma.authSession.count({ where: { userId: ids.user } }),
    prisma.booking.count({ where: { id: { in: [ids.pb1, ids.pb2] } } }),
  ]);
  return { inf, user, svc, sess, book, pay, refund, msg, payout, adm, evt, pin, wa, pa, gt, bd, ar, authSessions: as_, protectedTestBookings: prt };
}

async function controlsRemain() {
  assert.equal(await prisma.influencer.count({ where: { id: ids.control } }), 1, "control influencer");
  assert.equal(await prisma.booking.count({ where: { id: ids.controlBooking } }), 1, "control booking");
  assert.equal(await prisma.adminUser.count({ where: { id: ids.controlAdmin } }), 1, "control admin");
  assert.equal(await prisma.webhookEvent.count({ where: { eventId: eventControl } }), 1, "control webhook event");
  assert.equal(await prisma.influencer.count({ where: { id: ids.prot } }), 1, "protected look-alike");
  assert.equal(await prisma.booking.count({ where: { id: ids.realBooking } }), 1, "real customer booking on the protected influencer");
  assert.equal(await prisma.session.count({ where: { id: ids.s2 } }), 1, "session that still has a real booking");
}

test("db: the dry run counts this run's rows, lists the controls as kept, and deletes nothing", { skip }, async () => {
  const before = await exists();
  assert.equal(before.inf, 1);
  const plan = await lib.planCleanup(prisma, protectedOptions());
  assert.deepEqual(
    plan.counts,
    {
      influencers: 1, users: 1, auth_sessions: 1, password_reset_tokens: 1, email_verification_tokens: 1, services: 1,
      availability_rules: 1, blocked_dates: 1, google_tokens: 1, payout_accounts: 1, whatsapp_connections: 1,
      whatsapp_registration_pins: 1, payouts: 1,
      sessions: 2, // the test influencer's session + the protected influencer's session that would be left empty
      bookings: 3, // the test influencer's booking + two test-made bookings on the protected influencer
      payments: 2, refunds: 1, messages: 1, admin_users: 1, admin_sessions: 1, admin_recovery_codes: 1, webhook_events: 1,
    },
  );
  assert.deepEqual(plan.influencers.map((i) => i.slug), [slugT]);
  assert.deepEqual(plan.admins.map((a) => a.email), [adminTestEmail]);
  assert.equal(plan.auditRowsOfDeletedAdmins, 1);
  assert.deepEqual(plan.kept.protectedInfluencers, [slugProtected]); // demo is outside this run's filter
  assert.deepEqual(plan.kept.ambiguousInfluencers.map((i) => i.slug), [slugControl]);
  assert.deepEqual(plan.kept.unmatchedAdmins, [adminControlEmail]);
  const keptBooking = plan.kept.bookings.find((b) => b.influencerSlug === slugProtected);
  assert.ok(keptBooking, "the real customer's booking is listed as kept");
  assert.equal(keptBooking.emailDomain, "gmail.com");
  assert.equal(keptBooking.idPrefix, ids.realBooking.slice(0, 8));
  assert.ok(plan.kept.bookings.some((b) => b.influencerSlug === slugControl), "test-looking customer on the ambiguous influencer is listed, not deleted");

  // The printed report never contains a hash, a token or a full customer address.
  const text = lib.formatPlan(plan).join("\n");
  assert.ok(!text.includes(realCustomer) && !text.includes("passwordHash") && !text.includes(testCustomer));
  assert.ok(text.includes(slugT) && text.includes(adminTestEmail));
  assert.ok(TABLES.every((t) => text.includes(t)));

  assert.deepEqual(await exists(), before, "a dry run changes nothing");
  await controlsRemain();
});

test("db: --apply is refused (and deletes nothing) without confirmation, in production, or with a non-local APP_URL", { skip }, async () => {
  const snapshot = await exists();
  for (const [env, confirm] of [
    [SAFE_ENV, null],
    [SAFE_ENV, "delete-test-data"],
    [{ ...SAFE_ENV, NODE_ENV: "production" }, CONFIRM_VALUE],
    [{ ...SAFE_ENV, APP_URL: "https://app.example.com" }, CONFIRM_VALUE],
    [{ NODE_ENV: "test" }, CONFIRM_VALUE],
  ] as const) {
    await assert.rejects(lib.applyCleanup(prisma, { ...protectedOptions(), env, confirm }), lib.CleanupRefused);
  }
  assert.deepEqual(await exists(), snapshot);
});

test("db: --apply removes exactly this run's rows in one transaction and leaves every control", { skip }, async () => {
  const { plan, deleted } = await lib.applyCleanup(prisma, { ...protectedOptions(), env: SAFE_ENV, confirm: CONFIRM_VALUE });
  assert.deepEqual(deleted, plan.counts, "deleted counts equal the dry-run counts");
  const after = await exists();
  assert.equal(after.inf + after.user + after.svc + after.sess + after.book + after.pay + after.refund + after.msg + after.payout, 0);
  assert.equal(after.adm + after.evt + after.pin + after.wa + after.pa + after.gt + after.bd + after.ar + after.authSessions, 0);
  assert.equal(after.protectedTestBookings, 0, "the test-made bookings on the protected influencer are gone");
  assert.equal(await prisma.session.count({ where: { id: ids.s1 } }), 0, "the session left empty is gone");
  await controlsRemain();
  // Audit rows are never deleted: the row stays with its copied e-mail, the admin link is cleared by the foreign key.
  const audit = await prisma.adminAuditLog.findMany({ where: { adminEmail: adminTestEmail } });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].adminId, null);

  // A second run finds nothing left for this run.
  const again = await lib.planCleanup(prisma, protectedOptions());
  assert.ok(TABLES.every((t) => again.counts[t] === 0), JSON.stringify(again.counts));
  assert.deepEqual(again.kept.ambiguousInfluencers.map((i) => i.slug), [slugControl]);
});
