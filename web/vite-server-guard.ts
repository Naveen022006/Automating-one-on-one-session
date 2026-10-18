import { builtinModules } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * The server-module guard (doc/12-front-end.md). The SPA lives in web/ but shares a few pure modules with the server (the
 * route table, formatting, the intake-question rules), and those sit in lib/ next to server code. One careless
 * `import { prisma } from "@/lib/db"` in a file the browser bundle reaches would put database drivers, secrets handling and
 * Node APIs into JavaScript that is public. This plugin makes that a BUILD ERROR (and a dev-server error), naming the
 * importing file.
 *
 * The rule is an allowlist for `lib/`: only the small set of pure modules below may be imported by browser code. Add to
 * it only after checking the module imports nothing server-side (no Prisma, no `process.env` beyond the four names the
 * Vite config defines, no Node built-ins) AND is safe to ship to every visitor. Type-only imports
 * (`import type ... from "@/lib/views/dashboard-sessions"`) are erased before resolution and are always fine. Nothing under
 * app/ (route handlers, metadata routes) may be imported at all, and neither may the framework: the SPA does not use Next.
 *
 * The decision logic is in plain functions (`specifierProblem`, `repoPathProblem`) so tests/spa-guard.test.ts can check
 * it without running Vite.
 */

/** `lib/**` files browser code may import (repo-relative, forward slashes). Keep this list short. */
export const LIB_ALLOWLIST: readonly string[] = [
  "lib/format.ts",
  // The India-only constants and helpers (IST arithmetic and formatting, INR money, the Indian mobile parser): pure, no imports, no environment.
  "lib/india.ts",
  "lib/intake.ts",
  "lib/brand.ts",
  "lib/refund-policy.ts",
  "lib/auth/slug.ts",
  "lib/spa/routes.ts",
  "lib/jsonify.ts",
  "lib/safe-next-path.ts",
  // The WhatsApp connection panel (web/src/components/app/WhatsAppConnect.tsx) shows these; all three import nothing and read no
  // environment (the env-reading graphVersion/graphBase live in the server-only lib/whatsapp-graph-config.ts).
  "lib/message-templates.ts",
  "lib/whatsapp-copy.ts",
  "lib/whatsapp-graph-version.ts",
  // Which Facebook SDK script the same panel loads (Meta's, or the local mock's only when the server offers a loopback one).
  // Pure: imports nothing, reads no environment, holds no secret (doc/11-provider-simulator.md, 2.6).
  "lib/facebook-sdk.ts",
];

// Bare built-in names ("fs", "path/posix", ...). Prefix-only ones ("node:test", "node:sqlite") are caught by the `node:` check.
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("node:")));
/** Packages that are server-only by nature. */
const FORBIDDEN_PACKAGES = [/^@prisma\//, /^prisma$/, /^pg($|\/)/, /^ioredis($|\/)/, /^bullmq($|\/)/, /^dotenv($|\/)/];
/** A problem with an import specifier as written, or null. */
export function specifierProblem(specifier: string): string | null {
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return "a Node.js built-in module (browser code cannot use Node APIs)";
  if (specifier === "next" || specifier.startsWith("next/")) return "Next.js (server code; the SPA has its own link and navigation in web/src/lib)";
  if (FORBIDDEN_PACKAGES.some((re) => re.test(specifier))) return "a server-only package (database, queue or secret handling)";
  return null;
}

/**
 * A problem with a RESOLVED file, given its path relative to the repository root (forward slashes), or null.
 * Files outside the repository (npm packages) are judged by `nodeModulesProblem`.
 */
export function repoPathProblem(rel: string): string | null {
  const clean = rel.split("?")[0];
  if (clean.startsWith("generated/")) return "the generated Prisma client (server only)";
  if (clean.startsWith("app/")) return "a Next.js route handler or metadata route (server only)";
  if (clean.startsWith("worker/")) return "the background worker (server only)";
  if (clean.startsWith("prisma/") || clean.startsWith("scripts/") || clean.startsWith("tests/")) return "a server-side or tooling file";
  if (clean === "proxy.ts" || clean === "instrumentation.ts") return "server-side Next.js entry code";
  if (clean.startsWith("lib/") && !LIB_ALLOWLIST.includes(clean)) {
    return `lib module not on the browser allowlist (${LIB_ALLOWLIST.join(", ")}); import only types from it ("import type"), or move the pure logic to an allowlisted module`;
  }
  return null;
}

/** A problem with a resolved file inside node_modules, or null. */
export function nodeModulesProblem(posixPath: string): string | null {
  const m = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(posixPath);
  if (!m) return null;
  const pkg = m[1];
  if (pkg === "next" || pkg.startsWith("@next/")) return "the Next.js runtime (server code)";
  if (FORBIDDEN_PACKAGES.some((re) => re.test(pkg))) return "a server-only package (database, queue or secret handling)";
  return null;
}

export function serverModuleGuard(repoRoot: string): Plugin {
  const root = path.resolve(repoRoot);
  const toPosix = (p: string) => p.split(path.sep).join("/").replace(/\\/g, "/");

  return {
    name: "server-module-guard",
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Only imports written by OUR files are judged. Libraries decide their own imports (and are served their
      // browser builds by the resolver).
      if (!importer || importer.startsWith("\0")) return null;
      const importerRel = path.relative(root, importer.split("?")[0]);
      const ours = !importerRel.startsWith("..") && !path.isAbsolute(importerRel) && !toPosix(importerRel).includes("node_modules/");
      if (!ours) return null;

      const fail = (what: string, reason: string): never =>
        this.error(
          `[server-module guard] ${toPosix(importerRel)} imports ${what}: ${reason}.\n` +
            "The browser bundle must not contain server code (doc/10-react-migration-plan.md, section 1.4).",
        );

      const bad = specifierProblem(source);
      if (bad) fail(`"${source}"`, bad);

      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || resolved.external || resolved.id.startsWith("\0")) return resolved ?? null;
      const id = resolved.id.split("?")[0];
      if (path.isAbsolute(id) || /^[A-Za-z]:[\\/]/.test(id)) {
        const rel = path.relative(root, id);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          const nm = nodeModulesProblem(toPosix(id));
          if (nm) fail(`"${source}"`, nm);
        } else {
          const relPosix = toPosix(rel);
          // Inside the repository: either an npm package (node_modules/...) or one of our own files.
          const problem = relPosix.startsWith("node_modules/") ? nodeModulesProblem(`/${relPosix}`) : repoPathProblem(relPosix);
          if (problem) fail(`"${source}" (${relPosix})`, problem);
        }
      }
      return resolved;
    },
  };
}
