import { builtinModules } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * The server-module guard (doc/10-react-migration-plan.md, section 1.4). The SPA imports the project's shared
 * components, and those live next to server code. One careless `import { prisma } from "@/lib/db"` in a file the browser
 * bundle reaches would put database drivers, secrets handling and Node APIs into JavaScript that is public. This plugin
 * makes that a BUILD ERROR (and a dev-server error), naming the importing file.
 *
 * The rule is an allowlist for `lib/`: only the small set of pure modules below may be imported by browser code. Add to
 * it only after checking the module imports nothing server-side (no Prisma, no `process.env` beyond the four names the
 * Vite config defines, no Node built-ins) AND is safe to ship to every visitor. Type-only imports
 * (`import type ... from "@/lib/dashboard-data"`) are erased before resolution and are always fine.
 *
 * The decision logic is in plain functions (`specifierProblem`, `repoPathProblem`) so tests/spa-guard.test.ts can check
 * it without running Vite.
 */

/** `lib/**` files browser code may import (repo-relative, forward slashes). Keep this list short. */
export const LIB_ALLOWLIST: readonly string[] = [
  "lib/format.ts",
  "lib/intake.ts",
  "lib/brand.ts",
  "lib/refund-policy.ts",
  "lib/auth/slug.ts",
  "lib/spa/routes.ts",
  "lib/jsonify.ts",
  "lib/safe-next-path.ts",
];

// Bare built-in names ("fs", "path/posix", ...). Prefix-only ones ("node:test", "node:sqlite") are caught by the `node:` check.
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("node:")));
/** Packages that are server-only by nature. */
const FORBIDDEN_PACKAGES = [/^@prisma\//, /^prisma$/, /^pg($|\/)/, /^ioredis($|\/)/, /^bullmq($|\/)/, /^dotenv($|\/)/];
/** `next/link` and `next/navigation` are aliased to the SPA shims before this plugin sees them; anything else from Next is server code. */
const NEXT_ALLOWED = new Set(["next/link", "next/navigation"]);

/** A problem with an import specifier as written, or null. */
export function specifierProblem(specifier: string): string | null {
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) return "a Node.js built-in module (browser code cannot use Node APIs)";
  if (specifier === "next" || specifier.startsWith("next/")) {
    return NEXT_ALLOWED.has(specifier) ? null : "a server-side Next.js API (only next/link and next/navigation exist in the SPA, as shims)";
  }
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
  if (clean.startsWith("app/api/") || clean.startsWith("app/spa-shell/")) return "a route handler (server only)";
  if (clean.startsWith("worker/")) return "the background worker (server only)";
  if (clean.startsWith("prisma/") || clean.startsWith("scripts/") || clean.startsWith("tests/")) return "a server-side or tooling file";
  if (clean === "proxy.ts" || clean === "instrumentation.ts") return "server-side Next.js entry code";
  if (/^app\/(?:.*\/)?(page|layout|route|not-found|error|global-error)\.tsx?$/.test(clean)) return "a Next page/layout file (server code; import the shared view component instead)";
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
