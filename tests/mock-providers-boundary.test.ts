import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

// Static scan of the repository (doc/11-provider-simulator.md, 2.8). The local mock server is wired in through ONE module and ONE
// variable; these tests stop a later change from adding a second entry point or a hard-coded provider URL that silently
// bypasses the mock (or, worse, a way for production code to reach the mock server).

const root = process.cwd();
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "generated", ".git", "coverage"]);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && SOURCE.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(root, file).split("\\").join("/");

/** The production code: everything that can ship in the web image, the worker image or the browser bundle. */
const PRODUCTION = [
  ...["lib", "app", "components", "worker", "web/src"].flatMap((d) => walk(join(root, d))),
  ...["proxy.ts", "instrumentation.ts"].map((f) => join(root, f)).filter(existsSync),
].map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));

const filesMatching = (pattern: RegExp) => PRODUCTION.filter((f) => pattern.test(f.text)).map((f) => f.path).sort();

test("the production code has files to scan (the scan is not vacuous)", () => {
  assert.ok(PRODUCTION.length > 200, `${PRODUCTION.length} files`);
  for (const p of ["lib/provider-endpoints.ts", "lib/env.ts", "lib/google.ts", "proxy.ts"]) assert.ok(PRODUCTION.some((f) => f.path === p), p);
});

test("MOCK_PROVIDERS_URL is mentioned only in lib/provider-endpoints.ts (the guard) and lib/env.ts (the start-up check)", () => {
  assert.deepEqual(filesMatching(/MOCK_PROVIDERS_URL/), ["lib/env.ts", "lib/provider-endpoints.ts"]);
});

test("the mock server's own code is not reachable from production code", () => {
  for (const f of PRODUCTION) {
    for (const m of f.text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      assert.ok(!/(^|\/)scripts\//.test(m[1]) && !/mock-providers/.test(m[1]), `${f.path} imports ${m[1]}`);
    }
  }
});

test("Google and Meta base URLs are written only in lib/provider-endpoints.ts, lib/facebook-sdk.ts and proxy.ts (the CSP)", () => {
  const patterns = [
    /accounts\.google\.com\/o\/oauth2/,
    /oauth2\.googleapis\.com/,
    /www\.googleapis\.com\/calendar/,
    /gmail\.googleapis\.com\/gmail/,
    /graph\.facebook\.com/,
    /connect\.facebook\.net/,
  ];
  const allowed = new Set(["lib/provider-endpoints.ts", "lib/facebook-sdk.ts", "proxy.ts"]);
  for (const p of patterns) {
    const stray = filesMatching(p).filter((f) => !allowed.has(f));
    assert.deepEqual(stray, [], `${p} must be resolved through lib/provider-endpoints.ts, not written out`);
  }
});

test("the mock never enters an image: the build context excludes it, and nothing in the Dockerfiles copies it by name", () => {
  const ignored = readFileSync(join(root, ".dockerignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  assert.ok(ignored.includes("scripts/mock-providers") && ignored.includes("scripts/dev-mock.ts"));
  for (const file of ["Dockerfile", "Dockerfile.worker"]) assert.ok(!/mock-providers|dev-mock/.test(readFileSync(join(root, file), "utf8")), `${file} must not mention the mock`);
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
  assert.equal(scripts["dev:mock"], "tsx scripts/dev-mock.ts");
  assert.equal(scripts["mock:providers"], "tsx scripts/mock-providers/index.ts");
  assert.ok(!/mock/i.test(`${scripts.start} ${scripts.build} ${scripts.worker}`), "no production script starts the mock");
});

test("the mock server imports nothing from lib/ (it shares no parsing or signing code with the app); only the launcher reads isLocalAppUrl", () => {
  const importsOf = (file: string) => [...readFileSync(file, "utf8").matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const mockFiles = walk(join(root, "scripts", "mock-providers"));
  for (const file of mockFiles) {
    for (const spec of importsOf(file)) {
      assert.ok(!/(^|\/)lib\//.test(spec) && !spec.startsWith("@/") && !/(^|\/)app\//.test(spec) && !/(^|\/)worker\//.test(spec), `${rel(file)} imports ${spec}`);
    }
  }
  const launcher = join(root, "scripts", "dev-mock.ts");
  if (existsSync(launcher)) {
    const text = readFileSync(launcher, "utf8");
    const fromLib = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']*lib\/[^"']*)["']/g)];
    for (const m of fromLib) {
      assert.match(m[2], /lib\/provider-endpoints$/, `${m[2]}: only lib/provider-endpoints may be imported`);
      assert.deepEqual(m[1].split(",").map((s) => s.trim()).filter(Boolean), ["isLocalAppUrl"]);
    }
    assert.ok(importsOf(launcher).every((s) => !/(^|\/)(app|worker|components)\//.test(s)), "the launcher imports no app code");
  }
});
