import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { serverModuleGuard } from "./vite-server-guard.ts";

/**
 * Vite configuration of the React SPA (doc/10-react-migration-plan.md, F3 and sections 1.4 and 1.6).
 *
 * Run with an explicit path from the repository root: `vite --config web/vite.config.ts` (npm run dev:web / build:web).
 * Output: web/dist/index.html (the shell template, with CSP placeholders) and web/dist/assets/* (hashed files);
 * scripts/spa-postbuild.mjs then checks the output and copies assets/ to public/assets for Next to serve.
 *
 * SECURITY: the browser bundle is public. Three layers keep secrets and server code out of it:
 *   1. Only FOUR environment variables are read at all (NAMES below); everything else in .env is never loaded here. No
 *      `import.meta.env` prefix other than VITE_ (which nothing uses) is exposed.
 *   2. `define` replaces exactly the `process.env.<name>` expressions the shared modules (lib/brand.ts, lib/format.ts) use.
 *      Any other `process.env` in the bundle is a bug that scripts/spa-postbuild.mjs fails the build on.
 *   3. serverModuleGuard() fails the build when browser code imports server modules (see web/vite-server-guard.ts).
 */

const here = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = path.resolve(here, "..");
const posix = (p: string) => p.split(path.sep).join("/");

/** The only variables the web build reads from the environment or the root .env. All are public by nature. */
const NAMES = ["NEXT_PUBLIC_BRAND_NAME", "NEXT_PUBLIC_SUPPORT_EMAIL", "APP_LOCALE", "ENABLE_DESIGN_PAGE"] as const;

export default defineConfig(({ mode }) => {
  const fromFile = loadEnv(mode, repoRoot, [...NAMES]);
  // The real environment wins over .env files, like in Next; an unset name is "" (lib/brand.ts then uses its defaults).
  const pick = (name: (typeof NAMES)[number]): string => process.env[name] ?? fromFile[name] ?? "";
  const nextOrigin = (process.env.SPA_API_TARGET || "http://localhost:3000").replace(/\/$/, "");

  return {
    root: here,
    envDir: here,
    envPrefix: "VITE_",
    plugins: [react(), serverModuleGuard(repoRoot)],
    resolve: {
      alias: [
        { find: /^@web\//, replacement: `${posix(here)}/src/` },
        { find: /^@\//, replacement: `${posix(repoRoot)}/` },
      ],
      // The components and the pages must run on ONE copy of React (hooks break with two).
      dedupe: ["react", "react-dom"],
    },
    define: {
      "process.env.NEXT_PUBLIC_BRAND_NAME": JSON.stringify(pick("NEXT_PUBLIC_BRAND_NAME")),
      "process.env.NEXT_PUBLIC_SUPPORT_EMAIL": JSON.stringify(pick("NEXT_PUBLIC_SUPPORT_EMAIL")),
      "process.env.APP_LOCALE": JSON.stringify(pick("APP_LOCALE")),
      // The /design catalogue is part of the bundle only when built for development or with ENABLE_DESIGN_PAGE=true.
      __DESIGN_PAGE__: JSON.stringify(mode !== "production" || pick("ENABLE_DESIGN_PAGE") === "true"),
    },
    // Vite adds nonce="__CSP_NONCE__" to every script/style/link tag it writes, and <meta property="csp-nonce"> for the
    // tags it adds at run time. The server replaces the placeholder per request (lib/spa/shell.ts).
    html: { cspNonce: "__CSP_NONCE__" },
    server: {
      port: 5173,
      strictPort: true,
      fs: { allow: [repoRoot] },
      proxy: {
        // `npm run dev:hmr` only: the browser talks to this server, so /api and the metadata routes are forwarded to `next dev`
        // (SPA_API_TARGET, default :3000) and stay same-origin for cookies and the CSRF check.
        "^/(api/|sitemap\\.xml|robots\\.txt|icon\\.svg|opengraph-image)": {
          target: nextOrigin,
          changeOrigin: false,
          xfwd: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
      rolldownOptions: {
        onwarn(warning, warn) {
          // Some libraries carry React's "use client" directive, which means nothing to Vite.
          if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
        },
      },
    },
  };
});
