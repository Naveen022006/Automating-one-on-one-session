// EMAIL_PROVIDER=none (doc/15): the platform sends no e-mail. Every sender is a logged no-op that reports "not sent", and every caller
// carries on without an error and without claiming that anybody was e-mailed.
// The pure part needs nothing. The rest needs DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET (skipped otherwise); it replaces only
// `next/headers` (cookies) and global fetch (Google), and never sends anything.
import "dotenv/config";
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { NextRequest } from "next/server";
import { prisma } from "../lib/db";
import { EmailDisabledError, emailProviderName, noneTransport, platformEmailEnabled, transportFromEnv } from "../lib/email/providers";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const PASSWORD = "correct-horse-battery-9";
const DAY = 86_400_000;

const ENV_KEYS = ["EMAIL_PROVIDER", "GOOGLE_CLIENT_MODE", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "MOCK_PROVIDERS_URL", "APP_URL", "RATE_LIMIT_STORE", "REDIS_URL", "MESSAGING_DRY_RUN", "ADMIN_ALERT_EMAILS"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let envSaved = false;
const realFetch = globalThis.fetch;
const realLog = { log: console.log, error: console.error, warn: console.warn };
const logged: string[] = [];

/* ---------- pure ---------- */

test("the provider name and the boolean pages are allowed to know", () => {
  assert.equal(emailProviderName({}), "log");
  assert.equal(emailProviderName({ EMAIL_PROVIDER: "" }), "log");
  assert.equal(emailProviderName({ EMAIL_PROVIDER: "None" }), "none");
  assert.equal(emailProviderName({ EMAIL_PROVIDER: "resend" }), "resend");
  assert.equal(emailProviderName({ EMAIL_PROVIDER: "postmark" }), "postmark");
  assert.equal(emailProviderName({ EMAIL_PROVIDER: "sendgrid" }), "log", "an unknown name falls back like the transport does");
  assert.equal(platformEmailEnabled({ EMAIL_PROVIDER: "none" }), false);
  for (const p of [undefined, "log", "resend", "postmark"]) assert.equal(platformEmailEnabled({ EMAIL_PROVIDER: p }), true, String(p));
});

test("the none transport refuses with a recognisable error and never touches the network", async () => {
  await assert.rejects(noneTransport({ to: { email: "a@example.com" }, subject: "S", html: "h", text: "t" }), EmailDisabledError);
  const saved = process.env.EMAIL_PROVIDER;
  process.env.EMAIL_PROVIDER = "none";
  try {
    assert.equal(transportFromEnv(), noneTransport);
  } finally {
    if (saved === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = saved;
  }
});

/* ---------- with a database ---------- */

type Ctx = { params: Promise<{ id: string }> };
const jar = new Map<string, string>();
let accounts: typeof import("../lib/auth/accounts");
let emailLib: typeof import("../lib/email");
let holdsLib: typeof import("../lib/holds");
let approvalLib: typeof import("../lib/booking-approval");
let tokensLib: typeof import("../lib/google-tokens");
let credsLib: typeof import("../lib/google-credentials");
let gmailLib: typeof import("../lib/gmail");
let authLib: typeof import("../lib/auth/session");
let portalLib: typeof import("../lib/customer-portal");
let forgotRoute: { POST: (req: Request) => Promise<Response> };
let resendRoute: { POST: () => Promise<Response> };
let sessionRoute: { GET: () => Promise<Response> };
let adminSessionRoute: { GET: () => Promise<Response> };
let userId = "";
let influencerId = "";
let cookie = "";
let serviceId = "";
let approvalServiceId = "";
let bookingId = "";
let adminId = "";
const email = `en-inf-${run}@example.com`;
const customerEmail = `en-cust-${run}@example.com`;
const mail = { sent: 0 };

const googleCalls: string[] = [];
let tokenMode: "ok" | "down" = "down";

function installFakeGoogle() {
  const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    googleCalls.push(u);
    if (u.startsWith("https://oauth2.googleapis.com/token")) return tokenMode === "ok" ? json(200, { access_token: "at-1" }) : json(503, { error: { message: "backend", status: "UNAVAILABLE" } });
    if (u.startsWith("https://gmail.googleapis.com/")) return json(200, { id: "gm-1" });
    throw new Error(`unexpected network call in a test: ${u}`);
  }) as typeof fetch;
}

