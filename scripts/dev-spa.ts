import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * The React app's development build (doc/12-front-end.md). Next serves the browser app from files that Vite writes (the shell
 * template web/dist/index.html and the hashed files in public/assets), so in development something has to keep them fresh. This
 * starts Vite's build in watch mode: it rebuilds the whole app in about half a second whenever a file under web/src (or a
 * lib/ module the app imports) changes, and after every successful build runs scripts/spa-postbuild.mjs, the same step
 * `npm run build:web` ends with (template and bundle checks, secret scan, copy of the hashed files to public/assets). Reload the
 * page to see a change; the server reads the new template on the next request (lib/spa/shell.ts, outside production).
 *
 * It is a development build: React's development mode, no minification, source maps, and the /design catalogue.
 */

export interface SpaWatch {
  /** True when the first build (and its post-build checks) succeeded. False: the log says why, and the watcher keeps trying. */
  readonly firstBuildOk: boolean;
  close(): Promise<void>;
}

const FIRST_BUILD_TIMEOUT_MS = 180_000;

/** Runs the post-build step; returns its output lines and whether it passed. */
function postbuild(root: string): { ok: boolean; lines: string[] } {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "spa-postbuild.mjs")], { cwd: root, encoding: "utf8", windowsHide: true });
  const lines = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split(/\r?\n/).filter((l) => l.trim() !== "");
  return { ok: r.status === 0, lines };
}

export async function startSpaWatch(root: string, log: (line: string) => void): Promise<SpaWatch> {
  // React's development build and `import.meta.env.DEV`; web/vite.config.ts also reads the mode for the /design catalogue.
  (process.env as Record<string, string | undefined>).NODE_ENV = "development";
  const { build } = await import("vite");

  let firstBuildOk = false;
  let settled = false;
  let settle: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    settle = () => {
      settled = true;
      resolve();
    };
  });

  const result = await build({
    configFile: path.join(root, "web", "vite.config.ts"),
    mode: "development",
    logLevel: "warn",
    clearScreen: false,
    build: { watch: {}, minify: false, sourcemap: true },
  });
  if (!("on" in result) || typeof result.on !== "function") throw new Error("the Vite build did not return a watcher");
  const watcher = result;

  watcher.on("event", (event) => {
    if (event.code === "BUNDLE_START") log("rebuilding...");
    else if (event.code === "BUNDLE_END") {
      void event.result.close();
      const started = Date.now();
      const post = postbuild(root);
      if (post.ok) {
        log(`built in ${event.duration} ms, checked and published in ${Date.now() - started} ms: reload the page`);
        if (!settled) firstBuildOk = true;
      } else {
        log("the build finished, but the post-build checks FAILED, so nothing was published:");
        for (const line of post.lines) log(`  ${line}`);
      }
      if (!settled) settle();
    } else if (event.code === "ERROR") {
      void event.result?.close();
      log(`BUILD FAILED, the previous files are still served. Fix the error and save again:`);
      // Vite colours its messages; the launcher prefixes every line, so strip the colour codes and the empty lines.
      const text = String(event.error?.message ?? event.error).replace(/\u001b\[[0-9;]*m/g, "");
      for (const line of text.split(/\r?\n/).filter((l) => l.trim() !== "")) log(`  ${line}`);
      if (!settled) settle();
    }
  });

  const timer = setTimeout(() => {
    if (!settled) {
      log(`the first build has not finished after ${FIRST_BUILD_TIMEOUT_MS / 1000} s; continuing without waiting`);
      settle();
    }
  }, FIRST_BUILD_TIMEOUT_MS);
  await first;
  clearTimeout(timer);

  return {
    get firstBuildOk() {
      return firstBuildOk;
    },
    close: async () => {
      await watcher.close();
    },
  };
}
