# React SPA migration: Branch F (`spa/00-foundation`), deviations, notes and progress log

This file belongs to the foundation branch. It records (1) where the code or the installed packages made the plan
(`doc/10-react-migration-plan.md`) impossible, wrong or incomplete, and what was done instead, (2) additions the plan did not
list, (3) what the group branches and the owner must know, and (4) a progress log so that another person can continue if the work
stops. Group branches: read sections 1 and 3 before relying on the plan's wording for the items listed there.

## 1. Deviations from the plan

| # | Plan says | What was done | Why |
|---|---|---|---|
| D1 | "Branch from the current HEAD"; the plan "is already committed in your checkout" | `spa/00-foundation` was created from the tip of `main` (`c2681ae`, which contains the plan). `main` itself was not touched. | The agent worktree had been cut from `2d5f3b1`, three merges before the plan was committed, so the plan file did not exist there. `2d5f3b1` is an ancestor of `main`; only the base moved forward (plan, `npm run dev:logins`). |
| D2 | `react-router` "current stable" (F1), "React Router 7" (section 0) | Pinned `react-router@7.18.4`, not the 8.x line (latest 8.4.0). | The decision names React Router 7. 8.x requires Node `>=22.22.0`, this repository declares `>=22`; 7.18.4 (published the same day as 8.4.0, still maintained) runs on Node 20+. The data-mode APIs used (`createBrowserRouter`, `lazy`, `ScrollRestoration`, `react-router/dom`'s `RouterProvider`) were checked against 7.18.4. |
| D3 | "current stable ... at least two weeks old" | All six new packages are pinned to EXACT versions: `vite 8.3.1` (published 2026-09-24), `@vitejs/plugin-react 6.1.1`, `react-router 7.18.4`, `@tanstack/react-query 5.103.2`, `@fontsource-variable/inter 5.3.0`, `@fontsource-variable/newsreader 5.3.0`. | Newer patch releases (vite 8.3.2+, react-query 5.103.3+, plugin-react 6.1.2) are younger than two weeks on 2026-10-10. Exact pins stop a later `npm install` drifting onto them. |
| D4 | Vite config uses `build.rollupOptions` (F3 sketch) | `build.rolldownOptions.onwarn`. | Vite 8 builds with Rolldown; `rollupOptions` is a deprecated alias there. `html.cspNonce` exists in 8.3.1 and behaves as the plan assumes (nonce on every `script`/`style`/`link rel=stylesheet|modulepreload|preload`, plus `<meta property="csp-nonce">`; verified in `web/dist/index.html` and in the browser under the real CSP). |
| D5 | `web/` has no `package.json` | Added `web/package.json` containing only `{"private": true, "type": "module"}` (no dependencies, not a workspace; there is still one `node_modules` and one React). | Without it Vite 8 loads `web/vite.config.ts` as CommonJS and prints a "configLoader native" warning on every run. `vite.config.ts` therefore imports its plugin as `./vite-server-guard.ts` (with extension) and `web/tsconfig.json` sets `allowImportingTsExtensions`. |
| D6 | `web/tsconfig.json` maps `next/navigation` to `./src/shims/next-navigation.ts` | It maps to `./src/shims/next-navigation-types.d.ts`, which re-exports the real shim and additionally DECLARES the server-only `redirect`, `permanentRedirect`, `notFound`, `forbidden`, `unauthorized` (types only). The Vite alias still points at the real shim, which does not export them. | `import type { X } from "@/lib/..."` makes `tsc` read the server file X lives in, and `lib/admin/session.ts` / `lib/auth/guards.ts` call `redirect()`/`notFound()`. The path mapping applies to every file of the program, so against the bare shim those type-only imports failed to type-check. A RUNTIME import of such a function still fails the build (missing export) and the server-module guard. |
| D7 | `DashboardLayout` has "default title Dashboard" | The layouts render NO `<title>`. Each page renders exactly one `<PageTitle>` (rules at the top of `web/src/lib/head.tsx`). | React 19 inserts a hoisted `<title>` before the first existing `head > title`; parents commit after children, so a layout title would always beat the page's own. Pages (including placeholders, `NotFound`, `ErrorPage`) set theirs. Verified in the browser: the page's title is `document.title`, the server-written one stays behind it in `<head>`. |
| D8 | `web/src/lib/navigate.ts` | `navigate.tsx`. | It exports the `<AppNavigate>` component, which contains JSX. Imports are extensionless, so nothing changes for users. |
| D9 | NotBuiltYet says "Open http://localhost:3000<path>" | Uses `__NEXT_DEV_ORIGIN__`, a `define` set only by `vite serve` from `SPA_API_TARGET` (default `http://localhost:3000`), empty in a production build. | The parallel dev setup runs Next on ports 31NN, not 3000. It is not a secret and is declared in `web/src/env.d.ts`. |
| D10 | `/dashboard/*` and `/admin/*` `*` routes render `NotFound` inside the frame | They render `NotFoundView embedded` (card only, no second `main#main`); `NotFoundView` gained an `embedded` prop. | `NotFoundView` includes `FocusedLayout`, which has its own `<main id="main">`; the frames already provide one. |
| D11 | `lib/spa/routes.ts` "pure, no imports" | Kept pure. Additions: ids `dashboard-not-found` / `admin-not-found` for the group-specific 404 rows; a `{brand}` token in titles (the landing title is absolute and contains the brand); paths starting `/__next` are excluded from matching (Next dev endpoints such as the error overlay must keep reaching Next when the SPA is enabled); `matchEnabledSpaRoute`, `decodeSpaParam`, `spaRouteById`, `unknownSpaGroups` helpers. | Needed to implement section 1.7 and F10 without leaking brand into a pure module, and to keep `next dev` working with the SPA enabled. |
| D12 | `loadShellTemplate()`, `renderHead(head, nonce)` | `renderHead(head, brand, nonce)`; `escapeHtml` is exported from `lib/spa/head.ts`; `resolveHead` takes an injected `loadProfile` (and `designEnabled`, `supportEmail`, `appUrl`, `brand`) instead of importing the database. | Keeps head tests database-free and the head module free of server imports. |
| D13 | Section 1.7: the proxy answers a Next client prefetch of an SPA page with `204` by checking `next-router-prefetch` | The check is in the shell ROUTE and covers every request that carries `rsc` or `next-router-prefetch`; the proxy no longer has it. | Next strips its flight headers (`rsc`, `next-router-prefetch`, `next-router-state-tree`) from the request the proxy sees (`node_modules/next/dist/docs/.../proxy.md`, "RSC requests and rewrites"), so the plan's check could never fire. The rewrite target does receive them. Verified with curl and in a real browser: on an old Next page (`SPA_GROUPS=public`) a `<Link>` to `/terms` ends in a full page load of the SPA shell. |
| D14 | The shell route sets `Referrer-Policy: no-referrer` on token routes | `proxy.ts` sets it on the rewrite response; the route sets it too as a fallback and the head carries `<meta name="referrer">`. | The security headers in `next.config.ts` (`Referrer-Policy: strict-origin-when-cross-origin`) replace any response header with the same name that a route handler sets (observed). A header set by the proxy wins. |
| D15 | `useDashboardShell` / `useAdminShell` use the default `staleTime: 0` | `staleTime: 5_000` for these two. | The guard and the layout it renders both read the shell query; with `staleTime: 0` the layout's mount refetched, so each page load made two requests (observed in the browser network log). `router.refresh()` still refetches (invalidation ignores `staleTime`). |
| D16 | (not in the plan) | `/* turbopackIgnore: true */` on `path.join(cwd, "web/dist/index.html")` in `lib/env.ts` and `lib/spa/shell.ts`. | `next build` otherwise warned "Dynamic filesystem access causes tracing of the whole project". The file is added to the trace explicitly (`outputFileTracingIncludes`; key `"/spa-shell/\\[\\[\\.\\.\\.path\\]\\]"`, verified in `.next/server/app/spa-shell/[[...path]]/route.js.nft.json`). |
| D17 | Guard allowlist = the lib files listed in 1.4 | The guard additionally refuses `proxy.ts`, `instrumentation.ts`, `prisma/`, `scripts/`, `tests/`, any `app/**/{page,layout,route,not-found,error,global-error}.ts(x)`, and the packages `prisma` and `dotenv`; `next` only as `next/link` and `next/navigation`. | Defence in depth; none of these has a legitimate use in browser code. |
| D18 | `RootLayout` lists `ScrollRestoration` before `<Outlet/>` | It is rendered after the outlet. | No behavioural difference; React Router documents either position. |

## 2. Additions the plan did not list

- `web/src/lib/states.tsx`: `PageLoading`, `PageError`, `QueryGate`. The plan's section 2.7 defines how every page must treat 404 / 429 / other
  query errors; shipping one implementation stops six branches from writing six variants.
- `lib/views/session.ts`: the DTO types and builders of the two session endpoints (shared with the SPA by `import type`).
- `components/views/system/NotFoundView.tsx` and `ErrorView.tsx` as the plan says; `app/not-found.tsx` and `app/error.tsx` now render them.
- `app/layout.tsx` imports `DEFAULT_DESCRIPTION` from `lib/spa/routes.ts` instead of repeating the sentence (no behaviour change).
- `web/src/lib/guards.tsx` loads the dashboard and admin layouts with `React.lazy` so the landing/booking pages do not download the sidebars.
- `scripts/spa-postbuild.mjs` also verifies that EVERY script/style/stylesheet/preload tag in the template has `nonce="__CSP_NONCE__"`, that the
  `<!--spa-support-->` marker is present, and that no inline script with code was emitted.
- `scripts/spa-smoke.mjs` has `--old` (SPA_GROUPS empty: old pages expected) and `--verbose` besides the planned `--no-db`.
- The Docker CI job additionally proves that the web process refuses to start when `SPA_GROUPS` is set and the template is missing.
- Tests beyond the plan's list: `tests/spa-views.test.ts` (jsonify, safeNextPath, jsonView, assertNoSecretKeys), `tests/spa-guard.test.ts` (server-module guard
  rules and a real Vite build that must fail), `tests/spa-postbuild.test.ts` (template checks, `process.env` scan, secret scan; child process on fixture
  directories), `tests/spa-proxy.test.ts` and `tests/spa-proxy-empty.test.ts` (the SPA switch; and that with `SPA_GROUPS` empty nothing is rewritten),
  `tests/spa-shell-route.test.ts` (the route handler with a fixture template).

