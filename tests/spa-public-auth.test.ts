// The public and auth pages are view components (web/src/components/views) that the SPA pages render. These tests render the
// views (no browser, no database) and check the wiring: every page renders its view, one copy of every text, titles that match
// the route table, nothing server-side in the browser graph.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { repoPathProblem, specifierProblem } from "../web/vite-server-guard";
import { ForgotPasswordView } from "../web/src/components/views/auth/ForgotPasswordView";
import { LoginView } from "../web/src/components/views/auth/LoginView";
import { RegisterView } from "../web/src/components/views/auth/RegisterView";
import { ResetPasswordView } from "../web/src/components/views/auth/ResetPasswordView";
import { VerifyEmailView } from "../web/src/components/views/auth/VerifyEmailView";
import { ContactView } from "../web/src/components/views/public/ContactView";
import { LandingView } from "../web/src/components/views/public/LandingView";
import { PrivacyView } from "../web/src/components/views/public/PrivacyView";
import { RefundPolicyView } from "../web/src/components/views/public/RefundPolicyView";
import { TermsView } from "../web/src/components/views/public/TermsView";
import { BRAND_NAME, SUPPORT_EMAIL } from "../lib/brand";
import { spaRouteById, type SpaRouteId } from "../lib/spa/routes";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/** One row per page: route id, the SPA page, the view it renders. */
const PAGES: { id: SpaRouteId; spa: string; view: string }[] = [
  { id: "landing", spa: "web/src/pages/public/Landing.tsx", view: "public/LandingView" },
  { id: "terms", spa: "web/src/pages/public/Terms.tsx", view: "public/TermsView" },
  { id: "privacy", spa: "web/src/pages/public/Privacy.tsx", view: "public/PrivacyView" },
  { id: "refund-policy", spa: "web/src/pages/public/RefundPolicy.tsx", view: "public/RefundPolicyView" },
  { id: "contact", spa: "web/src/pages/public/Contact.tsx", view: "public/ContactView" },
  { id: "login", spa: "web/src/pages/auth/Login.tsx", view: "auth/LoginView" },
  { id: "register", spa: "web/src/pages/auth/Register.tsx", view: "auth/RegisterView" },
  { id: "forgot-password", spa: "web/src/pages/auth/ForgotPassword.tsx", view: "auth/ForgotPasswordView" },
  { id: "reset-password", spa: "web/src/pages/auth/ResetPassword.tsx", view: "auth/ResetPasswordView" },
  { id: "verify-email", spa: "web/src/pages/auth/VerifyEmail.tsx", view: "auth/VerifyEmailView" },
];

const viewFiles = (dir: "public" | "auth") =>
  readdirSync(path.join(root, "web/src/components/views", dir))
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => `web/src/components/views/${dir}/${f}`);

test("every SPA page renders its view and nothing else: no chrome or forms of its own", () => {
  for (const p of PAGES) {
    const viewImport = `@web/components/views/${p.view}`;
    assert.ok(read(p.spa).includes(`"${viewImport}"`), `${p.spa} must render ${p.view}`);
    assert.ok(!/from "@web\/components\/(site|auth)\//.test(read(p.spa)), `${p.spa} still renders chrome itself`);
  }
});

test("every SPA page sets its title with the same text and template as the route table (so the title never flickers)", () => {
  for (const p of PAGES) {
    const route = spaRouteById(p.id);
    assert.ok("title" in route && route.title, `${p.id} has a title in the route table`);
    const m = /<PageTitle title="([^"]+)"(?: template="(\w+)")?/.exec(read(p.spa));
    assert.ok(m, `${p.spa} renders a <PageTitle> with literal props`);
    assert.equal(m[1], route.title, `${p.id}: title`);
    assert.equal(m[2] ?? "brand", route.template, `${p.id}: template`);
    assert.equal(count(read(p.spa), "<PageTitle"), 1, `${p.spa}: exactly one PageTitle`);
  }
  assert.match(read("web/src/pages/public/Design.tsx"), /<PageTitle title="Design system" \/>/);
  assert.equal(spaRouteById("design").template, "brand");
});

test("legal and contact texts exist once: only in the views, never in a page file", () => {
  const sentinels: [string, string][] = [
    ["These terms govern the use of", "web/src/components/views/public/TermsView.tsx"],
    ["This policy explains what personal data", "web/src/components/views/public/PrivacyView.tsx"],
    ["Every service shows its cancellation policy", "web/src/components/views/public/RefundPolicyView.tsx"],
    ["For a question about a booking, include your booking reference", "web/src/components/views/public/ContactView.tsx"],
    ["Get paid for your time. The Meet link sends itself.", "web/src/components/views/public/LandingView.tsx"],
  ];
  const everyFile = PAGES.map((p) => p.spa);
  for (const [text, owner] of sentinels) {
    assert.equal(count(read(owner), text), 1, `${owner} holds the text once`);
    for (const f of everyFile) assert.equal(count(read(f), text), 0, `${f} must not copy "${text}"`);
  }
});

