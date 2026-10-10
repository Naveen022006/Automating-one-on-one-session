import { QueryCache, QueryClient } from "@tanstack/react-query";
import { ApiError, handleApiAuthError } from "./api";

/**
 * The one QueryClient (doc/10-react-migration-plan.md, section 1.3).
 *
 *  - staleTime 0: data is fetched again whenever a page mounts, like a dynamic Next page was rendered on every visit.
 *    Background refetches keep the current UI (a page only shows a skeleton while it has NO data yet), so components that
 *    hold local state (the onboarding wizard, an open drawer, a half-typed form) are never unmounted by a refresh.
 *  - no refetch on window focus or reconnect: the database has 15 connections in total.
 *  - retry: never for a 4xx (the answer will not change), once for a 5xx or a network failure.
 *  - the cache lives in memory only and is NEVER persisted (no persistQueryClient, no localStorage): personal data must
 *    not outlive the tab. Login and logout are full page reloads, which also empties it.
 */
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleApiAuthError }),
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (failureCount, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 1,
    },
  },
});

/**
 * Query keys. Use these helpers so that invalidation by prefix works (`router.refresh()` in the next/navigation shim
 * invalidates everything; a page can invalidate just `["dashboard"]`). Put everything the URL depends on in `params`.
 */
export const queryKeys = {
  session: () => ["session"] as const,
  adminSession: () => ["admin-session"] as const,
  dashboardShell: () => ["dashboard", "shell"] as const,
  adminShell: () => ["admin", "shell"] as const,
  dashboard: (page: string, params: Record<string, unknown> = {}) => ["dashboard", page, params] as const,
  admin: (page: string, params: Record<string, unknown> = {}) => ["admin", page, params] as const,
  publicProfile: (slug: string) => ["public", "profile", slug] as const,
  pay: (token: string) => ["pay", token] as const,
  manage: (token: string) => ["manage", token] as const,
};
