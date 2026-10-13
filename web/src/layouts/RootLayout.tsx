import { Outlet, ScrollRestoration } from "react-router";
import { RouteHead } from "../lib/head";
import { FocusOnNavigate, HashScroller, RouteAnnouncer } from "../lib/a11y";
import { scrollRestorationKey } from "../lib/scroll";

/**
 * The root of every route: the skip link plus the route-change behaviour a page navigation needs
 * (scroll restoration, announcements, focus, #hash targets; see lib/a11y.tsx).
 */
export function RootLayout() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <RouteAnnouncer />
      <FocusOnNavigate />
      <HashScroller />
      <RouteHead />
      <Outlet />
      <ScrollRestoration getKey={scrollRestorationKey} />
    </>
  );
}
