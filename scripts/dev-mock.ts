import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import { isLocalAppUrl } from "../lib/provider-endpoints";
import { mockEnvOverlay } from "./mock-providers/fixtures";
import { DEV_MOCK_HELP, NO_WORKER_NOTE, SHARED_STORES_BANNER, isLocalStoreUrl, planWorker, shouldReadHeartbeat, storeHost, type HeartbeatReading } from "./dev-mock-worker";
import { killTree, onShutdown, pipeLines, startNode } from "./dev-process";
import { startSpaWatch, type SpaWatch } from "./dev-spa";
import { createMockServer, startupProblem } from "./mock-providers/server";
import { defaultStateFile } from "./mock-providers/state";

/**
 * npm run dev:mock [-- --app-url http://localhost:3000] [--next-port 3000] [--port 4010] [--reset] [--with-worker [--allow-shared-stores]]
 *
 * One command to try the Google and Meta flow without accounts: starts the mock server (127.0.0.1 only) and `next dev`, both
 * pointed at it (doc/11-provider-simulator.md, 5.3), and, like `npm run dev`, Vite's watch build of the React app (web/), because
 * Next serves the app from the files that build writes. The fake credentials and MOCK_PROVIDERS_URL are handed to the child
 * processes' environment ONLY: nothing is written to .env, and an existing .env is read but never changed.
 * Refuses to run in production, on a serverless platform, or for an app URL that is not a local address.
 *
 * NO WORKER BY DEFAULT. A worker pointed at the mock sweeps the whole database (every influencer's Google and WhatsApp
 * connection) and would mark all of them broken; see scripts/dev-mock-worker.ts. `--with-worker` starts one only against a
 * Postgres and Redis on this machine with no other worker running; `--allow-shared-stores` overrides that (read its help).
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

/** The heartbeat the worker on this Redis writes, read with the app's own reader (lib/health.ts). Read only. */
async function readWorkerHeartbeat(redisUrl: string): Promise<HeartbeatReading> {
  const { default: IORedis } = await import("ioredis");
  const { HealthKv, readHeartbeat } = await import("../lib/health");
  const client = new IORedis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 4_000, connectTimeout: 5_000, lazyConnect: false });
  client.on("error", () => {});
  try {
    return (await readHeartbeat(new HealthKv(client as unknown as ConstructorParameters<typeof HealthKv>[0]))) as HeartbeatReading;
  } finally {
    client.disconnect();
  }
}

async function main() {
  if (flag("--help") || flag("-h")) {
    console.log(DEV_MOCK_HELP);
    return;
  }
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
  const withWorker = flag("--with-worker");
  const allowSharedStores = flag("--allow-shared-stores");
  if (allowSharedStores && !withWorker) warn("--allow-shared-stores has no effect without --with-worker.");
  if (flag("--no-worker")) warn("--no-worker is the default now and does nothing; use --with-worker to start a worker.");
  const databaseUrl = env("DATABASE_URL");
  const redisUrl = env("REDIS_URL");
  // The worker is only allowed against stores on this machine with no other worker (scripts/dev-mock-worker.ts). Decided BEFORE
  // anything is started, and refused loudly: the user asked for a worker, so silently running without one would mislead.
  let heartbeat: HeartbeatReading | undefined;
  if (shouldReadHeartbeat({ withWorker, allowSharedStores, redisUrl })) heartbeat = await readWorkerHeartbeat(redisUrl as string);
  const plan = planWorker({ withWorker, allowSharedStores, databaseUrl, redisUrl, heartbeat, now: Date.now() });
  if (withWorker && !plan.start) {
    fail(
      `Refusing to start the worker:\n${plan.problems.map((p) => `  - ${p}`).join("\n")}\n` +
        "A worker pointed at the mock sweeps EVERY influencer's Google and WhatsApp connection in its database and marks them broken, and it takes other users' queued jobs. " +
        "Use a Postgres and a Redis on this machine that hold only the demo and stop any other worker, or run without --with-worker.\n" +
        "To override anyway (read the consequences first): npm run dev:mock -- --help",
    );
  }
  const razorpay = env("RAZORPAY_KEY_ID");
  if (!razorpay) warn("RAZORPAY_KEY_ID is not set: payments need Razorpay TEST keys (rzp_test_...), which this mock does not replace.");
  else if (!razorpay.startsWith("rzp_test_")) warn("RAZORPAY_KEY_ID is not a test key (rzp_test_...). Do not run this demo against live payments.");
  if (!databaseUrl) warn("DATABASE_URL is not set.");
  else if (!isLocalStoreUrl(databaseUrl)) warn(`DATABASE_URL points at ${storeHost(databaseUrl)}, not at this machine: fake connections (tokens, links, @mock-google.invalid emails) and the demo's bookings will be written to that database.`);
  if (withWorker && !redisUrl) warn("REDIS_URL is not set: the worker would only expire holds; Meet links and messages are created through Redis.");

  const mock = await createMockServer({ port: mockPort, appUrl, stateFile, reset: flag("--reset") });
  const overlay = mockEnvOverlay(mock.url, new URL(appUrl).origin);
  const childEnv = { ...process.env, ...overlay };

  const children: { name: string; child: ChildProcess }[] = [];
  let spa: SpaWatch | undefined;
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    console.log("\n[dev:mock] stopping...");
    for (const { child } of children) killTree(child);
    void Promise.allSettled([spa?.close(), mock.close()]).finally(() => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  };
  // Ctrl+C, a closed console window (SIGHUP; also SIGBREAK on Windows) and a plain kill all stop the children first, with the
  // synchronous taskkill, so no next dev or worker is left running behind a closed window.
  onShutdown(
    () => stop(0),
    () => {
      for (const { child } of children) killTree(child);
    },
  );

  // The React app's files first, so the first page request already finds the shell (scripts/dev-spa.ts).
  spa = await startSpaWatch(root, (line) => console.log(`[web] ${line}`));
  if (!spa.firstBuildOk) warn("the first build of the React app failed (see [web] above); pages answer with an error until a build succeeds.");

  const start = (name: string, args: string[]) => {
    const child = startNode(args, { cwd: root, env: childEnv });
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
  if (plan.start) start("worker", ["--import", "tsx", "worker/index.ts"]);

  console.log(
    [
      "",
      "================================================================================================",
      " MOCK PROVIDERS ACTIVE: Google and Meta are mocked. Nothing reaches the real services.",
      ` Control page  ${mock.url}/__mock`,
      ` App           ${appUrl}   (next dev on port ${nextPort})`,
      " Log in as     demo@example.com (seed password; `npm run dev:logins` writes one to dev-logins.local.md)",
      " Not mocked    Razorpay (use its TEST mode); the real providers behave differently, see the control page.",
      ...(plan.start
        ? [plan.sharedStores ? ` ${SHARED_STORES_BANNER}` : " Worker        started (DATABASE_URL and REDIS_URL are on this machine, no other worker was running)."]
        : [` ${NO_WORKER_NOTE}`]),
      " Stop          Ctrl+C",
      "================================================================================================",
      "",
    ].join("\n"),
  );
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