test("views import nothing server-side: only allowlisted lib modules, no Next.js at all (what the Vite guard demands)", () => {
  for (const file of [...viewFiles("public"), ...viewFiles("auth"), "web/src/pages/public/Design.tsx", ...PAGES.map((p) => p.spa)]) {
    const src = read(file);
    for (const m of src.matchAll(/^import[^"']*from\s+["']([^"']+)["']/gm)) {
      const spec = m[1];
      assert.equal(specifierProblem(spec), null, `${file}: ${spec}`);
      // "@/..." is the repository root, "@web/..." is web/src.
      const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith("@web/") ? `web/src/${spec.slice(5)}` : null;
      if (base) {
        const target = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((rel) => existsSync(path.join(root, rel)) && statSync(path.join(root, rel)).isFile());
        assert.ok(target, `${file}: ${spec} resolves to a file`);
        assert.equal(repoPathProblem(target), null, `${file}: ${spec}`);
      }
    }
  }
});

test("LandingView: the header shows the signed-in button only when told; one main landmark, one h1", () => {
  const out = render(createElement(LandingView, { loggedIn: false }));
  assert.match(out, /<a [^>]*href="\/login"[^>]*>Log in<\/a>/);
  assert.match(out, /Get started/);
  assert.ok(!out.includes("Open dashboard"));
  const signedIn = render(createElement(LandingView, { loggedIn: true }));
  assert.match(signedIn, /<a [^>]*href="\/dashboard"[^>]*>Open dashboard<\/a>/);
  const header = signedIn.slice(0, signedIn.indexOf("<main"));
  assert.ok(!header.includes(">Get started<") && !header.includes(">Log in<"), "no sign-up or login button in the signed-in header");
  for (const html of [out, signedIn]) {
    assert.equal(count(html, '<main id="main"'), 1);
    assert.equal(count(html, "<h1"), 1);
    assert.ok(html.includes('id="how-it-works"') && html.includes('id="features"') && html.includes('id="faq"'), "the header's #anchors have targets");
    assert.ok(!html.includes("application/ld+json"), "the JSON-LD belongs to the shell head, not the view");
  }
});

test("legal pages: draft banner, one h1 with the page title, the brand and the support address from lib/brand", () => {
  const cases: [string, Parameters<typeof renderToStaticMarkup>[0], string][] = [
    ["Terms of Service", createElement(TermsView), BRAND_NAME],
    ["Privacy Policy", createElement(PrivacyView), BRAND_NAME],
    ["Refund and Cancellation Policy", createElement(RefundPolicyView), SUPPORT_EMAIL],
  ];
  for (const [title, el, mustContain] of cases) {
    const html = render(el);
    assert.equal(count(html, '<main id="main"'), 1, title);
    assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`), title);
    assert.ok(html.includes("Draft for review"), `${title}: draft banner`);
    assert.ok(html.includes("Last updated"), title);
    assert.ok(html.includes(mustContain), `${title}: ${mustContain}`);
    assert.ok(html.includes(`mailto:${SUPPORT_EMAIL}`), `${title}: support mailto`);
  }
  const contact = render(createElement(ContactView));
  assert.match(contact, /<h1[^>]*>Contact us<\/h1>/);
  assert.ok(contact.includes(`mailto:${SUPPORT_EMAIL}`));
});

test("auth views: LoginView shows the notice only for a non-empty ?reset, every screen is one focused frame with one h1", () => {
  const plain = render(createElement(LoginView, {}));
  assert.ok(!plain.includes("Your password was changed"));
  assert.ok(!render(createElement(LoginView, { reset: "" })).includes("Your password was changed"), "a bare ?reset= has no notice, as before");
  assert.ok(render(createElement(LoginView, { reset: "1", next: "/dashboard/sessions" })).includes("Your password was changed. Please log in."));
  const screens = [plain, render(createElement(RegisterView)), render(createElement(ForgotPasswordView)), render(createElement(ResetPasswordView, { token: "t" })), render(createElement(VerifyEmailView, { user: null }))];
  for (const html of screens) {
    assert.equal(count(html, '<main id="main" class="focused__main"'), 1);
    assert.equal(count(html, "<h1"), 1);
  }
  assert.ok(plain.includes('href="/register"') && render(createElement(RegisterView)).includes('href="/login"'));
});

test("ResetPasswordView: no token means an incomplete-link alert with a way forward, a token shows the form", () => {
  for (const token of [undefined, ""]) {
    const html = render(createElement(ResetPasswordView, { token }));
    assert.ok(html.includes("This link is incomplete") && html.includes('href="/forgot-password"'));
    assert.ok(!html.includes("Set new password"));
  }
  const withToken = render(createElement(ResetPasswordView, { token: "abc" }));
  assert.ok(withToken.includes("Set new password") && !withToken.includes("This link is incomplete"));
  assert.ok(!withToken.includes("abc"), "the token is never written into the markup");
});

test("VerifyEmailView: token button, resend hint for an unverified signed-in user, login hint otherwise; the address is escaped", () => {
  const withToken = render(createElement(VerifyEmailView, { token: "abc", user: null }));
  assert.ok(withToken.includes("Confirm my email"));
  const hint = render(createElement(VerifyEmailView, { user: { email: "a@example.com", emailVerified: false } }));
  assert.ok(hint.includes("We sent a link to a@example.com") && hint.includes("Resend the link"));
  const verified = render(createElement(VerifyEmailView, { user: { email: "a@example.com", emailVerified: true } }));
  assert.ok(!verified.includes("We sent a link") && verified.includes('href="/login"'));
  assert.ok(render(createElement(VerifyEmailView, { user: null })).includes('href="/login"'));
  const hostile = render(createElement(VerifyEmailView, { user: { email: '"><img src=x onerror=alert(1)>@example.com', emailVerified: false } }));
  assert.ok(!hostile.includes("<img"), "markup in the address is escaped");
});
