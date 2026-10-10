# React SPA migration: Branch F (`spa/00-foundation`), deviations and progress log

This file belongs to the foundation branch. It records (1) where the code or the installed packages made the plan
(`doc/10-react-migration-plan.md`) impossible, wrong or incomplete, and what was done instead, (2) additions the plan did not
list but that the group branches should know about, and (3) a short progress log so that another person can continue if the
work stops. The group branches should read sections 1 and 2 before relying on the plan's wording for the items listed there.

## 1. Deviations from the plan

| # | Plan says | What was done | Why |
|---|---|---|---|
| D1 | "Branch from the current HEAD"; the plan "is already committed in your checkout" | `spa/00-foundation` was created from the tip of `main` (`c2681ae`, which contains the plan). `main` itself was not touched. | The agent worktree had been cut from `2d5f3b1`, three merges before the plan was committed, so the plan file did not exist there. `2d5f3b1` is an ancestor of `main`; only the base moved forward (plan, `npm run dev:logins`). |
| D2 | `react-router` "current stable" (F1), "React Router 7" (section 0) | Pinned `react-router@7.18.4`, not the 8.x line (latest 8.4.0). | The decision names React Router 7. 8.x requires Node `>=22.22.0`, this repository declares `>=22`; 7.18.4 (published the same day as 8.4.0, still maintained) runs on Node 20+. The data-mode APIs used (`createBrowserRouter`, `lazy`, `ScrollRestoration`, `react-router/dom`'s `RouterProvider`) were checked against 7.18.4. |
| D3 | "current stable ... at least two weeks old" | All six new packages are pinned to EXACT versions: `vite 8.3.1` (published 2026-09-24), `@vitejs/plugin-react 6.1.1`, `react-router 7.18.4`, `@tanstack/react-query 5.103.2`, `@fontsource-variable/inter 5.3.0`, `@fontsource-variable/newsreader 5.3.0`. | Newer patch releases (vite 8.3.2+, react-query 5.103.3+, plugin-react 6.1.2) are younger than two weeks on 2026-10-10. Exact pins stop a later `npm install` drifting onto them. |
| D4 | Vite config uses `build.rollupOptions` (F3 sketch) | `build.rolldownOptions.onwarn`. | Vite 8 builds with Rolldown; `rollupOptions` is a deprecated alias there. `html.cspNonce` exists in 8.3.1 and behaves as the plan assumes (nonce on every `script`/`style`/`link rel=stylesheet|modulepreload|preload`, plus `<meta property="csp-nonce">`; verified in `web/dist/index.html`). |
| D5 | `web/` has no `package.json` | Added `web/package.json` containing only `{"private": true, "type": "module"}` (no dependencies, not a workspace; there is still one `node_modules` and one React). | Without it Vite 8 loads `web/vite.config.ts` as CommonJS and prints a "configLoader native" warning on every run. `vite.config.ts` therefore imports its plugin as `./vite-server-guard.ts` (with extension) and `web/tsconfig.json` sets `allowImportingTsExtensions`. |
| D6 | `web/tsconfig.json` maps `next/navigation` to `./src/shims/next-navigation.ts` | It maps to `./src/shims/next-navigation-types.d.ts`, which re-exports the real shim and additionally DECLARES the server-only `redirect`, `permanentRedirect`, `notFound`, `forbidden`, `unauthorized` (types only). The Vite alias still points at the real shim, which does not export them. | `import type { X } from "@/lib/..."` makes `tsc` read the server file X lives in, and `lib/admin/session.ts` / `lib/auth/guards.ts` call `redirect()`/`notFound()`. The path mapping applies to every file of the program, so against the bare shim those type-only imports failed to type-check. A RUNTIME import of such a function still fails the build (missing export) and the server-module guard. |
| D7 | `DashboardLayout` has "default title Dashboard" | The layouts render NO `<title>`. Each page renders exactly one `<PageTitle>` (rules at the top of `web/src/lib/head.tsx`). | React 19 inserts a hoisted `<title>` before the first existing `head > title`; parents commit after children, so a layout title would always beat the page's own. Pages (including placeholders, `NotFound`, `ErrorPage`) set theirs. |
| D8 | `web/src/lib/navigate.ts` | `navigate.tsx`. | It exports the `<AppNavigate>` component, which contains JSX. Imports are extensionless, so nothing changes for users. |
| D9 | NotBuiltYet says "Open http://localhost:3000<path>" | Uses `__NEXT_DEV_ORIGIN__`, a `define` set only by `vite serve` from `SPA_API_TARGET` (default `http://localhost:3000`), empty in a production build. | The parallel dev setup runs Next on ports 31NN, not 3000. It is not a secret and is declared in `web/src/env.d.ts`. |
| D10 | `/dashboard/*` and `/admin/*` `*` routes render `NotFound` inside the frame | They render `NotFoundView embedded` (card only, no second `main#main`); `NotFoundView` gained an `embedded` prop. | `NotFoundView` includes `FocusedLayout`, which has its own `<main id="main">`; the frames already provide one. |
| D11 | `lib/spa/routes.ts` "pure, no imports" | Kept pure. Additions: ids `dashboard-not-found` / `admin-not-found` for the group-specific 404 rows; a `{brand}` token in titles (the landing title is absolute and contains the brand); paths starting `/__next` are excluded from matching (Next dev endpoints such as the error overlay must keep reaching Next when the SPA is enabled); `matchEnabledSpaRoute`, `decodeSpaParam`, `spaRouteById`, `unknownSpaGroups` helpers. | Needed to implement section 1.7 and F10 without leaking brand into a pure module, and to keep `next dev` working with the SPA enabled. |
| D12 | `loadShellTemplate()`, `renderHead(head, nonce)` | `renderHead(head, brand, nonce)`; `escapeHtml` is exported from `lib/spa/head.ts`; `resolveHead` takes an injected `loadProfile` (and `designEnabled`, `supportEmail`, `appUrl`, `brand`) instead of importing the database. | Keeps head tests database-free and the head module free of server imports. |

## 2. Additions the plan did not list

- `web/src/lib/states.tsx`: `PageLoading`, `PageError`, `QueryGate`. The plan's section 2.7 defines how every page must treat 404 / 429 / other
  query errors; shipping one implementation stops six branches from writing six variants.
- `lib/views/session.ts`: the DTO types and builders of the two session endpoints (shared with the SPA by `import type`).
- `components/views/system/NotFoundView.tsx` and `ErrorView.tsx` as the plan says; `app/not-found.tsx` and `app/error.tsx` now render them.
- `app/layout.tsx` imports `DEFAULT_DESCRIPTION` from `lib/spa/routes.ts` instead of repeating the sentence (no behaviour change).
- `web/src/lib/guards.tsx` loads the dashboard and admin layouts with `React.lazy` so the landing/booking pages do not download the sidebars.
- `scripts/spa-postbuild.mjs` also verifies that EVERY script/style/stylesheet/preload tag in the template has `nonce="__CSP_NONCE__"`, that the
  `<!--spa-support-->` marker is present, and that no inline script with code was emitted.
- Tests added beyond the plan's list: `tests/spa-guard.test.ts` (server-module guard rules), `tests/spa-postbuild.test.ts` (secret scan, process.env scan,
  template checks, run as a child process on fixture directories).

## 3. Progress log

| Item | State | Commit |
|---|---|---|
| Setup: worktree, `npm ci`, `.env` copied, `prisma generate`, dependencies installed | done | |
