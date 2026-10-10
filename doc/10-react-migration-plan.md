# Front-end migration plan: Next.js-rendered UI -> standalone React SPA

Project: `E:\Automating one-on-one session` (Next.js 16 App Router, Prisma 7, BullMQ). Owner decision (fixed): the whole
UI becomes a standalone React single-page app (Vite + React + React Router, TypeScript). The Next.js project keeps the
JSON API, the webhooks, the metadata routes and the worker. The browser sees **one origin**.

This plan was written from a read-only inspection of every `app/**` page, layout, error/not-found file, metadata route,
route handler, `proxy.ts`, `lib/auth/*`, `lib/admin/*`, `lib/rate-limit/*`, `lib/readiness.ts`, `lib/public*.ts`, every
component under `components/**`, the Dockerfiles, compose file, CI and the tests that import pages. No code was run.

---

## 0. Decisions at a glance

| Topic | Decision | Why (one line) |
|---|---|---|
| Location | `web/` folder inside the same repo and the **same root `package.json`** (no npm workspace) | One `node_modules` guarantees a single React instance for components shared during the migration. |
| Build tool | Vite (current stable major), `@vitejs/plugin-react` | Standard SPA toolchain; supports a CSP nonce placeholder (`html.cspNonce`). |
| Router | React Router 7 in data mode (`createBrowserRouter`, `lazy` routes, `<Form method="get">`, `ScrollRestoration`) | Most widely known, built-in GET forms and route-level code splitting; TanStack Router's typed search params are not worth the learning curve here. |
| Server state | TanStack Query 5 | One cache; Next's `router.refresh()` maps cleanly to `queryClient.invalidateQueries()`. Router loaders are not used for data. |
| Forms | Keep the existing controlled forms in the components (no form library) | They already carry validation, error mapping and a11y wiring. |
| Client state | No global store; existing React contexts (Toast, Api) + URL search params | Nothing in the app needs more. |
| Styling | Import the existing `app/globals.css` (tokens/base/components/layouts) unchanged; fonts via `@fontsource-variable/inter` and `@fontsource-variable/newsreader` | Pixel parity; self-hosted fonts keep `font-src 'self'`. |
| Document metadata | React 19 native `<title>`/`<meta>` hoisting in the SPA, plus server-injected head tags in the HTML shell | No extra library; crawlers and link previews get real tags. |
| Sharing code during the migration | Shared components stay in `components/` and are imported by both Next and Vite; Vite aliases `next/link` and `next/navigation` to small shims | Old pages keep working (rollback target) with zero duplication; components move physically only in cleanup. |
| Page code | Each page's JSX moves into a shared **view component** (`components/views/<group>/*View.tsx`) rendered by both the old Next page and the new SPA page from the **same JSON data** | Visual parity by construction and no drift while old and new coexist. |
| Page data | Each page's data loading moves into a **view function** (`lib/views/*.ts`) used by the old page and by a new GET endpoint | No duplicated business logic; the endpoint and the old page cannot disagree. |
| Production serving | Next serves everything: `proxy.ts` rewrites SPA routes to an internal route handler that returns the Vite-built `index.html` with the per-request CSP nonce and per-route head tags; hashed assets are served from `public/assets/` | Single origin on Docker and Vercel, per-request nonce, real 404 status for unknown profiles, no extra container. |
| Gradual cut-over | `SPA_GROUPS` env var (`public,auth,booking,dashboard,admin` or `all`) decides per group whether the proxy serves the SPA shell or the old Next page | Each group goes live and rolls back independently by configuration until cleanup. |
| Development | Vite dev server (`:5173`) is the browser origin and proxies `/api`, `/sitemap.xml`, `/robots.txt`, `/icon.svg`, `/opengraph-image` to `next dev` (`:3000`) | Standard, HMR works, same-origin cookies and CSRF keep working. |
| Tests | Existing `node:test` (tsx) for all server and pure logic; no new test runner; an HTTP smoke script; named browser walk-throughs | Keeps CI shape; the risky parts are server-side and testable there. |
| Database | **No Prisma migration** in any branch | Nothing in this migration needs a schema change. |

Rejected alternatives (one line each): separate static host or CDN origin with CORS (breaks `__Host-` cookies,
`SameSite=Strict` admin cookie and the Origin check); nginx/Caddy in front (cannot inject a per-request nonce or
profile meta without templating, and does not work on Vercel); `public/index.html` + `next.config` rewrites (no nonce,
no per-route head or status); React Router framework mode with SSR (a second server framework, not what the owner
asked for); keeping Next with "use client" everywhere (still Next-rendered UI).

---

## 1. Target architecture

### 1.1 Directory layout (during the migration)

```
app/                         Next: API, metadata routes, shell route, and the OLD pages (until cleanup)
  api/**                     unchanged + new GET view endpoints (section 5)
  spa-shell/[[...path]]/route.ts   NEW: returns the SPA HTML shell (only reachable through the proxy rewrite)
  sitemap.ts robots.ts opengraph-image.tsx icon.svg   stay server-side
  <old pages>                refactored to render shared view components; deleted in cleanup
components/                  shared by Next and Vite until cleanup (frozen except components/views/<group>)
  views/<group>/*View.tsx    NEW: page bodies, rendered by old page and SPA page from the same JSON
lib/
  spa/routes.ts              NEW: single route table (pure; imported by proxy, shell route, SPA)
  spa/head.ts spa/shell.ts   NEW: server-side head resolution and shell rendering
  views/*.ts                 NEW: view functions (data loading extracted from pages)
  jsonify.ts safe-next-path.ts   NEW pure helpers (client-safe)
web/                         NEW: the SPA
  index.html vite.config.ts tsconfig.json
  src/main.tsx router.tsx env.d.ts styles.css spa.css
  src/lib/        api.ts query.ts session.ts guards.tsx head.tsx a11y.tsx link.tsx navigate.ts groups.ts
  src/shims/      next-link.tsx next-navigation.ts        (aliased; deleted in cleanup)
  src/layouts/    RootLayout.tsx DashboardLayout.tsx AdminLayout.tsx
  src/pages/      NotFound.tsx ErrorPage.tsx GlobalError.tsx NotBuiltYet.tsx
                  public/* auth/* booking/* dashboard/* admin/*   (thin wrappers: guard + query + view)
public/assets/               build output copied from web/dist/assets (gitignored)
scripts/spa-postbuild.mjs scripts/spa-smoke.mjs   NEW
```

After cleanup (section 6.8): `components/` -> `web/src/components/`, `app/styles` + `globals.css` ->
`web/src/styles/`, the client files living in `app/` (BookingFlow, PayNow, ManageBooking, DesignShowcase) ->
`web/src/pages/...`, shims removed, old pages deleted.

### 1.2 Runtime topology

```
DEVELOPMENT
 browser ──> Vite :5173 ──(/api, /sitemap.xml, /robots.txt, /icon.svg, /opengraph-image)──> next dev :3000 ──> Postgres/Redis
              serves index.html + modules (no CSP in dev)                                  worker (unchanged)

PRODUCTION (Docker or Vercel; one origin = APP_URL)
 browser ──> Next server
              proxy.ts: rate limit + CSRF for /api/*; for pages: admin/dashboard cookie redirects, nonce + CSP,
                        SPA route & group enabled ? rewrite -> /spa-shell/<path> : old Next page
              /spa-shell/[[...path]]  -> index.html with nonce, head tags, status (404 for unknown profile)
              /assets/*               -> public/assets (hashed, immutable, proxy skipped)
              /api/*                  -> route handlers (unchanged + new GET views)
```

### 1.3 Router, data fetching, caching, forms, state

- **Router**: `createBrowserRouter` in `web/src/router.tsx`. Every leaf route is `lazy: () => import("./pages/...")`
  (module exports `Component`), giving separate chunks for public, auth, booking, dashboard and admin. The map of route
  modules is typed `Record<SpaRouteId, LazyModule>` where `SpaRouteId` is the union of ids exported from
  `lib/spa/routes.ts`, so `tsc` fails if the router and the route table drift.
- **Data**: TanStack Query. `QueryClient` defaults: `staleTime: 0` (fresh data on every navigation, like dynamic
  Next pages), `refetchOnWindowFocus: false` and `refetchOnReconnect: false` (protects the 15-connection database),
  `retry`: none for 4xx, one retry for 5xx/network. The session queries use `staleTime: 60_000`. Pages show a
  skeleton only when there is no data yet (`isPending`); background refetches keep the current UI, so components that
  hold local state (the onboarding wizard, open drawers, half-typed forms) are never unmounted by a refresh.
- **Refresh after mutations**: shared components call `router.refresh()` 30+ times. The `next/navigation` shim's
  `refresh()` calls `queryClient.invalidateQueries()` (all active queries, including the layout's badge counts and the
  admin session/gate), which matches Next's "re-render the server tree, keep client state".
- **Same-URL navigation** (for example the admin Health page's "Refresh" `ButtonLink` to `/admin/health`): Next re-fetches;
  the SPA `Link` therefore invalidates active queries when the target equals the current location.
- **Query keys**: `["session"]`, `["admin-session"]`, `["dashboard","shell"]`, `["admin","shell"]`,
  `["dashboard",<page>,params]`, `["admin",<page>,params]`, `["public","profile",slug]`, `["pay",token]`,
  `["manage",token]`.
- **Forms**: unchanged components. GET filter forms on pages (`/dashboard/customers`, `/dashboard/earnings`,
  `/admin/influencers`) become React Router `<Form method="get" action=...>` with the same field names (client-side
  navigation instead of a full reload).
- **Never persist the query cache** (no `persistQueryClient`, no localStorage): personal data must not outlive the tab.
  Login and logout keep their full page reloads (`window.location.assign`), which also clears the cache.

### 1.4 Sharing code during the migration

- Vite `resolve.alias`: `@/` -> repo root, `@web/` -> `web/src/`, `next/link` -> `web/src/shims/next-link.tsx`,
  `next/navigation` -> `web/src/shims/next-navigation.ts`. `web/tsconfig.json` mirrors these in `paths`, so the shared
  components are type-checked against the shims too.
- `next/link` shim = the SPA's `AppLink` (`web/src/lib/link.tsx`): plain `<a>` for external URLs, `/api/*`, `/assets/*`,
  `target="_blank"`, `download`, and for paths whose SPA group is not enabled in this deployment (so a SPA page links to a
  not-yet-migrated Next page with a full navigation); otherwise React Router `<Link>`. Same-location clicks invalidate
  queries. Accepts the props used in this codebase (`href: string`, anchor attributes, ignores `prefetch`/`scroll`).
- `next/navigation` shim: `useRouter()` -> `{ push, replace, refresh, back, forward, prefetch: noop }` (push/replace go
  through `appNavigate`, which falls back to `window.location.assign` for non-SPA targets); `usePathname()`;
  `useSearchParams()`. Nothing else is exported (server-only APIs must fail to compile).
- `"use client"` directives are harmless in Vite; the `MODULE_LEVEL_DIRECTIVE` warning is filtered.
- `process.env` in shared modules: Vite `define` replaces exactly `process.env.NEXT_PUBLIC_BRAND_NAME`,
  `process.env.NEXT_PUBLIC_SUPPORT_EMAIL` and `process.env.APP_LOCALE` (build-time, the same semantics NEXT_PUBLIC_ already
  has; `APP_LOCALE` becomes a build input for the browser bundle). The post-build check fails if any other `process.env`
  survives in the bundle.
- **Server-code guard**: a Vite plugin (`enforce: "pre"`) errors if the browser graph resolves any of: `node:*`,
  `next/server|headers|font|og|cache`, `@prisma/*`, `pg`, `ioredis`, `bullmq`, `generated/**`, `app/api/**`,
  `worker/**`, or any `lib/**` file outside this allowlist: `lib/format.ts`, `lib/intake.ts`, `lib/brand.ts`,
  `lib/refund-policy.ts`, `lib/auth/slug.ts`, `lib/spa/routes.ts`, `lib/jsonify.ts`, `lib/safe-next-path.ts`.
  Type-only imports (`import type ... from "@/lib/dashboard-data"`) are erased before resolution and stay allowed.
- **Freeze rule**: existing files in `components/` are frozen for page-group branches. A needed change goes through a
  small coordinated follow-up on top of the foundation branch. Each group owns only `components/views/<group>/`.

### 1.5 Page port pattern (used by every group)

For each page:
1. **View function** `lib/views/<group>-<page>.ts`: move the page's data loading verbatim (Prisma reads, lib calls,
   derived business values such as `live`, approval views, payability) into `loadXView(...)`. It returns an explicit
   DTO built field by field from what the page renders (never a spread Prisma row). Export `type XView`.
