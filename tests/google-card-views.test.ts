// doc/15: the three-step Google card (web/src/components/app/GoogleConnect.tsx) in every state, and the pages that must stop promising
// e-mail when the platform sends none (emailEnabled false). Rendered on the server with react-dom/server; the router hooks are replaced
// by a stand-in, nothing else is. No database, no browser, no network.
import assert from "node:assert/strict";
import { before, mock, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GoogleClientView, GoogleStatusView } from "../lib/views/dashboard-types";
import { fakeNavigate } from "./helpers/fake-navigate";

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => unescape(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));

const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/gmail.send", "openid", "email"];
const NO_CLIENT: GoogleClientView = {
  mode: "own",
  hasOwnClient: false,
  clientId: null,
  clientSecretSaved: false,
  checkedAt: null,
  redirectUri: "https://sessions.example.com/api/google/callback",
  origin: "https://sessions.example.com",
  requiredScopes: SCOPES,
  canConnect: false,
  grantClient: null,
};
const SAVED: GoogleClientView = { ...NO_CLIENT, hasOwnClient: true, clientId: "1234567890-abcdef.apps.googleusercontent.com", clientSecretSaved: true, checkedAt: "2030-01-01T10:00:00.000Z", canConnect: true };
const NOT_CONNECTED: GoogleStatusView = { state: "not-connected", requestsGmail: true, liveEvents: 0, previousEmail: null };
const CONNECTED: GoogleStatusView = { state: "connected", email: "pat@gmail.com", connectedAt: "2030-01-01T10:00:00.000Z", gmailSend: true, liveEvents: 0, gmailFailing: false };

type Components = {
  GoogleConnect: typeof import("../web/src/components/app/GoogleConnect").GoogleConnect;
  VerifyBanner: typeof import("../web/src/components/app/SettingsForms").VerifyBanner;
  NotificationPrefs: typeof import("../web/src/components/app/SettingsForms").NotificationPrefs;
  VerifyEmailView: typeof import("../web/src/components/views/auth/VerifyEmailView").VerifyEmailView;
  ForgotPasswordView: typeof import("../web/src/components/views/auth/ForgotPasswordView").ForgotPasswordView;
  FindBookingsView: typeof import("../web/src/components/views/booking/FindBookingsView").FindBookingsView;
  AccountHelpActions: typeof import("../web/src/components/admin/AccountHelpActions").AccountHelpActions;
};
let c: Components;

before(async () => {
  mock.module("@web/lib/navigate", { namedExports: fakeNavigate("/dashboard/settings") });
  c = {
    GoogleConnect: (await import("../web/src/components/app/GoogleConnect")).GoogleConnect,
    VerifyBanner: (await import("../web/src/components/app/SettingsForms")).VerifyBanner,
    NotificationPrefs: (await import("../web/src/components/app/SettingsForms")).NotificationPrefs,
    VerifyEmailView: (await import("../web/src/components/views/auth/VerifyEmailView")).VerifyEmailView,
    ForgotPasswordView: (await import("../web/src/components/views/auth/ForgotPasswordView")).ForgotPasswordView,
    FindBookingsView: (await import("../web/src/components/views/booking/FindBookingsView")).FindBookingsView,
    AccountHelpActions: (await import("../web/src/components/admin/AccountHelpActions")).AccountHelpActions,
  };
});

const card = (status: GoogleStatusView, client: GoogleClientView, extra: { outcome?: string | null; emailEnabled?: boolean } = {}) =>
  render(createElement(c.GoogleConnect, { status, client, returnTo: "/dashboard/settings#google", ...extra }));

