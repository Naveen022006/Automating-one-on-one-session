// Regression tests for the defects found by the signed-in QA pass (doc/10-react-migration-qa-console.md). One test per finding that
// can be pinned without a browser; the numbers in the titles are the finding ids of that file. The first group needs no database;
// the loadBookableService test skips itself without DATABASE_URL.
import "dotenv/config";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { before, mock, test } from "node:test";
import * as ReactNs from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { razorpayErrorText } from "../lib/payments";
import { Dialog, Drawer, ToastProvider, useToast } from "../web/src/components/ui/overlays";
import { MobileNav, escapeReturnsFocus, focusLeavesBar, isInside, isNavActive, type MobileNavItem } from "../web/src/components/ui/MobileNav";
import nextConfig from "../next.config";
import { fakeNavigate } from "./helpers/fake-navigate";

const root = (p: string) => path.resolve(__dirname, "..", p);
const read = (p: string) => readFileSync(root(p), "utf8");
const count = (html: string, needle: string) => html.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------------------------------------
// C10: the page must not scroll sideways on a phone.
test("C10: the .shell grid tracks can shrink below their content (minmax(0, 1fr)), on desktop and on a phone", () => {
  const css = read("web/src/styles/layouts.css");
  const columns = [...css.matchAll(/\.shell\s*\{[^}]*?grid-template-columns:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.equal(columns.length, 2, "one declaration for the sidebar layout and one for the phone layout");
  for (const c of columns) {
    assert.match(c, /minmax\(0,\s*1fr\)$/, `"${c}": a bare 1fr track grows to the min-content width of its widest child (six nowrap tabs, a wide table)`);
    assert.doesNotMatch(c, /(^|\s)1fr$/, c);
  }
});

test("C21: every table of the dashboard has a name for screen readers", () => {
  assert.match(read("web/src/components/views/dashboard/CustomersView.tsx"), /<table className="table table--stack">\s*<caption className="sr-only">Customers<\/caption>/);
  assert.match(read("web/src/components/views/dashboard/MessagesView.tsx"), /<table className="table table--stack">\s*<caption className="sr-only">Messages<\/caption>/);
  assert.match(read("web/src/components/app/SessionsBoard.tsx"), /<table className="table table--stack">\s*<caption className="sr-only">Bookings<\/caption>/);
  assert.match(read("web/src/components/app/AvailabilityEditor.tsx"), /<table className="table">\s*<caption className="sr-only">Weekly hours<\/caption>/);
});

test("C20: an anchor inside the dashboard or console scrolls to below the sticky top bar, not under it", () => {
  const css = read("web/src/styles/layouts.css");
  assert.match(css, /\.topbar \{[^}]*position: sticky;[^}]*min-height: 64px;/s, "the bar is sticky and 64px tall");
  assert.match(css, /\.app-main \[id\] \{\s*scroll-margin-top: calc\(64px \+ var\(--space-6\)\);\s*\}/, "so every #target inside the page keeps clear of it");
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
    ["web/src/components/app/AppShell.tsx", ["/dashboard", "/dashboard/sessions", "/dashboard/services", "/dashboard/availability"], 9],
    // 10: the finance report (/admin/reports, doc/13) joined the console; it is not in the bar, so it lands in More.
    ["web/src/components/admin/AdminShell.tsx", ["/admin", "/admin/influencers", "/admin/payments", "/admin/payouts"], 10],
  ] as const) {
    const src = read(file);
    assert.match(src, /more=\{NAV\.filter\(\(n\) => !MOBILE_PRIMARY\.includes\(n\.href\)\)\}/, `${file}: More is the complement of the bar`);
    assert.match(src, /primary=\{NAV\.filter\(\(n\) => MOBILE_PRIMARY\.includes\(n\.href\)\)\}/, file);
    const declared = [...src.matchAll(/\{ href: "(\/[^"]+)", label:/g)].map((m) => m[1]);
    assert.equal(declared.length, total, `${file}: the nav lists ${total} sections`);
    for (const p of primaryPaths) assert.ok(declared.includes(p), `${file}: ${p} is a section`);
  }
});

