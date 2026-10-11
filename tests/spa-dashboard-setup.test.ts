// Branch spa/31-dashboard-setup: the Services, Availability, Payouts, Settings and Onboarding pages are shared view components
// that BOTH the old Next page and the SPA page render, fed by view functions that the endpoints
//   D6 GET /api/dashboard/services   D7 GET /api/dashboard/availability   D8 GET /api/dashboard/payouts
//   D9 GET /api/dashboard/settings   D10 GET /api/dashboard/onboarding
// also answer with. Three parts:
//   1. pure tests (no database): the field-by-field copies drop everything the panels do not show; the views render from JSON
//      fixtures; the old pages and the SPA pages render the same views; titles match the route table.
//   2. endpoint tests (need DATABASE_URL, TOKEN_ENCRYPTION_KEY, APP_SECRET; skipped otherwise): three influencers ("Alpha",
//      "Bravo", "Charlie" who has nothing and has not finished onboarding). Every endpoint must show a signed-in influencer
//      their own rows and never the other's, never a stored token, and answer 401 without a session.
// Only `next/headers` (cookies per call) and, for rendering, `next/navigation` are replaced. Every body goes through
// assertNoSecretKeys and the exact key sets are pinned, so adding a field is a deliberate act.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prisma } from "../lib/db";
import { formatTitle, spaRouteById, type SpaRouteId } from "../lib/spa/routes";
import { BRAND_NAME } from "../lib/brand";
import { jsonify } from "../lib/jsonify";
import { effectiveFeeBps, formatFeePercent } from "../lib/payouts";
import { maskAccountNumber } from "../lib/payout-account";
import type { DashboardOnboardingView } from "../lib/views/dashboard-onboarding";
import type { DashboardPayoutsView } from "../lib/views/dashboard-payouts";
import type { DashboardServicesView } from "../lib/views/dashboard-services";
import type { DashboardSettingsView } from "../lib/views/dashboard-settings";
import { assertNoSecretKeys } from "./helpers/assert-no-secret-keys";

const skip = process.env.DATABASE_URL && process.env.TOKEN_ENCRYPTION_KEY && process.env.APP_SECRET ? false : "DATABASE_URL / TOKEN_ENCRYPTION_KEY / APP_SECRET not set";
const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const keys = (o: unknown) => Object.keys(o as object).sort();

const jar = new Map<string, string>();
type Handler = () => Promise<Response>;
let routes: { services: Handler; availability: Handler; payouts: Handler; settings: Handler; onboarding: Handler };
let authLib: typeof import("../lib/auth/session");
let viewsLib: {
  settings: typeof import("../lib/views/dashboard-settings");
  payouts: typeof import("../lib/views/dashboard-payouts");
};

/** The shared components call `useRouter` from next/navigation, which only works inside Next's router; rendering them needs a stand-in. */
function mockNavigation() {
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  mock.module("next/navigation", {
    namedExports: { useRouter: () => router, usePathname: () => "/dashboard/test", useSearchParams: () => new URLSearchParams() },
  });
}

interface Owner {
  label: "Alpha" | "Bravo" | "Charlie";
  userId: string;
  influencerId: string;
  cookie: string;
  name: string;
  slug: string;
  email: string;
}
const owner = (label: Owner["label"]): Owner => ({
  label,
  userId: "",
  influencerId: "",
  cookie: "",
  name: `${label} Owner ${run}`,
  slug: `setup-${label.toLowerCase()}-${run}`,
  email: `setup-${label.toLowerCase()}-${run}@example.com`,
});
const A = owner("Alpha");
const B = owner("Bravo");
const C = owner("Charlie");

// Values that must never reach a browser: the "encrypted" columns, the ids behind the connections, the full account numbers.
const secrets = {
  googleEnc: (o: Owner) => `google-refresh-enc-${o.label}-${run}`,
  waToken: (o: Owner) => `wa-token-enc-${o.label}-${run}`,
  waba: (o: Owner) => `waba-${o.label}-${run}`,
  phoneId: (o: Owner) => `phoneid-${o.label}-${run}`,
  /** The two-step PIN of each number, in the clear (what the owner typed) and as stored (whatsapp_registration_pins.pin_enc, filled in by `before`). */
  pinPlain: (o: Owner) => `pin-plain-${o.label}-${run}`,
  account: { Alpha: "111122223333", Bravo: "999988887777" } as Record<string, string>,
  metaSecret: `meta-app-secret-${run}`,
};
const pinsEnc: string[] = [];
// The tests change process.env; every changed name is put back in `after`. (There is no table of OAuth states to seed: the
// Google round trip keeps its state in a signed value, not in the database.)
const savedEnv = { RATE_LIMIT_STORE: process.env.RATE_LIMIT_STORE };

