import { useCallback, useEffect } from "react";
import { Navigate, useNavigate, type DataRouter } from "react-router";
import { isSpaHref } from "./groups";

/**
 * Navigation that knows about the gradual cut-over (SPA_GROUPS). A target in an enabled SPA group is a client-side route
 * change; a target that is still an old Next page (or any other URL) is a full page load. Every redirect in the SPA
 * (guards, the shims for next/navigation, error handlers) goes through here.
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
