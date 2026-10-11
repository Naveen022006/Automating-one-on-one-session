# The front end (`web/`), for a newcomer

The whole user interface is one React single-page app in `web/`, built with Vite. The Next.js project around it is the backend:
the JSON API, the webhooks, the metadata routes and the worker. Next renders no page. This file describes the final structure;
how it got there (the plan, every deviation, the QA logs) is in `doc/10-react-migration-*.md`.

## The big picture

```
browser ──> Next server (one origin = APP_URL, port 3000)
              proxy.ts          rate limits and CSRF for /api, cookie redirects, per-request CSP nonce,
                                every page path -> rewrite to /spa-shell/<path>
              app/spa-shell     returns web/dist/index.html with the nonce and the page's <head> (title, robots, canonical, JSON-LD)
              public/assets     the hashed JS, CSS and fonts Vite built (immutable cache)
              app/api/**        JSON endpoints, webhooks (unchanged contract)
            ──> the React app starts, reads the URL, asks /api/... for the page's data, renders
```

- `lib/spa/routes.ts` is the single route table (path, title, robots, whether a page is a token page). The proxy, the shell's head
  builder (`lib/spa/head.ts`) and the web router all read it, and `web/src/router.tsx` is typed over its ids, so they cannot drift.
- The shell template is `web/index.html`: Vite adds `nonce="__CSP_NONCE__"` to every tag it writes; `lib/spa/shell.ts` replaces the
  placeholder per request. A page without the nonce would be blocked by the CSP and stay blank, so the build (`scripts/spa-postbuild.mjs`),
  the start-up check (`lib/env.ts`), the shell route and the smoke script (`scripts/spa-smoke.mjs`) all check it.
- An unknown path is a real 404 with the Not found screen; an unknown profile slug is a 404 decided by the shell (it looks the profile up).

## Folder map

```
web/
  index.html, vite.config.ts, vite-server-guard.ts, tsconfig.json
  src/
    main.tsx            entry: providers (TanStack Query, React Router), the stale-chunk reload
    router.tsx          the route tree; one lazy page module per route id
    layouts/            RootLayout (skip link, scroll, focus, announcer), DashboardLayout, AdminLayout (frames)
    pages/<area>/       thin route modules: guard comes from the router, `useApiQuery`, `<PageTitle>`, then a view
                        public/ auth/ booking/ dashboard/ admin/ (+ ErrorPage, NotFound, GlobalError)
                        booking/ also holds BookingFlow, PayNow, ManageBooking (the interactive customer screens)
    components/
      views/<area>/     page bodies (`XView`): pure functions of their JSON props, rendered by one page each
      app/ admin/       the signed-in panels (forms, tables, drawers) and the AppShell / AdminShell frames
      auth/ site/ ui/   login forms, site header and footer, design-system primitives and overlays (ui/)
    lib/                api.ts (fetch + errors), query.ts (QueryClient, keys), session.ts, guards.tsx + guard-decisions.ts,
                        link.tsx (AppLink), navigate.tsx (useRouter, redirects), href.ts, head.tsx (PageTitle), a11y.tsx, scroll.ts, states.tsx
    styles/             tokens.css, base.css, components.css, layouts.css (the design system), globals.css (imports them)
    styles.css, spa.css fonts (@fontsource-variable), the entry stylesheet and the few SPA-only rules
lib/views/              view functions: the server side of every page (see below)
lib/spa/                routes.ts, head.ts, shell.ts
app/spa-shell/          the shell route
```

## How a page works

1. The route table gives the URL and title. `router.tsx` lazy-loads `pages/<area>/<Page>.tsx`, which exports `Component`.
2. The guard around it (`RequireInfluencer`, `RequireAdmin`, `GuestOnly`, ...) asks `/api/dashboard/shell`, `/api/admin/shell` or the session
   endpoints and redirects. These are conveniences: **every endpoint checks the session itself**.
3. The page calls `useApiQuery(queryKeys.x(...), "/api/...")` and renders `<QueryGate query={q}>{(data) => <XView data={data} />}</QueryGate>`.
   `QueryGate` shows a skeleton while there is no data, an error with a retry, the 404 screen, and a "Couldn't refresh" notice when a refetch
   fails but old data is on screen. Exactly one `<PageTitle>` per page (layouts render none).
