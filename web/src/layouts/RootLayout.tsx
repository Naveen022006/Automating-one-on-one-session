import { Outlet, ScrollRestoration } from "react-router";
import { FocusOnNavigate, HashScroller, RouteAnnouncer } from "../lib/a11y";

/**
 * The root of every route: what app/layout.tsx's <body> contained (the skip link) plus the route-change behaviour Next
 * provided (scroll restoration, announcements, focus, #hash targets; see lib/a11y.tsx).
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
      <Outlet />
      <ScrollRestoration />
    </>
  );
}