async function ask(handler: Handler, cookie?: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  jar.clear();
  if (cookie !== undefined) jar.set(authLib.sessionCookieName(), cookie);
  const res = await handler();
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** Nothing of another owner and no id, token or secret of this one may be in a body. */
function assertOnlyOwn(body: unknown, mine: Owner, ...others: Owner[]) {
  const text = JSON.stringify(body);
  for (const theirs of others) {
    assert.ok(!text.includes(theirs.label), `the body of ${mine.label} mentions ${theirs.label}`);
    assert.ok(!text.includes(theirs.influencerId) && !text.includes(theirs.userId) && !text.includes(theirs.cookie) && !text.includes(theirs.email));
  }
  assert.ok(!text.includes(mine.influencerId) && !text.includes(mine.userId) && !text.includes(mine.cookie), "no influencer id, user id or session token");
  for (const o of [A, B, C]) {
    for (const s of [secrets.googleEnc(o), secrets.waToken(o), secrets.waba(o), secrets.phoneId(o), secrets.pinPlain(o), secrets.metaSecret]) assert.ok(!text.includes(s), `a stored secret or id (${s}) is in the body`);
  }
  for (const enc of pinsEnc) assert.ok(!text.includes(enc), "an encrypted registration PIN is in the body");
  for (const n of Object.values(secrets.account)) assert.ok(!text.includes(n), "a full account number is in the body");
  assertNoSecretKeys(body);
}

async function seed(o: Owner, extra: { hidden: boolean; fee: number | null }) {
  await prisma.influencer.update({
    where: { id: o.influencerId },
    data: { bio: `${o.label} bio ${run}`, photoUrl: `https://img.example.com/${o.label.toLowerCase()}-${run}.png`, platformFeeBps: extra.fee, onboardedAt: new Date() },
  });
  await prisma.service.create({
    data: {
      influencerId: o.influencerId,
      title: `${o.label} intro ${run}`,
      description: `${o.label} description`,
      durationMin: 30,
      priceMinor: 49900,
      prepNotes: `${o.label} prep`,
      intakeQuestions: [{ id: "q1", label: `What should ${o.label} cover?`, type: "text", required: true }],
    },
  });
  if (extra.hidden) {
    await prisma.service.create({ data: { influencerId: o.influencerId, title: `${o.label} hidden group ${run}`, durationMin: 60, priceMinor: 99900, type: "GROUP", capacity: 5, active: false } });
  }
  const rule = (weekday: number, startTime: string, endTime: string) =>
    prisma.availabilityRule.create({ data: { influencerId: o.influencerId, weekday, startTime, endTime, timezone: "Asia/Kolkata" } });
  await rule(3, "10:00", "11:00");
  await rule(1, "14:00", "16:00");
  await rule(1, "09:00", "12:00");
  await prisma.blockedDate.create({ data: { influencerId: o.influencerId, date: new Date("2030-01-05T00:00:00.000Z"), reason: `${o.label} holiday ${run}` } });
  await prisma.blockedDate.create({ data: { influencerId: o.influencerId, date: new Date("2030-01-02T00:00:00.000Z") } });
}

before(async () => {
  mockNavigation();
  if (skip) return;
  process.env.RATE_LIMIT_STORE = "memory";
  mock.module("next/headers", {
    namedExports: {
      cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined) }),
      headers: async () => new Headers(),
    },
  });
  authLib = await import("../lib/auth/session");
  const email = await import("../lib/email");
  email.setEmailSender(async () => ({ providerMessageId: null }));
  routes = {
    services: (await import("../app/api/dashboard/services/route")).GET,
    availability: (await import("../app/api/dashboard/availability/route")).GET,
    payouts: (await import("../app/api/dashboard/payouts/route")).GET,
    settings: (await import("../app/api/dashboard/settings/route")).GET,
    onboarding: (await import("../app/api/dashboard/onboarding/route")).GET,
  };
  viewsLib = { settings: await import("../lib/views/dashboard-settings"), payouts: await import("../lib/views/dashboard-payouts") };

  const accounts = await import("../lib/auth/accounts");
  for (const o of [A, B, C]) {
    const registered = await accounts.registerAccount({ name: o.name, email: o.email, password: "a long passphrase for the setup test", slug: o.slug, timezone: "Asia/Kolkata", acceptTerms: true });
    o.userId = registered.userId;
    o.influencerId = (await prisma.user.findUniqueOrThrow({ where: { id: o.userId } })).influencerId;
    o.cookie = await authLib.createSession(o.userId);
  }
  // Charlie has nothing and has not finished onboarding. Alpha and Bravo have the same kinds of rows, so a leak shows.
  await seed(A, { hidden: true, fee: 1250 });
  await seed(B, { hidden: false, fee: null });

  // Payout details (full numbers go in encrypted, only masked ones may come out) and one payout each.
  const payoutAccount = await import("../lib/payout-account");
  for (const o of [A, B]) {
    const number = secrets.account[o.label];
    await payoutAccount.savePayoutAccount(o.influencerId, { method: "BANK", accountHolderName: `${o.label} Owner`, bankName: `${o.label} Bank`, ifsc: "HDFC0001234", accountNumber: number, confirmAccountNumber: number });
    await prisma.payout.create({
      data: {
        influencerId: o.influencerId,
        status: o.label === "Alpha" ? "PAID" : "PENDING",
        currency: "INR",
        grossMinor: 10000,
        refundsMinor: 0,
        feeBps: 1000,
        feeMinor: 1000,
        netMinor: o.label === "Alpha" ? 9000 : 8000,
        paymentCount: 2,
        destination: `${o.label} Bank ${maskAccountNumber(number)}`,
        reference: `UTR-${o.label}-${run}`,
        createdByEmail: "admin@example.com",
        paidAt: o.label === "Alpha" ? new Date() : null,
      },
    });
  }

  // Google: Alpha connected with Gmail sending, Bravo needs to reconnect, Charlie never connected.
  await prisma.googleToken.create({
    data: {
      influencerId: A.influencerId,
      refreshTokenEnc: secrets.googleEnc(A),
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send",
      googleEmail: `alpha-calendar-${run}@example.com`,
    },
  });
  await prisma.googleToken.create({
    data: { influencerId: B.influencerId, refreshTokenEnc: secrets.googleEnc(B), scope: "https://www.googleapis.com/auth/calendar.events", status: "RECONNECT_NEEDED", reconnectReason: "invalid_grant", reconnectNeededAt: new Date(), googleEmail: `bravo-calendar-${run}@example.com` },
  });
  // WhatsApp: Alpha connected (one template approved), Bravo's connection has stopped working.
  await prisma.whatsAppConnection.create({
    data: {
      influencerId: A.influencerId,
      wabaId: secrets.waba(A),
      phoneNumberId: secrets.phoneId(A),
      displayPhone: "+91 98765 43210",
      verifiedName: `Alpha Studio ${run}`,
      tokenEnc: secrets.waToken(A),
      source: "manual",
      templates: { "booking-confirmation": { status: "APPROVED", language: "en" } },
    },
  });
  await prisma.whatsAppConnection.create({
    data: { influencerId: B.influencerId, wabaId: secrets.waba(B), phoneNumberId: secrets.phoneId(B), displayPhone: "+91 91234 56789", tokenEnc: secrets.waToken(B), status: "ERROR", lastError: "Bravo token was revoked" },
  });
  // The two-step PIN of each number: its own table, keyed by phone number id, encrypted with the number id as AAD. It is shown
  // nowhere, so neither the clear value nor the stored one may appear in any body.
  const { encryptSecret } = await import("../lib/crypto");
  const { whatsappPinAad } = await import("../lib/whatsapp-connection");
  for (const o of [A, B]) {
    const enc = encryptSecret(secrets.pinPlain(o), whatsappPinAad(secrets.phoneId(o)));
    await prisma.whatsAppRegistrationPin.create({ data: { phoneNumberId: secrets.phoneId(o), pinEnc: enc, generated: true } });
    pinsEnc.push(enc);
  }
});

