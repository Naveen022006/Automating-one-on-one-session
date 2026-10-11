import { matchSpaRoute } from "@/lib/spa/routes";

/**
 * True when `href` is a same-origin URL that the SPA router should handle: its path is one of the routes in
 * lib/spa/routes.ts (or the not-found fallback). Everything else (other origins, /api, /assets, mailto:, a download) must be
 * a normal navigation. Used by the link component and by every programmatic navigation (web/src/lib/link.tsx, navigate.tsx).
 */
export function isSpaHref(href: string): boolean {
  if (typeof window === "undefined") return false;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  return matchSpaRoute(url.pathname) !== null;
}
