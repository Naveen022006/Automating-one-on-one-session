import { mockEnvOverlay } from "./fixtures";
import { createMockServer, startupProblem } from "./server";
import { defaultStateFile } from "./state";

/**
 * npm run mock:providers [-- --port 4010 --app-url http://localhost:3000 --state <file> --reset --print-env]
 *
 * Runs the mock Google and Meta server on its own, on 127.0.0.1 only. `npm run dev:mock` (scripts/dev-mock.ts) starts the same
 * server together with the app and the worker. There is deliberately no --host option.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const port = Number(arg("--port") ?? 4010);
  const appUrl = arg("--app-url") ?? "http://localhost:3000";
  const stateFile = arg("--state") ?? defaultStateFile();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a port number, not "${arg("--port")}"`);
  const problem = startupProblem({ appUrl, stateFile });
  if (problem) throw new Error(problem);

  if (process.argv.includes("--print-env")) {
    const overlay = mockEnvOverlay(`http://127.0.0.1:${port}`, new URL(appUrl).origin);
    console.log("# Fake values for a manual terminal. Do NOT put them in .env: tests that assert the real hosts would fail.\n");
    console.log("# PowerShell");
    for (const [k, v] of Object.entries(overlay)) console.log(`$env:${k} = "${v}"`);
    console.log("\n# POSIX shell");
    for (const [k, v] of Object.entries(overlay)) console.log(`export ${k}='${v}'`);
    return;
  }

  const server = await createMockServer({ port, appUrl, stateFile, reset: process.argv.includes("--reset") });
  console.log(`[mock] MOCK PROVIDERS listening on ${server.url} (127.0.0.1 only). Control page: ${server.url}/__mock`);
  console.log(`[mock] app: ${appUrl} · state file: ${stateFile}`);
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