## 3. What the group branches and the owner must know

**For group branches (everything below is frozen: `web/src/{router.tsx,lib,layouts,shims}`, `lib/spa/**`, `proxy.ts`, `next.config.ts`, `lib/rate-limit/policies.ts`,
`lib/admin/session.ts`, `package.json`):**

1. **Adding a page.** Replace the placeholder `web/src/pages/<group>/<Page>.tsx` (it exports `Component`; the router already points at it). Render exactly one
   `<PageTitle title template>` using the route's row in `lib/spa/routes.ts`, also while loading. Fetch with `useApiQuery(queryKeys.x(...), url)` and render
   `<QueryGate query={q}>{(data) => <XView data={data} />}</QueryGate>` (pass `embedded` inside the dashboard/admin frames). Page data types are `Jsonify<XView>`.
2. **Endpoints.** Respond with `jsonView(data)` (private, no-store, object only). Build the DTO field by field. Influencer: `requireApiAuth()`; admin reads:
   `requireAdminMfa()` (never `requireAdminApi`, which lets a password-only session of a 2FA admin through). Call `assertNoSecretKeys(body, allow?)` from
   `tests/helpers/assert-no-secret-keys.ts` on every response in the endpoint's test. All rate-limit rules already exist; the new GET paths in the plan fall under `dashboard` / `admin`
   (asserted in `tests/rate-limit.test.ts`).