// N4: the More list follows keyboard focus, and Escape does not steal focus from elsewhere on the page.
test("N4: Tab or Shift+Tab out of the bar closes the list; a focus change inside the bar, or to nowhere, does not", () => {
  const link = { id: "inside-link" };
  const search = { id: "outside-search" };
  const bar: { contains(n: unknown): boolean } = { contains: (n: unknown) => n === link || n === bar };
  assert.equal(focusLeavesBar(bar, search), true, "focus went to a control outside the bar");
  assert.equal(focusLeavesBar(bar, link), false, "from the button to a link in the list");
  assert.equal(focusLeavesBar(bar, bar), false);
  assert.equal(focusLeavesBar(bar, null), false, "null is focus leaving the page or a tap that focuses nothing (Safari): closing would eat the click");
  assert.equal(focusLeavesBar(null, search), false, "no bar mounted");
});

test("N4: Escape hands focus back to More only when focus was in the bar", () => {
  const link = {};
  const search = {};
  const bar = { contains: (n: unknown) => n === link };
  assert.equal(escapeReturnsFocus(bar, link), true);
  assert.equal(escapeReturnsFocus(bar, search), false, "someone typing in a search field elsewhere stays there");
  assert.equal(escapeReturnsFocus(bar, null), false, "nothing focused");
  assert.equal(escapeReturnsFocus(null, link), false);
  assert.equal(isInside(bar, link), true);
  assert.equal(isInside(bar, undefined), false);
});