4. The endpoint (`app/api/.../route.ts`) authenticates, calls a view function in `lib/views/` and answers with `jsonView(...)`.
5. After a mutation the component calls `router.refresh()`, which invalidates every active query (the page, the sidebar badge, the admin gate).

**The DTO rule.** A view function builds its answer field by field from what the screen shows. Never a spread database row, never a token,
hash, ciphertext or an id the screen does not use. `Date` fields travel as ISO strings; the view's prop type is `Jsonify<XView>` so a
`Date` method on such a field fails to compile. Every endpoint test calls `assertNoSecretKeys` and pins the exact key set.

**Shared types.** A type that a view function and a component both need lives in `lib/` as plain TypeScript (`lib/views/dashboard-types.ts`,
`lib/views/*.ts`), never in a component file; the browser reads it with `import type`, which the bundler erases.

## What the browser may import

Browser code reaches server code only through `import type`, plus this short allowlist of pure modules in `lib/` (no database, no Node
APIs, no environment beyond the four build-time names): `format`, `intake`, `brand`, `refund-policy`, `auth/slug`, `spa/routes`, `jsonify`,
`safe-next-path`, `message-templates`, `whatsapp-copy`, `whatsapp-graph-version`, `facebook-sdk`. `web/vite-server-guard.ts` enforces it at
build time (it also refuses every `next/*` import and everything under `app/`), and `tests/spa-guard.test.ts` pins the list. Add to the list
only after reading the module and checking it is safe to ship to every visitor.

The bundle can see exactly four environment values, replaced at build time by Vite `define`: `NEXT_PUBLIC_BRAND_NAME`,
`NEXT_PUBLIC_SUPPORT_EMAIL`, `APP_LOCALE`, `ENABLE_DESIGN_PAGE` (the `/design` catalogue is built in only for development or when true;
use the same value at build and run time). Anything else that looks like a secret in `web/dist` fails the build.

## Behaviour worth knowing

