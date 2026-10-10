import { useMemo } from "react";
import { useLocation } from "react-router";
import { useAppNavigate } from "../lib/navigate";
import { queryClient } from "../lib/query";

/**
 * `next/navigation` inside the SPA build (aliased in vite.config.ts and web/tsconfig.json). Only what the shared
 * components use is exported on purpose: a server-only API (`redirect`, `notFound`, `headers`...) must FAIL TO COMPILE
 * here, instead of silently doing nothing in the browser. Deleted in the cleanup branch.
 *
 * `router.refresh()` is the important one (30+ call sites after mutations). In Next it re-rendered the server tree and kept
 * client state; here it invalidates every ACTIVE query, so the page, the layout's badge counts and the admin gate refetch
 * while mounted components (open drawers, half-typed forms) stay put.
 */

export interface AppRouterInstance {
  push(href: string, options?: { scroll?: boolean }): void;
  replace(href: string, options?: { scroll?: boolean }): void;
  refresh(): void;
  back(): void;
  forward(): void;
  prefetch(href: string): void;
}

export function useRouter(): AppRouterInstance {
  const go = useAppNavigate();
  return useMemo<AppRouterInstance>(
    () => ({
      push: (href) => go(href),
      replace: (href) => go(href, { replace: true }),
      refresh: () => void queryClient.invalidateQueries(),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      prefetch: () => {},
    }),
    [go],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}

export function useSearchParams(): URLSearchParams {
  const { search } = useLocation();
  return useMemo(() => new URLSearchParams(search), [search]);
}
