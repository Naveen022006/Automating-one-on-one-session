#!/usr/bin/env node
/**
 * Post-build check and publish step for the SPA (doc/10-react-migration-plan.md, section 1.6). Runs after
 * `vite build --config web/vite.config.ts` as part of `npm run build:web` and FAILS THE BUILD (exit 1) when:
 *
 *   1. web/dist/index.html is missing, lacks the `__CSP_NONCE__` or `<!--spa-head-->` placeholder, or contains a script,
 *      style or stylesheet/preload tag without `nonce="__CSP_NONCE__"` or an inline script with code. Under the strict CSP
 *      (script-src 'nonce-...' 'strict-dynamic') any such tag is silently blocked and the page is blank.
 *   2. any JavaScript file in web/dist still contains `process.env`. Vite replaces the three names the shared modules
 *      use; any other `process.env` is server-only code that reached the browser (it would also crash there).
 *   3. any file in web/dist contains the VALUE of an environment variable that looks like a secret (a name matching
 *      SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL, value of at least 8 characters), taken from the process
 *      environment and from the root .env files (parsed here, never loaded). Only the NAME is printed, never the value.
 *
 * On success it replaces public/assets/ with a copy of web/dist/assets/, which Next serves as static files (hashed names,
 * long-lived cache headers from next.config.ts). The shell template itself (web/dist/index.html) is read by the server
 * at run time and is not copied.
 *
 * Usage: node scripts/spa-postbuild.mjs [--root <repository root>]   (the option exists for the tests)
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NONCE = "__CSP_NONCE__";
const HEAD = "<!--spa-head-->";
const SECRET_NAME = /SECRET|PASSWORD|TOKEN|_KEY|PRIVATE|DATABASE_URL|REDIS_URL/i;
const MIN_SECRET_LENGTH = 8;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = path.resolve(arg("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const dist = path.join(root, "web", "dist");
const problems = [];
const fail = (message) => problems.push(message);
/** Repository-relative path with forward slashes, for messages. */
const rel = (file) => path.relative(root, file).split(path.sep).join("/");

/** Every file under a directory (absolute paths). */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 1. The shell template. */
function checkIndexHtml(html) {
  if (!html.includes(NONCE)) fail(`web/dist/index.html has no ${NONCE} placeholder (is html.cspNonce set in web/vite.config.ts?)`);
  if (!html.includes(HEAD)) fail(`web/dist/index.html has no ${HEAD} placeholder (web/index.html must keep it)`);
  if (!html.includes("<!--spa-support-->")) fail("web/dist/index.html has no <!--spa-support--> placeholder in <noscript>");
  const tags = html.match(/<(script|style|link)\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = /^<(\w+)/.exec(tag)[1].toLowerCase();
    if (name === "link" && !/\brel=["']?(stylesheet|modulepreload|preload)\b/i.test(tag)) continue;
    if (!tag.includes(`nonce="${NONCE}"`)) fail(`web/dist/index.html has a tag without nonce="${NONCE}": ${tag.slice(0, 120)}`);
  }
  // An inline script (no src) with code would need a nonce'd body we cannot audit here. Data blocks are fine.
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (!/\bsrc=/i.test(attrs) && m[2].trim() !== "" && !/type=["']application\/(ld\+)?json["']/i.test(attrs)) {
      fail("web/dist/index.html contains an inline <script> with code; the build must not emit inline scripts");
    }
  }
}

/** 2. No process.env left in the JavaScript. */
function checkProcessEnv(files) {
  for (const file of files.filter((f) => /\.(m?js|cjs)$/.test(f))) {
    if (/\bprocess\.env\b/.test(readFileSync(file, "utf8"))) {
      fail(`${rel(file)} still contains "process.env": server-only code reached the browser bundle, or a new environment variable needs a define in web/vite.config.ts`);
    }
  }
}

/** Parses KEY=VALUE lines of a .env file without loading anything into process.env. */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith("#")) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

/** name -> value for every secret-looking variable in the process environment and the root .env files. */
function collectSecrets() {
  const sources = [process.env];
  for (const name of readdirSync(root).filter((n) => n === ".env" || (n.startsWith(".env.") && n !== ".env.example"))) {
    try {
      sources.push(parseEnvFile(readFileSync(path.join(root, name), "utf8")));
    } catch {
      // unreadable env file: nothing to scan with
    }
  }
  const secrets = new Map();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) {
      if (SECRET_NAME.test(name) && typeof value === "string" && value.length >= MIN_SECRET_LENGTH) secrets.set(`${name}`, value);
    }
  }
  return secrets;
}

/** 3. No secret value anywhere in the build output (text or binary). */
function checkSecrets(files) {
  const secrets = collectSecrets();
  const hit = new Set();
  for (const file of files) {
    const content = readFileSync(file);
    for (const [name, value] of secrets) {
      if (content.includes(value)) hit.add(name);
    }
  }
  for (const name of hit) fail(`the value of ${name} appears in web/dist: a secret reached the browser bundle (only the name is shown; rotate it if this build was published)`);
  return secrets.size;
}

function main() {
  const indexFile = path.join(dist, "index.html");
  if (!existsSync(indexFile)) {
    console.error(`[spa-postbuild] ${rel(indexFile)} is missing: run vite build first`);
    process.exit(1);
  }
  const files = walk(dist);
  checkIndexHtml(readFileSync(indexFile, "utf8"));
  checkProcessEnv(files);
  const scanned = checkSecrets(files);

  if (problems.length) {
    console.error(`[spa-postbuild] FAILED with ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const assetsFrom = path.join(dist, "assets");
  const assetsTo = path.join(root, "public", "assets");
  if (!existsSync(assetsFrom) || !statSync(assetsFrom).isDirectory()) {
    console.error("[spa-postbuild] web/dist/assets is missing");
    process.exit(1);
  }
  mkdirSync(path.join(root, "public"), { recursive: true });
  rmSync(assetsTo, { recursive: true, force: true });
  cpSync(assetsFrom, assetsTo, { recursive: true });
  console.log(`[spa-postbuild] OK: template and bundle checked (${files.length} files, ${scanned} secret-looking variables scanned for), public/assets updated`);
}

main();
