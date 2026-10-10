import { Suspense, lazy, type ReactNode } from "react";
import { Outlet, useLocation, useSearchParams } from "react-router";
import type { ApiError } from "./api";
import { adminDecision, adminGuestDecision, guestDecision, influencerDecision, sessionDecision, type GuardDecision, type QueryLike } from "./guard-decisions";
import { AppNavigate } from "./navigate";
import { PageError, PageLoading } from "./states";
import { useAdminSession, useDashboardShell, useSession } from "./session";

/**
 * Route guards (doc/10-react-migration-plan.md, section 2.3). They are USER EXPERIENCE ONLY: they decide where to send
 * the browser. Every byte of private data is still protected by the API (401/403), so a guard that is wrong or bypassed
 * shows an empty frame at worst, never someone else's data.
 *
 * They are layout routes: each renders its layout/<Outlet /> only when the visitor may be there. While the answer is on its
 * way they show a skeleton (not the page, so nothing flashes); an infrastructure error shows the usual error alert, but only
 * when there is NO data yet: a failed background refetch (`router.refresh()` refetches everything) keeps the screen the user is
 * working in. The decisions themselves live in ./guard-decisions.ts (pure, tested); this file only renders them.
 * Redirects go through AppNavigate, which falls back to a full page load for a group that is not switched on yet.
 */

// The two frames pull in the whole dashboard/admin chrome (sidebars, menus, icons); load them only for those areas so the
// code a visitor downloads for the landing page or a booking page stays small.
const DashboardLayout = lazy(() => import("../layouts/DashboardLayout").then((m) => ({ default: m.DashboardLayout })));
const AdminLayout = lazy(() => import("../layouts/AdminLayout").then((m) => ({ default: m.AdminLayout })));

/** The few fields of a TanStack query result the decisions look at. */
function asQueryLike<T>(q: { data: T | undefined; isPending: boolean; isError: boolean; error: ApiError | null }): QueryLike<T> {
  return { data: q.data, isPending: q.isPending, isError: q.isError, errorStatus: q.error?.status };
}

function show(decision: GuardDecision, render: ReactNode, error: { error: ApiError | null; retry: () => void }): ReactNode {
  switch (decision.kind) {
    case "render":
      return render;
    case "redirect":
      return <AppNavigate to={decision.to} replace={decision.replace} />;
    case "error":
      return <PageError error={error.error ?? new Error("Unknown error")} onRetry={error.retry} />;
    case "loading":
      return <PageLoading />;
  }
}

/** `/dashboard/*`: signed-in influencer who finished onboarding. Also supplies the dashboard frame. */
export function RequireInfluencer() {
  const shell = useDashboardShell();
  const frame = (
    <Suspense fallback={<PageLoading />}>
      <DashboardLayout />
    </Suspense>
  );
  return <>{show(influencerDecision(asQueryLike(shell)), frame, { error: shell.error, retry: () => void shell.refetch() })}</>;
}

/** `/onboarding`: any signed-in influencer (an already onboarded one may stay, as before). */
export function RequireSession() {
  const session = useSession();
  const location = useLocation();
  const decision = sessionDecision(asQueryLike(session), location.pathname, location.search);
  return <>{show(decision, <Outlet />, { error: session.error, retry: () => void session.refetch() })}</>;
}

/** `/login`, `/register`: a signed-in visitor goes on to `next` (validated: no open redirect) or the dashboard. */
export function GuestOnly() {
  const session = useSession();
  const [params] = useSearchParams();
  // If the session check itself fails, still let people sign in: an outage must not lock the login form.
  return <>{show(guestDecision(asQueryLike(session), params.get("next")), <Outlet />, { error: session.error, retry: () => void session.refetch() })}</>;
}

/** `/admin/*` except the login: administrator with a session that passed every gate the server demands. */
export function RequireAdmin() {
  const session = useAdminSession();
  const location = useLocation();
  const frame = (
    <Suspense fallback={<PageLoading />}>
      <AdminLayout />
    </Suspense>
  );
  const decision = adminDecision(asQueryLike(session), location.pathname, location.search);
  return <>{show(decision, frame, { error: session.error, retry: () => void session.refetch() })}</>;
}

/** `/admin/login`: an administrator who is fully signed in goes on to `next` or the console. */
export function AdminGuestOnly() {
  const session = useAdminSession();
  const [params] = useSearchParams();
  return <>{show(adminGuestDecision(asQueryLike(session), params.get("next")), <Outlet />, { error: session.error, retry: () => void session.refetch() })}</>;
}