2. **View component** `components/views/<group>/<Page>View.tsx`: move the page JSX verbatim; props are
   `{ data: Jsonify<XView>, ...urlState }`. No hooks that read the URL (pass URL state as props), no server imports.
   Convert `Date` method calls to `new Date(iso)`.
3. **Old Next page** becomes: guards/metadata unchanged, then `<XView data={jsonify(await loadXView(...))} />`
   (`jsonify` = `JSON.parse(JSON.stringify(v))`, so the old page renders from exactly the JSON the SPA receives).
4. **Endpoint** `GET /api/...` returns `jsonView(await loadXView(...))` with the page's auth rule (section 2).
5. **SPA page** `web/src/pages/<group>/<Page>.tsx`: guard (layout route), `useApiQuery`, `<PageTitle>`, then the view.

Time zone note: times formatted with `toLocaleString`/`Intl.DateTimeFormat(undefined, ...)` were rendered in the server's
locale and time zone; in the SPA they render in the viewer's. This is accepted (it is more correct); the `en-IN` locale
arguments stay as written.

### 1.6 Production serving in detail

Build (`npm run build` = `npm run build:web && next build`):
1. `vite build -c web/vite.config.ts` -> `web/dist/index.html` (with `nonce="__CSP_NONCE__"` on every script/link
   Vite emits and `<meta property="csp-nonce" nonce="__CSP_NONCE__">`, from `html.cspNonce`) and `web/dist/assets/*`.
2. `node scripts/spa-postbuild.mjs`: checks `index.html` contains `__CSP_NONCE__` and `<!--spa-head-->`; fails on any
   `process.env` left in `web/dist/**/*.js`; fails if any value of an environment variable whose name matches
   `SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL` (from `process.env` and, if present, the root `.env` parsed
   without loading) of length >= 8 occurs in `web/dist`; then replaces `public/assets/` with `web/dist/assets/`.
3. `next build` (standalone when `BUILD_STANDALONE=1`). `next.config.ts` adds
   `outputFileTracingIncludes: { "/spa-shell/[[...path]]": ["./web/dist/index.html"] }` (route key escaped as the Next
   docs require) so Vercel and standalone bundles contain the template; the Dockerfile also copies it explicitly.

Serving:
- `proxy.ts` rewrites an enabled SPA route to `/spa-shell<path>` with the request headers (`x-nonce`, CSP) and sets the CSP
  response header exactly as today.
- `app/spa-shell/[[...path]]/route.ts` (`dynamic = "force-dynamic"`): 404 unless `x-nonce` is present (only the proxy
  sets it); resolves the route, the head and the status (`lib/spa/head.ts`), renders the template (`lib/spa/shell.ts`):
  replace every `__CSP_NONCE__`, insert head tags at `<!--spa-head-->`, insert
  `<meta name="spa-groups" content="...">`. Response headers: `content-type: text/html; charset=utf-8`,
  `cache-control: no-store`, `x-robots-tag: noindex` (or `noindex, nofollow`) for private routes,
  `referrer-policy: no-referrer` for token routes, `retry-after: 30` with status 503 when the profile lookup fails.
  The template is read once from `path.join(process.cwd(), "web/dist/index.html")` and cached; if it is missing or has
  no placeholder the route answers 500 and logs one clear line (production start-up already refused, see 1.8).
- `next.config.ts` `headers()`: keep the security headers for `/:path*`; add `Cache-Control: public, max-age=31536000,
  immutable` for `/assets/:path*`.
- Missing chunk files return a plain 404 (never the shell; `/assets/` is excluded from the proxy and from route
  matching). After a deploy, the SPA listens for `vite:preloadError` and reloads once (guarded by a sessionStorage flag
  in try/catch) so a tab running old code recovers.

### 1.7 `proxy.ts` changes

Keep everything that exists; change `handlePage` and the matcher:

```ts
import { matchSpaRoute, parseSpaGroups } from "@/lib/spa/routes";
const SPA_ENABLED = parseSpaGroups(process.env.SPA_GROUPS);

function handlePage(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  // The shell route is internal: only reachable through the rewrite below.
  if (pathname === "/spa-shell" || pathname.startsWith("/spa-shell/")) return new NextResponse("Not found", { status: 404 });
  // (unchanged) admin cookie-presence redirect -> /admin/login?next=...
  // (unchanged) dashboard/onboarding session-cookie redirect -> /login?next=...
  // (unchanged) nonce, csp, requestHeaders with x-nonce, x-pathname, Content-Security-Policy
  const spa = req.method === "GET" || req.method === "HEAD" ? matchSpaRoute(pathname) : null;
  const toSpa = spa !== null && SPA_ENABLED.has(spa.route.group);
  // A Next client prefetch of a page that is now SPA-served: answer cheaply (no shell render, no profile lookup).
  if (toSpa && req.headers.get("next-router-prefetch")) return new NextResponse(null, { status: 204 });
  let res: NextResponse;
  if (toSpa) {
    const url = req.nextUrl.clone();
    url.pathname = `/spa-shell${pathname === "/" ? "" : pathname}`;
    res = NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  } else {
    res = NextResponse.next({ request: { headers: requestHeaders } });
  }
  res.headers.set("Content-Security-Policy", csp);
  // (unchanged) rolling session cookie on GET
  return res;
}
```

- `handleApi`: unchanged rate limiting and CSRF, plus: for `GET` requests that carry a session cookie (any `/api/*`
  except `/api/webhooks/*`), re-set the cookie with the 30-day max-age exactly as `handlePage` does. Reason: a SPA tab
  makes few full page loads, so without this the browser cookie could expire while the server session is alive.
- Matcher: add `assets/` to the exclusion list (`...|opengraph-image|assets/).*`), so hashed files skip the proxy.
- **Stay server-side**: admin no-cookie redirect; dashboard/onboarding no-cookie redirect; Google OAuth
  connect/callback redirects (route handlers); `/spa-shell` block; real 404/503 status for profile pages (shell route).
- **Move to the client** (UX only; every one is still enforced by the API): "already signed in" redirects on `/login`,
  `/register`, `/admin/login`; `requirePageAuth` (session validity and the onboarding redirect); `requireAdminPage`'s MFA
  gate (enrol -> `/admin/security`, verify -> `/admin/login?next=`), which today rides on `x-pathname`; `notFound()` for
  an unknown admin influencer id; the `/design` production gate (shell answers 404, see section 3).
- **`x-pathname`** stays only for the old admin layout and is removed in cleanup. The SPA never relies on it.
- **CSP**: unchanged policy. The shell's scripts carry the nonce; chunks load through `'strict-dynamic'`; the
  Razorpay and Facebook SDK scripts inserted by trusted code keep working as today. No `'unsafe-eval'` is needed by the
  production bundle. Vite dev serves without CSP, so CSP is verified in production mode (section 7).