after(async () => {
  try {
    if (!skip) {
      const ids = [A, B, C].map((o) => o.influencerId).filter(Boolean);
      // Each delete has its own try/catch: one that fails (a dropped connection) must not leave the later ones undone.
      const attempt = async (what: string, step: () => Promise<unknown>) => {
        try {
          await step();
        } catch (error) {
          console.error(`cleanup: ${what} failed:`, error instanceof Error ? error.message : error);
        }
      };
      await attempt("registration pins", () => prisma.whatsAppRegistrationPin.deleteMany({ where: { phoneNumberId: { in: [A, B].map((o) => secrets.phoneId(o)) } } }));
      await attempt("payouts", () => prisma.payout.deleteMany({ where: { influencerId: { in: ids } } })); // Restrict: payouts block deleting their influencer
      await attempt("influencers", () => prisma.influencer.deleteMany({ where: { id: { in: ids } } }));
    }
  } finally {
    if (savedEnv.RATE_LIMIT_STORE === undefined) delete process.env.RATE_LIMIT_STORE;
    else process.env.RATE_LIMIT_STORE = savedEnv.RATE_LIMIT_STORE;
    await prisma.$disconnect();
  }
});

/* ---------- pure: the field-by-field copies ---------- */

test("toGoogleStatusView: the three states, dates as ISO strings, counts defaulted, nothing else carried over", async () => {
  const { toGoogleStatusView } = await import("../lib/views/dashboard-settings");
  const at = new Date("2030-01-01T10:00:00.000Z");
  const connected = toGoogleStatusView({ state: "connected", email: "a@example.com", connectedAt: at, gmailSend: true, ...({ refreshTokenEnc: "SECRET" } as object) });
  assert.deepEqual(connected, { state: "connected", email: "a@example.com", connectedAt: "2030-01-01T10:00:00.000Z", gmailSend: true, liveEvents: 0, gmailFailing: false });
  const reconnect = toGoogleStatusView({ state: "reconnect-needed", email: null, reason: "invalid_grant", since: at, liveEvents: 2 });
  assert.deepEqual(reconnect, { state: "reconnect-needed", email: null, reason: "invalid_grant", liveEvents: 2 });
  const none = toGoogleStatusView({ state: "not-connected", requestsGmail: false });
  assert.deepEqual(none, { state: "not-connected", requestsGmail: false, liveEvents: 0, previousEmail: null });
  for (const view of [connected, reconnect, none]) assert.ok(!JSON.stringify(view).includes("SECRET"));
});

test("toWhatsAppView copies the seven fields the panel shows and nothing else (no ids, no token, no webhook detail)", async () => {
  const { toWhatsAppView } = await import("../lib/views/dashboard-settings");
  assert.equal(toWhatsAppView(null), null);
  const stored = {
    displayPhone: "+91 98765 43210",
    verifiedName: "Studio",
    source: "embedded",
    status: "ACTIVE" as const,
    lastError: null,
    connectedAt: new Date(),
    templates: [{ name: "reschedule", status: "APPROVED", reason: null, ...({ metaId: "T1" } as object) }],
    ready: false,
    webhook: { subscribed: true, error: null },
    ...({ tokenEnc: "SECRET", accessToken: "SECRET", wabaId: "SECRET", phoneNumberId: "SECRET" } as object),
  };
  const view = toWhatsAppView(stored);
  assert.deepEqual(view, {
    displayPhone: "+91 98765 43210",
    verifiedName: "Studio",
    source: "embedded",
    status: "ACTIVE",
    lastError: null,
    templates: [{ name: "reschedule", status: "APPROVED", reason: null }],
    ready: false,
  });
  assert.ok(!JSON.stringify(view).includes("SECRET"));
});

test("toPayoutAccountData copies the eight fields the form shows; the masked values stay masked and updatedAt is not sent", async () => {
  const { toPayoutAccountData } = await import("../lib/views/dashboard-payouts");
  assert.equal(toPayoutAccountData(null), null);
  const view = toPayoutAccountData({
    method: "BANK",
    accountHolderName: "A B",
    bankName: "HDFC",
    ifsc: "HDFC0001234",
    accountNumber: "XXXXXXXX3333",
    upiId: null,
    status: "PENDING_REVIEW",
    rejectionReason: null,
    updatedAt: new Date(),
    ...({ accountNumberEnc: "SECRET" } as object),
  });
  assert.deepEqual(keys(view), ["accountHolderName", "accountNumber", "bankName", "ifsc", "method", "rejectionReason", "status", "upiId"]);
  assert.ok(!JSON.stringify(view).includes("SECRET"));
});

