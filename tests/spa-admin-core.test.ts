// Integration test of the admin console read endpoints behind the SPA's Overview, Influencers and Influencer pages
// (needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise):
//   M1 GET /api/admin/overview     M2 GET /api/admin/influencers     M3 GET /api/admin/influencers/:id
// (M4, the Security page's endpoint, has its own file: tests/spa-admin-security.test.ts.)
//
// Only `next/headers` is replaced (the cookie a request carries is chosen per call). The point of the file:
//   - the gate is the one the console PAGES have: 401 without a session, 403 `enroll` for an administrator who still has to
//     set up two-factor, 403 `verify` for a password-only session of one who has it, 200 otherwise. requireAdminApi() would
//     let the `verify` session through; these endpoints must not;
//   - every body goes through assertNoSecretKeys, the exact key sets are pinned (adding a field is a deliberate act), and
//     the encrypted payout columns and the full account number never appear;
//   - the payout approval view is the VIEWER's (the creator cannot approve, a second administrator can).
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { hashPassword } from "../lib/auth/password";
import { hashToken, randomToken } from "../lib/auth/tokens";
import { prisma } from "../lib/db";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const FULL_ACCOUNT_NUMBER = "123456789012";
const emailX = `core-x-${run}@example.com`; // administrator with two-factor
const emailY = `core-y-${run}@example.com`; // administrator without; creates the payout
const emailZ = `core-z-${run}@example.com`; // a second administrator without
const influencerName = `Core Fixture ${run}`;
const googleEmail = `core-google-${run}@gmail.example`;
const slug = `core-${run}`;