- **Origin/CSRF check must still protect** every `POST/PUT/PATCH/DELETE` under `/api/` except `/api/webhooks/*`,
  unchanged. Rules for the new endpoints: GET only, no side effects (the proxy's cookie refresh is the only write),
  never any CORS header, personal data with `Cache-Control: private, no-store`, JSON objects (never top-level arrays).
  In development the browser origin is the Vite server, so set `APP_URL=http://localhost:5173` (it is in the allowed
  origins; email links then also point at the dev SPA).

### 1.8 Dockerfile, compose, CI, Vercel, env

- **`Dockerfile`**: build stage adds `ARG APP_LOCALE=en-IN` and `ARG ENABLE_DESIGN_PAGE=false` (exported as ENV for the
  build only), `RUN BUILD_STANDALONE=1 npm run build` stays (now includes Vite). Runner adds
  `COPY --from=build --chown=node:node /app/public ./public` and
  `COPY --from=build --chown=node:node /app/web/dist/index.html ./web/dist/index.html`. Remove the "no public/" comment.
- **`.dockerignore`**: add `web/dist` and `public/assets` (build outputs are produced inside the image).
- **`.gitignore`**: add `/web/dist/` and `/public/assets/`.
- **`docker-compose.yml`**: web build args add `APP_LOCALE: ${APP_LOCALE:-en-IN}`; `SPA_GROUPS` comes from `.env` as
  every other runtime value. Worker and migrate unchanged.
- **`Dockerfile.worker`**: unchanged (it copies `lib/` and `worker/`; the new `lib/spa`, `lib/views` files are not
  imported by the worker and the esbuild import check stays green).
- **CI `check` job**: `npm run typecheck` now runs both projects; `npm test` includes the new tests; `npm run build`
  includes the Vite build, the server-code guard and the post-build secret scan. Add an advisory
  `npm audit --audit-level=high` without `--omit=dev` (`continue-on-error: true`), because the browser libraries are
  build-time devDependencies and the existing `--omit=dev` audit no longer covers browser code.
- **CI `docker` job**: keep all existing steps. Add `actions/setup-node` and: (a) the existing container (no
  `SPA_GROUPS`) still serves the old Next landing page (`/` has no `id="root"`); (b) a second container with
  `-e SPA_GROUPS=all` on port 3001, then `node scripts/spa-smoke.mjs http://127.0.0.1:3001 --no-db` (section 7.3).
- **Vercel**: unchanged settings; the build script runs Vite then Next; `public/assets` goes to the CDN;
  `outputFileTracingIncludes` puts the template in the function bundle; `proxy.ts` already runs on Node.
- **`lib/env.ts`**: validate `SPA_GROUPS` (warn on unknown names); in production with a non-empty `SPA_GROUPS`, refuse to
  start the web process if `web/dist/index.html` is missing or lacks `__CSP_NONCE__` (impure check in the `web` start-up
  path, with an injectable file reader for the test).
- **`.env.example`**: document `SPA_GROUPS=` (empty = old pages; `all` after cutover), `SPA_API_TARGET` (dev only) and
  that `APP_LOCALE`, `NEXT_PUBLIC_*`, `ENABLE_DESIGN_PAGE` are also build inputs of the browser bundle.

---

## 2. Auth and security in the SPA world

### 2.1 Cookies (unchanged)
- Influencer: opaque `__Host-sa_session` (prod) / `sa_session`, HttpOnly, SameSite=Lax, rolling 30 days.
- Admin: `__Host-sa_admin` / `sa_admin`, HttpOnly, SameSite=Strict, absolute 12 hours.
- The SPA never reads cookies; all fetches are same-origin (`credentials: "same-origin"`).

### 2.2 Session-check endpoints (foundation)
- `GET /api/auth/session` -> `200 { authenticated: false }` or
  `{ authenticated: true, user: { email, emailVerified, name, slug, onboarded } }` (from `getAuth()`; no ids, no
  tokens). Used by: landing header, `GuestOnly` (login/register), verify-email, the onboarding guard.
- `GET /api/admin/session` -> `{ authenticated: false }` or
  `{ authenticated: true, admin: { name, email }, gate: "ok" | "enroll" | "verify" }` (from `getAdminAuth()` +
  `mfaGateStatus()`; deliberately not behind `requireAdminApi`, because it must report the gate).
- `GET /api/dashboard/shell` (dashboard guard + layout, one request) and `GET /api/admin/shell` (admin layout badges).

### 2.3 Route guards (UX; the server enforces)
- `RequireInfluencer` (`/dashboard/*`): queries `/api/dashboard/shell`. 401 -> full reload to `/login?next=<path+search>`;
  `user.onboarded === false` -> replace to `/onboarding`; else render `DashboardLayout` (AppShell) with `<Outlet/>`.
- `RequireSession` (`/onboarding`): session query; unauthenticated -> `/login?next=/onboarding`. Onboarded users may
  stay (parity with `allowOnboarding`).
- `GuestOnly` (`/login`, `/register`): authenticated -> `safeNextPath(next)` / `/dashboard` (replace).
- `RequireAdmin` (`/admin/*` except login): admin session query. Not authenticated or `gate === "verify"` ->
  `/admin/login?next=<path+search>`; `gate === "enroll"` and path is not `/admin/security` -> replace to
  `/admin/security`; else `AdminLayout` (AdminShell, badges from `/api/admin/shell`).
- `AdminGuestOnly` (`/admin/login`): authenticated and `gate !== "verify"` -> `safeNextPath(next, "/admin")`.
- All redirects go through `appNavigate` (falls back to a full navigation when the target's group is not enabled).
- `safeNextPath` moves verbatim to `lib/safe-next-path.ts` (pure, client-safe); `lib/http.ts` re-exports it, so server
  imports do not change and the open-redirect rules stay in one place.

### 2.4 The admin MFA gate without `x-pathname`
Today the layout redirects using `x-pathname`, and pages read data directly, so the page gate *is* the data gate. With
JSON endpoints the data gate must be explicit, and **`requireAdminApi()` is not enough**: it lets a password-only session
of an admin who has 2FA (`verify`) through, which today cannot open any console page. Therefore:
- Extend `requireAdminMfa(opts: { allowEnrollment?: boolean } = {})` in `lib/admin/session.ts` to pass
  `allowEnrollment` to `adminApiGate(admin, { mfa: true, allowEnrollment })` (backward compatible).
- **Every new admin read endpoint uses `requireAdminMfa()`** (denies `enroll` and `verify`, the exact page gate), except
  `GET /api/admin/security` and `GET /api/admin/shell`, which use `requireAdminMfa({ allowEnrollment: true })` (the
  Security page and its sidebar are the only console screens an enrolling admin sees today; `verify` stays denied).
- `canViewAdminList()` keeps hiding the administrator list inside `GET /api/admin/security`.
- Client handling of `403 { mfaRequired: true, mfaAction }`: `enroll` -> navigate to `/admin/security`;
  `verify` -> full reload to `/admin/login?next=...`. Existing admin action components keep showing the server's message
  in a toast, as today.

### 2.5 Logout
Unchanged components: `AppShell` posts `/api/auth/logout` then `window.location.assign("/login")`; `AdminShell` posts
`/api/admin/auth/logout` then `/admin/login`. The full reload drops the in-memory query cache. "Log out everywhere" and
device revocation are unchanged (`SettingsForms`).

### 2.6 Re-authentication for sensitive actions
Unchanged: `ApiProvider` (mounted inside `AppShell` and `OnboardingWizard`) turns `401 { reauth: true }` into the password
dialog, calls `/api/auth/reauth`, retries once. GET view endpoints never return `reauth`. Admin sensitive actions keep
sending the password in the body; `requireAdminMfa` keeps protecting money and bank-detail routes.

### 2.7 Error, 401, 403 handling (`web/src/lib/api.ts`)
- `apiGet<T>(url, signal)` throws `ApiError { status, data }` for non-2xx. A `QueryCache` `onError` handler:
  influencer API 401 -> full reload to `/login?next=`; `/api/admin/*` 401 -> `/admin/login?next=`; admin 403
  `mfaRequired` -> as in 2.4. The session endpoints never return 401.
- Pages: 404 -> `<NotFound/>` (same content as `app/not-found.tsx`); 429 -> alert with the server message ("Too many
  requests..."); other errors -> page-level alert with "Try again" (refetch). A render crash -> the route's
  `errorElement` (`ErrorPage`, same copy as `app/error.tsx`, logs `[ui:error]`); a crash outside the router -> top-level
  boundary with the inline-styled `global-error.tsx` copy.

### 2.8 Data exposure rule (the biggest silent risk)
Server components only ever sent rendered markup; JSON endpoints send whatever they return. Every new endpoint returns
an explicit DTO containing only fields the old page rendered or passed to a client component. A shared test helper
`assertNoSecretKeys(json, allow?)` (in `tests/helpers/`) fails on keys matching
`/hash|enc$|secret|password|token/i` (allowlist: `pollToken` in the pay view, `token` in the manage view, which are the
same capabilities the pages already embed). Every endpoint test calls it.

---

## 3. SEO and sharing

What the server keeps doing: `sitemap.xml`, `robots.txt`, `/opengraph-image`, `/icon.svg` (Next metadata routes, excluded
from the proxy). The shell route injects head tags per route, in the initial HTML, from `lib/spa/routes.ts` and
`lib/spa/head.ts`; all interpolated text goes through a strict `escapeHtml` (`& < > " '`).

| Route | Initial HTML head | Status |
|---|---|---|
| `/` | absolute title "`BRAND`: get paid for your time, send the Meet link automatically", root description, canonical `/`, OG (`type website`, `site_name`, title, description, `og:image` = `${APP_URL}/opengraph-image` 1200x630 + alt), Twitter `summary_large_image`, Organization JSON-LD in a nonce'd `<script type="application/ld+json">` with `<` escaped | 200 |
| `/terms` `/privacy` `/refund-policy` `/contact` | `Title · BRAND`, root description, canonical, OG | 200 |
| `/register` | "Create your account · BRAND", its description | 200 |
| `/:slug` | `loadPublicProfile(slug)` (same function and the same owner-preview rule as the API): live -> "Book a session with NAME · BRAND", description = bio (160 chars) or the default sentence, canonical `/slug`, page-specific `og:title`/`og:description`; owner preview -> same + `noindex`; not found -> "Not found · BRAND" + `noindex`; database error -> generic head + `noindex` | 200 / 200 / **404** / 503 |
| `/:slug/book` | as above with "Book NAME", canonical `/slug/book` | same |
| `/pay/*`, `/admin/*` | title + `noindex, nofollow` (meta and `X-Robots-Tag`) | 200 |
| `/manage/*`, `/verify-email`, `/reset-password` | title + `noindex` + `Referrer-Policy: no-referrer` header | 200 |
| `/dashboard/*`, `/onboarding`, `/login`, `/forgot-password` | title + `noindex` | 200 |
| `/design` | `noindex`; 404 unless development or `ENABLE_DESIGN_PAGE=true` (the SPA only includes the page when built in development or with `ENABLE_DESIGN_PAGE=true`) | 200 / 404 |
| anything else | "Not found" + `noindex` | 404 |

Also common to every shell: `<html lang="en">`, charset, viewport, `theme-color #fbfaf7`, `format-detection
telephone=no`, `application-name`, `<link rel="icon" href="/icon.svg" type="image/svg+xml">`, and a `<noscript>` line
with the support email.

`robots.ts` change (foundation): add `allow: ["/", "/api/public/"]` next to the existing `disallow` list, because Google's
renderer obeys robots.txt for the fetches a page makes, and profile content comes from `/api/public/profiles/:slug`.
Do not disallow `/assets/` (crawlers need the JS and CSS to render).

What is lost anyway (accepted): page body text is not in the initial HTML, so non-rendering crawlers (and some
link-preview bots beyond the meta tags) see only the head; first paint waits for JS (slower LCP than server HTML,
mitigated by route-level code splitting and a small entry chunk); `next/font`'s fallback metric adjustment (small
layout shift while fonts load); streaming. A build-time prerender of `/` and the legal pages is the follow-up if
Search Console shows a problem; it is not part of this migration.

---

## 4. Page inventory

Size: S = under half a day, M = 0.5 to 1.5 days, L = more. "Server work today" lists what the Next page does on the
server that the SPA must get elsewhere. "New" endpoints are specified in section 5.

| # | Route | Group | Server work today | Data the screen needs | Endpoint(s) | Size |
|---|---|---|---|---|---|---|
| 1 | `/` | public | `getAuth()` for header; metadata; JSON-LD with nonce | logged in? | `GET /api/auth/session` (new, F) | S |
| 2 | `/terms` `/privacy` `/refund-policy` | public | metadata; BRAND/SUPPORT constants | none | none | S |
| 3 | `/contact` | public | metadata | none | none | S |
| 4 | `/design` | public | `notFound()` in production unless flag | none | none (shell 404 + build flag) | S |
| 5 | 404 / error / global error | public | `not-found.tsx`, `error.tsx`, `global-error.tsx` | none | none | S (F) |
| 6 | `/login?next&reset` | auth | `getAuth()` -> `redirect(safeNextPath(next))` | session | session (F); `POST /api/auth/login` (exists) | S |
| 7 | `/register` | auth | `getAuth()` -> redirect `/dashboard` | session | session; `GET slug-available`, `POST register` (exist) | S |
| 8 | `/forgot-password` | auth | metadata | none | `POST forgot-password` (exists) | S |
| 9 | `/reset-password?token` | auth | metadata, no-referrer | token (URL) | `POST reset-password` (exists) | S |
| 10 | `/verify-email?token` | auth | `getAuth()`; no-referrer | session (email, verified) | session; `POST verify-email`, `POST resend-verification` (exist) | S |
| 11 | `/:slug` | booking | `loadPublicProfile` (Prisma + `getAuth` for preview), `notFound()`, `generateMetadata` | profile + services | `GET /api/public/profiles/:slug` (new) | M |
| 12 | `/:slug/book?service` | booking | same + `BookingFlow` props | profile + services | same + slots/days, slots, hold, checkout, booking poll, resend, ics (exist) | M |
| 13 | `/pay/:token` | booking | `verifyPayToken`, Prisma booking, state machine, `signBookingPollToken`, `buildSelfServiceUrl`, formatting | pay view | `GET /api/pay/:token` (new) + checkout, poll, ics (exist) | M |
| 14 | `/manage/:token` | booking | `verifySelfServiceToken`, Prisma booking + captured payments, `refundDecision`, policy texts | manage view | `GET /api/manage/:token` (new, same file as POST) + slots, POST manage (exist) | M |
| 15 | dashboard layout | dashboard | `requirePageAuth`, photo + needs-refund count + Google status | user, attention count | `GET /api/dashboard/shell` (new, F) | S (F) |
| 16 | `/dashboard` | dashboard | `getOverview`, `loadReadiness`, `live`, `appUrl()` | overview, readiness, live, public URL | `GET /api/dashboard/overview` (new) + booking drawer `GET /api/dashboard/bookings/:id` (exists) | M |
| 17 | `/dashboard/sessions?view&page&booking` | dashboard | `listSessions` | sessions page | `GET /api/dashboard/sessions` (new) + drawer endpoints (exist) | M |
| 18 | `/dashboard/services` | dashboard | Prisma services + `parseQuestions` | services | `GET /api/dashboard/services` (new GET in existing file) | S |
| 19 | `/dashboard/availability` | dashboard | Prisma timezone, rules, blocked dates | tz, rules, blocked | `GET /api/dashboard/availability` (new GET in existing file) | S |
| 20 | `/dashboard/customers?q` | dashboard | `listCustomers` | customers | `GET /api/dashboard/customers` (new) | S |
| 21 | `/dashboard/earnings?from&to` | dashboard | `earningsPayments` + `aggregateEarnings`, date defaults | summary | `GET /api/dashboard/earnings` (new); CSV export (exists) | S |
| 22 | `/dashboard/payouts` | dashboard | `getPayoutAccountView`, `influencerPayoutSummary`, `formatFeePercent` | account, summary, fee text | `GET /api/dashboard/payouts` (new) | S |
| 23 | `/dashboard/messages?status&page` | dashboard | `listMessages` | messages page | `GET /api/dashboard/messages` (new) | S |
| 24 | `/dashboard/settings?google` | dashboard | Prisma profile, `getGoogleStatus`, `getConnectionView`, `embeddedSignupConfig`, `appUrl()` | settings view | `GET /api/dashboard/settings` (new); devices `GET /api/auth/sessions` (exists) | M |
| 25 | `/onboarding?step&google` | dashboard | `requirePageAuth(allowOnboarding)` + 8 loads | onboarding view | `GET /api/dashboard/onboarding` (new GET in existing file) | M |
| 26 | admin layout | admin | `x-pathname`, `requireAdminPage(mfaGate)`, `paymentViewCounts`, `getHealthReport` | admin, badge counts | `GET /api/admin/session`, `GET /api/admin/shell` (new, F) | S (F) |
| 27 | `/admin/login?next` | admin | `getAdminAuth` + `mfaGateStatus` redirect | admin session | admin session (F); login/mfa POST (exist) | S |
| 28 | `/admin` | admin | `getOverview`, `listAudit(1)`, `getHealthReport` | overview | `GET /api/admin/overview` (new) | S |
| 29 | `/admin/influencers?page&q` | admin | `listInfluencers` | page of rows | `GET /api/admin/influencers` (new) | S |
| 30 | `/admin/influencers/:id` | admin | `getInfluencerDetail`, payout account, fees, `loadPayable`, payouts, `postPayoutRefunds`, `recentUnapprovedFor`, `payoutApprovalView` (per viewer), `activeAdminCount`, readiness; `notFound()` | detail view | `GET /api/admin/influencers/:id` (new) + payout/fee/payout-account actions (exist) | L |
| 31 | `/admin/payments?view&page` | admin | `listPayments`, `paymentViewCounts` | rows, counts | `GET /api/admin/payments` (new) + reconcile actions (exist) | M |
| 32 | `/admin/payouts?status&page` | admin | Prisma payouts + counts, approval view per viewer, owed refunds, `activeAdminCount` | rows, counts | `GET /api/admin/payouts` (new) + payout actions (exist) | M |
| 33 | `/admin/bookings?status&page` | admin | `listBookings` | rows | `GET /api/admin/bookings` (new) | S |
| 34 | `/admin/health` | admin | `collectSnapshot`, `evaluateHealth`, recovered payments, failed jobs | health view | `GET /api/admin/health` (new) | M |
| 35 | `/admin/audit?page` | admin | `listAudit` | rows | `GET /api/admin/audit` (new) | S |
| 36 | `/admin/security` | admin | `requireAdminPage`, `getMfaStatus`, gated `listAdministrators`, policy flags | security view | `GET /api/admin/security` (new) + `POST /api/admin/security/2fa` (exists) | M |
| 37 | `/admin/settings` | admin | admin email | admin email | admin session (F); change-password POST (exists) | S |

Stay in Next (not UI): every `/api/*` route, `sitemap.ts`, `robots.ts`, `opengraph-image.tsx`, `icon.svg`,
`instrumentation.ts`. No `loading.tsx` and no `"use server"` actions exist.

---

## 5. API gap list

Rules for every row: reuse the existing library function (move page logic into `lib/views/*` instead of copying it);
the page's auth rule (influencer: `requireApiAuth`; admin: `requireAdminMfa()` unless stated); explicit DTO; respond with
`jsonView(data)` (sets `Cache-Control: private, no-store`); covered by the rate-limit entry named; a DB-backed
route-handler test in the style of `tests/admin-mfa-routes.test.ts` (mock `next/headers` cookies) covering 401/403/404,
the shape and `assertNoSecretKeys`. All new rate-limit entries are added by the foundation so group branches never touch
`lib/rate-limit/policies.ts`.

New rate-limit rules (foundation; insert before the broader rule named):
- `auth-session`: `GET ^/api/auth/session$`, 120/min, `session-or-ip` (before `auth-other`, whose 60/15 min is too tight).
- `public-profile`: `GET ^/api/public/profiles/[^/]+$`, 120/min, `ip`.
- `pay-view`: `GET ^/api/pay/[^/]+$`, 30/10 min, `ip`.
- `self-service-view`: `GET ^/api/manage/[^/]+$`, 60/10 min, `ip` (before `self-service`, so page loads do not use up
  the 20/10 min action budget).
- Dashboard GETs fall under `dashboard` (120/min per session); admin GETs under `admin` (120/min per IP). Checked: none of
  the new paths match `admin-security`, `admin-money`, `dashboard-export` or other narrower rules.

| # | Method, path | Auth | Response (DTO) | Reuses | Branch |
|---|---|---|---|---|---|
| A1 | `GET /api/auth/session` | optional cookie | `{authenticated:false}` / `{authenticated:true, user:{email,emailVerified,name,slug,onboarded}}` | `getAuth` | F |
| A2 | `GET /api/admin/session` | optional admin cookie | `{authenticated:false}` / `{authenticated:true, admin:{name,email}, gate}` | `getAdminAuth`, `mfaGateStatus` | F |
| A3 | `GET /api/dashboard/shell` | `requireApiAuth` | `{user:{name,email,slug,photoUrl,emailVerified,onboarded}, attentionCount}` | `loadDashboardShell` (extracted from `app/dashboard/layout.tsx`; layout refactored to call it) | F |
| A4 | `GET /api/admin/shell` | `requireAdminMfa({allowEnrollment:true})` | `{admin:{name,email}, attentionCount, healthCount}` | `loadAdminShell` (extracted from admin layout: `paymentViewCounts`, `getHealthReport().catch`) | F |
| P1 | `GET /api/public/profiles/:slug` | optional cookie (owner preview) | `PublicProfile` or 404 `{error}` | `loadPublicProfile` | booking |
| P2 | `GET /api/pay/:token` | signed token | union by `state`: `invalid`, `not-found`, `booked{serviceTitle,hostName,whenText,manageUrl}`, `requested{hostName,serviceTitle}`, `declined{hostName,hostSlug}`, `expired{hostSlug}`, `payable{bookingId,pollToken,hostName,serviceTitle,whenText,amountText,payByText,prepNotes}`; always 200 | `loadPayView` (`lib/views/booking-pay.ts`, moved from `app/pay/[token]/page.tsx`: `verifyPayToken`, `formatSessionTime`, `formatMoney`, `signBookingPollToken`, `buildSelfServiceUrl`) | booking |
| P3 | `GET /api/manage/:token` (add to existing route file) | signed token | `{state:"expired"}` 403, `{state:"not-found"}` 404, `{state:"ok", booking: ManageBookingData}` 200 | `loadManageView` (`lib/views/booking-manage.ts`, moved from the page; `ManageBookingData` type moves there and `ManageBooking.tsx` imports it) | booking |
| D1 | `GET /api/dashboard/overview` | `requireApiAuth` | `{overview: Overview, readiness: Readiness, live, publicUrl}` | `loadOverviewView` (`getOverview`, `loadReadiness`, `CONNECTION_KEYS`, `appUrl`) | dash-core |
| D2 | `GET /api/dashboard/sessions?view&page` | `requireApiAuth` | `{view, total, page, pageCount, sessions: SessionRow[]}`; unknown view -> `upcoming` | `listSessions` | dash-core |
| D3 | `GET /api/dashboard/messages?status&page` | `requireApiAuth` | `listMessages` result; status whitelist `""|FAILED|PENDING|DELIVERED` | `listMessages` | dash-core |
| D4 | `GET /api/dashboard/customers?q` | `requireApiAuth` | `{customers: CustomerRow[]}` (q trimmed, max 200) | `listCustomers` | dash-core |
| D5 | `GET /api/dashboard/earnings?from&to` | `requireApiAuth` | `{from, to, summary, paymentCount, refundedCount}` (same date defaults and validation) | `loadEarningsView` (`earningsPayments`, `aggregateEarnings`) | dash-core |
| D6 | `GET /api/dashboard/services` (add to existing file) | `requireApiAuth` | `{services: ServiceView[]}` (the page's field list, `parseQuestions`) | `listServiceViews` (`lib/views/dashboard-services.ts`, also used by onboarding) | dash-setup |
| D7 | `GET /api/dashboard/availability` (add to existing file) | `requireApiAuth` | `{timezone, rules:[{id,weekday,startTime,endTime,timezone}], blocked:[{id,date,reason}]}` | `loadAvailabilityView` | dash-setup |
| D8 | `GET /api/dashboard/payouts` | `requireApiAuth` | `{account: PayoutAccountView|null, summary: InfluencerPayoutSummary, feePercentText}` | `getPayoutAccountView`, `influencerPayoutSummary`, `formatFeePercent` | dash-setup |
| D9 | `GET /api/dashboard/settings` | `requireApiAuth` | `{profile:{name,bio,photoUrl,timezone,slug,notifyByEmail}, google: GoogleStatusView, whatsapp: WhatsAppView|null, embedded, origin, email, emailVerified}` | `loadSettingsView` (+ `toGoogleStatusView`, shared with onboarding) | dash-setup |
| D10 | `GET /api/dashboard/onboarding` (add to existing file) | `requireApiAuth` (no onboarded check) | `{profile, services, rules, blocked, google, whatsapp, embedded, payout, checklist, publicUrl, email, emailVerified}` (step and Google outcome stay in the URL) | `loadOnboardingView` | dash-setup |
| M1 | `GET /api/admin/overview` | `requireAdminMfa()` | `{overview, recentAudit:[{id,createdAt,adminEmail,action,targetType}] (max 8), health:{available, unhealthy:[{label,status}]}}` | `getOverview`, `listAudit`, `getHealthReport` | admin-core |
| M2 | `GET /api/admin/influencers?page&q` | `requireAdminMfa()` | `Paged<InfluencerRow>` (q max 80) | `listInfluencers`, `parsePage` | admin-core |
| M3 | `GET /api/admin/influencers/:id` | `requireAdminMfa()` | `{influencer:{id,name,email,slug,timezone,onboardedAt,createdAt,emailVerified}, readinessItems, connections:{google,whatsapp,gmailSend}, payoutAccount, fee:{overrideBps,defaultBps,feeBps,feePercentText}, verified, onlyOneAdmin, currencies:[CurrencyOverview + waitingText], payouts:[{id,createdAt,destination,netMinor,currency,status,reference,owedMinor,approval}], services:[...], bookings:[{id,serviceTitle,startTime,customerName,status,paidMinor,currency}]}`; 404 | `loadAdminInfluencerView(id, adminEmail)` moved from the page (all `lib/payouts`, `lib/readiness`, `lib/admin/data` calls as today) | admin-core |
| M4 | `GET /api/admin/security` | `requireAdminMfa({allowEnrollment:true})` | `{email, selfId, mfa:{enabled,recoveryCodesLeft}, required, fourEyes, fourEyesMinMinor, admins: AdministratorRow[] | null}` (null unless `canViewAdminList`) | `getMfaStatus`, `listAdministrators`, `admin2faRequired`, `fourEyes*` | admin-core |
| M5 | `GET /api/admin/payments?view&page` | `requireAdminMfa()` | `{view, page, pageCount, total, counts, rows:[{id,createdAt,status,needsRefund,refundStatus,refundAmountMinor,amountMinor,currency,reconciledAt,payoutId,providerPaymentId,providerOrderId,mismatch, booking:{status,customerName}, service:{title}, influencer:{id,name}}]}` (`mismatch` computed server-side from `MISMATCH_BOOKING_STATUSES`) | `listPayments`, `paymentViewCounts` | admin-money |
| M6 | `GET /api/admin/payouts?status&page` | `requireAdminMfa()` | `{status, page, pageCount, counts, onlyOneAdmin, rows:[{id,createdAt,influencer:{id,name},destination,grossMinor,refundsMinor,feeMinor,feeBps,feePercentText,netMinor,currency,status,reference,owedMinor,approval}]}` | `loadAdminPayoutsView(status,page,adminEmail)` moved from the page | admin-money |
| M7 | `GET /api/admin/bookings?status&page` | `requireAdminMfa()` | `{status, page, pageCount, total, rows:[{id,serviceTitle,startTime,influencer:{id,name},customerName,status,lastError(<=80),paidMinor,currency}]}` | `listBookings` | admin-money |
| M8 | `GET /api/admin/health` | `requireAdminMfa()` | `{at, thresholds:{workerStaleSeconds,meetingStuckMinutes,queueFailedMax,queueWaitingMax}, report:{conditions,unhealthy}, worker:{status,detail,hint,lastBeatAt,lastBeatAgeText,heartbeatState,heartbeatReason}, recovery, queueNames, queues, recovered, failed}` | `loadAdminHealthView` moved from the page (`collectSnapshot`, `evaluateHealth`, `formatAge`, `listRecoveredPayments`, `listFailedJobs`) | admin-money |
| M9 | `GET /api/admin/audit?page` | `requireAdminMfa()` | `{page, pageCount, rows:[{id,createdAt,adminEmail,action,targetType,targetId,ip}]}` (no `detail`) | `listAudit` | admin-money |

Changed existing code: `lib/admin/session.ts` (`requireAdminMfa` option, F), `lib/http.ts` (re-export
`safeNextPath`, F), `lib/rate-limit/policies.ts` (rules above, F), `lib/auth/slug.ts` (add `assets`, `spa-shell` to
`RESERVED_SLUGS`, F), `app/robots.ts` (allow `/api/public/`, F). Existing endpoints reused unchanged: everything under
`/api/auth/*`, `/api/admin/auth/*`, `/api/admin/security/2fa`, booking/slot/checkout/manage POST, dashboard
mutations, `GET /api/dashboard/bookings/:id|google|whatsapp|payout-account`, `GET /api/auth/sessions`, Google OAuth,
webhooks, health.

Owner check before cutover (not for an implementer to run against the shared DB): confirm no influencer already uses the
slug `assets` or `spa-shell`.

---

## 6. Work breakdown

Order: **F (foundation)** -> six group branches **in parallel** -> **cutover** per group (configuration) ->
**cleanup**. Branch names: `spa/00-foundation`, `spa/10-public-auth`, `spa/20-booking`, `spa/30-dashboard-core`,
`spa/31-dashboard-setup`, `spa/40-admin-core`, `spa/41-admin-money`, `spa/90-cleanup`.

### 6.0 Rules for every branch
- No new dependencies after F; no Prisma migrations; no worker changes.
- Do not edit files owned by another branch. Shared, frozen after F: `web/src/router.tsx`, `web/src/lib/**`,
  `web/src/layouts/**`, `web/src/shims/**`, `lib/spa/**`, `proxy.ts`, `next.config.ts`, `lib/rate-limit/policies.ts`,
  `lib/admin/session.ts`, `package.json`, existing `components/**`, `app/globals.css`, `app/styles/**`. Need a change?
  Raise it; it lands as a small follow-up on F that everyone rebases onto.
- Follow the page port pattern (1.5) and the DTO rule (2.8). Use `Jsonify<T>` types; no `any` for page data (this is
  what makes `tsc` catch a `Date` method called on an ISO string).
- Each branch keeps the old pages working (they are the rollback) and adds tests for every endpoint it creates.
- Parallel dev environment: one git worktree per branch, with the developer's env file copied into the worktree root
  (gitignored; never commit or print it), `npx prisma generate` (no DB access), then
  `PORT=31NN APP_URL=http://localhost:51NN DATABASE_POOL_MAX=2 RATE_LIMIT_STORE=memory npm run dev` and
  `SPA_API_TARGET=http://localhost:31NN npm run dev:web -- --port 51NN` (NN = 01..06 by branch). **Connection budget**:
  the shared Supabase allows 15 connections and the main dev server and worker are already running, so at most two
  branch servers run at the same time, and DB-backed tests run with `DATABASE_POOL_MAX=2` and `--test-concurrency=1`.
  Never start a second worker.

### 6.1 Branch F: `spa/00-foundation` (L, about 4 to 6 days, one implementer)

Goal: everything shared, so groups only add pages, views and their endpoints. After F, production behaviour is
unchanged (`SPA_GROUPS` empty) and with `SPA_GROUPS=all` every route serves the shell with placeholder pages.

**F1. Dependencies and scripts** (`package.json`, lockfile). devDependencies: `vite`, `@vitejs/plugin-react`,
`react-router`, `@tanstack/react-query`, `@fontsource-variable/inter`, `@fontsource-variable/newsreader` (current stable
releases, at least two weeks old, compatible with React 19.3 and Node 22). Scripts:
```
"dev:web": "vite --config web/vite.config.ts",
"build:web": "vite build --config web/vite.config.ts && node scripts/spa-postbuild.mjs",
"build": "npm run build:web && next build",
"typecheck": "tsc --noEmit && tsc --noEmit -p web/tsconfig.json"
```
Root `tsconfig.json`: `"exclude": ["node_modules", "web"]`. `.gitignore`, `.dockerignore` as in 1.8.

**F2. `web/tsconfig.json`**: same strictness as root, `lib: [dom, dom.iterable, esnext]`, `jsx: react-jsx`,
`moduleResolution: bundler`, `types: ["node", "vite/client"]` (node types are needed because type-only imports pull in
server type graphs), `include: ["src/**/*", "vite.config.ts"]`, `paths`: `@/*` -> `../*`, `@web/*` -> `./src/*`,
`next/link` -> `./src/shims/next-link.tsx`, `next/navigation` -> `./src/shims/next-navigation.ts`.
`web/src/env.d.ts` declares `__DESIGN_PAGE__: boolean`.

**F3. `web/vite.config.ts`** (sketch):
```ts
const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
export default defineConfig(({ mode }) => {
  // Only these names are read from the root .env; nothing else (secrets) can reach the bundle.
  const env = loadEnv(mode, repoRoot, ["NEXT_PUBLIC_BRAND_NAME", "NEXT_PUBLIC_SUPPORT_EMAIL", "APP_LOCALE", "ENABLE_DESIGN_PAGE"]);
  const pick = (k: string) => process.env[k] ?? env[k] ?? "";
  return {
    root: here, envDir: here, envPrefix: "VITE_",
    plugins: [react(), serverModuleGuard(repoRoot)],
    resolve: { alias: [/* @web/, @/, next/link, next/navigation as in 1.4 */], dedupe: ["react", "react-dom"] },
    define: {
      "process.env.NEXT_PUBLIC_BRAND_NAME": JSON.stringify(pick("NEXT_PUBLIC_BRAND_NAME")),
      "process.env.NEXT_PUBLIC_SUPPORT_EMAIL": JSON.stringify(pick("NEXT_PUBLIC_SUPPORT_EMAIL")),
      "process.env.APP_LOCALE": JSON.stringify(pick("APP_LOCALE")),
      __DESIGN_PAGE__: JSON.stringify(mode !== "production" || pick("ENABLE_DESIGN_PAGE") === "true"),
    },
    html: { cspNonce: "__CSP_NONCE__" },
    server: {
      port: 5173, strictPort: true, fs: { allow: [repoRoot] },
      proxy: { "^/(api/|sitemap\\.xml|robots\\.txt|icon\\.svg|opengraph-image)": {
        target: process.env.SPA_API_TARGET ?? "http://localhost:3000", changeOrigin: false, xfwd: true } },
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false,
      rollupOptions: { onwarn(w, warn) { if (w.code !== "MODULE_LEVEL_DIRECTIVE") warn(w); } } },
  };
});
```
`serverModuleGuard` implements the rule in 1.4 in `resolveId` (resolve with `skipSelf`, compute the repo-relative path,
`this.error` naming the importer). Brand/support falling back to defaults when empty is handled by `lib/brand.ts`'s `||`.

**F4. `web/index.html`**:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#fbfaf7" />
    <meta name="format-detection" content="telephone=no" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <!--spa-head-->
  </head>
  <body>
    <div id="root"></div>
    <noscript>This site needs JavaScript to work.<!--spa-support--></noscript>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```
(The shell renderer replaces `<!--spa-support-->` with " Questions: <support email>", escaped.)

**F5. Styles**: `web/src/styles.css` imports `@fontsource-variable/inter`, `@fontsource-variable/newsreader`,
`@/app/globals.css` (unchanged tokens/base/components/layouts) and `./spa.css`. `spa.css` defines
`:root { --font-inter: "Inter Variable", ...; --font-newsreader: "Newsreader Variable", ...; }` (the variables
`next/font` used to set) and `main#main:focus { outline: none; }` (programmatic focus target only).

**F6. `web/src/main.tsx`**: `createRoot(#root)`, `<StrictMode>`, top-level error boundary (inline-styled
`GlobalError`, same copy as `app/global-error.tsx`), `QueryClientProvider` (defaults in 1.3), `RouterProvider`, and the
`vite:preloadError` reload-once handler.

**F7. SPA libraries** (`web/src/lib/`):
- `groups.ts`: enabled groups from `<meta name="spa-groups">` (absent = all, i.e. Vite dev); `isSpaHref(href)` using
  `matchSpaRoute` from `lib/spa/routes.ts`.
- `navigate.ts`: `useAppNavigate()` and `<AppNavigate to replace>`: React Router navigation for enabled SPA routes,
  otherwise `window.location.assign`.
- `link.tsx`: `AppLink` (1.4). `shims/next-link.tsx` default-exports it; `shims/next-navigation.ts` as in 1.4.
- `api.ts`: `ApiError`, `apiGet`, the global auth error handler (2.7), `useApiQuery(key, url, options)`.
- `query.ts`: `queryClient` and query-key helpers.
- `session.ts`: `useSession()`, `useAdminSession()`, `useDashboardShell()`, `useAdminShell()`.
- `guards.tsx`: `RequireInfluencer`, `RequireSession`, `GuestOnly`, `RequireAdmin`, `AdminGuestOnly` (2.3).
- `head.tsx`: `<PageTitle title template>` rendering `<title>{formatTitle(...)}</title>` with `formatTitle` imported
  from `lib/spa/routes.ts` (the same function the shell uses, so there is no title flicker).
- `a11y.tsx`: `RouteAnnouncer` (visually hidden `aria-live="assertive"` region announcing `document.title` after each
  pathname change, parity with Next's route announcer; observe `<title>` changes, fallback after 500 ms);
  `FocusOnNavigate` (after a PUSH/REPLACE that changes the pathname, not on first load and not for search-only changes
  such as tabs and pagination, give `#main` `tabIndex=-1` and focus it with `preventScroll`); `HashScroller` (when the
  URL has a hash, scroll the target into view, retrying with a MutationObserver for up to 3 s because data-driven
  pages render the target late, for example `/dashboard/settings#google`).
- `jsonify.ts` type re-export from `lib/jsonify.ts`.

**F8. Layouts and system pages**: `RootLayout` (skip link `<a href="#main" className="skip-link">`, `ScrollRestoration`,
`HashScroller`, `RouteAnnouncer`, `FocusOnNavigate`, `<Outlet/>`); `DashboardLayout` (`AppShell` from the shell query,
default title "Dashboard"); `AdminLayout` (`AdminShell` from the admin shell query). `NotFound`, `ErrorPage` render the
shared `components/views/system/NotFoundView.tsx` / `ErrorView.tsx`, which F extracts from `app/not-found.tsx` and
`app/error.tsx` (those two files are refactored to render them). `NotBuiltYet`: in development says "Not migrated yet.
Open http://localhost:3000<path>"; in production renders `NotFound` (unreachable anyway, see cutover gating).

**F9. `web/src/router.tsx`**: the full tree, every route from section 4, each leaf `lazy` pointing at
`pages/<group>/<Page>.tsx`. F creates every page module as a placeholder exporting `Component = NotBuiltYet` (group
branches replace them). Structure: root (errorElement `ErrorPage`) -> public leaves; `GuestOnly` -> login, register;
forgot/reset/verify leaves; booking leaves (`pay/:token`, `manage/:token`, `:slug/book`, `:slug`); `onboarding` under
`RequireSession`; `dashboard` under `RequireInfluencer` with index + 8 children + `*` NotFound; `admin/login` under
`AdminGuestOnly`; `admin` under `RequireAdmin` with index + 9 children + `*`; `design` only when `__DESIGN_PAGE__`;
`*` NotFound. The lazy-module map is typed `Record<SpaRouteId, ...>`.

**F10. `lib/spa/routes.ts`** (pure, no imports except `lib/auth/slug.ts` constants if needed):
- `SPA_GROUPS = ["public","auth","booking","dashboard","admin"] as const`; `parseSpaGroups(raw)`: empty/undefined ->
  empty set, `all` -> all, else comma list (unknown names ignored; `lib/env.ts` warns).
- `SPA_ROUTES` (as const) with `{ id, path, group, robots: "index"|"noindex"|"noindex,nofollow", title?,
  template: "brand"|"dashboard"|"admin"|"absolute", description?, canonical?, noReferrer?, head:
  "static"|"landing"|"profile"|"book"|"design" }`. Rows:
  - public: `landing /` (absolute landing title, canonical, landing), `terms` "Terms of Service", `privacy` "Privacy
    Policy", `refund-policy` "Refund and Cancellation Policy", `contact` "Contact" (all canonical, index), `design`
    "Design system" (noindex, design).
  - auth: `login` "Log in" (noindex), `register` "Create your account" (index, description "Create a booking page for
    your paid 1:1 and group sessions."), `forgot-password` "Reset your password" (noindex), `reset-password` "Choose a new
    password" (noindex, noReferrer), `verify-email` "Confirm your email" (noindex, noReferrer).
  - booking: `pay /pay/:token` "Complete your booking" (noindex,nofollow), `manage /manage/:token` "Manage your booking"
    (noindex, noReferrer), `book /:slug/book` (head book), `profile /:slug` (head profile).
  - dashboard (template dashboard, noindex): `onboarding /onboarding` "Set up your booking page" (template brand),
    `dashboard /dashboard` "Overview", `/dashboard/sessions` "Sessions", `services`, `availability`, `customers`,
    `earnings`, `payouts`, `messages`, `settings` (titles as the old `metadata`).
  - admin (noindex,nofollow): `admin-login /admin/login` "Admin sign in" (template brand), `/admin` "Overview",
    `influencers` "Influencers", `/admin/influencers/:id` "Influencer", `payments`, `payouts`, `bookings`, `health`
    "System health", `audit` "Audit log", `security` "Security", `settings` "Settings" (template admin).
- `matchSpaRoute(pathname)`: returns null for `/api/*`, `/assets/*`, `/_next/*`, `/spa-shell*`, `/sitemap.xml`,
  `/robots.txt`, `/icon.svg`, `/favicon.ico`, `/opengraph-image*`; exact static paths; `/admin/influencers/:id`;
  unknown `/admin/*` -> admin not-found; unknown `/dashboard/*` or `/onboarding/*` -> dashboard not-found;
  `/pay/:token`, `/manage/:token`; `/:slug/book` and `/:slug` when the segment matches `^[A-Za-z0-9_-]{1,60}$`; anything
  else -> public not-found (`id: "not-found"`, status 404).
- `formatTitle(title, template, brand)`: brand -> `${title} · ${brand}`; dashboard -> `${title} · Dashboard`; admin ->
  `${title} · Admin`; absolute -> title.
- `DEFAULT_DESCRIPTION` (the root layout's description sentence).

**F11. `lib/spa/head.ts` and `lib/spa/shell.ts`** (server only):
- `resolveHead(match, { appUrl, brand, designEnabled })` -> `{ status, title, description?, canonical?, robots?,
  noReferrer?, og?, jsonLd? }` per section 3; profile/book call `loadPublicProfile(slug)` inside try/catch (null ->
  404 head, throw -> 503 head).
- `renderHead(head, nonce)` -> HTML string, every value through `escapeHtml`; JSON-LD via
  `JSON.stringify(...).replace(/</g, "\\u003c")` in `<script type="application/ld+json" nonce>`.
- `loadShellTemplate()` (read once, cache, validate placeholders) and `renderShell(template, { nonce, headHtml,
  groups, supportEmail })`.

**F12. `app/spa-shell/[[...path]]/route.ts`**: as described in 1.6.

**F13. `proxy.ts`**: as in 1.7. **`next.config.ts`**: assets cache header, `outputFileTracingIncludes`.
**`lib/env.ts`**: `SPA_GROUPS` validation and the template check. **`app/robots.ts`**: allow `/api/public/`.
**`lib/auth/slug.ts`**: reserve `assets`, `spa-shell`.

**F14. Endpoints A1 to A4** (section 5), `lib/views/dashboard-shell.ts`, `lib/views/admin-shell.ts`,
`lib/views/http.ts` (`jsonView`), `lib/jsonify.ts` (`Jsonify<T>`, `jsonify()`), `lib/safe-next-path.ts`; refactor
`app/dashboard/layout.tsx` and `app/admin/(console)/layout.tsx` to call the shell view functions;
`requireAdminMfa(opts)`; all rate-limit rules from section 5.

**F15. `scripts/spa-postbuild.mjs`** (1.6) and **`scripts/spa-smoke.mjs`** (7.3; dependency-free, Node 22 `fetch`).

**F16. Docker/compose/CI** (1.8). **Docs**: README section "Front end (React SPA)" (dev workflow with two processes,
`APP_URL` for SPA dev, `SPA_GROUPS`, build), `doc/08-deployment.md` (build outputs, `SPA_GROUPS`, rollback by
configuration, cache headers, Vercel tracing note), `.env.example`.

**F tests** (all `node:test`, run by `npm test`):
- `tests/spa-routes.test.ts`: matching for every route id, exclusions, reserved prefixes, not-found families,
  `parseSpaGroups`, `formatTitle`.
- `tests/spa-shell.test.ts`: renderer with a fixture template (every placeholder replaced, nonce on scripts, groups
  meta, missing-placeholder refusal); head per route class; **escaping** with a profile named
  `"><script>alert(1)</script>` and a bio containing `</title>`; JSON-LD `<` escaping. Profile head via an injected
  loader (no DB).
- `tests/spa-session-endpoints.test.ts` (DB-backed, skips without `DATABASE_URL`): A1 unauthenticated/authenticated;
  A2 for `ok`, `enroll` (with `ADMIN_REQUIRE_2FA=true`), `verify` (password-only session of a 2FA admin); A3 401 and shape;
  A4 allowed for `enroll`, 403 for `verify`; `assertNoSecretKeys` on all.
- extend `tests/rate-limit.test.ts` (each new rule matches, ordering before `auth-other` / `self-service`),
  `tests/env.test.ts` (`SPA_GROUPS` warnings, template check), `tests/admin-mfa-routes.test.ts` (`requireAdminMfa`
  with and without `allowEnrollment` for ok/enroll/verify).

**F acceptance test** (all must pass):
1. `npm run typecheck` (both projects), `npm test`, `npm run build` (guard and secret scan pass; `public/assets` and
   `web/dist/index.html` exist).
2. `SPA_GROUPS` empty: every route behaves exactly as before (old Next pages; spot-check `/`, `/demo`, `/dashboard`,
   `/admin`); the docker job's old-landing assertion passes.
3. `SPA_GROUPS=all` with `next start`: every sample path returns the shell; the CSP header nonce equals every `nonce=`
   in the HTML; placeholders render; no CSP violation in the browser console; `/spa-shell/x` -> 404;
   `/no-such-slug-xyz` -> 404; `/assets/<entry>.js` has `immutable`; dashboard/admin no-cookie redirects unchanged;
   `node scripts/spa-smoke.mjs http://localhost:3000` passes.
4. Vite dev (`npm run dev` + `npm run dev:web`): placeholders render, `/api` proxied, login via the old Next page on
   :3000 then `/dashboard` on :5173 passes `RequireInfluencer`; an enrolling admin is forced to `/admin/security`;
   a password-only 2FA admin session is sent to `/admin/login`.
5. Docker CI job green (both containers).

### 6.2 Branch `spa/10-public-auth` (M, 2 to 3 days). Depends on F.
- Owns: `web/src/pages/public/{Landing,Terms,Privacy,RefundPolicy,Contact,Design}.tsx`,
  `web/src/pages/auth/{Login,Register,ForgotPassword,ResetPassword,VerifyEmail}.tsx`,
  `components/views/public/*`, `components/views/auth/*`, and the old pages `app/page.tsx`, `app/terms|privacy|
  refund-policy|contact|login|register|forgot-password|reset-password|verify-email|design/page.tsx` (refactored to the
  views). No endpoints.
- Notes: legal texts live once in the views (no drift). Landing view takes `loggedIn`; JSON-LD stays in the old page
  and in the shell head. Login keeps `?reset` notice and `next`; register/login keep their full-reload redirects.
  `/design` renders `app/design/DesignShowcase.tsx` (imported in place).
- Acceptance: side-by-side screenshots (old vs SPA, desktop and 375 px) identical; flows F3 (register, verify via
  `EMAIL_PROVIDER=log`), F4 (login with `next`, `?reset`, forgot/reset); keyboard pass and axe on each screen with no
  new violations; titles/canonicals match the old metadata; with `SPA_GROUPS=public,auth` and dashboard disabled, login
  ends on the old Next dashboard via a full navigation.

### 6.3 Branch `spa/20-booking` (M/L, 3 to 4 days). Depends on F.
- Owns: `web/src/pages/booking/{Profile,Book,Pay,Manage}.tsx`, `components/views/booking/*`,
  `app/api/public/profiles/[slug]/route.ts`, `app/api/pay/[token]/route.ts`, the GET in `app/api/manage/[token]/route.ts`,
  `lib/views/booking-pay.ts`, `lib/views/booking-manage.ts`, the old pages `app/[influencer]/page.tsx`,
  `app/[influencer]/book/page.tsx`, `app/pay/[token]/page.tsx`, `app/manage/[token]/page.tsx`, the type import in
  `ManageBooking.tsx`, tests `tests/spa-booking.test.ts`.
- Notes: `BookingFlow`, `PayNow`, `ManageBooking` are imported in place (moved in cleanup). Preview banner and
  "holding disabled" behaviour must stay for the owner. `?service=` preselect. `/pay` keeps `decodeURIComponent(token)`.
- Tests: P1 (live 200, not live 404 for strangers, 200 `preview:true` for the owner, unknown 404); P2 every state
  (invalid, not-found, booked, requested, declined, expired, payable) with seeded bookings; P3 expired/not-found/ok,
  redacted booking -> not-found; `assertNoSecretKeys`.
- Acceptance: F1 and F2 end to end with Razorpay test mode (webhook through the tunnel, or let the recovery job apply
  it) on the SPA: hold countdown, pay, "Confirming", Meet link polling, `.ics`, manage link, reschedule, cancel with the
  refund text; approval flow to `/pay/<token>`; owner preview of a not-live page; `/unknown-slug` 404 status and
  "Not found" view; view-source of `/demo` shows the OG tags; no CSP violations with the Razorpay modal open.

### 6.4 Branch `spa/30-dashboard-core` (L, 3 to 4 days). Depends on F.
- Owns: `web/src/pages/dashboard/{Overview,Sessions,Messages,Customers,Earnings}.tsx`,
  `components/views/dashboard/{Overview,Sessions,Messages,Customers,Earnings}View.tsx`, endpoints D1 to D5
  (`app/api/dashboard/{overview,sessions,messages,customers,earnings}/route.ts`), `lib/views/dashboard-overview.ts`,
  `lib/views/dashboard-earnings.ts`, the five old pages, `tests/spa-dashboard-core.test.ts`.
- Notes: `SessionsBoard` (drawer, actions, reschedule picker) is used unchanged; `?booking=` opens the drawer; tabs and
  pagination are links (query key includes params); customers/earnings filters use `<Form method="get">`; CSV export
  stays a plain anchor.
- Tests: each endpoint 401 without cookie; another influencer's data never appears (create two influencers); view/status
  fallbacks; earnings date defaults; `assertNoSecretKeys`.
- Acceptance: F5 part 1 (overview checklist and attention links incl. `#hash` targets, sessions drawer resend/cancel
  with refund -> reauth dialog -> retry, badge count updates after actions, messages filters, customers search and
  erase, earnings range and CSV); visual parity screenshots; keyboard and axe.

### 6.5 Branch `spa/31-dashboard-setup` (L, 3 to 4 days). Depends on F.
- Owns: `web/src/pages/dashboard/{Services,Availability,Payouts,Settings}.tsx`, `web/src/pages/dashboard/Onboarding.tsx`,
  `components/views/dashboard/{Services,Availability,Payouts,Settings,Onboarding}View.tsx`, endpoints D6 to D10 (GET
  added to `app/api/dashboard/services/route.ts`, `availability/route.ts`, `onboarding/route.ts`; new
  `app/api/dashboard/payouts/route.ts`, `settings/route.ts`), `lib/views/dashboard-{services,availability,payouts,
  settings,onboarding}.ts`, the five old pages, `tests/spa-dashboard-setup.test.ts`.
- Notes: `PayoutAccountView.updatedAt` is a `Date` in the component prop types: revive it in the page
  (`new Date(...)`) rather than editing `PayoutForm`/`PayoutPanel`. Onboarding: step in `?step=` (the wizard's
  `router.replace` keeps working through the shim), `?google=` outcome banners after the OAuth round trip; adding a
  service or hours in the wizard must update "Continue" (refresh -> refetch of the onboarding query).
- Acceptance: F3 onboarding all steps incl. Google connect/disconnect with each `?google=` outcome, WhatsApp manual
  connect form validation, payout details save (reauth + email), F5 part 2 (services create/edit/hide with questions,
  weekly hours, blocked dates, settings profile/slug change dialog/notifications/password/devices/log out everywhere);
  visual parity; keyboard and axe.

### 6.6 Branch `spa/40-admin-core` (L, 3 to 4 days). Depends on F.
- Owns: `web/src/pages/admin/{Login,Overview,Influencers,InfluencerDetail,Security,Settings}.tsx`,
  `components/views/admin/{Login,Overview,Influencers,InfluencerDetail,Security,Settings}View.tsx`, endpoints M1 to M4
  (`app/api/admin/overview/route.ts`, `influencers/route.ts`, `influencers/[id]/route.ts`, `security/route.ts`),
  `lib/views/admin-{overview,influencer,security}.ts`, the six old pages, `tests/spa-admin-core.test.ts`.
- Must port the page-based assertions of `tests/admin-mfa-routes.test.ts` ("the administrator list is hidden ...")
  to `GET /api/admin/security` in its own test file (enrolling admin: 200 with `admins: null`; password-only 2FA admin:
  403 `mfaAction: "verify"`; verified: list present), so cleanup can delete the page import.
- Gate tests for M1 to M3: 401, 403 enroll, 403 verify, 200 ok; M3 404; approval view is per viewer (creator cannot
  approve, second admin can); `assertNoSecretKeys`.
- Acceptance: F6 part 1: sign-in without 2FA and `ADMIN_REQUIRE_2FA=true` -> forced to Security; enrol (secret and
  otpauth link, confirm code, recovery codes shown and downloaded); sign out; sign in with TOTP; with a recovery code;
  locked-out message; password-only 2FA session bounced to login; influencer detail: reveal/verify/reject payout
  details, fee change, create payout, four-eyes approve as a second admin; change password; visual parity; keyboard and axe.

### 6.7 Branch `spa/41-admin-money` (M, 2 to 3 days). Depends on F.
- Owns: `web/src/pages/admin/{Payments,Payouts,Bookings,Health,Audit}.tsx`,
  `components/views/admin/{Payments,Payouts,Bookings,Health,Audit}View.tsx`, endpoints M5 to M9
  (`app/api/admin/{payments,payouts,bookings,health,audit}/route.ts`), `lib/views/admin-{payouts,health}.ts`, the five
  old pages, `tests/spa-admin-money.test.ts`.
- Note: `app/api/admin/payouts/route.ts` (GET) sits next to the existing `payouts/[id]/route.ts`; the admin-money
  rate rule only matches `POST/PATCH` on `payouts/...`, so the GET falls under `admin` (asserted in F's rule tests).
- Acceptance: F6 part 2: reconcile and undo, payouts tabs with counts, mark paid with UTR, cancel, "refunded since"
  badge, bookings filters, health page incl. the "Worker is not running" rendering (check it with a view-component
  render from a fixture whose heartbeat is stale; never stop the shared worker) and the Refresh button re-fetching, audit
  pagination; gate tests 401/403/200 for M5 to M9; visual parity; keyboard and axe.

### 6.8 Cutover (configuration, per group, owner-run)
For each group in the order public -> auth -> booking -> dashboard -> admin: verify on a staging deployment with
`SPA_GROUPS` including it (flows in section 7), then add it to production `SPA_GROUPS` and restart. Watch for 24 h:
error webhook, admin System health, 4xx/5xx rates on the new endpoints, 429s from the new rate rules, and for booking
the webhook log and the payment-recovery count. Rollback = remove the group from `SPA_GROUPS` and restart.

### 6.9 Branch `spa/90-cleanup` (M, 2 to 3 days). Depends on all groups live in production for at least 7 days with no rollback.
1. Delete old pages, layouts, `app/error.tsx`, `app/global-error.tsx`; keep a minimal `app/layout.tsx` (html/body) and a
   minimal `app/not-found.tsx` only if `next build` requires them (the proxy sends every page path to the shell).
2. Move `components/**` -> `web/src/components/**`, `app/globals.css` + `app/styles/**` -> `web/src/styles/**`,
   `BookingFlow.tsx`, `PayNow.tsx`, `ManageBooking.tsx`, `DesignShowcase.tsx` -> `web/src/pages/...`; switch imports to
   `@web/...`; replace `next/link` / `next/navigation` imports with `@web/lib/link` / `@web/lib/navigate`; delete the shims
   and aliases; drop `"use client"`; drop `jsonify()` calls that only existed for old pages (view functions stay; the
   endpoints use them).
3. `proxy.ts`: remove `SPA_GROUPS` gating (every matched page path goes to the shell) and `x-pathname`; keep the cookie
   redirects, the `/spa-shell` block, the prefetch rule. `lib/env.ts`: drop `SPA_GROUPS` (warn if still set).
4. Remove `requirePageAuth` (`lib/auth/guards.ts`) and `requireAdminPage`; port or delete their tests
   (`tests/admin-mfa-routes.test.ts` page import, `requireAdminPage` assertions -> endpoint gate tests from 6.6).
5. Server-code guard allowlist re-checked; docs (README, doc/08, `.env.example`, and `CLAUDE.md`, which is out of date).
- Acceptance: typecheck/tests/build/docker green; `grep` finds no `next/link|next/navigation|next/headers` outside
  `app/api`, `app/spa-shell`, metadata routes and server `lib`; full walk-through F1 to F10 once more.

---

## 7. Risks, verification and rollback

### 7.1 What could silently break, and how each is caught

| Risk | Check |
|---|---|
| New JSON endpoints expose fields the server pages never sent (encrypted tokens, hashes, admin-only fields) | DTO rule; `assertNoSecretKeys` in every endpoint test; review checklist "each field is rendered somewhere" |
| Admin data readable by a session that could not open the page (`verify` / `enroll`) | `requireAdminMfa()` on all admin reads; gate tests ok/enroll/verify per endpoint |
| Another influencer's data via a new dashboard endpoint | Two-influencer ownership tests per endpoint |
| Blank page from CSP (nonce missing on a script, Vite inline script) | Template placeholder check at build, start-up and render; smoke compares header and HTML nonces; console check in production mode on every flow |
| XSS through server-injected head (profile name/bio) | `escapeHtml` + malicious-name test; React escapes the rest |
| Server code or secrets in the browser bundle | Vite guard plugin; post-build `process.env` and secret-value scan; `loadEnv` restricted to four names, `envPrefix: VITE_` |
| Two React copies -> "Invalid hook call" | Single `package.json`; `resolve.dedupe` |
| `router.refresh()` no longer refreshing data or badges | Shim invalidates all active queries; walk-through checks every mutation updates the screen and the sidebar badge |
| Same-URL "Refresh" links doing nothing | `AppLink` same-location invalidation; health page check |
| `Date` vs ISO string (dates shown raw) | `Jsonify` types (string has no `toLocaleDateString`, and `toLocaleString(locale, opts)` does not type-check); no `any` |
| Soft 404s for unknown profiles; private pages indexed | Shell status codes and `X-Robots-Tag`; smoke checks |
| Profile content invisible to Google because `/api/` is disallowed | `robots.ts` allows `/api/public/`; check with Search Console URL inspection after cutover |
| Token URLs leaking via Referer | `Referrer-Policy: no-referrer` header on manage/verify/reset shells; smoke check |
| Rolling cookie stops rolling in long-lived tabs | Proxy refreshes the cookie on GET `/api/*`; test that the response carries `Set-Cookie` with max-age |
| Rate limits hit by the extra API calls (shared NAT on a popular booking page) | Dedicated rules with headroom; watch 429s at cutover; `RATE_LIMIT_MULTIPLIER` as the lever |
| Database connection pressure (15-connection cap) | Guard and layout share one request; no focus refetch; branch servers at pool 2; watch pool waits during cutover |
| Mixed mode: SPA page linking to a not-yet-migrated page and back | `AppLink`/`appNavigate` group check; Next client hard-navigates when it receives HTML; prefetch 204; walk-through with partial `SPA_GROUPS` |
| Stale chunks after deploy | `/assets` never falls back to HTML; `vite:preloadError` reload once |
| Focus, announcements, hash targets (accessibility) | `RouteAnnouncer`, `FocusOnNavigate`, `HashScroller`; keyboard and screen-reader spot checks; axe per screen |
| OAuth return pages (`?google=`), Razorpay modal, Facebook SDK | Covered by F1, F2, F3 in production mode |
| Tests that import Next pages break at cleanup | Ported in 6.6 before cleanup |
| Template missing in an image or on Vercel | `outputFileTracingIncludes` + explicit COPY + start-up refusal + docker smoke |

### 7.2 Verification layers (every branch, in this order)
1. `npm run typecheck` (root and web).
2. `npm test` (pure tests always; DB-backed ones against the shared database with `DATABASE_POOL_MAX=2
   --test-concurrency=1`, because the dev server and worker are using connections).
3. `npm run build` (Vite + guard + secret scan + Next).
4. `node scripts/spa-smoke.mjs <base-url>` against `next start` with the branch's groups enabled.
5. Browser walk-through of the branch's named flows in **production mode** (`npm run build && SPA_GROUPS=... npm start`)
   for CSP, plus Vite dev for axe (no CSP there).

### 7.3 Smoke script (`scripts/spa-smoke.mjs`, F; dependency-free)
Embedded sample list (one per route class: `/`, `/terms`, `/register`, `/login`, `/reset-password?token=x`,
`/demo`, `/demo/book`, `/no-such-slug-xyz`, `/pay/bad`, `/manage/bad`, `/a/b/c`, `/dashboard`, `/admin`,
`/admin/login`). For each: status (DB-independent routes exact; profile routes 200/404, or 503 with `--no-db`),
`content-type: text/html`, `<div id="root">`, CSP header present and its nonce equal to every `nonce="..."` in the body,
`cache-control: no-store`, robots meta/`X-Robots-Tag` per class, `Referrer-Policy: no-referrer` on token routes,
canonical and OG on `/`; security headers from `next.config` present; `/dashboard` and `/admin` without cookies ->
307 to the login pages; `/spa-shell/x` -> 404; one `/assets/*` file (read from the shell) -> 200 with `immutable`;
`GET /api/auth/session` and `GET /api/admin/session` -> `{authenticated:false}`; `POST /api/auth/logout` with
`Origin: https://evil.example` -> 403; `GET /api/public/profiles/demo` shape (skipped with `--no-db`); no stack traces
or connection strings in any body.

### 7.4 Named browser walk-throughs
- **F1 Customer booking**: landing -> demo profile -> book (service preselect, time zone switch, month navigation) ->
  hold -> Razorpay test payment -> confirmation, Meet link appears, `.ics`, resend link -> manage link -> reschedule ->
  cancel (refund text).
- **F2 Approval booking**: request on an approval service -> influencer approves in Sessions > Requests -> customer opens
  `/pay/<token>` -> pays -> already-booked state on reload; declined and expired states.
- **F3 New influencer**: register (slug availability) -> verify email (log provider) -> onboarding every step
  (Google connect with each `?google=` outcome, WhatsApp manual form, payout details) -> finish -> dashboard.
- **F4 Session**: login with `next`, `?reset` notice, forgot/reset, logout, log out everywhere, device revoke, reauth
  dialog (shorten `authenticatedAt` in a test database or rely on the existing unit tests for the 8-hour rule).
- **F5 Dashboard**: every page and mutation listed in 6.4 and 6.5; sidebar badge updates.
- **F6 Admin**: everything listed in 6.6 and 6.7, with two administrators for four-eyes.
- **F7 Accessibility**: keyboard-only through login, booking flow, dashboard nav, a dialog, the drawer; skip link; route
  change announced by a screen reader (NVDA or VoiceOver spot check); focus lands in `main`; axe on every screen with no
  new violations compared with the old page.
- **F8 CSP**: production mode, browser console free of CSP violations on F1 to F6.
- **F9 SEO**: view-source of `/`, `/terms`, `/demo` (title, description, canonical, OG, JSON-LD on `/`);
  `/no-such-slug` 404; owner preview 200 + `noindex`.
- **F10 Mixed mode**: with `SPA_GROUPS=public,auth`, navigate landing -> login -> (Next) dashboard -> link back to
  landing; with `SPA_GROUPS=dashboard` only, an old Next page link into the dashboard hard-navigates correctly.
- Visual parity: screenshots old vs new for every route at desktop width and 375 px.

### 7.5 Rollback
- Until cleanup, every group can be switched back to the old Next pages by removing it from `SPA_GROUPS` and restarting;
  no code deploy is needed. The new endpoints and view functions are additive, and the old pages render from the same
  view functions and view components (checked by typecheck, tests and the parity screenshots).
- The foundation itself is inert with `SPA_GROUPS` empty (only additive endpoints, rate rules, a cookie refresh on
  GET API responses, the `/spa-shell` block and the `assets/` matcher exclusion); reverting the merge restores the
  previous state.
- Cleanup runs only after all groups have been live for at least 7 days without a rollback. After cleanup, rollback is
  redeploying the previous image (or reverting the cleanup merge), since the old pages no longer exist on `main`.