test("loadEmbeddedSignupView: null unless the Meta app is configured; then exactly the public ids, never the app secret", async () => {
  const { loadEmbeddedSignupView } = await import("../lib/views/dashboard-settings");
  const names = ["META_APP_ID", "META_ES_CONFIG_ID", "META_APP_SECRET", "WHATSAPP_APP_SECRET", "WHATSAPP_GRAPH_VERSION", "MOCK_PROVIDERS_URL", "APP_URL", "NODE_ENV", "VERCEL"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    assert.equal(loadEmbeddedSignupView(), null);
    process.env.META_APP_ID = "1234567890";
    process.env.META_ES_CONFIG_ID = "9876543210";
    assert.equal(loadEmbeddedSignupView(), null, "ids without the app secret: the server cannot finish a sign-up, so the button is not offered");
    process.env.META_APP_SECRET = secrets.metaSecret;
    const view = loadEmbeddedSignupView();
    assert.deepEqual(keys(view), ["appId", "configId", "graphVersion"]);
    assert.equal(view?.appId, "1234567890");
    assert.equal(view?.configId, "9876543210");
    assert.match(view?.graphVersion ?? "", /^v\d+\.\d+$/);
    assert.ok(!JSON.stringify(view).includes(secrets.metaSecret));
    assert.ok(!("sdkUrl" in (view as object)), "no sdkUrl unless the local mock override is active");

    // With the guarded local mock override active the view carries the mock's SDK URL (copied from embeddedSignupConfig, never made
    // up here). Production, a serverless platform and a non-local APP_URL all leave it out.
    process.env.APP_URL = "http://localhost:3000";
    process.env.MOCK_PROVIDERS_URL = "http://127.0.0.1:4010";
    assert.deepEqual(keys(loadEmbeddedSignupView()), ["appId", "configId", "graphVersion", "sdkUrl"]);
    assert.equal(loadEmbeddedSignupView()?.sdkUrl, "http://127.0.0.1:4010/meta/en_US/sdk.js");
    assert.ok(!JSON.stringify(loadEmbeddedSignupView()).includes(secrets.metaSecret));
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    assert.deepEqual(keys(loadEmbeddedSignupView()), ["appId", "configId", "graphVersion"]);
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    process.env.VERCEL = "1";
    assert.deepEqual(keys(loadEmbeddedSignupView()), ["appId", "configId", "graphVersion"]);
    delete process.env.VERCEL;
    process.env.APP_URL = "https://app.example.com";
    assert.deepEqual(keys(loadEmbeddedSignupView()), ["appId", "configId", "graphVersion"]);
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else (process.env as Record<string, string | undefined>)[n] = saved[n];
    }
  }
});

/* ---------- pure: the views render from JSON ---------- */

const when = "2030-02-01T12:00:00.000Z";

test("PayoutsView renders from JSON: money, the fee text, masked details, the history with its reference; an empty state without data", async () => {
  const { PayoutsView } = await import("../components/views/dashboard/PayoutsView");
  const data: DashboardPayoutsView = {
    account: { method: "BANK", accountHolderName: "Pat Doe", bankName: "HDFC Bank", ifsc: "HDFC0001234", accountNumber: "XXXXXXXX3333", upiId: null, status: "PENDING_REVIEW", rejectionReason: null },
    summary: {
      currencies: [{ currency: "INR", readyMinor: 150000, waitingMinor: 20000, pendingMinor: 5000, paidOutMinor: 90000 }],
      history: [{ id: "p1", status: "PAID", currency: "INR", netMinor: 90000, feeMinor: 10000, paymentCount: 3, destination: "HDFC Bank XXXXXXXX3333", reference: "UTR123", paidAt: new Date(when), createdAt: new Date(when) }],
    },
    feePercentText: "12.50%",
  };
  const html = render(createElement(PayoutsView, { data: jsonify(data) }));
  assert.ok(html.includes("Ready to send (INR)") && html.includes("Platform fee: 12.50% of what customers pay"));
  assert.ok(html.includes("XXXXXXXX3333") && html.includes("HDFC Bank XXXXXXXX3333") && html.includes("Ref UTR123"));
  assert.ok(html.includes("Your payout details are being verified") && html.includes("Paid"));
  assert.ok(html.includes("Feb 1, 2030") || html.includes("1 Feb 2030"), "the date prints as a date, not as an ISO string");
  assert.ok(!html.includes(when));

  const empty = render(createElement(PayoutsView, { data: jsonify<DashboardPayoutsView>({ account: null, summary: { currencies: [], history: [] }, feePercentText: "0%" }) }));
  assert.ok(empty.includes("Add your payout details") && empty.includes("No payouts yet") && !empty.includes("Ready to send"));
});

test("ServicesView and AvailabilityView render from JSON, including hidden services, questions, ordered hours and days off", async () => {
  const { ServicesView } = await import("../components/views/dashboard/ServicesView");
  const { AvailabilityView } = await import("../components/views/dashboard/AvailabilityView");
  const service = (over: Partial<DashboardServicesView["services"][number]>): DashboardServicesView["services"][number] => ({
    id: "s1", title: "Career chat", description: null, durationMin: 45, priceMinor: 49900, currency: "INR", type: "ONE_TO_ONE", capacity: 1, active: true, refundPolicy: "FULL",
    intakeQuestions: [{ id: "q1", label: "What do you want to cover?", type: "text", required: true }], minNoticeHours: 0, maxAdvanceDays: 60, prepNotes: null, requiresApproval: false, ...over,
  });
  const html = render(createElement(ServicesView, { data: jsonify<DashboardServicesView>({ services: [service({}), service({ id: "s2", title: "Hidden workshop", type: "GROUP", capacity: 6, active: false })] }) }));
  assert.ok(html.includes("Career chat") && html.includes("1 question for customers") && html.includes("Group, 6 seats") && html.includes("Hidden"));
  assert.ok(render(createElement(ServicesView, { data: { services: [] } })).includes("Add your first service"));

  const avail = render(
    createElement(AvailabilityView, {
      data: { timezone: "Asia/Kolkata", rules: [{ id: "r1", weekday: 1, startTime: "09:00", endTime: "12:00", timezone: "Asia/Kolkata" }], blocked: [{ id: "b1", date: "2030-01-05", reason: "Diwali" }, { id: "b2", date: "2030-01-02", reason: null }] },
    }),
  );
  assert.ok(avail.includes("Monday") && avail.includes("Weekly hours") && avail.includes("Days off") && avail.includes("Diwali"));
});