const messages = () => prisma.message.findMany({ where: { bookingId, channel: "EMAIL" } });

before(async () => {
  if (skip) return;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  envSaved = true;
  process.env.EMAIL_PROVIDER = "none";
  process.env.RATE_LIMIT_STORE = "memory";
  process.env.MESSAGING_DRY_RUN = "true";
  process.env.APP_URL = "http://localhost:3000";
  process.env.GOOGLE_CLIENT_ID = "7-shared.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "shared-secret-0123456789abcdef";
  console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  installFakeGoogle();

  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  // Imported only now: lib/google creates its default client at load time and keeps the fetch of that moment, which must be the fake.
  gmailLib = await import("../lib/gmail");
  accounts = await import("../lib/auth/accounts");
  emailLib = await import("../lib/email");
  holdsLib = await import("../lib/holds");
  approvalLib = await import("../lib/booking-approval");
  tokensLib = await import("../lib/google-tokens");
  credsLib = await import("../lib/google-credentials");
  authLib = await import("../lib/auth/session");
  portalLib = await import("../lib/customer-portal");
  forgotRoute = await import("../app/api/auth/forgot-password/route");
  resendRoute = await import("../app/api/auth/resend-verification/route");
  sessionRoute = await import("../app/api/auth/session/route");
  adminSessionRoute = await import("../app/api/admin/session/route");

  const registered = await accounts.registerAccount({ name: `En Fixture ${run}`, email, password: PASSWORD, slug: `en${run}`, timezone: "Asia/Kolkata", acceptTerms: true });
  userId = registered.userId;
  influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).influencerId;
  await prisma.influencer.update({ where: { id: influencerId }, data: { onboardedAt: new Date() } });
  cookie = await authLib.createSession(userId);
  serviceId = (await prisma.service.create({ data: { influencerId, title: "En 1:1", durationMin: 30, priceMinor: 1000 } })).id;
  approvalServiceId = (await prisma.service.create({ data: { influencerId, title: "En reviewed", durationMin: 30, priceMinor: 2000, requiresApproval: true } })).id;
  const start = new Date(Date.now() + 2 * DAY);
  const session = await prisma.session.create({ data: { serviceId, startTime: start, endTime: new Date(start.getTime() + 30 * 60_000) } });
  bookingId = (
    await prisma.booking.create({ data: { sessionId: session.id, status: "SCHEDULED", customerName: "En Customer", customerEmail, whatsappE164: "+919876543210", meetLink: "https://meet.google.com/aaa-bbbb-ccc" } })
  ).id;
  adminId = (await prisma.adminUser.create({ data: { email: `en-admin-${run}@example.com`, name: "En Admin", passwordHash: "not-a-real-hash" } })).id;
  emailLib.setEmailSender(null);
});

after(async () => {
  console.log = realLog.log;
  console.error = realLog.error;
  console.warn = realLog.warn;
  globalThis.fetch = realFetch;
  try {
    if (!skip) {
      const step = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (e) {
          console.error(`[email-none] cleanup step failed (${what}):`, e instanceof Error ? e.message : e);
        }
      };
      if (influencerId) {
        await step("bookings", () => prisma.booking.deleteMany({ where: { session: { service: { influencerId } } } }));
        await step("sessions", () => prisma.session.deleteMany({ where: { service: { influencerId } } }));
        await step("services", () => prisma.service.deleteMany({ where: { influencerId } }));
        await step("access tokens", () => prisma.customerAccessToken.deleteMany({ where: { email: customerEmail } }));
        await step("audit rows", () => prisma.adminAuditLog.deleteMany({ where: { targetId: influencerId } }));
        await step("influencer", () => prisma.influencer.deleteMany({ where: { id: influencerId } }));
      }
      await step("admin", () => prisma.adminUser.deleteMany({ where: { id: adminId } }));
    }
  } finally {
    emailLib?.setEmailSender(null);
    if (envSaved) {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }
});

