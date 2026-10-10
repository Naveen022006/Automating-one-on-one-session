import { SPA_GROUPS, matchSpaRoute, parseSpaGroups, type SpaGroup } from "@/lib/spa/routes";

/**
 * Which page groups THIS deployment serves from the SPA (doc/10-react-migration-plan.md, SPA_GROUPS cut-over).
 *
 * The server writes `<meta name="spa-groups" content="public,auth,...">` into the shell (lib/spa/shell.ts). A page that
 * is not in an enabled group is still an old Next page, so a link to it must be a full page load, not a client-side
 * route change. When the meta tag is absent (the Vite dev server, which has no old pages to link to) every group counts as
 * enabled.
 */
function readEnabledGroups(): ReadonlySet<SpaGroup> {
  const meta = typeof document === "undefined" ? null : document.querySelector('meta[name="spa-groups"]');
  return meta ? parseSpaGroups(meta.getAttribute("content")) : new Set(SPA_GROUPS);
}

export const enabledGroups: ReadonlySet<SpaGroup> = readEnabledGroups();

/**
 * True when `href` is a same-origin URL that the SPA router should handle in this deployment: its path is one of the
 * routes in lib/spa/routes.ts (or the not-found fallback) AND that route's group is enabled. Everything else (other
 * origins, /api, /assets, mailto:, a group still served by Next) must be a normal navigation.
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
  const match = matchSpaRoute(url.pathname);
  return match !== null && enabledGroups.has(match.route.group);
}
