// Regression tests for the defects found by the signed-in QA pass (doc/10-react-migration-qa-console.md). One test per finding that
// can be pinned without a browser; the numbers in the titles are the finding ids of that file. The first group needs no database;
// the loadBookableService test skips itself without DATABASE_URL.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, mock, test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { razorpayErrorText } from "../lib/payments";
import { Dialog, Drawer, ToastProvider } from "../components/ui/overlays";
import { MobileNav, isNavActive, type MobileNavItem } from "../components/ui/MobileNav";
import nextConfig from "../next.config";

const root = (p: string) => path.resolve(__dirname, "..", p);
const read = (p: string) => readFileSync(root(p), "utf8");
const count = (html: string, needle: string) => html.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------------------------------------
// C10: the page must not scroll sideways on a phone.
test("C10: the .shell grid tracks can shrink below their content (minmax(0, 1fr)), on desktop and on a phone", () => {
  const css = read("app/styles/layouts.css");
  const columns = [...css.matchAll(/\.shell\s*\{[^}]*?grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(columns.length, 2, "one declaration for the sidebar layout and one for the phone layout");
  for (const c of columns) {
    assert.match(c, /minmax\(0,\s*1fr\)$/, `"${c}": a bare 1fr track grows to the min-content width of its widest child (six nowrap tabs, a wide table)`);
    assert.doesNotMatch(c, /(^|\s)1fr$/, c);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// C11: every section is reachable from the bottom bar of a phone.
const icon = (() => null) as unknown as MobileNavItem["icon"];
const primary: MobileNavItem[] = [
  { href: "/dashboard", label: "Overview", icon, exact: true },
  { href: "/dashboard/sessions", label: "Sessions", icon },
];
const more: MobileNavItem[] = [
  { href: "/dashboard/customers", label: "Customers", icon },
  { href: "/dashboard/earnings", label: "Earnings", icon },
];

test("C11: the bottom bar has a slot per primary section and a More button that is current while one of its sections is open", () => {
  const closed = renderToStaticMarkup(createElement(MobileNav, { pathname: "/dashboard/sessions", primary, more }));
  assert.equal(count(closed, "<a "), 2, "one link per primary section");
  assert.match(closed, /aria-current="page"[^>]*>.*?Sessions|Sessions/, "the open section is marked");
  assert.match(closed, /<button[^>]*aria-expanded="false"[^>]*>/, "the More button starts collapsed");
  assert.doesNotMatch(closed, /Customers|Earnings/, "the list of the other sections is not in the page until it is opened");
  assert.doesNotMatch(closed, /<button[^>]*aria-current/, "More is not current while a primary section is open");

  const inMore = renderToStaticMarkup(createElement(MobileNav, { pathname: "/dashboard/earnings", primary, more }));
  assert.match(inMore, /<button[^>]*aria-current="page"[^>]*>/, "More is current while one of its sections is open");
  assert.equal(count(renderToStaticMarkup(createElement(MobileNav, { pathname: "/", primary, more: [] })), "<button"), 0, "no More button when nothing is behind it");
});

test("C11: a section and its sub-pages are active, a look-alike prefix is not, an exact item only matches itself", () => {
  assert.equal(isNavActive("/dashboard/sessions", { href: "/dashboard/sessions" }), true);
  assert.equal(isNavActive("/dashboard/sessions/x", { href: "/dashboard/sessions" }), true);
  assert.equal(isNavActive("/dashboard/sessionsx", { href: "/dashboard/sessions" }), false);
  assert.equal(isNavActive("/dashboard/sessions", { href: "/dashboard", exact: true }), false);
  assert.equal(isNavActive("/dashboard", { href: "/dashboard", exact: true }), true);
});

test("C11: both shells hand every section that is not in the bar to More (nothing is dropped)", () => {
  for (const [file, primaryPaths, total] of [
    ["components/app/AppShell.tsx", ["/dashboard", "/dashboard/sessions", "/dashboard/services", "/dashboard/availability"], 9],
    ["components/admin/AdminShell.tsx", ["/admin", "/admin/influencers", "/admin/payments", "/admin/payouts"], 9],
  ] as const) {
    const src = read(file);
    assert.match(src, /more=\{NAV\.filter\(\(n\) => !MOBILE_PRIMARY\.includes\(n\.href\)\)\}/, `${file}: More is the complement of the bar`);
    assert.match(src, /primary=\{NAV\.filter\(\(n\) => MOBILE_PRIMARY\.includes\(n\.href\)\)\}/, file);
    const declared = [...src.matchAll(/\{ href: "(\/[^"]+)", label:/g)].map((m) => m[1]);
    assert.equal(declared.length, total, `${file}: the nav lists ${total} sections`);
    for (const p of primaryPaths) assert.ok(declared.includes(p), `${file}: ${p} is a section`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// C2: toasts must be visible and announced while a modal is open.
test("C2: an open Dialog or Drawer carries its own toast stack (the page's one is under the modal and inert); a closed one does not", () => {
  const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ToastProvider, null, el));
  const dialog = (open: boolean) => render(createElement(Dialog, { open, onClose: () => {}, title: "Title" }, "body"));
  const drawer = (open: boolean) => render(createElement(Drawer, { open, onClose: () => {}, title: "Title", children: "body" }));
  assert.equal(count(dialog(false), 'class="toasts"'), 1, "closed: only the page's stack");
  assert.equal(count(dialog(true), 'class="toasts"'), 2, "open: the page's stack and the one inside the dialog");
  assert.equal(count(drawer(false), 'class="toasts"'), 1);
  assert.equal(count(drawer(true), 'class="toasts"'), 2);
  const html = dialog(true);
  const inside = html.slice(html.indexOf("<dialog"), html.indexOf("</dialog>"));
  assert.equal(count(inside, 'class="toasts"'), 1, "one stack inside the <dialog> element");
  assert.ok(html.lastIndexOf('class="toasts"') > html.indexOf("</dialog>"), "and the page's own stack after it");
  assert.match(inside, /class="toasts" aria-live="polite"/, "the stack inside the modal is a live region");
});

// ---------------------------------------------------------------------------------------------------------------------------
// C1: Cache-Control on the signed-in API.
test("C1: every /api/dashboard, /api/admin and /api/auth answer is private, no-store; public endpoints and assets are not touched", async () => {
  const rules = await nextConfig.headers!();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { match } = require("next/dist/compiled/path-to-regexp") as { match(source: string): (path: string) => false | object };
  const noStore = (path: string) =>
    rules.some((r) => r.headers.some((h) => h.key === "Cache-Control" && h.value === "private, no-store") && match(r.source)(path) !== false);
  for (const p of [
    "/api/dashboard/google",
    "/api/dashboard/payout-account",
    "/api/dashboard/whatsapp",
    "/api/dashboard/bookings/abc",
    "/api/dashboard/earnings/export",
    "/api/dashboard/shell",
    "/api/auth/sessions",
    "/api/auth/session",
    "/api/auth/login",
    "/api/admin/influencers/abc",
    "/api/admin/payments/reconcile",
    "/api/admin/session",
  ]) assert.equal(noStore(p), true, `${p} must not be cacheable`);
  for (const p of ["/api/public/profiles/demo", "/api/slots", "/api/slots/days", "/api/health", "/api/webhooks/payment", "/assets/index-abc.js", "/dashboard", "/admin", "/api/manage/token"]) {
    assert.equal(noStore(p), false, `${p} is not covered by the signed-in rule`);
  }
  const immutable = rules.filter((r) => r.headers.some((h) => /immutable/.test(h.value)));
  assert.equal(immutable.length, 1, "the asset rule is still there");
});

// ---------------------------------------------------------------------------------------------------------------------------
// C6: the sentence of a Razorpay error, not its JSON.
test("C6: razorpayErrorText shows the description of Razorpay's error body, the gateway message, or the plain text", () => {
  assert.equal(
    razorpayErrorText('{"error":{"code":"BAD_REQUEST_ERROR","description":"The id provided does not exist","source":"internal","step":"payment_initiation"}}'),
    "The id provided does not exist",
  );
  assert.equal(razorpayErrorText('{\n  "message":"no Route matched with those values"\n}'), "no Route matched with those values");
  assert.equal(razorpayErrorText("Bad Gateway"), "Bad Gateway");
  assert.equal(razorpayErrorText("  two\n  lines  "), "two lines");
  assert.equal(razorpayErrorText('{"error":{"description":"' + "x".repeat(400) + '"}}').length, 300, "cut to the limit");
  assert.equal(razorpayErrorText('{"error":{"description":"' + "x".repeat(400) + '"}}', 50).length, 50);
  assert.equal(razorpayErrorText('{"error":{"code":"X"}}'), '{"error":{"code":"X"}}', "no description: the text as it is");
  assert.equal(razorpayErrorText(""), "");
  assert.equal(razorpayErrorText("null"), "null");
  const src = read("lib/payments.ts");
  assert.equal(count(src, "body.slice("), 0, "no message cuts a raw body any more");
  assert.equal(count(src, "${razorpayErrorText(body"), 5, "all five failure messages use it");
});

// ---------------------------------------------------------------------------------------------------------------------------
// C4: the device list is reloaded after a password change.
test("C4: PasswordForm tells DeviceSessions to reload, and DeviceSessions listens for it and also reloads when a device is already gone", () => {
  const src = read("components/app/SettingsForms.tsx");
  assert.match(src, /export const SESSIONS_CHANGED_EVENT = "sa:sessions-changed"/);
  assert.equal(count(src, "window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT))"), 1, "dispatched once, after a successful password change");
  assert.equal(count(src, "window.addEventListener(SESSIONS_CHANGED_EVENT"), 1);
  assert.equal(count(src, "window.removeEventListener(SESSIONS_CHANGED_EVENT"), 1, "and removed again");
  assert.match(src, /r\.status === 404 \? "That device was already signed out\."/, "a 404 from the revoke call is not shown as a failure");
});

// ---------------------------------------------------------------------------------------------------------------------------
// C3: the onboarding hint must not promise more than is true.
test("C3: the last onboarding step does not say the page goes live when the email is confirmed", () => {
  const src = read("components/app/OnboardingWizard.tsx");
  assert.doesNotMatch(src, /goes live for customers as soon as you confirm your email/);
  assert.match(src, /Customers cannot see your page until you confirm your email\./);
});

// ---------------------------------------------------------------------------------------------------------------------------
// C9: the influencer search announces its result and keeps its box.
let InfluencersView: ComponentType<{ data: unknown; q?: string; busy?: boolean }>;
before(async () => {
  mock.module("@/components/views/admin/InfluencerSearchForm", { namedExports: { InfluencerSearchForm: () => createElement("div", { "data-fake": "InfluencerSearchForm" }) } });
  InfluencersView = (await import("../components/views/admin/InfluencersView")).InfluencersView as typeof InfluencersView;
});
const row = (n: number) => ({
  id: `id${n}`,
  name: `Name ${n}`,
  email: `n${n}@example.com`,
  live: false,
  emailVerified: true,
  blockers: ["Connect Google Calendar"],
  google: "none",
  whatsapp: { text: "Not connected", tone: "neutral" },
  payout: "none",
  services: 0,
  bookings: 0,
  grossMinor: 0,
});
test("C9: the Influencers list renders a live status line (count, search text, page) and marks itself busy while the next search loads", () => {
  const data = { rows: [row(1), row(2)], total: 2, page: 1, pageCount: 1 };
  const html = renderToStaticMarkup(createElement(InfluencersView, { data, q: "ann" }));
  assert.match(html, /<p role="status" class="sr-only">2 accounts for “ann”, page 1 of 1\.<\/p>/);
  assert.doesNotMatch(html, /aria-busy/);
  assert.match(renderToStaticMarkup(createElement(InfluencersView, { data, busy: true })), /class="table-wrap" aria-busy="true"/);
  const none = renderToStaticMarkup(createElement(InfluencersView, { data: { rows: [], total: 0, page: 1, pageCount: 1 }, q: "zz" }));
  assert.match(none, /No accounts for “zz”, page 1 of 1\./);
  assert.match(renderToStaticMarkup(createElement(InfluencersView, { data: { rows: [row(1)], total: 1, page: 1, pageCount: 1 } })), /1 account, page 1 of 1\./);
  const page = read("web/src/pages/admin/Influencers.tsx");
  assert.match(page, /placeholderData: keepPreviousData/);
  assert.match(page, /busy=\{query\.isPlaceholderData\}/);
});

// ---------------------------------------------------------------------------------------------------------------------------
// C5: the owner can read the slots of a service they have hidden (to move its existing bookings).
const skipDb = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
test("C5: loadBookableService lets the owner read a hidden service, and nobody else", { skip: skipDb }, async () => {
  const { prisma } = await import("../lib/db");
  const { loadBookableService } = await import("../lib/availability");
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const owner = await prisma.influencer.create({ data: { name: `QA C5 owner ${run}`, slug: `qac5-o-${run}`, email: `qac5-o-${run}@example.com` } });
  const other = await prisma.influencer.create({ data: { name: `QA C5 other ${run}`, slug: `qac5-x-${run}`, email: `qac5-x-${run}@example.com` } });
  try {
    const hidden = await prisma.service.create({ data: { influencerId: owner.id, title: `QA C5 hidden ${run}`, durationMin: 30, priceMinor: 10000, active: false } });
    const shown = await prisma.service.create({ data: { influencerId: owner.id, title: `QA C5 shown ${run}`, durationMin: 30, priceMinor: 10000, active: true } });
    assert.ok(await loadBookableService(hidden.id, owner.id), "the owner can read a hidden service");
    assert.equal(await loadBookableService(hidden.id, other.id), null, "another influencer cannot");
    assert.equal(await loadBookableService(hidden.id, null), null, "a visitor cannot");
    assert.equal(await loadBookableService(hidden.id), null);
    assert.ok(await loadBookableService(shown.id, owner.id), "the owner can still preview an active service of a page that is not live yet");
    assert.equal(await loadBookableService(shown.id, other.id), null, "the page is not live, so a stranger cannot");
    assert.equal(await loadBookableService("no-such-service", owner.id), null);
  } finally {
    await prisma.influencer.deleteMany({ where: { id: { in: [owner.id, other.id] } } }).catch(() => {});
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// C12: the wrong-code sentence must be true wherever a code is typed.
test("C12: the wrong-code message does not tell someone who is typing a recovery code (or turning two-factor on) to use a recovery code or the app", async () => {
  const { codeFailureMessage } = await import("../lib/admin/mfa");
  const m = codeFailureMessage("invalid");
  assert.doesNotMatch(m, /recovery/i, "nobody has recovery codes while enrolling, and a recovery code was just typed at sign-in");
  assert.doesNotMatch(m, /authenticator app/i, "a recovery code is not in the authenticator app");
  assert.match(m, /^That code is not correct\./);
  assert.match(codeFailureMessage("replayed"), /already used/);
  assert.match(codeFailureMessage("locked", new Date(Date.now() + 5 * 60_000)), /locked for about \d+ minutes?\. You can still use a recovery code\./, "the lock message may mention recovery codes: it is shown at sign-in only, after codes exist");
});

// ---------------------------------------------------------------------------------------------------------------------------
// C13: coming back from Google lands on the Google card, not on the top of a long Settings page.
test("C13: outcomeTarget keeps the #fragment of returnTo, and Settings asks to come back to #google", async () => {
  const { outcomeTarget } = await import("../lib/google-connect");
  assert.deepEqual(outcomeTarget("/dashboard/settings#google", "connected"), { pathname: "/dashboard/settings", search: "?google=connected", hash: "#google" });
  assert.deepEqual(outcomeTarget("/onboarding?step=3#x", "denied"), { pathname: "/onboarding", search: "?step=3&google=denied", hash: "#x" });
  assert.deepEqual(outcomeTarget("/dashboard/settings#", "failed"), { pathname: "/dashboard/settings", search: "?google=failed" }, "an empty fragment is dropped");
  assert.deepEqual(outcomeTarget("/dashboard/settings", "connected"), { pathname: "/dashboard/settings", search: "?google=connected" }, "no fragment: the shape the older callers see");
  assert.match(read("components/views/dashboard/SettingsView.tsx"), /returnTo="\/dashboard\/settings#google"/);
  for (const file of ["app/api/google/callback/route.ts", "app/api/google/connect/route.ts"]) {
    assert.match(read(file), /url\.hash = hash \?\? ""/, `${file} sets the fragment on the redirect`);
  }
});