test("sendAccountEmail: not sent, one log line with the tag only, no address, no subject, no body, no throw", { skip }, async () => {
  const before = logged.length;
  const ok = await emailLib.sendAccountEmail({ email: "secret.person@example.com", name: "Secret Person" }, { subject: "Reset link for you", html: "<p>https://x/reset?token=TOKEN123</p>", text: "https://x/reset?token=TOKEN123" }, "password-reset");
  assert.equal(ok, false);
  const lines = logged.slice(before);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[email:password-reset\] not sent/);
  assert.ok(!/secret\.person|Secret Person|Reset link for you|TOKEN123/.test(lines[0]), lines[0]);
  // Every tag the callers use is handled the same way.
  for (const tag of ["verify-email", "password-changed", "payout-details-saved", "payout-details-reviewed", "account-status", "admin-security", "system-health", "customer-portal-link", "customer-portal-erased", "alert-google-reconnect-needed"]) {
    assert.equal(await emailLib.sendAccountEmail({ email: "x@example.com" }, { subject: "s", html: "h", text: "t" }, tag), false, tag);
  }
});

test("registration works: the user is created unverified, no verification link exists, and nothing was sent", { skip }, async () => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.emailVerifiedAt, null);
  assert.equal(await prisma.emailVerificationToken.count({ where: { userId } }), 0);
  assert.equal(await accounts.resendVerification(userId), false);
});

test("password reset: no link is created or cancelled, and the password flows that used to e-mail a notice still work", { skip }, async () => {
  const noticesBefore = logged.filter((l) => l.includes("[email:password-changed] not sent")).length;
  await accounts.requestPasswordReset(email);
  assert.equal(await prisma.passwordResetToken.count({ where: { userId } }), 0);
  // A link handed over by hand still resets the password; the "your password was changed" notice is silently not sent.
  const { url } = await accounts.createPasswordResetLink(userId);
  const token = new URL(url).searchParams.get("token") ?? "";
  await accounts.resetPassword(token, "brand-new-password-77");
  const session = await prisma.authSession.findFirst({ where: { userId } });
  await accounts.changePassword(userId, session?.id ?? "none", "brand-new-password-77", "yet-another-password-88");
  assert.equal(logged.filter((l) => l.includes("[email:password-changed] not sent")).length - noticesBefore, 2);
  cookie = await authLib.createSession(userId); // both flows end every other session
});

