// The server-module guard (web/vite-server-guard.ts): the rules, and an end-to-end Vite build that proves the plugin is
// actually wired in and stops a build when browser code imports server code. No database.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LIB_ALLOWLIST, nodeModulesProblem, repoPathProblem, serverModuleGuard, specifierProblem } from "../web/vite-server-guard";

test("specifiers: Node built-ins, server-side Next APIs and server-only packages are refused", () => {
  for (const s of ["node:fs", "node:crypto", "fs", "path", "crypto", "child_process", "fs/promises"]) assert.ok(specifierProblem(s), s);
  for (const s of ["next/server", "next/headers", "next/font/google", "next/og", "next/cache", "next/dist/server/x", "next"]) assert.ok(specifierProblem(s), s);
  for (const s of ["@prisma/client", "@prisma/adapter-pg", "prisma", "pg", "pg-pool", "ioredis", "bullmq", "dotenv"]) {
    // "pg-pool" is not on the list by name; it can only arrive through "pg" anyway
    if (s === "pg-pool") continue;
    assert.ok(specifierProblem(s), s);
  }
  // Allowed: the two Next modules the shims stand in for, and ordinary browser libraries.
  for (const s of ["next/link", "next/navigation", "react", "react-dom/client", "react-router", "@tanstack/react-query", "luxon", "./x", "@/components/ui/primitives"]) {
    assert.equal(specifierProblem(s), null, s);
  }
});

test("resolved repository files: only the allowlisted lib modules, never routes, the worker, the generated client or scripts", () => {
  for (const ok of LIB_ALLOWLIST) assert.equal(repoPathProblem(ok), null, ok);
  assert.deepEqual([...LIB_ALLOWLIST].sort(), [
    "lib/auth/slug.ts", "lib/brand.ts", "lib/facebook-sdk.ts", "lib/format.ts", "lib/intake.ts", "lib/jsonify.ts", "lib/message-templates.ts", "lib/refund-policy.ts", "lib/safe-next-path.ts",
    "lib/spa/routes.ts", "lib/whatsapp-copy.ts", "lib/whatsapp-graph-version.ts",
  ]);
  // The rule in web/vite-server-guard.ts: an allowlisted module reads no environment beyond the names the Vite config
  // replaces at build time (no bare `process.env`, e.g. as a default parameter). The one exception is `appUrl()` in
  // lib/brand.ts (APP_URL), a server-only function the browser bundle drops.
  const defined = new Set(["NEXT_PUBLIC_BRAND_NAME", "NEXT_PUBLIC_SUPPORT_EMAIL", "APP_LOCALE"]);
  for (const file of LIB_ALLOWLIST) {
    const source = readFileSync(path.resolve(__dirname, "..", file), "utf8");
    const reads = [...source.matchAll(/process\.env(\.[A-Za-z_][A-Za-z0-9_]*)?/g)];
    for (const m of reads) {
      const name = m[1]?.slice(1);
      const allowed = name !== undefined && (defined.has(name) || (file === "lib/brand.ts" && name === "APP_URL"));
      assert.ok(allowed, `${file} reads ${m[0]}: move the environment access out of the module the browser imports`);
    }
  }
  for (const bad of [
    "lib/db.ts", "lib/crypto.ts", "lib/env.ts", "lib/auth/session.ts", "lib/admin/session.ts", "lib/payments.ts", "lib/spa/head.ts", "lib/spa/shell.ts", "lib/views/http.ts",
    "generated/prisma/client.ts", "app/api/auth/session/route.ts", "app/spa-shell/[[...path]]/route.ts", "worker/index.ts", "prisma/seed.ts", "scripts/spa-postbuild.mjs",
    "tests/helpers/x.ts", "proxy.ts", "instrumentation.ts", "app/page.tsx", "app/dashboard/layout.tsx", "app/[influencer]/book/page.tsx", "app/error.tsx",
  ]) {
    assert.ok(repoPathProblem(bad), bad);
  }
  // Client files that live in app/ are importable (BookingFlow, PayNow, ManageBooking, DesignShowcase) and so are the styles.
  for (const ok of ["app/[influencer]/book/BookingFlow.tsx", "app/pay/[token]/PayNow.tsx", "app/globals.css", "app/styles/tokens.css", "components/ui/primitives.tsx", "components/views/system/NotFoundView.tsx", "web/src/main.tsx"]) {
    assert.equal(repoPathProblem(ok), null, ok);
  }
  assert.equal(repoPathProblem("lib/format.ts?used"), null, "a query string is ignored");
  assert.ok(repoPathProblem("lib/db.ts?x"));
});