// Settings the developer's .env may carry that change what these endpoints answer (the two-factor requirement, four-eyes
// approval, the hold period that decides what is payable, the default fee). They are removed for the run, so a test passes
// alone (--test-name-pattern) and with any .env, and put back afterwards.
const ENV_KEYS = ["ADMIN_REQUIRE_2FA", "PAYOUT_FOUR_EYES", "PAYOUT_FOUR_EYES_MIN_MINOR", "PAYOUT_HOLD_DAYS", "PLATFORM_FEE_BPS"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;

const jar = new Map<string, string>();
type Answer = { status: number; body: Record<string, unknown>; headers: Headers };
let routes: {
  overview: () => Promise<Response>;
  influencers: (req: Request) => Promise<Response>;
  influencer: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};
let sessionLib: typeof import("../lib/admin/session");
let viewLib: typeof import("../lib/views/admin-influencer");
let jsonifyLib: typeof import("../lib/jsonify");
let X = "";
let Y = "";
let Z = "";
let influencerId = "";
let payoutId = "";
let encryptedAccountNumber = "";
let encryptedGoogleToken = "";
let encryptedWhatsAppToken = "";

/** A password-only session row for an admin who has two-factor (createAdminSession refuses to make one). */
async function passwordOnlySession(adminId: string): Promise<string> {
  const token = randomToken();
  await prisma.adminSession.create({ data: { tokenHash: hashToken(token), adminId, expiresAt: new Date(Date.now() + 3_600_000) } });
  return token;
}

const adminCookie = (token: string) => ({ [sessionLib.adminCookieName()]: token });
const keys = (o: unknown) => Object.keys(o as object).sort();

async function ask(call: () => Promise<Response>, cookies: Record<string, string> = {}): Promise<Answer> {
  jar.clear();
  for (const [k, v] of Object.entries(cookies)) jar.set(k, v);
  const res = await call();
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

const endpoint = {
  overview: () => routes.overview(),
  influencers: (query = "") => routes.influencers(new Request(`http://localhost/api/admin/influencers${query}`)),
  influencer: (id = influencerId) => routes.influencer(new Request(`http://localhost/api/admin/influencers/${id}`), { params: Promise.resolve({ id }) }),
};

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.RATE_LIMIT_STORE = "memory";
  // GET /api/admin/overview builds the health report, which would open BullMQ/Redis connections that keep the test process
  // alive (and touch the shared Redis). Without REDIS_URL the report degrades exactly as it does when Redis is down.
  delete process.env.REDIS_URL;
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  sessionLib = await import("../lib/admin/session");
  viewLib = await import("../lib/views/admin-influencer");
  jsonifyLib = await import("../lib/jsonify");
  const mfa = await import("../lib/admin/mfa");
  const totp = await import("../lib/admin/totp");
  routes = {
    overview: (await import("../app/api/admin/overview/route")).GET,
    influencers: (await import("../app/api/admin/influencers/route")).GET,
    influencer: (await import("../app/api/admin/influencers/[id]/route")).GET,
  };

  const hash = await hashPassword(PASSWORD);
  X = (await prisma.adminUser.create({ data: { email: emailX, name: "Core Admin X", passwordHash: hash } })).id;
  Y = (await prisma.adminUser.create({ data: { email: emailY, name: "Core Admin Y", passwordHash: hash } })).id;
  Z = (await prisma.adminUser.create({ data: { email: emailZ, name: "Core Admin Z", passwordHash: hash } })).id;
  const past = Date.now() - 60_000;
  const secret = (await mfa.startTotpEnrollment(X)).secret;
  assert.ok((await mfa.confirmTotpEnrollment(X, totp.totpAt(secret, past), null, past)).ok);

  // The fixture: an influencer with a 10% fee, a 1:1 and a group service, verified payout details (a full number that must
  // never come back), one payable payment, one waiting for reconciliation, and a pending payout created by Y.
  influencerId = (await prisma.influencer.create({ data: { slug, name: influencerName, email: `core-inf-${run}@example.com`, platformFeeBps: 1000, onboardedAt: new Date() } })).id;
  const one = await prisma.service.create({ data: { influencerId, title: "Core 1:1", durationMin: 30, priceMinor: 50_000 } });
  await prisma.service.create({ data: { influencerId, title: "Core group", durationMin: 60, priceMinor: 30_000, type: "GROUP", capacity: 5 } });
  for (const [i, reconciled, amount] of [[1, true, 50_000], [2, false, 30_000]] as const) {
    const start = new Date(Date.now() - (10 + i) * 86_400_000);
    const session = await prisma.session.create({ data: { serviceId: one.id, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
    const booking = await prisma.booking.create({ data: { sessionId: session.id, status: "SCHEDULED", customerName: `Core Customer ${i}`, customerEmail: `core-c${i}-${run}@example.com`, whatsappE164: "+919876543210" } });
    await prisma.payment.create({
      data: { bookingId: booking.id, providerOrderId: `order_core_${run}_${i}`, providerPaymentId: `pay_core_${run}_${i}`, amountMinor: amount, currency: "INR", status: "CAPTURED", reconciledAt: reconciled ? new Date() : null },
    });
  }
  const { savePayoutAccount } = await import("../lib/payout-account");
  await savePayoutAccount(influencerId, {
    method: "BANK",
    accountHolderName: "Core Holder",
    bankName: "HDFC Bank",
    ifsc: "HDFC0001234",
    accountNumber: FULL_ACCOUNT_NUMBER,
    confirmAccountNumber: FULL_ACCOUNT_NUMBER,
  });
  await prisma.payoutAccount.update({ where: { influencerId }, data: { status: "VERIFIED" } });
  encryptedAccountNumber = (await prisma.payoutAccount.findUniqueOrThrow({ where: { influencerId } })).accountNumberEnc ?? "";
  assert.ok(encryptedAccountNumber.length > 10);
  payoutId = (
    await prisma.payout.create({
      data: { influencerId, currency: "INR", grossMinor: 45_000, refundsMinor: 0, feeBps: 0, feeMinor: 0, netMinor: 45_000, paymentCount: 1, destination: "HDFC Bank XXXXXXXX9012", createdByEmail: emailY },
    })
  ).id;

  // The two includes that hold encrypted tokens (getInfluencerDetail selects the Google token's status and email, the WhatsApp
  // connection's number): real ciphertexts, so the exposure checks can look for them in the body. The Google connection needs
  // reconnecting, so its account email must NOT be shown (the old page showed "Reconnect needed" and nothing else).
  const { encryptSecret } = await import("../lib/crypto");
  encryptedGoogleToken = encryptSecret(`refresh-token-${run}`, `core-test:google:${run}`);
  encryptedWhatsAppToken = encryptSecret(`whatsapp-token-${run}`, `core-test:whatsapp:${run}`);
  await prisma.googleToken.create({
    data: { influencerId, refreshTokenEnc: encryptedGoogleToken, scope: "openid email", status: "RECONNECT_NEEDED", reconnectReason: "invalid_grant", googleEmail },
  });
  await prisma.whatsAppConnection.create({
    data: { influencerId, wabaId: `waba-core-${run}`, phoneNumberId: `pn-core-${run}`, displayPhone: "+91 98765 43210", verifiedName: "Core Verified", tokenEnc: encryptedWhatsAppToken, source: "manual" },
  });
});

after(async () => {
  // Every step on its own, so one failure (a pool timeout on a slow network) cannot leave the rest behind, and the connection
  // pool is always closed. Rows are found by their timestamped names, so a `before` that stopped halfway is cleaned up too.
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[spa-admin-core] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      const inf = await prisma.influencer.findUnique({ where: { slug }, select: { id: true } }).catch(() => null);
      if (inf) {
        await step("payouts", () => prisma.payout.deleteMany({ where: { influencerId: inf.id } }));
        await step("influencer", () => prisma.influencer.deleteMany({ where: { id: inf.id } }));
      }
      await step("audit rows", () => prisma.adminAuditLog.deleteMany({ where: { adminEmail: { in: [emailX, emailY, emailZ] } } }));
      await step("administrators", () => prisma.adminUser.deleteMany({ where: { email: { in: [emailX, emailY, emailZ] } } }));
    }
  } finally {
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("M1 to M3 are gated like the console pages: 401 signed out, 403 enroll, 403 verify, 200 ok", { skip }, async () => {
  const cases = [
    ["M1 overview", () => endpoint.overview()],
    ["M2 influencers", () => endpoint.influencers()],
    ["M3 influencer", () => endpoint.influencer()],
    ["M3 influencer, unknown id", () => endpoint.influencer("no-such-influencer")],
  ] as const;

  for (const [name, call] of cases) {
    const signedOut = await ask(call);
    assert.equal(signedOut.status, 401, `${name}: no cookie`);
    assert.equal((await ask(call, adminCookie("garbage"))).status, 401, `${name}: garbage cookie`);
  }

  const plainY = await sessionLib.createAdminSession(Y);
  const staleX = await passwordOnlySession(X);
  const verifiedX = await sessionLib.createAdminSession(X, {}, { mfaVerified: true });

  // 2FA required: Y has not enrolled -> enroll (the Security page is the only screen open to Y); X's password-only session -> verify.
  process.env.ADMIN_REQUIRE_2FA = "true";
  try {
    for (const [name, call] of cases) {
      const enroll = await ask(call, adminCookie(plainY));
      assert.equal(enroll.status, 403, `${name}: enroll`);
      assert.deepEqual(enroll.body.mfaRequired, true);
      assert.equal(enroll.body.mfaAction, "enroll");
      assert.deepEqual(keys(enroll.body), ["error", "mfaAction", "mfaRequired"], `${name}: nothing of the console in a denial (not even a 404)`);

      const verify = await ask(call, adminCookie(staleX));
      assert.equal(verify.status, 403, `${name}: verify`);
      assert.equal(verify.body.mfaAction, "verify");
      assert.deepEqual(keys(verify.body), ["error", "mfaAction", "mfaRequired"]);
    }
    // ok: a session that passed the second factor.
    for (const [name, call] of cases.slice(0, 3)) assert.equal((await ask(call, adminCookie(verifiedX))).status, 200, `${name}: verified session`);
    assert.equal((await ask(cases[3][1], adminCookie(verifiedX))).status, 404, "an unknown id is a 404 only for a session that may read the console");
  } finally {
    delete process.env.ADMIN_REQUIRE_2FA;
  }

  // Without the requirement: Y (no 2FA) is fine, but an administrator who HAS two-factor and a password-only session is still "verify".
  for (const [name, call] of cases.slice(0, 3)) {
    assert.equal((await ask(call, adminCookie(plainY))).status, 200, `${name}: no 2FA anywhere`);
    const verify = await ask(call, adminCookie(staleX));
    assert.equal(verify.status, 403, `${name}: 2FA enabled, password-only session`);
    assert.equal(verify.body.mfaAction, "verify");
  }
});

test("M1 GET /api/admin/overview: the hand-picked fields only, private and uncached", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const res = await ask(endpoint.overview, adminCookie(token));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(res.body), ["health", "overview", "recentAudit"]);
  const o = res.body.overview as Record<string, unknown>;
  assert.deepEqual(keys(o), ["attention", "bookingsByStatus", "captured", "influencers", "refunded"]);
  assert.deepEqual(keys(o.attention), ["failedMessages7d", "googleReconnect", "mismatched", "needsRefund"]);
  assert.deepEqual(keys(o.influencers), ["onboarded", "total"]);
  assert.ok((o.influencers as { total: number }).total >= 1, "counts the fixture");
  const captured = (o.captured as { currency: string; amountMinor: number }[]).find((m) => m.currency === "INR");
  assert.ok(captured && captured.amountMinor >= 80_000, "the fixture's two captured payments are in the INR total");
  const audit = res.body.recentAudit as Record<string, unknown>[];
  assert.ok(audit.length <= 8);
  for (const row of audit) assert.deepEqual(keys(row).filter((k) => k !== "targetType"), ["action", "adminEmail", "createdAt", "id"], "no detail, no ip, no target id");
  assert.deepEqual(keys(res.body.health), ["available", "unhealthy"]);
  for (const c of (res.body.health as { unhealthy: unknown[] }).unhealthy) assert.deepEqual(keys(c), ["label", "status"], "no hint, no href, no value");
  assertNoSecretKeys(res.body);
});

test("M2 GET /api/admin/influencers: paged, searchable, hand-picked rows", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const found = await ask(() => endpoint.influencers(`?q=${encodeURIComponent(influencerName)}`), adminCookie(token));
  assert.equal(found.status, 200);
  assert.equal(found.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(found.body), ["counts", "page", "pageCount", "rows", "status", "total"]);
  assert.equal(found.body.status, "all");
  assert.deepEqual(keys(found.body.counts), ["awaitingApproval", "suspended"]);
  assert.equal(found.body.total, 1);
  assert.equal(found.body.page, 1);
  const rows = found.body.rows as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.deepEqual(keys(row), ["accountStatus", "blockers", "bookings", "email", "emailVerified", "google", "grossMinor", "id", "live", "name", "payout", "services", "whatsapp"]);
  assert.equal(row.id, influencerId);
  assert.equal(row.accountStatus, "active");
  assert.equal(row.name, influencerName);
  assert.equal(row.services, 2);
  assert.equal(row.bookings, 2);
  assert.equal(row.grossMinor, 80_000);
  assert.equal(row.payout, "verified");
  assert.equal(row.google, "reconnect");
  assert.deepEqual(keys(row.whatsapp), ["text", ...("tone" in (row.whatsapp as object) ? ["tone"] : [])]);
  assert.equal(typeof (row.whatsapp as { text: unknown }).text, "string");
  assert.notEqual((row.whatsapp as { text: string }).text, "Not connected", "the fixture has a WhatsApp connection");
  assert.equal(typeof row.live, "boolean");
  assert.ok(Array.isArray(row.blockers));
  assertNoSecretKeys(found.body);
  const listText = JSON.stringify(found.body);
  for (const secret of [encryptedGoogleToken, encryptedWhatsAppToken, googleEmail, "98765 43210", "invalid_grant"]) assert.ok(!listText.includes(secret), `the list never carries ${secret.slice(0, 12)}...`);

  // The search is case-insensitive and matches the email and the page address too; nothing matches gibberish.
  assert.equal((await ask(() => endpoint.influencers(`?q=${encodeURIComponent(`CORE-${run}`)}`), adminCookie(token))).body.total, 1);
  const none = await ask(() => endpoint.influencers(`?q=zzz-nobody-${run}`), adminCookie(token));
  assert.equal(none.status, 200);
  // The whole body: `counts` is the real, global number behind the two moderation tabs, so only its shape is pinned.
  const { counts: noneCounts, ...noneRest } = none.body;
  assert.deepEqual(noneRest, { rows: [], total: 0, page: 1, pageCount: 1, status: "all" });
  assert.deepEqual(keys(noneCounts), ["awaitingApproval", "suspended"]);
  for (const n of Object.values(noneCounts as Record<string, unknown>)) assert.ok(Number.isInteger(n) && (n as number) >= 0);
  // A bad `page` falls back to 1, an over-long `q` is cut to 80 characters instead of failing.
  assert.equal((await ask(() => endpoint.influencers(`?page=-3&q=${encodeURIComponent(influencerName)}`), adminCookie(token))).body.page, 1);
  assert.equal((await ask(() => endpoint.influencers(`?page=abc`), adminCookie(token))).body.page, 1);
  assert.equal((await ask(() => endpoint.influencers(`?q=${"a".repeat(500)}`), adminCookie(token))).status, 200);
  // Page 2 of a one-row result is empty but still well-formed.
  const page2 = await ask(() => endpoint.influencers(`?page=2&q=${encodeURIComponent(influencerName)}`), adminCookie(token));
  assert.equal(page2.status, 200);
  assert.deepEqual(page2.body.rows, []);
});

test("M3 GET /api/admin/influencers/:id: the page's data, masked payout details only, and 404 for an unknown id", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const missing = await ask(() => endpoint.influencer("no-such-influencer"), adminCookie(token));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "private, no-store");
  assert.equal(typeof missing.body.error, "string");

  const res = await ask(() => endpoint.influencer(), adminCookie(token));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(res.body), ["bookings", "connections", "currencies", "fee", "influencer", "onlyOneAdmin", "payoutAccount", "payouts", "readinessItems", "services", "verified"]);
  assertNoSecretKeys(res.body);

  // The money-handling secrets: no ciphertext, no full number, anywhere in the body.
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes(FULL_ACCOUNT_NUMBER), "the full account number is never sent (only the audited reveal action returns it)");
  assert.ok(!text.includes(encryptedAccountNumber), "the encrypted account number is never sent");
  assert.ok(!/passwordHash|tokenHash|totp/i.test(text));
  // The Google and WhatsApp rows hold encrypted tokens: neither ciphertext, nor the reconnect reason, nor (for a connection that
  // needs reconnecting) the Google account's email may be in the body.
  assert.ok(!text.includes(encryptedGoogleToken), "the encrypted Google refresh token is never sent");
  assert.ok(!text.includes(encryptedWhatsAppToken), "the encrypted WhatsApp token is never sent");
  assert.ok(!text.includes(googleEmail), "a connection that needs reconnecting shows no account email, as the old page did");
  assert.ok(!text.includes("invalid_grant") && !text.includes(`waba-core-${run}`) && !text.includes(`pn-core-${run}`), "no reconnect reason, no WhatsApp account or phone number ids");
  assert.deepEqual(keys(res.body.payoutAccount), ["accountHolderName", "accountNumber", "bankName", "ifsc", "method", "rejectionReason", "status", "upiId"]);
  assert.equal((res.body.payoutAccount as { accountNumber: string }).accountNumber, "XXXXXXXX9012");
  assert.equal(res.body.verified, true);

  assert.deepEqual(keys(res.body.influencer), ["createdAt", "email", "emailVerified", "id", "name", "onboardedAt", "slug", "timezone"]);
  assert.equal((res.body.influencer as { id: string }).id, influencerId);
  assert.equal((res.body.influencer as { slug: string }).slug, `core-${run}`);
  assert.equal((res.body.influencer as { emailVerified: boolean }).emailVerified, false);
  assert.notEqual((res.body.influencer as { onboardedAt: unknown }).onboardedAt, null);

  const items = res.body.readinessItems as Record<string, unknown>[];
  assert.equal(items.length, 7);
  for (const item of items) assert.deepEqual(keys(item), ["key", "label", "required", "state"], "no detail text, no href");
  assert.deepEqual(keys(res.body.connections), ["gmailSend", "google", "whatsapp"]);
  assert.deepEqual((res.body.connections as { google: unknown }).google, { state: "reconnect", email: null });
  const whatsapp = (res.body.connections as { whatsapp: { text: string; tone?: string } }).whatsapp;
  assert.ok(whatsapp.text.startsWith("+91 98765 43210, "), `the number and the state, as on the old page: ${whatsapp.text}`);
  assert.deepEqual(keys(whatsapp), ["text", ...("tone" in whatsapp ? ["tone"] : [])]);
  assert.equal((res.body.connections as { gmailSend: boolean }).gmailSend, false);

  const fee = res.body.fee as Record<string, unknown>;
  assert.deepEqual(keys(fee), ["defaultBps", "feeBps", "feePercentText", "overrideBps"]);
  assert.equal(fee.overrideBps, 1000);
  assert.equal(fee.feeBps, 1000);
  assert.equal(fee.feePercentText, "10%");
  assert.equal(typeof fee.defaultBps, "number");
  assert.equal(typeof res.body.onlyOneAdmin, "boolean");

  // One payment is payable (reconciled, session long past): 50 000 - 10% fee. The other waits for reconciliation.
  const currencies = res.body.currencies as Record<string, unknown>[];
  assert.equal(currencies.length, 1);
  assert.deepEqual(currencies[0], {
    currency: "INR",
    readyMinor: 45_000,
    readyGrossMinor: 50_000,
    readyFeeMinor: 5_000,
    readyCount: 1,
    waitingMinor: 30_000,
    waitingCount: 1,
    waitingText: "1 waiting for reconciliation",
  });

  const services = res.body.services as Record<string, unknown>[];
  assert.equal(services.length, 2);
  for (const s of services) assert.deepEqual(keys(s), ["active", "capacity", "currency", "durationMin", "id", "priceMinor", "title", "type"], "no description, intake questions or prep notes");
  assert.deepEqual(services.map((s) => s.type).sort(), ["GROUP", "ONE_TO_ONE"]);
  const bookings = res.body.bookings as Record<string, unknown>[];
  assert.equal(bookings.length, 2);
  for (const b of bookings) assert.deepEqual(keys(b), ["currency", "customerName", "id", "paidMinor", "serviceTitle", "startTime", "status"], "no customer email or phone number");
  assert.deepEqual(bookings.map((b) => b.paidMinor).sort(), [30_000, 50_000]);
  assert.ok(!text.includes(`core-c1-${run}@example.com`) && !text.includes("+919876543210"));

  const payouts = res.body.payouts as Record<string, unknown>[];
  assert.equal(payouts.length, 1);
  assert.deepEqual(keys(payouts[0]), ["approval", "createdAt", "currency", "destination", "id", "netMinor", "owedMinor", "reference", "status"]);
  assert.equal(payouts[0].destination, "HDFC Bank XXXXXXXX9012");
  assert.deepEqual(keys(payouts[0].approval), ["approved", "approvedByEmail", "canApprove", "canMarkPaid", "createdByViewer", "required"]);
  assert.ok(!text.includes(emailZ) && !text.includes(emailX), "other administrators do not appear, except as the approver of a payout");

  // The endpoint sends exactly the view function's JSON: the two cannot disagree.
  const direct = jsonifyLib.jsonify(await viewLib.loadAdminInfluencerView(influencerId, emailY));
  assert.deepEqual(res.body, direct);
});

