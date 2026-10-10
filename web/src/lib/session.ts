import type { AdminShellView } from "@/lib/views/admin-shell";
import type { DashboardShellView } from "@/lib/views/dashboard-shell";
import type { AdminSessionView, SessionView } from "@/lib/views/session";
import { useApiQuery } from "./api";
import { queryKeys } from "./query";

/**
 * The four queries behind the route guards and layouts (doc/10-react-migration-plan.md, section 2.2). The response types
 * come from the server modules that build them (type-only imports, erased by the build), so the browser and the server
 * cannot drift apart.
 *
 * The session endpoints answer 200 even when nobody is signed in; the shell endpoints answer 401/403 (and the global
 * handler in ./api.ts then moves the browser to the right login page).
 */

/** Who is signed in as an influencer, if anyone. Shared by the landing header, GuestOnly, verify-email and the onboarding guard. */
export function useSession() {
  return useApiQuery<SessionView>(queryKeys.session(), "/api/auth/session", { staleTime: 60_000 });
}

/** The administrator session and its two-factor gate. */
export function useAdminSession() {
  return useApiQuery<AdminSessionView>(queryKeys.adminSession(), "/api/admin/session", { staleTime: 60_000 });
}

/** Dashboard frame data: the signed-in influencer for the sidebar, plus the badge count. Also the dashboard auth check. */
export function useDashboardShell() {
  return useApiQuery<DashboardShellView>(queryKeys.dashboardShell(), "/api/dashboard/shell");
}

/** Admin console frame data: badges and the account menu. */
export function useAdminShell() {
  return useApiQuery<AdminShellView>(queryKeys.adminShell(), "/api/admin/shell");
}
