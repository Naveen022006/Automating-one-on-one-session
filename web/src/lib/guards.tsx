import { Suspense, lazy } from "react";
import { Outlet, useLocation, useSearchParams } from "react-router";
import { safeNextPath } from "@/lib/safe-next-path";
import { AppNavigate } from "./navigate";
import { PageError, PageLoading } from "./states";
import { useAdminSession, useDashboardShell, useSession } from "./session";

/**
 * Route guards (doc/10-react-migration-plan.md, section 2.3). They are USER EXPERIENCE ONLY: they decide where to send
 * the browser. Every byte of private data is still protected by the API (401/403), so a guard that is wrong or bypassed
 * shows an empty frame at worst, never someone else's data.
 *
 * They are layout routes: each renders its layout/<Outlet /> only when the visitor may be there. While the answer is on its
 * way they show a skeleton (not the page, so nothing flashes); an infrastructure error shows the usual error alert.
 * Redirects go through AppNavigate, which falls back to a full page load for a group that is not switched on yet.
 */

const here = (loc: { pathname: string; search: string }) => encodeURIComponent(loc.pathname + loc.search);

// The two frames pull in the whole dashboard/admin chrome (sidebars, menus, icons); load them only for those areas so the
// code a visitor downloads for the landing page or a booking page stays small.
const DashboardLayout = lazy(() => import("../layouts/DashboardLayout").then((m) => ({ default: m.DashboardLayout })));
const AdminLayout = lazy(() => import("../layouts/AdminLayout").then((m) => ({ default: m.AdminLayout })));

/** `/dashboard/*`: signed-in influencer who finished onboarding. Also supplies the dashboard frame. */
export function RequireInfluencer() {
  const shell = useDashboardShell();
  if (shell.data) {
    return shell.data.user.onboarded ? (
      <Suspense fallback={<PageLoading />}>
        <DashboardLayout />
      </Suspense>
    ) : (
      <AppNavigate to="/onboarding" replace />
    );
  }
  // 401: the global handler (lib/api.ts) is already reloading to /login?next=..., so just keep the skeleton up.
  if (shell.isError && shell.error.status !== 401) return <PageError error={shell.error} onRetry={() => void shell.refetch()} />;
  return <PageLoading />;
}

/** `/onboarding`: any signed-in influencer (an already onboarded one may stay, as before). */
export function RequireSession() {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <PageLoading />;
  if (session.isError) return <PageError error={session.error} onRetry={() => void session.refetch()} />;
  return session.data.authenticated ? <Outlet /> : <AppNavigate to={`/login?next=${here(location)}`} replace />;
}

/** `/login`, `/register`: a signed-in visitor goes on to `next` (validated: no open redirect) or the dashboard. */
export function GuestOnly() {
  const session = useSession();
  const [params] = useSearchParams();
  if (session.isPending) return <PageLoading />;
  // If the session check itself fails, still let people sign in: an outage must not lock the login form.
  if (session.data?.authenticated) return <AppNavigate to={safeNextPath(params.get("next"))} replace />;
  return <Outlet />;
}

/** `/admin/*` except the login: administrator with a session that passed every gate the server demands. */
export function RequireAdmin() {
  const session = useAdminSession();
  const location = useLocation();
  if (session.isPending) return <PageLoading />;
  if (session.isError) return <PageError error={session.error} onRetry={() => void session.refetch()} />;
  const s = session.data;
  // Not signed in, or a password-only session of an admin who has 2FA ("verify"): sign in again, with the code.
  if (!s.authenticated || s.gate === "verify") return <AppNavigate to={`/admin/login?next=${here(location)}`} replace />;
  // 2FA is required but not set up: the Security page is the only screen open.
  if (s.gate === "enroll" && location.pathname !== "/admin/security") return <AppNavigate to="/admin/security" replace />;
  return (
    <Suspense fallback={<PageLoading />}>
      <AdminLayout />
    </Suspense>
  );
}

/** `/admin/login`: an administrator who is fully signed in goes on to `next` or the console. */
export function AdminGuestOnly() {
  const session = useAdminSession();
  const [params] = useSearchParams();
  if (session.isPending) return <PageLoading />;
  const s = session.data;
  if (s?.authenticated && s.gate !== "verify") return <AppNavigate to={safeNextPath(params.get("next"), "/admin")} replace />;
  return <Outlet />;
}