test("M3 shows the Google account's email only while the connection is ACTIVE, and never a token", { skip }, async () => {
  const token = await sessionLib.createAdminSession(Y);
  const googleOf = (body: Record<string, unknown>) => (body.connections as { google: unknown }).google;
  try {
    await prisma.googleToken.update({ where: { influencerId }, data: { status: "ACTIVE", reconnectReason: null, reconnectNeededAt: null } });
    const active = await ask(() => endpoint.influencer(), adminCookie(token));
    assert.equal(active.status, 200);
    assert.deepEqual(googleOf(active.body), { state: "active", email: googleEmail });
    const text = JSON.stringify(active.body);
    assert.ok(text.includes(googleEmail), "the email is on the page while Google works");
    assert.ok(!text.includes(encryptedGoogleToken) && !text.includes(encryptedWhatsAppToken), "still no ciphertext");
    assertNoSecretKeys(active.body);
    const list = await ask(() => endpoint.influencers(`?q=${encodeURIComponent(influencerName)}`), adminCookie(token));
    assert.equal((list.body.rows as { google: string }[])[0].google, "connected");
    assert.ok(!JSON.stringify(list.body).includes(googleEmail), "the list shows a state, not the account");
  } finally {
    await prisma.googleToken.update({ where: { influencerId }, data: { status: "RECONNECT_NEEDED", reconnectReason: "invalid_grant" } });
  }
  const back = await ask(() => endpoint.influencer(), adminCookie(token));
  assert.deepEqual(googleOf(back.body), { state: "reconnect", email: null });
  assert.ok(!JSON.stringify(back.body).includes(googleEmail));
});