3. **Endpoint tests.** Copy the pattern of `tests/spa-session-endpoints.test.ts` (mock `next/headers` cookies, create users/admins with timestamped names, delete them in `after`).
   **Delete `process.env.REDIS_URL` in `before` when a route can reach `getHealthReport()`** (the admin shell and health do): otherwise BullMQ keeps a Redis connection open and the test
   process never exits. Run DB tests one file at a time with `DATABASE_POOL_MAX=2`.
4. **Type-check surface.** `tsc -p web/tsconfig.json` also reads server files that browser code imports with `import type`; that is why `next-navigation-types.d.ts` declares the server-only
   `redirect`/`notFound` (D6). Do not `import` (not `import type`) anything from `lib/` that is not on the allowlist in `web/vite-server-guard.ts`; the build tells you which line.
5. **`router.refresh()`** in shared components invalidates every active query. A same-URL `<Link>` does too. `useRouter().push/replace` and `AppLink` fall back to a full page load for a
   path whose group is not in `SPA_GROUPS` (`web/src/lib/groups.ts`), so a half-migrated deployment links correctly in both directions (verified in a browser).
6. **Placeholders in production.** A page that is still a placeholder renders the 404 view (`NotBuiltYet`). It cannot be reached while its group stays out of `SPA_GROUPS`; turning a group on
   before its branch has landed shows 404s.
