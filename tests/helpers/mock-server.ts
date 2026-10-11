import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockEnvOverlay } from "../../scripts/mock-providers/fixtures";
import { createMockServer, type MockServer, type MockServerOptions } from "../../scripts/mock-providers/server";

/** Helpers for the tests that run the mock server (doc/11-provider-simulator.md, 6.4). Loopback only, nothing else is reached. */

export interface TestMock {
  mock: MockServer;
  dir: string;
  stop(): Promise<void>;
}

export async function startMock(appUrl = "http://localhost:3000", extra: Partial<MockServerOptions> = {}): Promise<TestMock> {
  const dir = mkdtempSync(path.join(tmpdir(), "mock-providers-test-"));
  const mock = await createMockServer({ port: 0, appUrl, stateFile: path.join(dir, "state.json"), ...extra });
  return {
    mock,
    dir,
    async stop() {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = Record<string, any>>(): T;
}

/** A request with full control of the headers (fetch cannot set Host, Origin or Sec-Fetch-Site the way a browser does). */
export function raw(mock: MockServer, method: string, pathAndQuery: string, headers: Record<string, string> = {}, body?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: mock.address().port, method, path: pathAndQuery, headers: { ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}), ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: <T>() => JSON.parse(text) as T });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** POST to a control endpoint with the control token, like the pages and the tests do. */
export async function control(mock: MockServer, route: string, body: unknown = {}): Promise<RawResponse> {
  const res = await raw(mock, "POST", route, { "content-type": "application/json", "x-mock-control": mock.controlToken }, JSON.stringify(body));
  if (res.status >= 400) throw new Error(`control ${route} -> ${res.status} ${res.text}`);
  return res;
}

export const setFault = (mock: MockServer, key: string, value: string, once = false) => control(mock, "/__mock/faults", { key, value, once });

export interface Received {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  raw: string;
}

/** A local server that plays the app's webhook endpoint: records what it gets and answers as `respond` says. */
export async function startReceiver(respond: (n: number, req: Received) => { status: number; body?: string } = () => ({ status: 200, body: '{"ok":true}' })) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") };
      received.push(entry);
      const answer = respond(received.length, entry);
      res.writeHead(answer.status, { "content-type": "text/plain" });
      res.end(answer.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    received,
    url,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Runs every cleanup step, each in its own try/catch, so one failing step never skips the rest (a half-cleaned shared database is
 * worse than a noisy one), then `last` (the Prisma `$disconnect`). A failure is reported with the step's name and the error's
 * message only. Nothing here may delete a row this run did not create.
 */
export async function cleanup(steps: [name: string, fn: () => unknown | Promise<unknown>][], last: () => unknown | Promise<unknown>): Promise<void> {
  try {
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        console.warn(`[test cleanup] ${name} failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
  } finally {
    await last();
  }
}

/** Polls until `check` is true (or fails the test after `ms`). */
export async function waitFor(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/**
 * Points the app's own provider clients at `mock` for the duration of a test file: writes the same overlay `npm run dev:mock` gives
 * the app (restored by the returned function). NODE_ENV stays what it is (unset under the test runner).
 */
export function useMockEnv(mock: MockServer, appUrl = "http://localhost:3000"): () => void {
  const overlay = mockEnvOverlay(mock.url, appUrl);
  const proc = process.env as Record<string, string | undefined>;
  const saved = new Map<string, string | undefined>();
  for (const k of [...Object.keys(overlay), "MESSAGING_DRY_RUN", "WHATSAPP_DISABLED", "NODE_ENV", "VERCEL", "WHATSAPP_GRAPH_VERSION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) saved.set(k, proc[k]);
  for (const k of ["NODE_ENV", "VERCEL", "WHATSAPP_GRAPH_VERSION", "WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID"]) delete proc[k];
  Object.assign(proc, overlay);
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete proc[k];
      else proc[k] = v;
    }
  };
}