test("the payout approval state is the VIEWER's: its creator cannot approve, a second administrator can", { skip }, async () => {
  process.env.PAYOUT_FOUR_EYES = "true";
  try {
    const tokenY = await sessionLib.createAdminSession(Y);
    const tokenZ = await sessionLib.createAdminSession(Z);
    const approvalOf = async (token: string) => ((await ask(() => endpoint.influencer(), adminCookie(token))).body.payouts as { id: string; approval: Record<string, unknown> }[]).find((p) => p.id === payoutId)!.approval;

    assert.deepEqual(await approvalOf(tokenY), { required: true, approved: false, approvedByEmail: null, canApprove: false, createdByViewer: true, canMarkPaid: false });
    assert.deepEqual(await approvalOf(tokenZ), { required: true, approved: false, approvedByEmail: null, canApprove: true, createdByViewer: false, canMarkPaid: false });

    const { approvePayout } = await import("../lib/payouts");
    await approvePayout(payoutId, emailZ);
    assert.deepEqual(await approvalOf(tokenY), { required: true, approved: true, approvedByEmail: emailZ, canApprove: false, createdByViewer: true, canMarkPaid: true });
    assert.deepEqual(await approvalOf(tokenZ), { required: true, approved: true, approvedByEmail: emailZ, canApprove: false, createdByViewer: false, canMarkPaid: true });
  } finally {
    delete process.env.PAYOUT_FOUR_EYES;
    await prisma.payout.update({ where: { id: payoutId }, data: { approvedAt: null, approvedByEmail: null } });
  }
  // Four-eyes off: no approval step at all, whoever looks.
  process.env.PAYOUT_FOUR_EYES = "false";
  try {
    const tokenY = await sessionLib.createAdminSession(Y);
    const body = (await ask(() => endpoint.influencer(), adminCookie(tokenY))).body;
    assert.equal((body.payouts as { approval: { required: boolean } }[])[0].approval.required, false);
    assert.equal(body.onlyOneAdmin, false);
  } finally {
    delete process.env.PAYOUT_FOUR_EYES;
  }
});
