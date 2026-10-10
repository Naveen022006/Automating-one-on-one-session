// The route guards' decisions (web/src/lib/guard-decisions.ts), as pure functions: no browser, no React renderer, no database.
// The point of most of these tests: a FAILED REFETCH (TanStack Query v5 keeps the old `data` and sets isError) must never replace
// the screen the user is working in with an error alert (`router.refresh()` refetches every active query).
import assert from "node:assert/strict";
import { test } from "node:test";
import { adminDecision, adminGuestDecision, guestDecision, influencerDecision, sessionDecision, type QueryLike } from "../web/src/lib/guard-decisions";
import type { DashboardShellView } from "../lib/views/dashboard-shell";
import type { AdminSessionView, SessionView } from "../lib/views/session";

const ok = <T>(data: T): QueryLike<T> => ({ data, isPending: false, isError: false });
/** A background refetch that failed: data stays, isError is true. */
const failedRefetch = <T>(data: T, errorStatus = 503): QueryLike<T> => ({ data, isPending: false, isError: true, errorStatus });
const pending = <T>(): QueryLike<T> => ({ data: undefined, isPending: true, isError: false });
const failedFirst = <T>(errorStatus = 500): QueryLike<T> => ({ data: undefined, isPending: false, isError: true, errorStatus });

const signedIn: SessionView = { authenticated: true, user: { email: "a@b.example", emailVerified: true, name: "A", slug: "a", onboarded: true } };
const signedOut: SessionView = { authenticated: false };
const admin = (gate: "ok" | "enroll" | "verify"): AdminSessionView => ({ authenticated: true, admin: { name: "N", email: "n@b.example" }, gate });
const shell = (onboarded: boolean): DashboardShellView => ({ user: { name: "A", email: "a@b.example", slug: "a", photoUrl: null, emailVerified: true, onboarded }, attentionCount: 0 });

test("a failed refetch with data present keeps the screen in every guard (open dialogs and half-typed forms survive)", () => {
  for (const status of [500, 502, 503, 429, 0]) {
    assert.deepEqual(sessionDecision(failedRefetch(signedIn, status), "/onboarding", "?step=2"), { kind: "render" }, `onboarding wizard, ${status}`);
    assert.deepEqual(adminDecision(failedRefetch(admin("ok"), status), "/admin/payments", ""), { kind: "render" }, `admin console, ${status}`);
    assert.deepEqual(influencerDecision(failedRefetch(shell(true), status)), { kind: "render" }, `dashboard, ${status}`);
    assert.deepEqual(guestDecision(failedRefetch(signedOut, status), null), { kind: "render" });
    assert.deepEqual(adminGuestDecision(failedRefetch(admin("verify"), status), null), { kind: "render" });
  }
  // ... and the data still decides: a refetch that failed does not hide that the session has meanwhile become a different one.
  assert.equal(adminDecision(failedRefetch(admin("verify")), "/admin", "").kind, "redirect");
  assert.equal(sessionDecision(failedRefetch(signedOut), "/onboarding", "").kind, "redirect");
});

test("an error is shown only when there is no data yet", () => {
  assert.deepEqual(sessionDecision(failedFirst(), "/onboarding", ""), { kind: "error" });
  assert.deepEqual(adminDecision(failedFirst(), "/admin", ""), { kind: "error" });
  assert.deepEqual(influencerDecision(failedFirst(503)), { kind: "error" });
  // 401 from the shell: the global handler is already reloading to the login page, so the skeleton stays.
  assert.deepEqual(influencerDecision(failedFirst(401)), { kind: "loading" });
  // A failing session check never blocks the login forms.
  assert.deepEqual(guestDecision(failedFirst(), null), { kind: "render" });
  assert.deepEqual(adminGuestDecision(failedFirst(), null), { kind: "render" });
});

test("while the first answer is on its way every guard shows a skeleton, not the page", () => {
  assert.deepEqual(sessionDecision(pending(), "/onboarding", ""), { kind: "loading" });
  assert.deepEqual(adminDecision(pending(), "/admin", ""), { kind: "loading" });
  assert.deepEqual(influencerDecision(pending()), { kind: "loading" });
  assert.deepEqual(guestDecision(pending(), null), { kind: "loading" });
  assert.deepEqual(adminGuestDecision(pending(), null), { kind: "loading" });
});

test("redirects: signed out, onboarding, two-factor gates", () => {
  assert.deepEqual(sessionDecision(ok(signedOut), "/onboarding", "?step=2"), { kind: "redirect", to: "/login?next=%2Fonboarding%3Fstep%3D2", replace: true });
  assert.deepEqual(sessionDecision(ok(signedIn), "/onboarding", ""), { kind: "render" });
  assert.deepEqual(influencerDecision(ok(shell(false))), { kind: "redirect", to: "/onboarding", replace: true });
  assert.deepEqual(influencerDecision(ok(shell(true))), { kind: "render" });

  assert.deepEqual(adminDecision(ok({ authenticated: false }), "/admin/payments", "?view=mismatch"), { kind: "redirect", to: "/admin/login?next=%2Fadmin%2Fpayments%3Fview%3Dmismatch", replace: true });
  assert.deepEqual(adminDecision(ok(admin("verify")), "/admin", ""), { kind: "redirect", to: "/admin/login?next=%2Fadmin", replace: true });
  assert.deepEqual(adminDecision(ok(admin("enroll")), "/admin/payments", ""), { kind: "redirect", to: "/admin/security", replace: true });
  assert.deepEqual(adminDecision(ok(admin("enroll")), "/admin/security", ""), { kind: "render" });
  assert.deepEqual(adminDecision(ok(admin("ok")), "/admin/payments", ""), { kind: "render" });
});

test("signed-in visitors on the login pages go on to a validated next, never to another site", () => {
  assert.deepEqual(guestDecision(ok(signedOut), "/dashboard"), { kind: "render" });
  assert.deepEqual(guestDecision(ok(signedIn), null), { kind: "redirect", to: "/dashboard", replace: true });
  assert.deepEqual(guestDecision(ok(signedIn), "/dashboard/sessions?view=past"), { kind: "redirect", to: "/dashboard/sessions?view=past", replace: true });
  for (const evil of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    assert.deepEqual(guestDecision(ok(signedIn), evil), { kind: "redirect", to: "/dashboard", replace: true }, evil);
    assert.deepEqual(adminGuestDecision(ok(admin("ok")), evil), { kind: "redirect", to: "/admin", replace: true }, evil);
  }
  assert.deepEqual(adminGuestDecision(ok(admin("ok")), "/admin/payouts"), { kind: "redirect", to: "/admin/payouts", replace: true });
  // A password-only session of a 2FA admin must stay on the login page (no redirect loop with RequireAdmin).
  assert.deepEqual(adminGuestDecision(ok(admin("verify")), "/admin/payouts"), { kind: "render" });
  assert.deepEqual(adminGuestDecision(ok({ authenticated: false }), null), { kind: "render" });
});