test("SettingsView renders every panel from JSON: anchors for #google and #whatsapp, the outcome banner, the address field, the verify banner", async () => {
  const { SettingsView } = await import("../components/views/dashboard/SettingsView");
  const data: DashboardSettingsView = {
    profile: { name: "Pat Doe", bio: "Hello", photoUrl: null, timezone: "Asia/Kolkata", slug: "pat", notifyByEmail: true },
    google: { state: "connected", email: "pat@gmail.com", connectedAt: when, gmailSend: true, liveEvents: 0, gmailFailing: false },
    whatsapp: { displayPhone: "+91 98765 43210", verifiedName: "Pat Studio", source: "manual", status: "ACTIVE", lastError: null, templates: [{ name: "reschedule", status: "APPROVED", reason: null }], ready: false },
    embedded: null,
    whatsappRequired: false,
    origin: "example.com",
    email: "pat@example.com",
    emailVerified: false,
  };
  const html = render(createElement(SettingsView, { data: jsonify(data), outcome: "denied" }));
  assert.ok(html.includes('id="google"') && html.includes('id="whatsapp"'));
  assert.ok(html.includes("Connected as pat@gmail.com") && html.includes("+91 98765 43210") && html.includes("Pat Studio"));
  assert.ok(html.includes("Google access was not granted"), "the ?google= outcome banner");
  assert.ok(html.includes("example.com/") && html.includes("We sent a link to pat@example.com"));
  assert.ok(html.includes("Signed-in devices") && html.includes("Change password"));
  const plain = render(createElement(SettingsView, { data: jsonify({ ...data, emailVerified: true, whatsapp: null }), outcome: null }));
  assert.ok(!plain.includes("Google access was not granted") && !plain.includes("We sent a link to") && plain.includes("Connect my WhatsApp number"));
  const withSignup = render(createElement(SettingsView, { data: jsonify({ ...data, whatsapp: null, embedded: { appId: "1", configId: "2", graphVersion: "v26.0" } }), outcome: null }));
  assert.ok(withSignup.includes("Connect with WhatsApp") && withSignup.includes("Enter details manually"));
});

test("OnboardingView renders the step from the URL with Google's outcome, and every step is reachable", async () => {
  const { OnboardingView } = await import("../components/views/dashboard/OnboardingView");
  const data: DashboardOnboardingView = {
    profile: { name: "Pat Doe", bio: null, photoUrl: null, timezone: "Asia/Kolkata", slug: "pat", notifyByEmail: true },
    services: [],
    rules: [],
    blocked: [],
    google: { state: "not-connected", requestsGmail: true, liveEvents: 0, previousEmail: null },
    whatsapp: null,
    embedded: null,
    payout: null,
    checklist: [{ key: "email", label: "Confirm your email", done: false, required: true }, { key: "google", label: "Connect Google Calendar", done: true, required: true }],
    publicUrl: "https://example.com/pat",
    email: "pat@example.com",
    emailVerified: false,
  };
  const at = (step: number, outcome: string | null) => render(createElement(OnboardingView, { data: jsonify(data), step, outcome }));
  assert.ok(at(0, null).includes("Tell customers who you are") && at(0, null).includes("Step 1 of 7"));
  assert.ok(at(1, null).includes("Create your first service") && at(1, null).includes("Add a service to continue."));
  assert.ok(at(2, null).includes("When are you available?"));
  const google = at(3, "connected-no-gmail");
  assert.ok(google.includes("Connect Google") && google.includes("sending email from your Gmail was not allowed"), "the outcome banner after the OAuth round trip");
  assert.ok(google.includes("Skip for now") && google.includes("cannot go live until Google Calendar is connected"));
  assert.ok(at(4, null).includes("Connect your WhatsApp number"));
  assert.ok(at(5, null).includes("Where should we send your earnings?"));
  const last = at(6, null);
  assert.ok(last.includes("Ready to take bookings?") && last.includes("https://example.com/pat") && last.includes("Finish and open dashboard") && last.includes("Required"));
  assert.ok(at(99, null).includes("Step 7 of 7") && at(-1, null).includes("Step 1 of 7"), "an out-of-range ?step= is clamped");
});

/* ---------- pure: wiring ---------- */

/** One row per page of this branch: route id, old Next page, SPA page, the view both render, the view function and the endpoint file. */
const PAGES: { id: SpaRouteId; old: string; spa: string; view: string; load: string; endpoint: string; url: string }[] = [
  { id: "dashboard-services", old: "app/dashboard/services/page.tsx", spa: "web/src/pages/dashboard/Services.tsx", view: "ServicesView", load: "loadServicesView", endpoint: "app/api/dashboard/services/route.ts", url: "/api/dashboard/services" },
  { id: "dashboard-availability", old: "app/dashboard/availability/page.tsx", spa: "web/src/pages/dashboard/Availability.tsx", view: "AvailabilityView", load: "loadAvailabilityView", endpoint: "app/api/dashboard/availability/route.ts", url: "/api/dashboard/availability" },
  { id: "dashboard-payouts", old: "app/dashboard/payouts/page.tsx", spa: "web/src/pages/dashboard/Payouts.tsx", view: "PayoutsView", load: "loadPayoutsView", endpoint: "app/api/dashboard/payouts/route.ts", url: "/api/dashboard/payouts" },
  { id: "dashboard-settings", old: "app/dashboard/settings/page.tsx", spa: "web/src/pages/dashboard/Settings.tsx", view: "SettingsView", load: "loadSettingsView", endpoint: "app/api/dashboard/settings/route.ts", url: "/api/dashboard/settings" },
  { id: "onboarding", old: "app/onboarding/page.tsx", spa: "web/src/pages/dashboard/Onboarding.tsx", view: "OnboardingView", load: "loadOnboardingView", endpoint: "app/api/dashboard/onboarding/route.ts", url: "/api/dashboard/onboarding" },
];