- **Navigation.** Use `AppLink` (`lib/link.tsx`) instead of `<a>`: it routes in the SPA for page paths and falls back to a normal link for
  other origins, `/api`, `/assets`, downloads. Clicking a link to the page you are on re-fetches it (the Health page's Refresh).
  Programmatic moves use `useRouter()`/`appNavigate()` from `lib/navigate.tsx`; a hard navigation is used for login and logout so that the
  query cache (personal data) is dropped. The cache is never persisted.
- **Query defaults.** `staleTime: 0`, no refetch on focus or reconnect (the database allows 15 connections in total), no retry on 4xx, one on 5xx.
- **Accessibility.** `RootLayout` mounts the route announcer, focus-on-navigate (moves focus to `main#main`), scroll restoration keyed so a
  fresh document never inherits the last one's position, and `#hash` scrolling. A loading frame marks its `main` as a placeholder so focus waits
  for the real one. Dialogs and the booking drawer carry their own toast stack.
- **Stale tabs.** After a deploy an open tab asks for chunk files that no longer exist: `/assets` answers a plain 404 (never the shell) and
  `vite:preloadError` reloads the page once.
- **Time zones.** Server-rendered times used to appear in the server's zone; the app formats in the viewer's zone, `APP_LOCALE` for number and
  date styles.

## Marketplace screens (doc/13)

Six features added these routes, pages and components (the plan and the deviations are `doc/13-product-build-plan.md`,
`doc/13-marketplace-essentials.md`, `doc/13-deviations.md`). The browser import allowlist did not change.

**New routes** (rows in `lib/spa/routes.ts`; the router lists `/bookings` before the `:slug` routes, and `bookings` is a reserved slug):

| Path | Route id | Page module | View | Data |
|---|---|---|---|---|
| `/bookings` | `customer-bookings` | `pages/booking/FindBookings.tsx` | `components/views/booking/FindBookingsView.tsx` | `POST /api/customer/access` (always 202) |
| `/bookings/:token` | `customer-portal` | `pages/booking/CustomerPortal.tsx` | `components/views/booking/CustomerPortalView.tsx` | `GET /api/customer/portal/:token`; `.../export` (JSON download) and `POST .../erase` |
| `/admin/reports` | `admin-reports` | `pages/admin/Reports.tsx` | `components/views/admin/ReportsView.tsx` | `GET /api/admin/reports?from=&to=` (a bad range is a 400 the page shows next to its form) |

`/bookings/:token` is a token page: `noindex,nofollow` and `Referrer-Policy: no-referrer`. An unknown or expired token is a 403
`{ state: "expired" }` that the view renders as a screen ("This link has expired", with a button back to `/bookings`), not as an error.
"Find your booking" is the last item of the site footer's Contact column (`components/site/SiteChrome.tsx`), and Reports is a section in the
admin sidebar (`components/admin/AdminShell.tsx`).

**New components**
- `components/views/booking/ReceiptCard.tsx`: the printable receipt, shared by the portal and by `pages/booking/ManageBooking.tsx` (the
  manage page owns its `FocusedLayout`, so it renders the receipt itself and hides it once the booking is cancelled). It is a receipt, not a
  tax invoice. Its data is `ReceiptView` from `lib/receipts.ts` (type only).
- `styles/print.css` (imported by `styles/globals.css`): the receipt's screen styles (`.receipt`, `.portal__*`) and `@media print` rules.
  Printing hides everything except `.receipt` when the page root carries `portal--receipt-open` (portal) or `print-receipt-only` (manage
  page); anything marked `no-print` is left out. "Print receipt" calls `window.print()`, so "Save as PDF" in the browser's dialog makes the PDF.
- `components/app/AccountActivityPanel.tsx`: the influencer's "Account activity" card in Settings (`SettingsView`), a paged table of
  When / What / Device / IP over `GET /api/dashboard/activity`. It starts its query after mount and refreshes on the window event
  `sa:activity-changed` (`SettingsForms.tsx` and `ApiProvider.tsx` dispatch it after a password change or similar).
- `components/admin/InfluencerActivityPanel.tsx`: the same table for an administrator, over `GET /api/admin/influencers/:id/activity`.
- `components/admin/InfluencerStatusPanel.tsx`: suspend, reinstate and approve on the admin Influencer page (`InfluencerDetailView`); the
  Influencers list (`InfluencersView`) gained the status tabs (Awaiting approval is hidden while its count is 0).
- `components/admin/ExportControls.tsx`: the CSV download control on the Payments, Bookings, Payouts and Audit views. A plain
  `<a href download>` whose click is intercepted to `fetch` the file, so a refusal ("More than 20,000 rows") shows as a message.
- `components/admin/RefundAction.tsx` (in the Payments rows) and `components/admin/CancelBookingAction.tsx` (Bookings rows): confirm dialogs
  with a required reason; the refund sends `expectedRemainingMinor` as a check. `PayoutActions.tsx` gained the "pay anyway" acknowledgement
  for a suspended influencer. `BookingsView` has the search box (`?q=`).

## Working on it

```
npm run dev        # http://localhost:3000, rebuilds web/src on every change (about a second), reload the page
npm run dev:hmr    # http://localhost:5173 with hot module reload; Next gets APP_URL=http://localhost:5173 (see README, "Run it locally")
npm run typecheck  # both TypeScript projects (the root project also reads the web/ files the tests import)
```

The production-like check (the real CSP, the template check, the hashed assets) needs two terminals, because `npm start` does not return.
Production mode refuses an `http://` `APP_URL`, so the local run says so explicitly (the same variables as the README, "Run it locally"):

```
# terminal 1
npm run build
APP_URL=http://localhost:3000 ALLOW_INSECURE_LOCAL_RUN=true READINESS_REQUIRED=payout npm start    # PowerShell: set $env:... first
# terminal 2
node scripts/spa-smoke.mjs http://localhost:3000        # add --no-db when the server has no database
```

Adding a page: add a row to `lib/spa/routes.ts`, create `web/src/pages/<area>/<Page>.tsx` (the router will not compile without it), a view
in `web/src/components/views/`, a view function in `lib/views/` and its endpoint, and a test per endpoint (gate, ownership, key set, no secrets).
Tests that render views use `react-dom/server`, `tests/helpers/fake-navigate.ts` for the router hooks, and read the real page files to pin the
wiring (view import, title equal to the route table, endpoint gate); see `tests/spa-*.test.ts`.