test("N4: the bar wires those decisions to focus-out and to the Escape listener", () => {
  const src = read("web/src/components/ui/MobileNav.tsx");
  assert.match(src, /onBlur=\{\(e\) => \{\s*if \(open && focusLeavesBar\(e\.currentTarget, e\.relatedTarget\)\) setOpen\(false\);/);
  assert.match(src, /const hadFocus = escapeReturnsFocus\(rootRef\.current, document\.activeElement\);\s*setOpen\(false\);\s*if \(hadFocus\) buttonRef\.current\?\.focus\(\);/, "the focus is looked at before the list unmounts");
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
    // N9: the booking the confirmation page polls carries the Meet link and the self-service link.
    "/api/bookings/abc",
    "/api/bookings/abc/ics",
    "/api/bookings/hold",
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
  const src = read("web/src/components/app/SettingsForms.tsx");
  assert.match(src, /export const SESSIONS_CHANGED_EVENT = "sa:sessions-changed"/);
  assert.equal(count(src, "window.dispatchEvent(new Event(SESSIONS_CHANGED_EVENT))"), 1, "dispatched once, after a successful password change");
  assert.equal(count(src, "window.addEventListener(SESSIONS_CHANGED_EVENT"), 1);
  assert.equal(count(src, "window.removeEventListener(SESSIONS_CHANGED_EVENT"), 1, "and removed again");
  assert.match(src, /r\.status === 404 \? "That device was already signed out\."/, "a 404 from the revoke call is not shown as a failure");
});

// ---------------------------------------------------------------------------------------------------------------------------
// C3: the onboarding hint must not promise more than is true.
test("C3: the last onboarding step does not say the page goes live when the email is confirmed", () => {
  const src = read("web/src/components/app/OnboardingWizard.tsx");
  assert.doesNotMatch(src, /goes live for customers as soon as you confirm your email/);
  assert.match(src, /Customers cannot see your page until you confirm your email\./);
});

// ---------------------------------------------------------------------------------------------------------------------------
// C9: the influencer search announces its result and keeps its box.
let InfluencersView: ComponentType<{ data: unknown; q?: string; busy?: boolean }>;
before(async () => {
  mock.module("@web/components/views/admin/InfluencerSearchForm", { namedExports: { InfluencerSearchForm: () => createElement("div", { "data-fake": "InfluencerSearchForm" }) } });
  InfluencersView = (await import("../web/src/components/views/admin/InfluencersView")).InfluencersView as typeof InfluencersView;
});
const list = { status: "all", counts: { suspended: 0, awaitingApproval: 0 } };
const row = (n: number) => ({
  id: `id${n}`,
  name: `Name ${n}`,
  email: `n${n}@example.com`,
  live: false,
  accountStatus: "active",
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
  const data = { rows: [row(1), row(2)], total: 2, page: 1, pageCount: 1, ...list };
  const html = renderToStaticMarkup(createElement(InfluencersView, { data, q: "ann" }));
  assert.match(html, /<p role="status" class="sr-only">2 accounts for “ann”, page 1 of 1\.<\/p>/);
  assert.doesNotMatch(html, /aria-busy/);
  assert.match(renderToStaticMarkup(createElement(InfluencersView, { data, busy: true })), /class="table-wrap" aria-busy="true"/);
  const none = renderToStaticMarkup(createElement(InfluencersView, { data: { rows: [], total: 0, page: 1, pageCount: 1, ...list }, q: "zz" }));
  assert.match(none, /No accounts for “zz”, page 1 of 1\./);
  assert.match(renderToStaticMarkup(createElement(InfluencersView, { data: { rows: [row(1)], total: 1, page: 1, pageCount: 1, ...list } })), /1 account, page 1 of 1\./);
  const page = read("web/src/pages/admin/Influencers.tsx");
  assert.match(page, /placeholderData: keepPreviousData/);
  assert.match(page, /busy=\{query\.isPlaceholderData\}/);
});

test("N3: while the previous result is still shown, the status line says the next one is loading instead of announcing the old total", () => {
  const data = { rows: [row(1), row(2)], total: 2, page: 1, pageCount: 1, ...list };
  const busy = renderToStaticMarkup(createElement(InfluencersView, { data, q: "ann", busy: true }));
  assert.match(busy, /<p role="status" class="sr-only">Searching…<\/p>/);
  assert.doesNotMatch(busy, /<p role="status"[^>]*>[^<]*accounts/, "the old total is not announced next to the new search text");
  assert.match(renderToStaticMarkup(createElement(InfluencersView, { data, q: "ann", busy: false })), /2 accounts for “ann”/, "and the result is announced once it has arrived");
  // Every list page with this status line (the ones that set `busy` from isPlaceholderData) does the same.
  const searches = ["web/src/components/views/admin/InfluencersView.tsx", "web/src/components/views/dashboard/CustomersView.tsx"];
  const lists = [
    "web/src/components/views/admin/AuditView.tsx",
    "web/src/components/views/admin/BookingsView.tsx",
    "web/src/components/views/admin/PaymentsView.tsx",
    "web/src/components/views/admin/PayoutsView.tsx",
    "web/src/components/views/dashboard/EarningsView.tsx",
    "web/src/components/views/dashboard/MessagesView.tsx",
    "web/src/components/views/dashboard/SessionsView.tsx",
  ];
  for (const f of searches) assert.match(read(f), /<p role="status" className="sr-only">\{busy \? "Searching…" : found\}<\/p>/, f);
  for (const f of lists) assert.match(read(f), /<p role="status" className="sr-only">\{busy \? "Loading…" : found\}<\/p>/, f);
});

// ---------------------------------------------------------------------------------------------------------------------------
// C5: the owner can read the slots of a service they have hidden (to move its existing bookings).
const skipDb = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

/**
 * The database tests create their influencers INSIDE the try block, pushing each id as soon as it exists (a failure halfway
 * through still leaves the first one to be deleted), and delete them here. A cleanup failure is logged with the ids, never
 * swallowed: a leftover row on the shared database is something to know about. Everything else hangs off the influencer by
 * cascade.
 */
type Db = typeof import("../lib/db").prisma;
async function removeInfluencers(prisma: Db, ids: string[]): Promise<void> {
  try {
    if (ids.length > 0) await prisma.influencer.deleteMany({ where: { id: { in: ids } } });
  } catch (e) {
    console.error(`[qa-console test] could not delete the test influencers ${ids.join(", ")}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

test("C5: loadBookableService lets the owner read a hidden service, and nobody else", { skip: skipDb }, async () => {
  const { prisma } = await import("../lib/db");
  const { loadBookableService } = await import("../lib/availability");
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const ids: string[] = [];
  try {
    const owner = await prisma.influencer.create({ data: { name: `QA C5 owner ${run}`, slug: `qac5-o-${run}`, email: `qac5-o-${run}@example.com` } });
    ids.push(owner.id);
    const other = await prisma.influencer.create({ data: { name: `QA C5 other ${run}`, slug: `qac5-x-${run}`, email: `qac5-x-${run}@example.com` } });
    ids.push(other.id);
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
    await removeInfluencers(prisma, ids);
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
// C15: the "reconnect Google" attention item must not end in two full stops.
test("C15: the Google reconnect attention text drops the full stop Google's reason already ends with", { skip: skipDb }, async () => {
  const { prisma } = await import("../lib/db");
  const { getOverview } = await import("../lib/dashboard-data");
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const ids: string[] = [];
  try {
    const inf = await prisma.influencer.create({ data: { name: `QA C15 ${run}`, slug: `qac15-${run}`, email: `qac15-${run}@example.com` } });
    ids.push(inf.id);
    await prisma.googleToken.create({
      data: { influencerId: inf.id, refreshTokenEnc: "not-a-real-token", scope: "x", status: "RECONNECT_NEEDED", reconnectReason: "Refresh token rejected: Token has been expired or revoked.", reconnectNeededAt: new Date() },
    });
    const overview = await getOverview(inf.id, true);
    const item = overview.attention.find((a) => a.kind === "google");
    assert.ok(item, "the reconnect item is listed");
    assert.equal(item.detail, "Google stopped accepting the connection: Refresh token rejected: Token has been expired or revoked. Paid bookings are waiting for their Meet links.");
    assert.doesNotMatch(item.detail, /\.\./);
    await prisma.googleToken.update({ where: { influencerId: inf.id }, data: { reconnectReason: null } });
    assert.equal((await getOverview(inf.id, true)).attention.find((a) => a.kind === "google")?.detail, "Google stopped accepting the connection. Paid bookings are waiting for their Meet links.", "no reason: no colon");
  } finally {
    await removeInfluencers(prisma, ids);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// C13: coming back from Google lands on the Google card, not on the top of a long Settings page.
test("C13: outcomeTarget keeps the #fragment of returnTo, and Settings asks to come back to #google", async () => {
  const { outcomeTarget } = await import("../lib/google-connect");
  assert.deepEqual(outcomeTarget("/dashboard/settings#google", "connected"), { pathname: "/dashboard/settings", search: "?google=connected", hash: "#google" });
  assert.deepEqual(outcomeTarget("/onboarding?step=3#x", "denied"), { pathname: "/onboarding", search: "?step=3&google=denied", hash: "#x" });
  assert.deepEqual(outcomeTarget("/dashboard/settings#", "failed"), { pathname: "/dashboard/settings", search: "?google=failed" }, "an empty fragment is dropped");
  assert.deepEqual(outcomeTarget("/dashboard/settings", "connected"), { pathname: "/dashboard/settings", search: "?google=connected" }, "no fragment: the shape the older callers see");
  assert.match(read("web/src/components/views/dashboard/SettingsView.tsx"), /returnTo="\/dashboard\/settings#google"/);
  for (const file of ["app/api/google/callback/route.ts", "app/api/google/connect/route.ts"]) {
    assert.match(read(file), /url\.hash = hash \?\? ""/, `${file} sets the fragment on the redirect`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// C16: the WhatsApp connect form's field errors are plain language.
test("C16: connecting WhatsApp with empty or too-short fields answers with sentences an influencer can act on, not zod's defaults", async () => {
  const { POST } = await import("../app/api/dashboard/whatsapp/route");
  const send = async (body: unknown) => {
    const res = await POST(new Request("http://localhost/api/dashboard/whatsapp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as { details?: { fieldErrors?: Record<string, string[]> } } };
  };
  const manual = await send({ action: "connect-manual", wabaId: "", phoneNumberId: " ", accessToken: "short" });
  assert.equal(manual.status, 400);
  const fe = manual.body.details?.fieldErrors ?? {};
  assert.deepEqual(Object.keys(fe).sort(), ["accessToken", "phoneNumberId", "wabaId"]);
  assert.match(fe.wabaId[0], /^Enter the WhatsApp Business Account ID/);
  assert.match(fe.phoneNumberId[0], /^Enter the Phone number ID/);
  assert.match(fe.accessToken[0], /^Paste the permanent access token/);
  const embedded = await send({ action: "connect-embedded", code: "x", wabaId: "1", phoneNumberId: "2" });
  assert.equal(embedded.status, 400);
  for (const msgs of Object.values({ ...fe, ...(embedded.body.details?.fieldErrors ?? {}) })) {
    for (const m of msgs) assert.doesNotMatch(m, /Too small|expected string|Invalid input/i, m);
  }
  assert.match((embedded.body.details?.fieldErrors ?? {}).code?.[0] ?? "", /did not send a sign-up code/);
  assert.match(fe.wabaId[0] + (await send({ action: "connect-manual", wabaId: "1".repeat(41), phoneNumberId: "12345", accessToken: "t".repeat(20) })).body.details?.fieldErrors?.wabaId?.[0], /too long/);
});

// ---------------------------------------------------------------------------------------------------------------------------
// C18 and C8: "Check template status" with a token Meta no longer accepts, and the not-connected badge.
test("C18: refreshing templates with a rejected saved token marks the connection and says to Reconnect (not 'check it is a permanent token')", { skip: skipDb }, async () => {
  const { prisma } = await import("../lib/db");
  const { encryptSecret } = await import("../lib/crypto");
  const { WhatsAppGraphError } = await import("../lib/whatsapp-connect");
  const { WhatsAppConnectError, refreshTemplates, whatsappTokenAad } = await import("../lib/whatsapp-connection");
  const { setAlertSender } = await import("../lib/alerts");
  const run = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const ids: string[] = [];
  // markTokenInvalid alerts the influencer, and the default alert sender emails them through EMAIL_PROVIDER (with dotenv
  // loading .env that could be a real address book). Nothing leaves the process: a recording no-op sender stands in.
  const alerts: string[] = [];
  const previousSender = setAlertSender(async (_to, alert) => void alerts.push(alert.kind));
  try {
    const inf = await prisma.influencer.create({ data: { name: `QA C18 ${run}`, slug: `qac18-${run}`, email: `qac18-${run}@example.com` } });
    ids.push(inf.id);
    await prisma.whatsAppConnection.create({
      data: { influencerId: inf.id, wabaId: "123456", phoneNumberId: `5${run}`, tokenEnc: encryptSecret("EAAG-a-token-that-decrypts-1234567890", whatsappTokenAad(inf.id)) },
    });
    const deps = { ensureTemplates: async () => { throw new WhatsAppGraphError("Error validating access token: The session has been invalidated.", 400, 190); } } as unknown as Parameters<typeof refreshTemplates>[1];
    await assert.rejects(refreshTemplates(inf.id, deps), (e: unknown) => {
      assert.ok(e instanceof WhatsAppConnectError);
      assert.match(e.message, /Use Reconnect to connect it again\./);
      assert.doesNotMatch(e.message, /permanent token/);
      assert.equal(e.field, undefined, "not a field of the connect form");
      return true;
    });
    const row = await prisma.whatsAppConnection.findUnique({ where: { influencerId: inf.id }, select: { status: true, lastError: true } });
    assert.equal(row?.status, "ERROR", "the card will show Reconnect needed");
    assert.match(row?.lastError ?? "", /session has been invalidated/);
    assert.deepEqual(alerts, ["whatsapp-reconnect-needed"], "the influencer is alerted once, through the recording sender");
  } finally {
    setAlertSender(previousSender);
    await removeInfluencers(prisma, ids);
  }
});

test("C19: the 'Could not submit' notice names templates the way the card does, not by their internal keys", async () => {
  const { templateLabel, TEMPLATE_LABELS, TEMPLATE_SPECS } = await import("../lib/message-templates");
  assert.equal(templateLabel("booking-confirmation"), "Booking confirmation");
  assert.equal(templateLabel("reminder-24h"), "Reminder, 24 hours before");
  assert.equal(templateLabel("something-new"), "something-new", "an unknown key is shown as it is rather than hidden");
  for (const key of Object.keys(TEMPLATE_SPECS)) assert.ok(TEMPLATE_LABELS[key], `every template key has a label (${key})`);
  const src = read("lib/whatsapp-connection.ts");
  assert.equal(count(src, "Could not submit: ${sync.failed.map((f) => templateLabel(f.name)).join"), 2, "both places that build the notice use the labels");
  assert.doesNotMatch(read("web/src/components/app/WhatsAppConnect.tsx"), /const TEMPLATE_LABEL\b/, "one label map, shared");
});

test("C18/C8: the card reloads after a refused refresh, and a number that is not connected is 'Recommended', not 'Required'", () => {
  const src = read("web/src/components/app/WhatsAppConnect.tsx");
  const refresh = src.slice(src.indexOf("async function refresh()"), src.indexOf("// The ways to connect"));
  assert.match(refresh, /if \(!r\.ok\) \{[\s\S]*router\.refresh\(\);[\s\S]*return;[\s\S]*\}/, "a failure also asks the page to reload its data");
  assert.doesNotMatch(src, /Required to message by WhatsApp/);
  assert.match(src, /Not connected \{required \? <Badge tone="warning">Required<\/Badge> : <Badge>Recommended<\/Badge>\}/, "Recommended unless the go-live checklist requires it (N7)");
});

// ---------------------------------------------------------------------------------------------------------------------------
// N8: showing a toast must not re-render every component that can show one.
test("N8: useToast reads a context whose value never changes; only the viewports read the list that does", () => {
  const src = read("web/src/components/ui/overlays.tsx");
  assert.match(src, /const ToastPushContext = createContext<PushToast>\(/);
  assert.match(src, /const ToastListContext = createContext<ToastList>\(/);
  assert.match(src, /<ToastPushContext\.Provider value=\{push\}>/, "the value is the useCallback([]) function itself, not an object holding the list");
  assert.match(src, /const push = useCallback<PushToast>\([\s\S]*?\}, \[\]\);/, "and that callback has no dependencies");
  assert.match(src, /export function useToast\(\): PushToast \{\s*return useContext\(ToastPushContext\);\s*\}/);
  assert.equal(count(src, "useContext(ToastListContext)"), 1, "ToastViewport is the only reader of the list");

  // Behaviour that did not change: a consumer gets a function, a provider renders its (empty) stack, and outside a provider the call is a harmless no-op.
  let seen: unknown;
  const Consumer = () => ((seen = useToast()), null);
  const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(Consumer)));
  assert.equal(typeof seen, "function");
  assert.equal(count(html, 'class="toasts"'), 1);
  renderToStaticMarkup(createElement(Consumer));
  assert.doesNotThrow(() => (seen as (m: string) => void)("outside a provider"));
});

// ---------------------------------------------------------------------------------------------------------------------------
// C17 (N10): a rejected WhatsApp template shows a sentence, not Meta's reason code.
test("C17: Meta's documented rejection reasons become plain sentences with what happens next; our own sentences and other statuses are left alone", async () => {
  const { templateReasonText, TEMPLATE_REJECTION_REASONS, TEMPLATE_REJECTION_NEXT_STEP } = await import("../lib/message-templates");
  const documented = ["ABUSIVE_CONTENT", "INCORRECT_CATEGORY", "INVALID_FORMAT", "PROMOTIONAL", "SCAM", "TAG_CONTENT_MISMATCH"];
  assert.deepEqual(Object.keys(TEMPLATE_REJECTION_REASONS).sort(), documented, "every documented reason has a sentence");
  for (const code of documented) {
    const text = templateReasonText("REJECTED", code);
    assert.equal(text, `${TEMPLATE_REJECTION_REASONS[code]} ${TEMPLATE_REJECTION_NEXT_STEP}`);
    assert.doesNotMatch(text ?? "", new RegExp(code), `${code} is not shown raw`);
    assert.doesNotMatch(TEMPLATE_REJECTION_REASONS[code], /_/);
  }
  assert.match(TEMPLATE_REJECTION_NEXT_STEP, /contact support/);
  assert.match(TEMPLATE_REJECTION_NEXT_STEP, /SMS/, "and the customer is not left without the message meanwhile");

  // NONE, nothing, or a code we have never seen.
  for (const none of ["NONE", "", null, undefined, "  "]) {
    assert.match(templateReasonText("REJECTED", none) ?? "", /^Meta did not say why it rejected this message\. /);
    assert.equal(templateReasonText("PAUSED", none), null, "no reason and not a rejection: nothing to add");
    assert.equal(templateReasonText("APPROVED", none), null);
  }
  assert.equal(templateReasonText("REJECTED", "BRAND_NEW_REASON"), `Meta gave this reason: brand new reason. ${TEMPLATE_REJECTION_NEXT_STEP}`);
  assert.equal(templateReasonText("PAUSED", "BRAND_NEW_REASON"), "Meta gave this reason: brand new reason.", "no 'cannot change it' line for a status that is not a rejection");

  // Already a sentence (our name-conflict text, or free text from Meta): shown as it is.
  const ours = 'A template named "x" already exists on your WhatsApp account and is not ours: body differs. Rename or delete it.';
  assert.equal(templateReasonText("CONFLICT", ours), ours);

  // The card uses it for every row.
  assert.match(read("web/src/components/app/WhatsAppConnect.tsx"), /const why = templateReasonText\(t\.status, t\.reason\);[\s\S]*\{why && <div className="subtle">\{why\}<\/div>\}/);
  assert.doesNotMatch(read("web/src/components/app/WhatsAppConnect.tsx"), /\{t\.reason && /, "the raw reason is no longer printed");
});

test("C17: the card prints the sentence under a rejected template", async () => {
  mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/dashboard/settings") });
  try {
    const { WhatsAppConnect } = await import(`../web/src/components/app/WhatsAppConnect?c17=${Math.random()}`);
    const connection = {
      displayPhone: "+91 98765 43210",
      verifiedName: "Pat",
      source: "manual",
      status: "ACTIVE",
      lastError: null,
      ready: false,
      templates: [
        { name: "booking-confirmation", status: "REJECTED", reason: "INVALID_FORMAT" },
        { name: "reminder-24h", status: "APPROVED", reason: null },
      ],
    };
    const html = renderToStaticMarkup(createElement(WhatsAppConnect, { connection, embedded: null }));
    assert.match(html, /Booking confirmation<div class="subtle">Meta did not accept the layout of the message/);
    assert.doesNotMatch(html, /INVALID_FORMAT/);
    assert.doesNotMatch(html, /Reminder, 24 hours before<div class="subtle">/, "an approved template has no line");
  } finally {
    mock.reset();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// C7 (N10): a failed background refetch is no longer silent.
test("C7: a page that still shows data after a failed refetch says so, offers Retry and never unmounts; nothing else changes", async () => {
  const { refreshNotice, REFRESH_FAILED_TEXT, REFRESH_RETRYING_TEXT } = await import("../web/src/lib/refresh-notice");
  const q = (over: Partial<{ data: unknown; isError: boolean; isFetching: boolean }>) => ({ data: { a: 1 }, isError: false, isFetching: false, ...over });
  assert.equal(refreshNotice(q({})), "none", "a healthy page says nothing");
  assert.equal(refreshNotice(q({ isFetching: true })), "none", "a background refetch that has not failed says nothing");
  assert.equal(refreshNotice(q({ isError: true })), "failed", "data on screen, the last refetch failed");
  assert.equal(refreshNotice(q({ isError: true, isFetching: true })), "retrying", "Retry was pressed");
  assert.equal(refreshNotice(q({ data: undefined, isError: true })), "none", "no data: the existing error alert handles it, not this");
  assert.equal(refreshNotice(q({ data: undefined })), "none");
  assert.equal(refreshNotice(q({ data: null, isError: true })), "failed", "null is data (a view may legitimately be null)");
  assert.equal(refreshNotice(q({ isError: true }), { framed: true }), "none", "a public customer page does not show it");
  assert.match(REFRESH_FAILED_TEXT, /^Couldn't refresh\./);
  assert.match(REFRESH_RETRYING_TEXT, /Refreshing/);

  // The real query library, not a stand-in: after data, a failing refetch keeps the data and sets isError; Retry flips isFetching.
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  let failing = false;
  const observer = new QueryObserver(client, { queryKey: ["c7"], queryFn: async () => { if (failing) throw new Error("boom"); return { v: 1 }; } });
  const stop = observer.subscribe(() => {});
  try {
    await observer.refetch();
    assert.equal(refreshNotice(observer.getCurrentResult()), "none");
    failing = true;
    await observer.refetch();
    const after = observer.getCurrentResult();
    assert.deepEqual(after.data, { v: 1 }, "the page keeps its data");
    assert.equal(refreshNotice(after), "failed");
    failing = false;
    const again = observer.refetch();
    assert.equal(refreshNotice(observer.getCurrentResult()), "retrying");
    await again;
    assert.equal(refreshNotice(observer.getCurrentResult()), "none", "and the notice goes away once a refetch works");
  } finally {
    stop();
    client.clear();
  }

  // The bar: a polite status with a Retry button, or nothing at all. (web/ files are compiled with the classic JSX transform here.)
  (globalThis as { React?: unknown }).React = ReactNs;
  const { RefreshNoticeBar } = await import("../web/src/lib/states");
  const bar = (state: "none" | "failed" | "retrying") => renderToStaticMarkup(createElement(RefreshNoticeBar, { state, onRetry: () => {} }));
  assert.equal(bar("none"), "");
  const failed = bar("failed");
  assert.match(failed, /role="status"/);
  assert.match(failed, /Couldn&#x27;t refresh\. What you see may be out of date\./);
  assert.match(failed, /<button[^>]*>Retry<\/button>/);
  assert.doesNotMatch(failed, /disabled/);
  const retrying = bar("retrying");
  assert.match(retrying, /Refreshing…/);
  assert.match(retrying, /<button[^>]*disabled=""[^>]*aria-busy="true"|<button[^>]*aria-busy="true"[^>]*disabled=""/, "the same button, busy, so focus is not dropped");

  // Wiring: the notice sits in a fixed slot above the page, and the existing rules around it are untouched.
  const states = read("web/src/lib/states.tsx");
  assert.match(states, /<RefreshNoticeBar state=\{refreshNotice\(query, \{ framed \}\)\} onRetry=\{\(\) => void query\.refetch\(\)\} \/>\s*\{children\(query\.data\)\}/);
  assert.match(states, /if \(query\.isPending\) return <>\{frame\(loading \?\? <PageLoading \/>\)\}<\/>;/, "the skeleton rule is unchanged");
  assert.match(states, /if \(error\?\.status === 404\) return <NotFoundView embedded=\{embedded\} \/>;/, "the 404 rule is unchanged");
  assert.doesNotMatch(read("web/src/lib/guard-decisions.ts"), /refresh-notice|RefreshNotice/, "the guard decisions know nothing about it");
});

// ---------------------------------------------------------------------------------------------------------------------------
// N7: the WhatsApp card says what the go-live checklist says (READINESS_REQUIRED can include whatsapp).
test("N7: the not-connected WhatsApp card says Required when the checklist requires it, Recommended otherwise", async () => {
  mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/dashboard/settings") });
  const { WhatsAppConnect } = await import(`../web/src/components/app/WhatsAppConnect?n7=${Math.random()}`);
  const card = (required?: boolean) => renderToStaticMarkup(createElement(WhatsAppConnect, { connection: null, embedded: null, ...(required === undefined ? {} : { required }) }));
  const optional = card();
  assert.match(optional, /Not connected <span class="pill">Recommended<\/span>/);
  assert.match(optional, /Without it, they are sent by SMS\./);
  assert.match(card(false), /Recommended/);
  const mandatory = card(true);
  assert.match(mandatory, /Not connected <span class="pill pill--warning">Required<\/span>/);
  assert.doesNotMatch(mandatory, /Recommended|sent by SMS/);
  assert.match(mandatory, /Your booking page cannot go live until it is connected\./);

  // The flag comes from the same rule as the checklist and the public filter, and reaches the card on both screens.
  const { requiredConnections } = await import("../lib/readiness");
  assert.equal(requiredConnections({ NODE_ENV: "test", READINESS_REQUIRED: "google,whatsapp,payout" }).includes("whatsapp"), true);
  assert.equal(requiredConnections({ NODE_ENV: "test" }).includes("whatsapp"), false, "not required by default");
  assert.match(read("lib/views/dashboard-settings.ts"), /whatsappRequired: requiredConnections\(\)\.includes\("whatsapp"\)/);
  assert.match(read("web/src/components/views/dashboard/SettingsView.tsx"), /required=\{data\.whatsappRequired\}/);
  const wizard = read("web/src/components/app/OnboardingWizard.tsx");
  assert.match(wizard, /const whatsappRequired = d\.checklist\.some\(\(c\) => c\.key === "whatsapp" && c\.required\);/);
  assert.match(wizard, /<WhatsAppConnect connection=\{d\.whatsapp\} embedded=\{d\.embedded\} required=\{whatsappRequired\} \/>/);
  mock.reset();
});