test("the routes tell the truth: forgot-password and resend-verification say no e-mail goes out, the session says emailEnabled false", { skip }, async () => {
  // The password reset above also verified the address (it proves control of the mailbox); this test needs it unverified again.
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: null } });
  const forgot = await forgotRoute.POST(new Request("http://localhost/api/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }));
  assert.equal(forgot.status, 200);
  const f = (await forgot.json()) as { ok: boolean; emailEnabled: boolean; message: string };
  assert.equal(f.ok, true);
  assert.equal(f.emailEnabled, false);
  assert.match(f.message, /Ask your administrator/);
  assert.ok(!/on its way|check your/i.test(f.message));
  // The answer is the same for an address nobody has.
  const unknown = await forgotRoute.POST(new Request("http://localhost/api/auth/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `nobody-${run}@example.com` }) }));
  assert.deepEqual(await unknown.json(), f);

  jar.set(authLib.sessionCookieName(), cookie);
  const resend = await resendRoute.POST();
  assert.equal(resend.status, 200);
  const r = (await resend.json()) as { sent: boolean; emailEnabled: boolean; message: string };
  assert.equal(r.sent, false);
  assert.equal(r.emailEnabled, false);
  assert.match(r.message, /administrator verifies/);
  assert.equal(await prisma.emailVerificationToken.count({ where: { userId } }), 0);

  const session = (await (await sessionRoute.GET()).json()) as Record<string, unknown>;
  assert.equal(session.emailEnabled, false);
  jar.clear();
  assert.deepEqual(await (await sessionRoute.GET()).json(), { authenticated: false, emailEnabled: false });
  assert.deepEqual(await (await adminSessionRoute.GET()).json(), { authenticated: false, emailEnabled: false });
  assert.ok(!JSON.stringify(session).toLowerCase().includes("provider"), "the provider's name is not exposed");
});

test("moderation reports 'not emailed', and the other account senders (admin 2FA notices, alerts, portal) neither throw nor create anything", { skip }, async () => {
  const moderation = await import("../lib/admin/moderation");
  const out = await moderation.moderateInfluencer({ adminId, email: `en-admin-${run}@example.com` }, influencerId, { action: "suspend", reason: "Testing the no-email mode" }, null);
  assert.deepEqual(out, { emailed: false });
  await moderation.moderateInfluencer({ adminId, email: `en-admin-${run}@example.com` }, influencerId, { action: "reinstate" }, null);

  const { notifyAdminSecurity } = await import("../lib/admin/security-notices");
  await notifyAdminSecurity(adminId, "2fa-enabled", { ip: "203.0.113.9" });

  const { alertInfluencer } = await import("../lib/alerts");
  await alertInfluencer(influencerId, { kind: "google-reconnect-needed", detail: "test" });

  // The customer portal: asking for a link creates no token (there is nothing to send it with); erasing still works.
  await portalLib.requestPortalLink(customerEmail, { globalKey: `en-${run}` }).done;
  assert.equal(await prisma.customerAccessToken.count({ where: { email: customerEmail } }), 0);
  await portalLib.erasePortalData(`nobody-${run}@example.com`);
  assert.ok(logged.some((l) => l.includes("[email:account-status] not sent")));
  assert.ok(logged.some((l) => l.includes("[email:admin-security] not sent")));
});

test("customer e-mail with no Gmail: nothing is sent, the row says why (never pending, never sent), and nothing throws", { skip }, async () => {
  await emailLib.sendBookingEmail(bookingId, "booking-confirmation");
  const rows = await messages();
  assert.equal(rows.length, 1, "a record that it was not sent, not a vanished one");
  assert.equal(rows[0].status, "FAILED");
  assert.equal(rows[0].error, emailLib.NO_EMAIL_ROUTE_REASON);
  assert.equal(rows[0].sentAt, null);
  // That reason is not "Gmail is not working": the Google panel only reads rows Gmail itself failed to send.
  assert.ok(!rows[0].error?.startsWith(gmailLib.GMAIL_FAILED_PREFIX));
  assert.ok(logged.some((l) => l.includes("[email:customer] booking-confirmation not sent") && l.includes("no Gmail connection")));
  assert.ok(!logged.join("\n").includes(customerEmail), "the customer's address is not logged");
});

test("customer e-mail through the influencer's Gmail: a failing Gmail leaves a FAILED row and the panel says so; a working one sends and clears it", { skip }, async () => {
  // The influencer has connected Google with Gmail permission (a grant made with the shared client).
  await tokensLib.saveGoogleToken(influencerId, "refresh-en", "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send", "host@gmail.example", "sub-en", "platform");

  tokenMode = "down";
  await emailLib.sendBookingEmail(bookingId, "booking-confirmation");
  const failed = await messages();
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, "FAILED");
  assert.ok(failed[0].error?.startsWith(gmailLib.GMAIL_FAILED_PREFIX), String(failed[0].error));
  const status = await tokensLib.getGoogleStatus(influencerId, { details: true });
  assert.ok(status.state === "connected" && status.gmailSend && status.gmailFailing, "the Google panel says Gmail is not working");

  tokenMode = "ok";
  await emailLib.sendBookingEmail(bookingId, "booking-confirmation", { force: true });
  const sent = await messages();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, "SENT", `${sent[0].error} | ${logged.slice(-4).join(" // ")}`);
  assert.equal(sent[0].providerMessageId, "gmail:gm-1");
  const after = await tokensLib.getGoogleStatus(influencerId, { details: true });
  assert.ok(after.state === "connected" && after.gmailFailing === false);
  assert.ok(googleCalls.some((u) => u.startsWith("https://gmail.googleapis.com/")));

  // A forced resend (or a second reschedule) that finds no route must not wipe or downgrade the record of the e-mail that WAS sent.
  tokenMode = "down";
  await emailLib.sendBookingEmail(bookingId, "booking-confirmation", { force: true });
  const afterFailedResend = await messages();
  assert.equal(afterFailedResend.length, 1);
  assert.equal(afterFailedResend[0].status, "SENT", "never downgraded");
  assert.equal(afterFailedResend[0].providerMessageId, "gmail:gm-1");
  assert.equal(afterFailedResend[0].error, null);
  assert.ok(afterFailedResend[0].sentAt);
  await prisma.googleToken.deleteMany({ where: { influencerId } });
  await emailLib.sendBookingEmail(bookingId, "booking-confirmation", { force: true });
  const afterNoRoute = await messages();
  assert.equal(afterNoRoute.length, 1, "not deleted either");
  assert.equal(afterNoRoute[0].status, "SENT");
  assert.equal(afterNoRoute[0].providerMessageId, "gmail:gm-1");
});

