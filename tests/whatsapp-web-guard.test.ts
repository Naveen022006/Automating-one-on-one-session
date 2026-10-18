import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { LIB_ALLOWLIST, nodeModulesProblem, repoPathProblem, specifierProblem } from "../web/vite-server-guard";

// Pure tests: the browser bundle must never contain the WhatsApp client library, the QR renderer or anything under lib/whatsapp-web/.

const root = process.cwd();
const toPosix = (p: string) => p.split(sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "generated" || name === "dist" || name === ".claude" || name === ".git") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

test("no lib/whatsapp-web module is on the browser allowlist, and the guard refuses each of them", () => {
  const files = readdirSync(join(root, "lib", "whatsapp-web")).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 10, "the module folder exists");
  assert.ok(!LIB_ALLOWLIST.some((p) => p.startsWith("lib/whatsapp-web/")), "not on the allowlist");
  for (const f of files) {
    const problem = repoPathProblem(`lib/whatsapp-web/${f}`);
    assert.ok(problem && /allowlist/.test(problem), `lib/whatsapp-web/${f} must be refused for browser code`);
  }
  // The worker is refused as a whole, the manager included.
  assert.ok(repoPathProblem("worker/whatsapp-web-manager.ts"));
});

test("the WhatsApp client library, its signal library and the QR renderer cannot be imported by browser code", () => {
  for (const spec of ["@whiskeysockets/baileys", "@whiskeysockets/baileys/lib/index.js", "libsignal", "libsignal/src/x", "uqr"]) {
    assert.ok(specifierProblem(spec), spec);
  }
  assert.equal(specifierProblem("uqrx"), null, "the pattern is exact");
  for (const p of ["@whiskeysockets/baileys", "libsignal", "uqr"]) assert.ok(nodeModulesProblem(`/repo/node_modules/${p}/dist/index.mjs`), p);
});

test("web/src imports nothing from lib/whatsapp-web at run time (types only), and none of the libraries", () => {
  const offenders: string[] = [];
  for (const file of walk(join(root, "web", "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
      const [, typeOnly, spec] = m;
      if (/lib\/whatsapp-web\//.test(spec) && !typeOnly) offenders.push(`${toPosix(relative(root, file))}: ${spec}`);
      if (/^(@whiskeysockets|libsignal|uqr)(\/|$)/.test(spec)) offenders.push(`${toPosix(relative(root, file))}: ${spec}`);
    }
    if (/import\(\s*["'](@whiskeysockets|uqr)/.test(text)) offenders.push(`${toPosix(relative(root, file))}: dynamic import`);
  }
  assert.deepEqual(offenders, []);
});

test("Baileys is referenced by exactly one source file, and only through a type import and a dynamic import()", () => {
  const holders: string[] = [];
  for (const dir of ["lib", "app", "worker", "scripts", "web"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of walk(join(root, dir))) {
      const rel = toPosix(relative(root, file));
      const text = readFileSync(file, "utf8");
      if (!/["'`]@whiskeysockets\/baileys["'`]/.test(text)) continue;
      holders.push(rel);
      // No static, run-time import of the library anywhere.
      for (const m of text.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']@whiskeysockets\/baileys["']/gm)) {
        assert.fail(`${rel}: static import of the library: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(holders, ["lib/whatsapp-web/baileys-transport.ts"]);
  const src = readFileSync(join(root, "lib", "whatsapp-web", "baileys-transport.ts"), "utf8");
  assert.match(src, /import type \* as BaileysTypes from "@whiskeysockets\/baileys"/);
  assert.match(src, /import\("@whiskeysockets\/baileys"\)/);
});

test("the QR renderer is used by one server module only", () => {
  const holders: string[] = [];
  for (const dir of ["lib", "app", "worker", "web", "scripts"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of walk(join(root, dir))) {
      if (/["']uqr["']/.test(readFileSync(file, "utf8"))) holders.push(toPosix(relative(root, file)));
    }
  }
  assert.deepEqual(holders, ["lib/whatsapp-web/qr-svg.ts"]);
});

test("modules that load in tests, the Next build and the web process do not pull the WhatsApp library in", () => {
  // Everything except baileys-transport.ts must be free of it, including through other imports of that file.
  const importers: string[] = [];
  for (const dir of ["lib", "app", "worker", "scripts"]) {
    if (!existsSync(join(root, dir))) continue;
    for (const file of walk(join(root, dir))) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["'](?:\.{1,2}\/|@\/)[^"']*baileys-transport["']/.test(text)) importers.push(toPosix(relative(root, file)));
      if (/import\(\s*["'](?:\.{1,2}\/|@\/)[^"']*baileys-transport["']\s*\)/.test(text)) importers.push(`${toPosix(relative(root, file))} (dynamic)`);
    }
  }
  // Only the worker's start-up code loads the adapter, and only with a dynamic import() inside a function.
  assert.deepEqual(importers, ["worker/whatsapp-web.ts (dynamic)"]);
});

test("a built browser bundle, when present, holds no trace of the WhatsApp libraries or the server modules", () => {
  const dist = join(root, "web", "dist");
  if (!existsSync(dist)) return;
  const needles = ["@whiskeysockets", "whatsapp-rust-bridge", "libsignal", "renderSVG", "wa-web:", "authStateEnc", "auth_state_enc"];
  const hits: string[] = [];
  const scan = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) scan(full);
      else if (/\.(js|css|html|json|map)$/.test(name)) {
        const text = readFileSync(full, "utf8");
        for (const n of needles) if (text.includes(n)) hits.push(`${toPosix(relative(root, full))}: ${n}`);
      }
    }
  };
  scan(dist);
  assert.deepEqual(hits, []);
});
