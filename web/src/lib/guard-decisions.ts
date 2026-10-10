import { safeNextPath } from "@/lib/safe-next-path";
import type { AdminSessionView, SessionView } from "@/lib/views/session";
import type { DashboardShellView } from "@/lib/views/dashboard-shell";

/**
 * What each route guard does with its query, as pure functions (web/src/lib/guards.tsx renders the result). Kept separate so
 * the rules can be tested without a browser or a React renderer.
 *
 * THE RULE: decide on `data` whenever there is any. In TanStack Query v5 a REFETCH that fails sets `isError` while the previous
 * `data` stays. `router.refresh()` refetches every active query, so one transient 500/503/429 would otherwise swap the whole
 * dashboard, console or onboarding wizard (with its open dialogs and half-typed forms) for an error alert. An error is shown
 * only when there is no data at all.
 */

export interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  /** HTTP status of the failure, when there is one (ApiError.status). */
  errorStatus?: number;
}

export type GuardDecision =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "render" }
  | { kind: "redirect"; to: string; replace: true };

const redirect = (to: string): GuardDecision => ({ kind: "redirect", to, replace: true });
const here = (path: string, search: string) => encodeURIComponent(path + search);

/** `/dashboard/*`: a signed-in influencer who finished onboarding. */
export function influencerDecision(q: QueryLike<DashboardShellView>): GuardDecision {
  if (q.data) return q.data.user.onboarded ? { kind: "render" } : redirect("/onboarding");
  // 401: the global handler (lib/api.ts) is already reloading to /login?next=..., so keep the skeleton up.
  if (q.isError && q.errorStatus !== 401) return { kind: "error" };
  return { kind: "loading" };
}

/** `/onboarding`: any signed-in influencer. */
export function sessionDecision(q: QueryLike<SessionView>, path: string, search: string): GuardDecision {
  if (q.data) return q.data.authenticated ? { kind: "render" } : redirect(`/login?next=${here(path, search)}`);
  return q.isPending ? { kind: "loading" } : { kind: "error" };
}

/** `/admin/*` except the login: an administrator with a session that passed every gate the server demands. */
export function adminDecision(q: QueryLike<AdminSessionView>, path: string, search: string): GuardDecision {
  const s = q.data;
  if (s) {
    // Not signed in, or a password-only session of an admin who has 2FA ("verify"): sign in again, with the code.
    if (!s.authenticated || s.gate === "verify") return redirect(`/admin/login?next=${here(path, search)}`);
    // 2FA is required but not set up: the Security page is the only screen open.
    if (s.gate === "enroll" && path !== "/admin/security") return redirect("/admin/security");
    return { kind: "render" };
  }
  return q.isPending ? { kind: "loading" } : { kind: "error" };
}

/** `/login`, `/register`: a signed-in visitor goes on to `next` (validated) or the dashboard. A failing session check never blocks the form. */
export function guestDecision(q: QueryLike<SessionView>, next: string | null): GuardDecision {
  if (q.data?.authenticated) return redirect(safeNextPath(next));
  if (!q.data && q.isPending) return { kind: "loading" };
  return { kind: "render" };
}

/** `/admin/login`: an administrator who is fully signed in goes on to `next` or the console. */
export function adminGuestDecision(q: QueryLike<AdminSessionView>, next: string | null): GuardDecision {
  const s = q.data;
  if (s?.authenticated && s.gate !== "verify") return redirect(safeNextPath(next, "/admin"));
  if (!s && q.isPending) return { kind: "loading" };
  return { kind: "render" };
}