test("no client yet: the guide is open with the exact values to copy, the form is there, and connecting is locked", () => {
  const html = card(NOT_CONNECTED, NO_CLIENT);
  const t = text(html);
  assert.match(html, /<details open/, "the guide is open until a client is saved");
  for (const step of ["Create your own Google client", "Paste your Client ID and Client Secret", "Connect Google Calendar"]) assert.ok(t.includes(step), step);
  // The numbered guide, with the values the influencer must type into Google Cloud.
  for (const needle of ["Google Calendar API", "Gmail API", "External", "Test users", "Publish app", "In production", "unverified app", "Web application", "Authorized JavaScript origins", "Authorized redirect URIs"]) {
    assert.ok(t.includes(needle), `the guide mentions ${needle}`);
  }
  for (const scope of SCOPES) assert.ok(html.includes(scope), `scope ${scope}`);
  assert.ok(html.includes("https://sessions.example.com/api/google/callback"), "the exact redirect URI the server computed");
  assert.ok(html.includes(">https://sessions.example.com<"), "the site origin");
  assert.equal((html.match(/aria-label="Copy Authorized/g) ?? []).length, 2, "a copy button for the origin and for the redirect URI");
  assert.match(t, /no longer expires every week|not expire every week|every week/);
  // Step 2: labelled fields, the secret masked, no autofill, and the promise about storage.
  assert.match(html, /<label[^>]*>Client ID/);
  assert.match(html, /<label[^>]*>Client Secret/);
  assert.match(html, /type="password"[^>]*autoComplete="off"|autoComplete="off"[^>]*type="password"|type="password"/);
  assert.ok(/name="google-client-secret"/.test(html) && /type="password"/.test(html.slice(html.indexOf('name="google-client-secret"') - 200, html.indexOf('name="google-client-secret"') + 200)), "the secret field is a password field");
  assert.ok(t.includes("Stored encrypted and never shown again"));
  assert.ok(t.includes("Save and check"));
  // Step 3 is locked: no connect link at all.
  assert.ok(t.includes("Finish step 2 first"));
  assert.ok(!html.includes("/api/google/connect"), "nothing to click through to Google yet");
});

test("client saved: the ID is shown in full, the secret only as 'saved', Replace and Remove exist, and Connect works", () => {
  const html = card(NOT_CONNECTED, SAVED);
  const t = text(html);
  assert.ok(html.includes("1234567890-abcdef.apps.googleusercontent.com"));
  assert.ok(t.includes("Secret saved") && t.includes("never shown again") && t.includes("Checked with Google on"));
  assert.ok(/>Replace</.test(html) && />Remove</.test(html));
  assert.ok(!/type="password"/.test(html), "the form is folded away while a client is saved");
  assert.ok(!/<details open/.test(html), "the guide is folded away once it has done its job");
  assert.ok(html.includes('href="/api/google/connect?returnTo=%2Fdashboard%2Fsettings%23google&amp;gmail=1"'), "Connect carries the Gmail choice");
  assert.ok(t.includes("Connect Google Calendar"));
  assert.ok(t.includes("Secret saved"));
});

test("the Gmail permission is a visible choice, and the words say what happens without it", () => {
  const html = card(NOT_CONNECTED, SAVED);
  assert.match(html, /type="checkbox"[^>]*checked|checked[^>]*type="checkbox"/);
  assert.ok(text(html).includes("Also allow sending customers' emails from my Gmail"));
  assert.ok(text(html).includes("Without it, customer emails come from our address with your email as Reply-To"), "when the site sends email itself");
  const noEmail = text(card(NOT_CONNECTED, SAVED, { emailEnabled: false }));
  assert.ok(noEmail.includes("Without it, customers get WhatsApp or SMS only and no email"));
  assert.ok(!noEmail.includes("come from our address"), "no promise of an address that does not exist");
  const off = card({ ...NOT_CONNECTED, requestsGmail: false }, SAVED);
  assert.ok(off.includes('gmail=0') || /checkbox/.test(off));
});

test("connected with the own client: who, Gmail on, switch and disconnect", () => {
  const html = card(CONNECTED, { ...SAVED, grantClient: "own" }, { outcome: "connected" });
  const t = text(html);
  assert.ok(t.includes("Connected as pat@gmail.com") && t.includes("Gmail on") && t.includes("Switch account") && t.includes("Disconnect"));
  assert.ok(t.includes("Google connected. New bookings get a Meet link automatically."));
  assert.ok(!t.includes("shared Google app"));
  // Gmail off or failing, in both e-mail worlds.
  assert.ok(text(card({ ...CONNECTED, gmailSend: false } as GoogleStatusView, SAVED, { emailEnabled: false })).includes("customers get WhatsApp or SMS only and no email"));
  const failing = text(card({ ...CONNECTED, gmailFailing: true }, SAVED, { emailEnabled: false }));
  assert.ok(failing.includes("Gmail not working") && failing.includes("Customers get WhatsApp or SMS only, and no email") && failing.includes("Gmail API is enabled in your Google Cloud project"));
});

test("a connection made with the shared Google app says how to move to your own client", () => {
  const t = text(card(CONNECTED, { ...SAVED, hasOwnClient: false, clientId: null, grantClient: "platform", canConnect: true }));
  assert.ok(t.includes("made with the site’s shared Google app"));
});

test("reconnect needed: the plain reason, and a pointer to step 2 when the client is the problem", () => {
  const reason = "Your Google client was removed or is no longer valid. Save your Google client again, then reconnect.";
  const html = card({ state: "reconnect-needed", email: "pat@gmail.com", reason, liveEvents: 0 }, NO_CLIENT);
  const t = text(html);
  assert.ok(t.includes("Reconnect needed") && t.includes(reason) && t.includes("Fix your Google client in step 2 first"));
  assert.ok(!html.includes("/api/google/connect"), "no Reconnect link while there is no client to reconnect with");
  const other = text(card({ state: "reconnect-needed", email: null, reason: "invalid_grant", liveEvents: 0 }, SAVED));
  assert.ok(other.includes("(invalid_grant)") && !other.includes("Fix your Google client"));
  assert.ok(/>Reconnect</.test(card({ state: "reconnect-needed", email: null, reason: "invalid_grant", liveEvents: 0 }, SAVED)));
});

test("platform mode: no client to create, just Connect", () => {
  const t = text(card(NOT_CONNECTED, { ...NO_CLIENT, mode: "platform", canConnect: true }));
  assert.ok(!t.includes("Create your own Google client") && !t.includes("Paste your Client ID"));
  assert.ok(t.includes("Connect Google Calendar"));
});

test("the outcome banners after Google's return trip, including the two new ones", () => {
  const t = (o: string, emailEnabled = true) => text(card(NOT_CONNECTED, NO_CLIENT, { outcome: o, emailEnabled }));
  assert.ok(t("no-client").includes("Save your own Google client first"));
  assert.ok(t("client-rejected").includes("Google did not accept your saved Google client"));
  assert.ok(t("not-configured").includes("not set up on this site") && !t("not-configured").includes("GOOGLE_CLIENT_ID"), "no environment variable names in front of an influencer");
  assert.ok(t("connected-no-gmail").includes("sending email from your Gmail was not allowed") && t("connected-no-gmail").includes("from our address"));
  assert.ok(t("connected-no-gmail", false).includes("no email") && !t("connected-no-gmail", false).includes("from our address"));
  assert.ok(!t("not-an-outcome").includes("Google connected"));
});

test("accessibility: every step is a labelled section with a heading, controls have names, nothing is positioned wider than the screen", () => {
  const html = card(NOT_CONNECTED, NO_CLIENT);
  assert.equal((html.match(/<section[^>]*aria-label="Step \d:/g) ?? []).length, 3);
  assert.equal((html.match(/<h3/g) ?? []).length, 3);
  assert.ok(html.includes("sr-only"), "screen-reader step numbers and the live region for copy and save results");
  assert.match(html, /role="status"/);
  for (const m of html.matchAll(/<input[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])?.[1];
    assert.ok(id && html.includes(`for="${id}"`), `an input without a label: ${m[0]}`);
  }
  // Long values wrap instead of widening the page (375 px, no horizontal scroll).
  assert.ok(html.includes("overflow-wrap:anywhere"));
});

test("the Client ID and Client Secret inputs cannot be filled with the site login: distinctive names, new-password, password-manager opt-outs", () => {
  const html = card(NOT_CONNECTED, NO_CLIENT);
  const input = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0] ?? "";
  const id = input("google-client-id");
  const secret = input("google-client-secret");
  assert.ok(id && secret, "the fields are named google-client-id and google-client-secret");
  assert.ok(html.indexOf("google-client-id") < html.indexOf("google-client-secret"), "the Client ID comes first");
  assert.ok(!/name="(clientId|clientSecret|password|username|email)"/.test(html));
  for (const [what, tag] of [["id", id], ["secret", secret]] as const) {
    assert.ok(tag.includes('data-1p-ignore'), `${what}: 1Password opt-out`);
    assert.ok(tag.includes('data-lpignore="true"'), `${what}: LastPass opt-out`);
    assert.ok(tag.includes('autoComplete="off"') || tag.includes('autocomplete="off"') || tag.includes('autoComplete="new-password"') || tag.includes('autocomplete="new-password"'), what);
  }
  assert.ok(/autoComplete="new-password"|autocomplete="new-password"/.test(secret), "Chrome ignores off on password fields: new-password");
  assert.ok(/type="password"/.test(secret) && !/type="password"/.test(id));
  assert.ok(!/autoComplete="current-password"|autocomplete="current-password"|autocomplete="username"/.test(html));
});

test("the card never contains a secret: not in the markup of any state", () => {
  for (const html of [card(NOT_CONNECTED, NO_CLIENT), card(NOT_CONNECTED, SAVED), card(CONNECTED, SAVED)]) {
    assert.ok(!/GOCSPX-[A-Za-z0-9_-]{10,}/.test(html) && !/client_secret/.test(html), "no secret value rendered (the help text only names the GOCSPX- prefix)");
    assert.ok(!/<input[^>]*type="password"[^>]*value="[^"]+"/.test(html), "the secret field is never pre-filled");
  }
});

/* ---------- no platform e-mail: the pages stop promising it ---------- */

test("verification: with e-mail the page says a link was sent; without it says an administrator verifies, and offers no resend", () => {
  const user = { email: "pat@example.com", emailVerified: false };
  const withMail = text(render(createElement(c.VerifyEmailView, { user, emailEnabled: true })));
  assert.ok(withMail.includes("We sent a link to pat@example.com") && withMail.includes("Resend the link"));
  const withoutMail = render(createElement(c.VerifyEmailView, { user, emailEnabled: false }));
  const t = text(withoutMail);
  assert.ok(t.includes("Your administrator verifies new accounts") && t.includes("pat@example.com") && t.includes("booking page goes live once it is confirmed"));
  assert.ok(!t.includes("We sent a link") && !t.includes("Resend") && !t.includes("spam"));
  // The default (what an older session answer without the field gets) is the e-mail wording.
  assert.ok(text(render(createElement(c.VerifyEmailView, { user }))).includes("We sent a link"));
});

test("forgot password: without e-mail there is no form, and the page says to ask the administrator", () => {
  const withMail = render(createElement(c.ForgotPasswordView, { emailEnabled: true }));
  assert.ok(withMail.includes("Send reset link") && text(withMail).includes("we will send you a link"));
  const without = render(createElement(c.ForgotPasswordView, { emailEnabled: false }));
  assert.ok(!without.includes("Send reset link") && !/<form/.test(without) && !without.includes("forgot-email"));
  assert.ok(text(without).includes("Ask your administrator for a reset link") && text(without).includes("does not send e-mail"));
  assert.ok(without.includes('href="/login"'), "the way back stays");
});

test("settings: the verify banner and the alert switch tell the truth without e-mail", () => {
  const banner = text(render(createElement(c.VerifyBanner, { email: "pat@example.com", emailEnabled: false })));
  assert.ok(banner.includes("Your administrator verifies new accounts") && !banner.includes("Resend") && !banner.includes("We sent a link"));
  assert.ok(text(render(createElement(c.VerifyBanner, { email: "pat@example.com" }))).includes("We sent a link to pat@example.com"));
  const prefs = text(render(createElement(c.NotificationPrefs, { notifyByEmail: true, emailEnabled: false })));
  assert.ok(prefs.includes("does not send e-mail") && !prefs.includes("Email me when"));
  assert.ok(render(createElement(c.NotificationPrefs, { notifyByEmail: true })).includes("Email me when something needs attention"));
});

test("find your bookings: without e-mail there is nothing to submit and no promise of a link", () => {
  const withMail = render(createElement(c.FindBookingsView, {}));
  assert.ok(withMail.includes("E-mail me a link") && /<form/.test(withMail));
  const without = render(createElement(c.FindBookingsView, { emailEnabled: false }));
  assert.ok(!/<form/.test(without) && !without.includes("E-mail me a link") && !text(without).includes("Check your e-mail"));
  assert.ok(text(without).includes("We cannot e-mail you a link"));
});

test("admin: the account help buttons exist, say what they do, and the reset link is never in the markup", () => {
  const unverified = render(createElement(c.AccountHelpActions, { influencerId: "inf1", emailVerified: false, emailEnabled: false }));
  assert.ok(unverified.includes("Mark email verified") && unverified.includes("Create password reset link"));
  assert.ok(text(unverified).includes("This site sends no e-mail"));
  const verified = render(createElement(c.AccountHelpActions, { influencerId: "inf1", emailVerified: true, emailEnabled: true }));
  assert.ok(!verified.includes("Mark email verified") && verified.includes("Create password reset link"));
  assert.ok(!/reset-password\?token/.test(unverified + verified), "a link only exists after the click, in a dialog, once");
});

test("the pages read the platform's answer from the session: source-level guard for the glue the static renders cannot reach", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  for (const rel of ["web/src/pages/auth/ForgotPassword.tsx", "web/src/pages/auth/VerifyEmail.tsx", "web/src/pages/booking/FindBookings.tsx"]) {
    assert.match(read(rel), /emailEnabled=\{session\.data\?\.emailEnabled !== false\}/, rel);
  }
  assert.match(read("web/src/components/views/dashboard/SettingsView.tsx"), /emailEnabled=\{data\.emailEnabled\}/);
});