test("every page: the old Next page and the SPA page render the same view, the old page and the endpoint call the same view function", () => {
  for (const p of PAGES) {
    const viewImport = `@/components/views/dashboard/${p.view}`;
    assert.ok(read(p.old).includes(`"${viewImport}"`), `${p.old} must render ${p.view}`);
    assert.ok(read(p.spa).includes(`"${viewImport}"`), `${p.spa} must render ${p.view}`);
    assert.ok(read(p.old).includes(`await ${p.load}(`) && read(p.old).includes("jsonify("), `${p.old} must pass jsonify(await ${p.load}(...)) so it renders from exactly the JSON the SPA gets`);
    assert.ok(read(p.endpoint).includes(`await ${p.load}(`) && read(p.endpoint).includes("jsonView("), `${p.endpoint} must answer with jsonView(await ${p.load}(...))`);
    assert.ok(read(p.endpoint).includes("requireApiAuth()"), `${p.endpoint}: the influencer session is required`);
    assert.ok(read(p.spa).includes(`"${p.url}"`), `${p.spa} reads ${p.url}`);
    // The old page keeps only what Next needs (metadata and the auth redirect); the page body lives in the view.
    assert.ok(!/from "@\/components\/app\//.test(read(p.old)), `${p.old} still renders panels itself`);
  }
});

test("every SPA page sets its title with the same text and template as the route table, and the old metadata says the same", () => {
  for (const p of PAGES) {
    const route = spaRouteById(p.id);
    assert.ok("title" in route && route.title);
    const m = /<PageTitle title="([^"]+)"(?: template="(\w+)")?/.exec(read(p.spa));
    assert.ok(m, `${p.spa} renders a <PageTitle> with literal props`);
    assert.equal(m[1], route.title, `${p.id}: title`);
    assert.equal(m[2] ?? "brand", route.template, `${p.id}: template`);
    assert.equal(count(read(p.spa), "<PageTitle"), 1, `${p.spa}: exactly one PageTitle`);
    const meta = /title: "([^"]+)"/.exec(read(p.old));
    assert.ok(meta, `${p.old}: metadata title`);
    // The old dashboard layout adds " · Dashboard"; the onboarding page has no layout and uses the root template.
    assert.equal(formatTitle(meta[1], route.template, BRAND_NAME), formatTitle(route.title as string, route.template, BRAND_NAME));
  }
});

test("the data endpoints are read-only additions: GET returns jsonView, the dashboard mutations keep their guards", () => {
  for (const p of PAGES) assert.ok(/export async function GET\(\)/.test(read(p.endpoint)), `${p.endpoint} has a GET`);
  // The new GET-only files carry no write method at all.
  for (const f of ["app/api/dashboard/payouts/route.ts", "app/api/dashboard/settings/route.ts"]) {
    assert.ok(!/export (async )?function (POST|PUT|PATCH|DELETE)/.test(read(f)), `${f} must stay read-only`);
  }
  // Saving payout details still needs a recent password entry; that route is untouched by this branch.
  assert.ok(read("app/api/dashboard/payout-account/route.ts").includes("requireRecentAuth()"));
});

/* ---------- 401 ---------- */

test("every endpoint answers 401 without a session cookie, or a blank or garbage one, and sends no data", { skip }, async () => {
  for (const [name, handler] of Object.entries(routes)) {
    for (const cookie of [undefined, "", "not-a-real-session-token"]) {
      const out = await ask(handler, cookie);
      assert.equal(out.status, 401, `${name} with cookie ${JSON.stringify(cookie)}`);
      assert.deepEqual(keys(out.body), ["error"], `${name}: only an error sentence`);
      assert.equal(typeof out.body.error, "string");
    }
  }
});

/* ---------- D6 ---------- */

test("D6 GET /api/dashboard/services: the owner's services (hidden ones too) with exactly the editor's fields, in creation order", { skip }, async () => {
  const out = await ask(routes.services, A.cookie);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.equal(out.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(keys(out.body), ["services"]);
  const services = out.body.services as Record<string, unknown>[];
  assert.deepEqual(services.map((s) => s.title), [`Alpha intro ${run}`, `Alpha hidden group ${run}`]);
  for (const s of services) {
    assert.deepEqual(keys(s), ["active", "capacity", "currency", "description", "durationMin", "id", "intakeQuestions", "maxAdvanceDays", "minNoticeHours", "prepNotes", "priceMinor", "refundPolicy", "requiresApproval", "title", "type"]);
  }
  assert.deepEqual(services[0].intakeQuestions, [{ id: "q1", label: "What should Alpha cover?", type: "text", required: true }]);
  assert.equal(services[0].prepNotes, "Alpha prep");
  assert.equal(services[1].active, false);
  assert.equal(services[1].type, "GROUP");
  assert.equal(services[1].capacity, 5);
  assertOnlyOwn(out.body, A, B, C);

  const bravo = await ask(routes.services, B.cookie);
  assert.deepEqual((bravo.body.services as { title: string }[]).map((s) => s.title), [`Bravo intro ${run}`]);
  assertOnlyOwn(bravo.body, B, A, C);
  assert.deepEqual((await ask(routes.services, C.cookie)).body, { services: [] }, "a new account has none, and that is a normal answer");
});

/* ---------- D7 ---------- */

test("D7 GET /api/dashboard/availability: the owner's zone, rules ordered by day and time, and days off as YYYY-MM-DD", { skip }, async () => {
  const out = await ask(routes.availability, A.cookie);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(out.body), ["blocked", "rules", "timezone"]);
  assert.equal(out.body.timezone, "Asia/Kolkata");
  const rules = out.body.rules as Record<string, unknown>[];
  assert.deepEqual(rules.map((r) => [r.weekday, r.startTime, r.endTime]), [[1, "09:00", "12:00"], [1, "14:00", "16:00"], [3, "10:00", "11:00"]]);
  for (const r of rules) assert.deepEqual(keys(r), ["endTime", "id", "startTime", "timezone", "weekday"]);
  const blocked = out.body.blocked as Record<string, unknown>[];
  assert.deepEqual(blocked.map((b) => [b.date, b.reason]), [["2030-01-02", null], ["2030-01-05", `Alpha holiday ${run}`]]);
  for (const b of blocked) assert.deepEqual(keys(b), ["date", "id", "reason"]);
  assertOnlyOwn(out.body, A, B, C);
  assertOnlyOwn((await ask(routes.availability, B.cookie)).body, B, A, C);
  assert.deepEqual((await ask(routes.availability, C.cookie)).body, { timezone: "Asia/Kolkata", rules: [], blocked: [] });
});

/* ---------- D8 ---------- */