test("an approved request: the host is handed the pay link when the customer could not be e-mailed, and decline does not throw", { skip }, async () => {
  const hold = (offset: number, mail: string) => {
    const start = new Date(Date.now() + offset);
    start.setUTCMinutes(0, 0, 0);
    return holdsLib.createHold({
      serviceId: approvalServiceId,
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60_000),
      capacity: 1,
      customerName: "En Requester",
      customerEmail: mail,
      whatsappE164: "+919876543210",
      whatsappOptIn: true,
      requestApproval: true,
    });
  };
  const requested = await hold(5 * DAY, `en-req1-${run}@example.com`);
  const approved = await approvalLib.approveRequest(influencerId, requested.id);
  assert.equal(approved.emailed, false);
  assert.match(String(approved.payUrl), /^http:\/\/localhost:3000\/pay\//);
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: requested.id } })).status, "HELD", "approved all the same");

  const declined = await hold(6 * DAY, `en-req2-${run}@example.com`);
  await approvalLib.declineRequest(influencerId, declined.id, "No thanks");
  assert.equal((await prisma.booking.findUniqueOrThrow({ where: { id: declined.id } })).status, "CANCELLED");
});

test("with a real provider the same approval says the customer was e-mailed and does not hand out the link", { skip }, async () => {
  process.env.EMAIL_PROVIDER = "resend";
  emailLib.setEmailSender(async () => {
    mail.sent += 1;
    return { providerMessageId: "p1" };
  });
  try {
    const start = new Date(Date.now() + 8 * DAY);
    start.setUTCMinutes(0, 0, 0);
    const requested = await holdsLib.createHold({
      serviceId: approvalServiceId,
      startTime: start,
      endTime: new Date(start.getTime() + 30 * 60_000),
      capacity: 1,
      customerName: "En Requester",
      customerEmail: `en-req3-${run}@example.com`,
      whatsappE164: "+919876543210",
      whatsappOptIn: true,
      requestApproval: true,
    });
    const approved = await approvalLib.approveRequest(influencerId, requested.id);
    assert.equal(approved.emailed, true);
    assert.equal(approved.payUrl, null);
    assert.equal(mail.sent, 1);
  } finally {
    process.env.EMAIL_PROVIDER = "none";
    emailLib.setEmailSender(null);
  }
});

test("nothing that was sent or created leaked a token or an address into the logs", { skip }, async () => {
  const text = logged.join("\n");
  assert.ok(!/token=[A-Za-z0-9_-]{20,}/.test(text), "no link with a token");
  assert.ok(!text.includes(customerEmail) && !text.includes(email));
  void NextRequest;
  void credsLib;
});
