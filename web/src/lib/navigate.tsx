import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { Navigate, useLocation, useNavigate, type DataRouter } from "react-router";
import { isSpaHref } from "./href";

/**
 * Navigation for the whole SPA. A target the router can show is a client-side route change; anything else (another origin,
 * /api, /assets, a file such as /sitemap.xml) is a full page load. Every redirect in the SPA (guards, error handlers, the
 * components) goes through here.
 *
 * `useRouter` and `usePathname` keep the call shape the components were written with (`router.push(href)`,
 * `router.refresh()`), on top of React Router and TanStack Query.
 */

let router: Pick<DataRouter, "navigate"> | null = null;

/** main.tsx registers the router once, so code outside React (the query error handler) can navigate too. */
export function registerRouter(r: Pick<DataRouter, "navigate">): void {
  router = r;
}

export interface NavigateOptions {
  replace?: boolean;
}

function hardNavigate(to: string, replace?: boolean): void {
  if (replace) window.location.replace(to);
  else window.location.assign(to);
}

/** For code that runs outside the React tree. Prefer useAppNavigate() inside components. */
export function appNavigate(to: string, opts: NavigateOptions = {}): void {
  if (router && isSpaHref(to)) void router.navigate(to, { replace: opts.replace });
  else hardNavigate(to, opts.replace);
}

export function useAppNavigate(): (to: string, opts?: NavigateOptions) => void {
  const navigate = useNavigate();
  return useCallback(
    (to: string, opts: NavigateOptions = {}) => {
      if (isSpaHref(to)) void navigate(to, { replace: opts.replace });
      else hardNavigate(to, opts.replace);
    },
    [navigate],
  );
}

/** Redirect element: `<AppNavigate to="/login?next=..." replace />`. Renders nothing. */
export function AppNavigate({ to, replace }: { to: string; replace?: boolean }) {
  const spa = isSpaHref(to);
  useEffect(() => {
    if (!spa) hardNavigate(to, replace);
  }, [spa, to, replace]);
  return spa ? <Navigate to={to} replace={replace} /> : null;
}

export interface AppRouterInstance {
  push(href: string, options?: { scroll?: boolean }): void;
  replace(href: string, options?: { scroll?: boolean }): void;
  refresh(): void;
  back(): void;
  forward(): void;
  prefetch(href: string): void;
}

/**
 * The router object the components use. `refresh()` is the important one (30+ call sites after mutations): it invalidates every
 * ACTIVE query, so the page, the layout's badge counts and the admin gate refetch while mounted components (open drawers,
 * half-typed forms) stay put. `prefetch` does nothing (the SPA loads a page's code when it is shown).
 */
export function useRouter(): AppRouterInstance {
  const go = useAppNavigate();
  const queryClient = useQueryClient();
  return useMemo<AppRouterInstance>(
    () => ({
      push: (href) => go(href),
      replace: (href) => go(href, { replace: true }),
      refresh: () => void queryClient.invalidateQueries(),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      prefetch: () => {},
    }),
    [go, queryClient],
  );
}

export function usePathname(): string {
  return useLocation().pathname;
}