7. **Production-mode checks.** `npm run build`, then `SPA_GROUPS=<your group> npm start` (port 3101 with `APP_URL=http://localhost:3101`, `ALLOW_INSECURE_LOCAL_RUN=true`,
   `RATE_LIMIT_STORE=memory`, `DATABASE_POOL_MAX=2`), `node scripts/spa-smoke.mjs http://localhost:3101`. The Vite dev server applies no CSP; the console CSP check only means something in this mode.
8. **React StrictMode** (dev) runs effects twice, so the first request of every query shows as `ERR_ABORTED` in the network tab. That is normal.
9. `tests/` files are CommonJS under tsx: use `await import("vite")` (not a static import) when a test needs Vite's API.

**For the owner:**

- Before cut-over confirm no influencer already uses the slug `assets` or `spa-shell` (plan section 5). Both are reserved for new accounts now.
- Existing gap, not introduced here: `pay` is not in `RESERVED_SLUGS`. A profile with the slug `pay` would be reachable at `/pay`, but its booking page `/pay/book` is taken by the pay-link route
  (a static first segment wins, in Next and in the SPA alike). Not changed because it is outside the migration; adding `pay` to the reserved list is a one-line follow-up.
- The GitHub Actions workflow could not be run from this machine; its Docker steps were exercised locally with the same commands (see the progress log), and the new `check`-job steps
  are the same commands that were run here.
- `x-pathname` is still set by the proxy (the old admin layout needs it); the SPA never reads it. It goes away in the cleanup branch.

## 4. Progress log

| Item | State |
|---|---|
| Setup: worktree, `npm ci`, `.env` copied, `prisma generate`, dependencies installed | done |
| F1 dependencies, scripts, ignore files | done |
| F2 `web/tsconfig.json`, `env.d.ts` | done |
| F3 `web/vite.config.ts`, server-module guard (+ tests) | done |
| F4 `web/index.html` | done |
| F5 styles | done |
| F6 `main.tsx` | done |
| F7 SPA libraries (`groups`, `navigate`, `link`, `api`, `query`, `session`, `guards`, `head`, `a11y`, `jsonify`, plus `states`) | done |
| F8 layouts and system pages, shared 404/error views | done |
| F9 router with 36 placeholder page modules | done |
| F10 `lib/spa/routes.ts` | done |
| F11 `lib/spa/head.ts`, `lib/spa/shell.ts` | done |
| F12 `app/spa-shell/[[...path]]/route.ts` | done |
| F13 `proxy.ts`, `next.config.ts`, `lib/env.ts`, `app/robots.ts`, `lib/auth/slug.ts` | done |
| F14 endpoints A1 to A4, view functions, `jsonView`, `jsonify`, `safe-next-path`, layout refactors, `requireAdminMfa(opts)`, rate-limit rules | done |
| F15 `scripts/spa-postbuild.mjs`, `scripts/spa-smoke.mjs` | done |
| F16 Dockerfile, compose, CI, README, `doc/08-deployment.md`, `.env.example` | done |
| F tests | done (see the final report for counts) |