test("D8 GET /api/dashboard/payouts: masked details only, the owner's history, the fee as text; a new account has no details and no history", { skip }, async () => {
  const out = await ask(routes.payouts, A.cookie);
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(out.body), ["account", "feePercentText", "summary"]);
  assert.equal(out.body.feePercentText, "12.50%", "Alpha's own fee override");
  assert.deepEqual(keys(out.body.account), ["accountHolderName", "accountNumber", "bankName", "ifsc", "method", "rejectionReason", "status", "upiId"]);
  const account = out.body.account as Record<string, unknown>;
  assert.equal(account.accountNumber, maskAccountNumber(secrets.account.Alpha));
  assert.equal(account.status, "PENDING_REVIEW");
  assert.deepEqual(keys(out.body.summary), ["currencies", "history"]);
  const history = (out.body.summary as { history: Record<string, unknown>[] }).history;
  assert.equal(history.length, 1);
  assert.deepEqual(keys(history[0]), ["createdAt", "currency", "destination", "feeMinor", "id", "netMinor", "paidAt", "paymentCount", "reference", "status"]);
  assert.equal(history[0].reference, `UTR-Alpha-${run}`);
  assert.equal(history[0].destination, `Alpha Bank ${maskAccountNumber(secrets.account.Alpha)}`);
  assert.equal(typeof history[0].paidAt, "string", "dates travel as ISO strings");
  assertOnlyOwn(out.body, A, B, C);

  const bravo = await ask(routes.payouts, B.cookie);
  assert.equal(bravo.body.feePercentText, formatFeePercent(effectiveFeeBps(null)), "no override: the platform default");
  assert.equal((bravo.body.account as { accountNumber: string }).accountNumber, maskAccountNumber(secrets.account.Bravo));
  assert.equal(((bravo.body.summary as { history: { reference: string }[] }).history)[0].reference, `UTR-Bravo-${run}`);
  assertOnlyOwn(bravo.body, B, A, C);

  const charlie = await ask(routes.payouts, C.cookie);
  assert.equal(charlie.status, 200);
  assert.equal(charlie.body.account, null);
  assert.deepEqual(charlie.body.summary, { currencies: [], history: [] });
  assertNoSecretKeys(charlie.body);
});

/* ---------- D9 ---------- */

test("D9 GET /api/dashboard/settings: profile, the three Google states, WhatsApp connected / broken / absent, never a stored token or an id", { skip }, async () => {
  const names = ["META_APP_ID", "META_ES_CONFIG_ID", "META_APP_SECRET", "WHATSAPP_APP_SECRET", "MOCK_PROVIDERS_URL", "APP_URL", "NODE_ENV", "VERCEL"] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) delete process.env[n];
    const out = await ask(routes.settings, A.cookie);
    assert.equal(out.status, 200);
    assert.equal(out.headers.get("cache-control"), "private, no-store");
    assert.equal(out.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(keys(out.body), ["email", "emailVerified", "embedded", "google", "origin", "profile", "whatsapp", "whatsappRequired"]);
    assert.deepEqual(out.body.profile, {
      name: A.name,
      bio: `Alpha bio ${run}`,
      photoUrl: `https://img.example.com/alpha-${run}.png`,
      timezone: "Asia/Kolkata",
      slug: A.slug,
      notifyByEmail: true,
    });
    assert.equal(out.body.email, A.email);
    assert.equal(out.body.emailVerified, false);
    assert.ok(typeof out.body.origin === "string" && !/^https?:/.test(out.body.origin) && out.body.origin.length > 0);
    assert.equal(out.body.embedded, null, "Embedded Signup is not configured here");
    const google = out.body.google as Record<string, unknown>;
    assert.deepEqual(keys(google), ["connectedAt", "email", "gmailFailing", "gmailSend", "liveEvents", "state"]);
    assert.equal(google.state, "connected");
    assert.equal(google.email, `alpha-calendar-${run}@example.com`);
    assert.equal(google.gmailSend, true);
    assert.equal(typeof google.connectedAt, "string");
    const whatsapp = out.body.whatsapp as Record<string, unknown>;
    assert.deepEqual(keys(whatsapp), ["displayPhone", "lastError", "ready", "source", "status", "templates", "verifiedName"]);
    assert.equal(whatsapp.displayPhone, "+91 98765 43210");
    assert.equal(whatsapp.ready, false, "only one of the five templates is approved");
    const templates = whatsapp.templates as { name: string; status: string; reason: unknown }[];
    assert.equal(templates.length, 5);
    assert.deepEqual(templates.find((t) => t.name === "booking-confirmation"), { name: "booking-confirmation", status: "APPROVED", reason: null });
    for (const t of templates) assert.deepEqual(keys(t), ["name", "reason", "status"]);
    assertOnlyOwn(out.body, A, B, C);

    const bravo = await ask(routes.settings, B.cookie);
    assert.deepEqual(bravo.body.google, { state: "reconnect-needed", email: `bravo-calendar-${run}@example.com`, reason: "invalid_grant", liveEvents: 0 });
    assert.equal((bravo.body.whatsapp as { status: string }).status, "ERROR");
    assert.equal((bravo.body.whatsapp as { lastError: string }).lastError, "Bravo token was revoked");
    assertOnlyOwn(bravo.body, B, A, C);

    const charlie = await ask(routes.settings, C.cookie);
    assert.equal(charlie.status, 200, "settings do not wait for onboarding to be finished by the API; the page guard decides that");
    assert.deepEqual(keys(charlie.body.google), ["liveEvents", "previousEmail", "requestsGmail", "state"]);
    assert.equal((charlie.body.google as { state: string }).state, "not-connected");
    assert.equal(charlie.body.whatsapp, null);
    assertOnlyOwn(charlie.body, C, A, B);

    // With the Meta app configured the browser gets the two public ids the Facebook SDK needs, and the app secret stays on the server.
    process.env.META_APP_ID = `meta-app-${run}`;
    process.env.META_ES_CONFIG_ID = `meta-config-${run}`;
    process.env.META_APP_SECRET = secrets.metaSecret;
    const configured = await ask(routes.settings, A.cookie);
    assert.deepEqual(keys(configured.body.embedded), ["appId", "configId", "graphVersion"], "no sdkUrl without the local mock override");
    assert.equal((configured.body.embedded as { appId: string }).appId, `meta-app-${run}`);
    assertOnlyOwn(configured.body, A, B, C);

    // The local mock override (doc/11-provider-simulator.md) is on: the settings AND the onboarding endpoint carry the mock's SDK
    // URL, otherwise the page would load Meta's real SDK with the fake app id. Not otherwise, and never invented.
    process.env.APP_URL = "http://localhost:3000";
    process.env.MOCK_PROVIDERS_URL = "http://127.0.0.1:4010";
    const mocked = await ask(routes.settings, A.cookie);
    assert.deepEqual(keys(mocked.body.embedded), ["appId", "configId", "graphVersion", "sdkUrl"]);
    assert.equal((mocked.body.embedded as { sdkUrl: string }).sdkUrl, "http://127.0.0.1:4010/meta/en_US/sdk.js");
    assert.deepEqual((await ask(routes.onboarding, A.cookie)).body.embedded, mocked.body.embedded, "onboarding sends the same Embedded Signup block");
    assertOnlyOwn(mocked.body, A, B, C);
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    assert.deepEqual(keys((await ask(routes.settings, A.cookie)).body.embedded), ["appId", "configId", "graphVersion"], "production ignores the override");
    delete (process.env as Record<string, string | undefined>).NODE_ENV;
    process.env.APP_URL = "https://app.example.com";
    assert.deepEqual(keys((await ask(routes.onboarding, A.cookie)).body.embedded), ["appId", "configId", "graphVersion"], "a non-local APP_URL ignores it too");
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else (process.env as Record<string, string | undefined>)[n] = saved[n];
    }
  }
});

