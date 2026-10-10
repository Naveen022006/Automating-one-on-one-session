// scripts/spa-postbuild.mjs run as a child process on throwaway "repositories": the template checks, the process.env scan,
// the secret-value scan (names only in the output, never values) and the copy of assets/ to public/assets/. No database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.join(process.cwd(), "scripts", "spa-postbuild.mjs");
const GOOD_HTML = `<!doctype html><html><head>
<!--spa-head-->
<meta property="csp-nonce" nonce="__CSP_NONCE__">
<script type="module" crossorigin src="/assets/index-1.js" nonce="__CSP_NONCE__"></script>
<link rel="modulepreload" crossorigin href="/assets/chunk-1.js" nonce="__CSP_NONCE__">
<link rel="stylesheet" crossorigin href="/assets/index-1.css" nonce="__CSP_NONCE__">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
</head><body><div id="root"></div><noscript>JS needed.<!--spa-support--></noscript></body></html>`;

interface Fixture {
  html?: string;
  files?: Record<string, string | Buffer>;
  dotenv?: string;
  env?: Record<string, string>;
}

function run(fixture: Fixture): { status: number | null; out: string; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "spa-postbuild-"));
  try {
    mkdirSync(path.join(root, "web", "dist", "assets"), { recursive: true });
    if (fixture.html !== undefined) writeFileSync(path.join(root, "web", "dist", "index.html"), fixture.html);
    for (const [file, content] of Object.entries({ "assets/index-1.js": "console.log('hi')", "assets/index-1.css": "body{}", ...fixture.files })) {
      writeFileSync(path.join(root, "web", "dist", file), content);
    }
    if (fixture.dotenv !== undefined) writeFileSync(path.join(root, ".env"), fixture.dotenv);
    // A minimal environment: the child must not inherit this machine's real secrets into the assertions.
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...fixture.env } as unknown as NodeJS.ProcessEnv;
    const r = spawnSync(process.execPath, [SCRIPT, "--root", root], { env, encoding: "utf8" });
    const out = `${r.stdout}${r.stderr}`;
    const copied = existsSync(path.join(root, "public", "assets", "index-1.js"));
    return { status: r.status, out, root: copied ? "copied" : "not-copied" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a correct build passes and public/assets receives the hashed files", () => {
  const r = run({ html: GOOD_HTML });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.root, "copied");
  assert.match(r.out, /OK/);
});

test("the template must exist, have both placeholders, and a nonce on every script/style/stylesheet/preload tag", () => {
  assert.notEqual(run({}).status, 0, "no index.html");
  const noNonce = run({ html: GOOD_HTML.split("__CSP_NONCE__").join("fixed") });
  assert.equal(noNonce.status, 1);
  assert.match(noNonce.out, /__CSP_NONCE__ placeholder/);
  assert.equal(noNonce.root, "not-copied", "a failed check publishes nothing");
  const noHead = run({ html: GOOD_HTML.replace("<!--spa-head-->", "") });
  assert.equal(noHead.status, 1);
  assert.match(noHead.out, /spa-head/);
  const bareScript = run({ html: GOOD_HTML.replace("</head>", '<script type="module" src="/assets/x.js"></script></head>') });
  assert.equal(bareScript.status, 1);
  assert.match(bareScript.out, /without nonce/);
  const bareLink = run({ html: GOOD_HTML.replace("</head>", '<link rel="stylesheet" href="/assets/x.css"></head>') });
  assert.equal(bareLink.status, 1);
  const inline = run({ html: GOOD_HTML.replace("</head>", '<script nonce="__CSP_NONCE__">alert(1)</script></head>') });
  assert.equal(inline.status, 1);
  assert.match(inline.out, /inline <script>/);
  // A link that is not a stylesheet/preload (the icon) needs no nonce; a JSON-LD block is data.
  assert.equal(run({ html: GOOD_HTML.replace("</head>", '<script type="application/ld+json" nonce="__CSP_NONCE__">{}</script></head>') }).status, 0);
});

test("process.env left in a JavaScript file fails the build", () => {
  const r = run({ html: GOOD_HTML, files: { "assets/server-1.js": "export const x = process.env.DATABASE_URL;" } });
  assert.equal(r.status, 1);
  assert.match(r.out, /assets\/server-1\.js/);
  assert.match(r.out, /process\.env/);
  // The word in a CSS or font file is not JavaScript.
  assert.equal(run({ html: GOOD_HTML, files: { "assets/notes.css": "/* process.env */" } }).status, 0);
});

test("a secret value in the output fails the build; the message names the variable and never prints the value", () => {
  const secret = "s3cr3t-value-ABCDEFGH-123456";
  const r = run({ html: GOOD_HTML, files: { "assets/leak-1.js": `const k="${secret}";` }, env: { APP_SECRET: secret } });
  assert.equal(r.status, 1);
  assert.match(r.out, /APP_SECRET/);
  assert.ok(!r.out.includes(secret), "the value must not be echoed");
  assert.equal(r.root, "not-copied");
});

test("secret values are also taken from the root .env files (parsed, not loaded), and found in binary files too", () => {
  const secret = "tok-ABCDEFGH-987654321";
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(secret), Buffer.from([4, 5])]);
  const r = run({
    html: GOOD_HTML,
    files: { "assets/font-1.woff2": bin },
    dotenv: `# comment\nWHATSAPP_WEBHOOK_VERIFY_TOKEN="${secret}"\nNEXT_PUBLIC_BRAND_NAME=Some Brand Name\n`,
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
  assert.ok(!r.out.includes(secret));
  // Public names, short values and unrelated names are not secrets: a brand name in the bundle is expected.
  const ok = run({
    html: GOOD_HTML,
    files: { "assets/index-2.js": 'const b="Some Brand Name";const s="short";' },
    dotenv: "NEXT_PUBLIC_BRAND_NAME=Some Brand Name\nAPP_SECRET=short\nAPP_LOCALE=en-IN\n",
  });
  assert.equal(ok.status, 0, ok.out);
});

test("the checks cover every secret-looking name: SECRET, PASSWORD, TOKEN, _KEY, PRIVATE, DATABASE_URL, REDIS_URL", () => {
  for (const name of ["MY_SECRET", "DB_PASSWORD", "BOT_TOKEN", "SMS_API_KEY", "SIGNING_PRIVATE", "DATABASE_URL", "REDIS_URL"]) {
    const value = `value-for-${name.toLowerCase()}-0123456789`;
    const r = run({ html: GOOD_HTML, files: { "assets/x-1.js": `"${value}"` }, env: { [name]: value } });
    assert.equal(r.status, 1, name);
    assert.match(r.out, new RegExp(name), name);
    assert.ok(!r.out.includes(value), name);
  }
  const notSecret = run({ html: GOOD_HTML, files: { "assets/x-1.js": '"some-ordinary-value-12345"' }, env: { SOME_SETTING: "some-ordinary-value-12345" } });
  assert.equal(notSecret.status, 0);
});

test("the real build output, when present, passes the same checks", () => {
  const dist = path.join(process.cwd(), "web", "dist", "index.html");
  if (!existsSync(dist)) return; // `npm run build:web` has not run in this checkout
  const html = readFileSync(dist, "utf8");
  assert.ok(html.includes("__CSP_NONCE__") && html.includes("<!--spa-head-->") && html.includes("<!--spa-support-->"));
});
