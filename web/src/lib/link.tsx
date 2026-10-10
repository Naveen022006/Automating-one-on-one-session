import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { isSpaHref } from "./groups";
import { queryClient } from "./query";

/**
 * The SPA's link component, and what `next/link` is aliased to for the shared components (web/src/shims/next-link.tsx;
 * doc/10-react-migration-plan.md, section 1.4). It accepts the props this codebase passes to Next's Link
 * (`href: string`, anchor attributes, `replace`) and ignores Next-only ones (`prefetch`, `scroll`).
 *
 * A plain `<a>` (full page load) when the target cannot be an SPA route change: another origin, /api, /assets, mailto:,
 * `target="_blank"`, `download`, and a path whose SPA group is not enabled in this deployment (it is still a Next page).
 * Otherwise a React Router link. Clicking a link to the page you are already on re-fetches that page's data (Next
 * re-rendered the server page in that case; the Health page's "Refresh" button relies on it).
 */
export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  replace?: boolean;
  /** Next-only props, accepted and ignored so shared components compile unchanged. */
  prefetch?: boolean | null;
  scroll?: boolean;
}

export function AppLink({ href, replace, prefetch: _prefetch, scroll: _scroll, onClick, target, download, ...rest }: AppLinkProps) {
  const location = useLocation();
  if (target || download !== undefined || !isSpaHref(href)) {
    return <a href={href} target={target} download={download} onClick={onClick} {...rest} />;
  }
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const to = new URL(href, window.location.href);
    const sameLocation = to.pathname === location.pathname && to.search === location.search && to.hash === location.hash;
    const plainClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (sameLocation && plainClick) void queryClient.invalidateQueries();
  };
  return <RouterLink to={href} replace={replace} onClick={handleClick} {...rest} />;
}