test("node_modules: Next's runtime and database/queue packages are refused, ordinary libraries are not", () => {
  assert.ok(nodeModulesProblem("/repo/node_modules/next/dist/server/x.js"));
  assert.ok(nodeModulesProblem("/repo/node_modules/@next/env/x.js"));
  assert.ok(nodeModulesProblem("/repo/node_modules/@prisma/client/index.js"));
  assert.ok(nodeModulesProblem("/repo/node_modules/pg/lib/index.js"));
  assert.ok(nodeModulesProblem("/repo/node_modules/ioredis/built/index.js"));
  assert.ok(nodeModulesProblem("/repo/node_modules/bullmq/dist/x.js"));
  assert.equal(nodeModulesProblem("/repo/node_modules/react/index.js"), null);
  assert.equal(nodeModulesProblem("/repo/node_modules/react-router/dist/x.js"), null);
  assert.equal(nodeModulesProblem("/repo/node_modules/@tanstack/react-query/build/x.js"), null);
  assert.equal(nodeModulesProblem("/repo/lib/format.ts"), null);
});

/** A throwaway project: files = path -> source. Builds `src/main.ts` with only the guard plugin and the repo's aliasing. */
async function buildFixture(files: Record<string, string>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "spa-guard-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      const full = path.join(root, file);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, source);
    }
    // Dynamic import on purpose: a static import compiles to require("vite") in this CommonJS test file, which loads
    // Vite's deprecated CJS build, where the alias resolution below does not work.
    const { build } = await import("vite");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [serverModuleGuard(root)],
      resolve: { alias: [{ find: /^@\//, replacement: `${root.split(path.sep).join("/")}/` }] },
      build: { write: false, lib: { entry: path.join(root, "src/main.ts"), formats: ["es"] } },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the plugin passes browser code that imports allowlisted lib modules and type-only server imports", async () => {
  await buildFixture({
    "lib/format.ts": "export const f = (n: number) => n + 1;",
    "lib/db.ts": "export const prisma = { secret: 'server only' };",
    "lib/dashboard-data.ts": "import { prisma } from './db'; export type Overview = { n: number }; export const load = () => prisma;",
    "src/main.ts": "import { f } from '@/lib/format';\nimport type { Overview } from '@/lib/dashboard-data';\nexport const x: Overview = { n: f(1) };",
  });
});

test("the plugin stops the build when browser code imports a server module, naming the importing file", async () => {
  const server = { "lib/db.ts": "export const prisma = { secret: 'server only' };" };
  await assert.rejects(
    buildFixture({ ...server, "src/main.ts": "import { prisma } from '@/lib/db';\nexport const x = prisma;" }),
    (e: Error) => /server-module guard/.test(e.message) && /src\/main\.ts/.test(e.message) && /lib\/db\.ts/.test(e.message),
  );
  await assert.rejects(
    buildFixture({ "src/main.ts": "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;" }),
    (e: Error) => /server-module guard/.test(e.message) && /node:fs/.test(e.message),
  );
  await assert.rejects(
    buildFixture({ "src/main.ts": "import { NextResponse } from 'next/server';\nexport const x = NextResponse;" }),
    (e: Error) => /server-module guard/.test(e.message) && /next\/server/.test(e.message),
  );
  await assert.rejects(
    buildFixture({ "app/api/x/route.ts": "export const GET = () => 1;", "src/main.ts": "import { GET } from '@/app/api/x/route';\nexport const x = GET;" }),
    (e: Error) => /route handler/.test(e.message),
  );
  // A dynamic import is judged like a static one.
  await assert.rejects(
    buildFixture({ ...server, "src/main.ts": "export const x = () => import('@/lib/db');" }),
    (e: Error) => /server-module guard/.test(e.message),
  );
});