test("D9 reflects a disconnect right away: the Google and WhatsApp panels go back to their not-connected state", { skip }, async () => {
  const connected = await ask(routes.settings, A.cookie);
  assert.equal((connected.body.google as { state: string }).state, "connected");
  await prisma.googleToken.delete({ where: { influencerId: A.influencerId } });
  await prisma.whatsAppConnection.delete({ where: { influencerId: A.influencerId } });
  try {
    const gone = await ask(routes.settings, A.cookie);
    assert.equal((gone.body.google as { state: string }).state, "not-connected");
    assert.equal(gone.body.whatsapp, null);
    assertOnlyOwn(gone.body, A, B, C);
  } finally {
    // Put Alpha's connections back for the tests that follow.
    await prisma.googleToken.create({ data: { influencerId: A.influencerId, refreshTokenEnc: secrets.googleEnc(A), scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send", googleEmail: `alpha-calendar-${run}@example.com` } });
    await prisma.whatsAppConnection.create({
      data: { influencerId: A.influencerId, wabaId: secrets.waba(A), phoneNumberId: secrets.phoneId(A), displayPhone: "+91 98765 43210", verifiedName: `Alpha Studio ${run}`, tokenEnc: secrets.waToken(A), templates: { "booking-confirmation": { status: "APPROVED", language: "en" } } },
    });
  }
});

/* ---------- D10 ---------- */

test("D10 GET /api/dashboard/onboarding: any signed-in influencer, finished or not; the same data the four pages show; the step is not part of the answer", { skip }, async () => {
  const out = await ask(routes.onboarding, C.cookie);
  assert.equal(out.status, 200, "an account that has NOT finished onboarding is exactly who needs this");
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(keys(out.body), ["blocked", "checklist", "email", "emailVerified", "embedded", "google", "payout", "profile", "publicUrl", "rules", "services", "whatsapp"]);
  assert.equal(out.body.email, C.email);
  assert.match(out.body.publicUrl as string, new RegExp(`/${C.slug}$`));
  assert.deepEqual(out.body.services, []);
  assert.deepEqual(out.body.rules, []);
  assert.deepEqual(out.body.blocked, []);
  assert.equal(out.body.payout, null);
  assert.equal(out.body.whatsapp, null);
  const checklist = out.body.checklist as { key: string; label: string; done: boolean; required: boolean }[];
  assert.deepEqual(checklist.map((i) => i.key), ["email", "service", "availability", "google", "gmail", "whatsapp", "payout"]);
  for (const item of checklist) assert.deepEqual(keys(item), ["done", "key", "label", "required"]);
  assert.ok(checklist.filter((i) => ["email", "service", "availability"].includes(i.key)).every((i) => !i.done && i.required));
  assertOnlyOwn(out.body, C, A, B);

  // For an owner with data it is the same data the Services, Availability, Payouts and Settings endpoints return.
  const alpha = await ask(routes.onboarding, A.cookie);
  assert.equal(alpha.status, 200);
  assert.deepEqual(alpha.body.services, (await ask(routes.services, A.cookie)).body.services);
  const availability = (await ask(routes.availability, A.cookie)).body;
  assert.deepEqual(alpha.body.rules, availability.rules);
  assert.deepEqual(alpha.body.blocked, availability.blocked);
  assert.deepEqual(alpha.body.payout, (await ask(routes.payouts, A.cookie)).body.account);
  const settings = (await ask(routes.settings, A.cookie)).body;
  assert.deepEqual(alpha.body.profile, settings.profile);
  assert.deepEqual(alpha.body.google, settings.google);
  assert.deepEqual(alpha.body.whatsapp, settings.whatsapp);
  assert.deepEqual(alpha.body.embedded, settings.embedded);
  assertOnlyOwn(alpha.body, A, B, C);
  assertOnlyOwn((await ask(routes.onboarding, B.cookie)).body, B, A, C);
});

test("a view function and the jsonify round trip agree: what the old page renders from is exactly what the endpoint sends", { skip }, async () => {
  const auth = { influencerId: A.influencerId, email: A.email, emailVerified: false, userId: A.userId } as Parameters<typeof viewsLib.settings.loadSettingsView>[0];
  const direct = jsonify(await viewsLib.settings.loadSettingsView(auth));
  assert.deepEqual(direct, (await ask(routes.settings, A.cookie)).body);
  const payouts = jsonify(await viewsLib.payouts.loadPayoutsView(A.influencerId));
  assert.deepEqual(payouts, (await ask(routes.payouts, A.cookie)).body);
});
