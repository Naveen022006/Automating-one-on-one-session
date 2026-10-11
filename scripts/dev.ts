import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import { killTree, onShutdown, pipeLines, portInUse, startNode } from "./dev-process";
import { startSpaWatch, type SpaWatch } from "./dev-spa";

/**
 * npm run dev [-- --port 3000]            one command, ONE origin: the app on http://localhost:3000
 * npm run dev:hmr [-- --vite-port 5173]   two origins: Vite's hot-reload server in front of `next dev` (see the README)
 *
 * The browser app (web/) is built by Vite and served by Next: Next answers every page request with the HTML shell
 * web/dist/index.html and serves the hashed files from public/assets. `npm run dev` therefore starts
 *   [web]   Vite in watch mode: rebuilds the app in about half a second after every change under web/src, checks it and publishes
 *           it (scripts/dev-spa.ts); reload the page to see the change
 *   [next]  `next dev` on port 3000: the API, the webhooks, the metadata routes and the shell
 * and nothing else (never a worker). Port 3000 is the one the Razorpay webhook tunnel and the Google redirect URI in .env point
 * at, so the default workflow keeps it. Ctrl+C, a closed console window and a plain kill stop both processes.
 *
 * `--hmr` adds Vite's dev server on port 5173 (module hot reload, no rebuild wait) and makes THAT the browser origin: Next is
 * started with APP_URL=http://localhost:5173 so the Origin check and e-mailed links follow. Caveats are in the banner and the README.
 */

const root = process.cwd();
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const HMR = flag("--hmr");
const tag = HMR ? "dev:hmr" : "dev";

function fail(message: string): never {
  console.error(`[${tag}] ${message}`);
  process.exit(1);
}

/** The values of .env, parsed (not loaded into process.env, never printed except the two URLs below). */
function readDotEnv(): Record<string, string> {
  try {
    return parseEnv(readFileSync(path.join(root, ".env"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

const port = (value: string | undefined, fallback: number, name: string): number => {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`${name} must be a port number.`);
  return n;
};

/** Same host and port, whatever spelling of the loopback address. */
function sameOrigin(a: string, b: string): boolean {
  try {
    const norm = (u: URL) => `${u.protocol}//${["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ? "loopback" : u.hostname}:${u.port}`;
    return norm(new URL(a)) === norm(new URL(b));
  } catch {
    return false;
  }
}

async function main() {
  if (flag("--help") || flag("-h")) {
    console.log(
      [
        "npm run dev [-- --port 3000]           the app on one origin (Next on 3000, with Vite rebuilding web/src on every change)",
        "npm run dev:hmr [-- --vite-port 5173]  Vite's hot-reload server on 5173 in front of next dev on 3000 (APP_URL becomes 5173)",
        "Both refuse to run in production. See README.md, 'Run it locally'.",
      ].join("\n"),
    );
    return;
  }
  if (process.env.NODE_ENV === "production") fail("Refusing to start: NODE_ENV is production. This is the development launcher; use `npm run build` and `npm start`.");

  const dotEnv = readDotEnv();
  const nextPort = port(arg("--port") ?? process.env.PORT, 3000, "--port");
  const vitePort = port(arg("--vite-port"), 5173, "--vite-port");
  const nextOrigin = `http://localhost:${nextPort}`;
  const viteOrigin = `http://localhost:${vitePort}`;
  const appUrl = (HMR ? viteOrigin : (process.env.APP_URL ?? dotEnv.APP_URL ?? nextOrigin)).replace(/\/+$/, "");

  for (const [what, p] of [["Next", nextPort], ...(HMR ? ([["Vite", vitePort]] as const) : [])] as const) {
    if (await portInUse(p)) fail(`Port ${p} is already in use (${what} needs it). Another dev server, or a leftover one from a closed window? Stop it first (Windows: \`netstat -ano | findstr :${p}\`, then \`taskkill /PID <pid> /T /F\`).`);
  }

  const children: { name: string; child: ChildProcess }[] = [];
  let spa: SpaWatch | undefined;
  let viteServer: { close(): Promise<void> } | undefined;
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[${tag}] stopping...`);
    for (const { child } of children) killTree(child);
    void Promise.allSettled([spa?.close(), viteServer?.close()]).finally(() => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  };
  onShutdown(
    () => stop(0),
    () => {
      for (const { child } of children) killTree(child);
    },
  );

  // 1. The app's files, before Next starts, so the first page request already finds the shell.
  console.log(`[${tag}] building the React app (web/) ...`);
  const webLog = (line: string) => console.log(`[web] ${line}`);
  spa = await startSpaWatch(root, webLog);
  if (!spa.firstBuildOk) console.warn(`[${tag}] WARNING: the first build of the React app failed (see [web] above). Pages answer with an error until a build succeeds; the watcher keeps trying on every save.`);

  // 2. Next.
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...(HMR ? { APP_URL: viteOrigin } : {}) };
  let banner = false;
  const showBanner = () => {
    if (banner) return;
    banner = true;
    const lines = HMR
      ? [
          ` Open          ${viteOrigin}   <- the browser origin (Vite, hot reload); /api is proxied to ${nextOrigin}`,
          ` APP_URL       ${viteOrigin} for the Next process (overrides .env); sign-in and POSTs only work from this origin`,
          ` Caveats       Google's redirect URI and the Razorpay tunnel in .env point at port ${nextPort}: the return from Google lands on`,
          `               ${nextOrigin}, which serves the last build of the app (the session cookie is shared, it just is not hot).`,
          "               E-mailed links use APP_URL. Details: README.md, 'Run it locally'.",
        ]
      : [
          ` Open          ${appUrl}   <- the React app and the API, one origin`,
          ` Editing       web/src/** is rebuilt in about a second ([web] lines); reload the page. Server code reloads by itself.`,
          " .env          NEXT_PUBLIC_*, APP_LOCALE and ENABLE_DESIGN_PAGE are read by the build: restart this command after changing them.",
        ];
    if (!HMR && !sameOrigin(appUrl, nextOrigin)) {
      lines.push(` WARNING       APP_URL is ${appUrl} but the app listens on ${nextOrigin}. Open APP_URL, or POSTs fail the cross-site check.`);
    }
    console.log(["", "=".repeat(110), ` Development server (no worker is started; \`npm run worker\` is a separate process)`, ...lines, " Stop          Ctrl+C (stops everything started here)", "=".repeat(110), ""].join("\n"));
  };
  const nextBin = createRequire(path.join(root, "package.json")).resolve("next/dist/bin/next");
  const next = startNode([nextBin, "dev", "-p", String(nextPort)], { cwd: root, env: childEnv });
  children.push({ name: "next", child: next });
  pipeLines(next.stdout, "[next]", process.stdout, (line) => {
    if (/Ready in/i.test(line)) showBanner();
  });
  pipeLines(next.stderr, "[next]", process.stderr);
  next.on("exit", (code) => {
    if (!stopping) console.error(`[${tag}] next exited${code ? ` with code ${code}` : ""}; stopping everything`);
    stop(code ?? 0);
  });
  setTimeout(showBanner, 45_000).unref();

  // 3. --hmr: Vite's dev server, the browser origin.
  if (HMR) {
    process.env.SPA_API_TARGET ??= nextOrigin;
    const { createServer } = await import("vite");
    const server = await createServer({
      configFile: path.join(root, "web", "vite.config.ts"),
      mode: "development",
      logLevel: "info",
      clearScreen: false,
      server: { port: vitePort, strictPort: true },
    });
    await server.listen();
    viteServer = server;
    console.log(`[web] hot-reload server on ${viteOrigin}`);
  }
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
