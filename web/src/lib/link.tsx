import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { Link as RouterLink } from "react-router";
import { isSpaHref } from "./href";
import { queryClient } from "./query";

/**
 * The SPA's link component (doc/12-front-end.md), used by every component instead of a bare `<a>`. It accepts `href: string`,
 * anchor attributes and `replace`, and ignores the Next-only `prefetch` and `scroll` props some call sites still pass.
 *
 * A plain `<a>` (full page load) when the target cannot be an SPA route change: another origin, /api, /assets, mailto:,
 * `target="_blank"`, `download`. Otherwise a React Router link. Clicking a link to the page you are already on re-fetches that
 * page's data (a "Refresh" link; the Health page relies on it).
 *
 * It reads no router context while rendering (the current location is read from `window` when a link is clicked), so the plain
 * branch also works outside a router: in a server render, in a test, and in an error screen drawn above the router.
 */
export interface AppLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string;
  replace?: boolean;
  /** Next-only props, accepted and ignored so call sites that still pass them compile. */
  prefetch?: boolean | null;
  scroll?: boolean;
}

export function AppLink({ href, replace, prefetch: _prefetch, scroll: _scroll, onClick, target, download, ...rest }: AppLinkProps) {
  if (target || download !== undefined || !isSpaHref(href)) {
    return <a href={href} target={target} download={download} onClick={onClick} {...rest} />;
  }
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const to = new URL(href, window.location.href);
    const here = window.location;
    const sameLocation = to.pathname === here.pathname && to.search === here.search && to.hash === here.hash;
    const plainClick = event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (sameLocation && plainClick) void queryClient.invalidateQueries();
  };
  return <RouterLink to={href} replace={replace} onClick={handleClick} {...rest} />;
}
