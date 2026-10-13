import type { ComponentType } from "react";
import { createBrowserRouter, type RouteObject } from "react-router";
import { spaRouteById, type SpaRouteId } from "@/lib/spa/routes";
import { RootLayout } from "./layouts/RootLayout";
import { AdminGuestOnly, GuestOnly, RequireAdmin, RequireInfluencer, RequireSession } from "./lib/guards";
import { PageLoading } from "./lib/states";
import { ErrorPage } from "./pages/ErrorPage";
import { NotFound } from "./pages/NotFound";

/**
 * The route tree (doc/12-front-end.md). Paths come from the ONE route table the server also uses
 * (lib/spa/routes.ts), so the proxy, the shell head and this router cannot disagree about which URL is which page.
 *
 * `pages` has one lazy module per route id and is typed `Record<SpaRouteId, ...>`: adding a route to the table without
 * a page module here (or the other way round) is a TypeScript error. Each module is a separate chunk loaded on demand and
 * exports `Component`.
 */

type LazyPage = () => Promise<{ Component: ComponentType }>;

const pages: Record<SpaRouteId, LazyPage> = {
  // public
  landing: () => import("./pages/public/Landing"),
  terms: () => import("./pages/public/Terms"),
  privacy: () => import("./pages/public/Privacy"),
  "refund-policy": () => import("./pages/public/RefundPolicy"),
  contact: () => import("./pages/public/Contact"),
  design: () => import("./pages/public/Design"),
  // auth
  login: () => import("./pages/auth/Login"),
  register: () => import("./pages/auth/Register"),
  "forgot-password": () => import("./pages/auth/ForgotPassword"),
  "reset-password": () => import("./pages/auth/ResetPassword"),
  "verify-email": () => import("./pages/auth/VerifyEmail"),
  // booking
  pay: () => import("./pages/booking/Pay"),
  manage: () => import("./pages/booking/Manage"),
  "customer-bookings": () => import("./pages/booking/FindBookings"),
  "customer-portal": () => import("./pages/booking/CustomerPortal"),
  book: () => import("./pages/booking/Book"),
  profile: () => import("./pages/booking/Profile"),
  // dashboard
  onboarding: () => import("./pages/dashboard/Onboarding"),
  dashboard: () => import("./pages/dashboard/Overview"),
  "dashboard-sessions": () => import("./pages/dashboard/Sessions"),
  "dashboard-services": () => import("./pages/dashboard/Services"),
  "dashboard-availability": () => import("./pages/dashboard/Availability"),
  "dashboard-customers": () => import("./pages/dashboard/Customers"),
  "dashboard-earnings": () => import("./pages/dashboard/Earnings"),
  "dashboard-payouts": () => import("./pages/dashboard/Payouts"),
  "dashboard-messages": () => import("./pages/dashboard/Messages"),
  "dashboard-settings": () => import("./pages/dashboard/Settings"),
  // admin
  "admin-login": () => import("./pages/admin/Login"),
  admin: () => import("./pages/admin/Overview"),
  "admin-influencers": () => import("./pages/admin/Influencers"),
  "admin-influencer": () => import("./pages/admin/InfluencerDetail"),
  "admin-payments": () => import("./pages/admin/Payments"),
  "admin-payouts": () => import("./pages/admin/Payouts"),
  "admin-reports": () => import("./pages/admin/Reports"),
  "admin-bookings": () => import("./pages/admin/Bookings"),
  "admin-health": () => import("./pages/admin/Health"),
  "admin-audit": () => import("./pages/admin/Audit"),
  "admin-security": () => import("./pages/admin/Security"),
  "admin-settings": () => import("./pages/admin/Settings"),
};

/** A leaf route. Absolute paths on purpose: layout routes below are pathless, so a path never depends on nesting. */
function leaf(id: SpaRouteId): RouteObject {
  return { path: spaRouteById(id).path, lazy: pages[id] };
}

const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <ErrorPage />,
    // Shown while the first route's code is loading (a lazy route cannot render before its module is in). Inside a container,
    // so the skeleton has the page's margins instead of sitting against the left edge of the window.
    hydrateFallbackElement: (
      <div className="container container--narrow">
        <PageLoading />
      </div>
    ),
    children: [
      // --- public
      leaf("landing"),
      leaf("terms"),
      leaf("privacy"),
      leaf("refund-policy"),
      leaf("contact"),
      // Without the design page `/design` must not fall through to `/:slug` (a profile lookup that 404s in the console).
      ...(__DESIGN_PAGE__ ? [leaf("design")] : [{ path: "/design", element: <NotFound /> }]),

      // --- auth. A signed-in visitor on login/register goes on to `next` or the dashboard.
      { element: <GuestOnly />, children: [leaf("login"), leaf("register")] },
      leaf("forgot-password"),
      leaf("reset-password"),
      leaf("verify-email"),

      // --- booking. pay/manage/bookings come before the `:slug` routes (a static first segment wins, as in Next).
      leaf("pay"),
      leaf("manage"),
      leaf("customer-bookings"),
      leaf("customer-portal"),
      leaf("book"),
      leaf("profile"),

      // --- dashboard
      { element: <RequireSession />, children: [leaf("onboarding")] },
      {
        element: <RequireInfluencer />,
        children: [
          leaf("dashboard"),
          leaf("dashboard-sessions"),
          leaf("dashboard-services"),
          leaf("dashboard-availability"),
          leaf("dashboard-customers"),
          leaf("dashboard-earnings"),
          leaf("dashboard-payouts"),
          leaf("dashboard-messages"),
          leaf("dashboard-settings"),
          { path: "/dashboard/*", element: <NotFound embedded template="dashboard" /> },
        ],
      },

      // --- admin
      { element: <AdminGuestOnly />, children: [leaf("admin-login")] },
      {
        element: <RequireAdmin />,
        children: [
          leaf("admin"),
          leaf("admin-influencers"),
          leaf("admin-influencer"),
          leaf("admin-payments"),
          leaf("admin-payouts"),
          leaf("admin-reports"),
          leaf("admin-bookings"),
          leaf("admin-health"),
          leaf("admin-audit"),
          leaf("admin-security"),
          leaf("admin-settings"),
          { path: "/admin/*", element: <NotFound embedded template="admin" /> },
        ],
      },

      { path: "*", element: <NotFound /> },
    ],
  },
];

export const router = createBrowserRouter(routes);
