import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import { isLocalAppUrl } from "../lib/provider-endpoints";
import { mockEnvOverlay } from "./mock-providers/fixtures";
import { createMockServer, startupProblem } from "./mock-providers/server";
import { defaultStateFile } from "./mock-providers/state";

/**
 * npm run dev:mock [-- --app-url http://localhost:3000] [--next-port 3000] [--port 4010] [--no-worker] [--reset]
 *
 * One command to try the whole Google and Meta flow without accounts: starts the mock server (127.0.0.1 only), `next dev` and
 * the worker, all pointed at it (doc/11-provider-simulator.md, 5.3). The fake credentials and MOCK_PROVIDERS_URL are handed to
 * the child processes' environment ONLY: nothing is written to .env, and an existing .env is read but never changed.
 * Refuses to run in production, on a serverless platform, or for an app URL that is not a local address.
 */

const root = process.cwd();
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(name);
const warn = (text: string) => console.warn(`[dev:mock] WARNING: ${text}`);

function fail(message: string): never {
  console.error(`[dev:mock] ${message}`);
  process.exit(1);
}

/** The values of .env, parsed (not loaded into process.env). */
function readDotEnv(): Record<string, string> {
  try {
    return parseEnv(readFileSync(path.join(root, ".env"), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

/** Stops a child and everything it started (next dev starts workers). */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGTERM");
}

/** Prints a child's output line by line with a prefix, whatever way it is chunked. */
function pipeLines(stream: NodeJS.ReadableStream, prefix: string, out: NodeJS.WriteStream): void {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => {
    if (rest) out.write(`${prefix} ${rest}\n`);
  });
}

async function main() {
  const appUrl = (arg("--app-url") ?? "http://localhost:3000").replace(/\/+$/, "");
  const mockPort = Number(arg("--port") ?? 4010);
  if (process.env.NODE_ENV === "production") fail("Refusing to start: NODE_ENV is production. The mock providers are for local development only.");
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.NETLIFY) fail("Refusing to start: this looks like a serverless platform.");
  if (!isLocalAppUrl(appUrl)) fail(`Refusing to start: --app-url must be a local address (localhost, 127.0.0.1, [::1] or *.localhost), not ${appUrl}.`);
  if (!Number.isInteger(mockPort) || mockPort < 1 || mockPort > 65535) fail("--port must be a port number.");
  const nextPort = Number(arg("--next-port") ?? (new URL(appUrl).port || 3000));
  if (!Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) fail("--next-port must be a port number.");

  const stateFile = defaultStateFile();
  const problem = startupProblem({ appUrl, stateFile });
  if (problem) fail(problem);

  // What the owner's .env says (read only), to warn about the things that would make the demo silently do nothing.
  const dotEnv = readDotEnv();
  const env = (name: string) => process.env[name] ?? dotEnv[name];
  if (!env("REDIS_URL")) warn("REDIS_URL is not set. Meet links and messages are created by the worker through Redis; without it nothing after payment happens.");
  const razorpay = env("RAZORPAY_KEY_ID");
  if (!razorpay) warn("RAZORPAY_KEY_ID is not set: payments need Razorpay TEST keys (rzp_test_...), which this mock does not replace.");
  else if (!razorpay.startsWith("rzp_test_")) warn("RAZORPAY_KEY_ID is not a test key (rzp_test_...). Do not run this demo against live payments.");
  const dbHost = hostOf(env("DATABASE_URL"));
  if (!dbHost) warn("DATABASE_URL is not set.");
  else if (!["localhost", "127.0.0.1", "[::1]"].includes(dbHost)) warn(`DATABASE_URL points at ${dbHost}, not at this machine: fake connections (tokens, links, @mock-google.invalid emails) will be written to that database.`);

  const mock = await createMockServer({ port: mockPort, appUrl, stateFile, reset: flag("--reset") });
  const overlay = mockEnvOverlay(mock.url, new URL(appUrl).origin);
  const childEnv = { ...process.env, ...overlay };

  const children: { name: string; child: ChildProcess }[] = [];
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    console.log("\n[dev:mock] stopping...");
    for (const { child } of children) killTree(child);
    void mock.close().finally(() => process.exit(code));
  };

  const start = (name: string, args: string[]) => {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    pipeLines(child.stdout, `[${name}]`, process.stdout);
    pipeLines(child.stderr, `[${name}]`, process.stderr);
    child.on("exit", (code) => {
      if (!stopping) console.error(`[dev:mock] ${name} exited${code ? ` with code ${code}` : ""}; stopping everything`);
      stop(code ?? 0);
    });
    children.push({ name, child });
  };

  const nextBin = createRequire(path.join(root, "package.json")).resolve("next/dist/bin/next");
  start("next", [nextBin, "dev", "-p", String(nextPort)]);
  if (!flag("--no-worker")) start("worker", ["--import", "tsx", "worker/index.ts"]);

  console.log(
    [
      "",
      "================================================================================================",
      " MOCK PROVIDERS ACTIVE: Google and Meta are mocked. Nothing reaches the real services.",
      ` Control page  ${mock.url}/__mock`,
      ` App           ${appUrl}   (next dev on port ${nextPort})`,
      " Log in as     demo@example.com (seed password; `npm run dev:logins` writes one to dev-logins.local.md)",
      " Not mocked    Razorpay (use its TEST mode); the real providers behave differently, see the control page.",
      " Stop          Ctrl+C",
      "================================================================================================",
      "",
    ].join("\n"),
  );

  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  process.on("exit", () => {
    for (const { child } of children) killTree(child);
  });
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
