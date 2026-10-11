import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { mockEnvOverlay } from "../../scripts/mock-providers/fixtures";
import { createMockServer, type MockServer } from "../../scripts/mock-providers/server";

/** Helpers for the tests that run the mock server (doc/11-provider-simulator.md, 6.4). Loopback only, nothing else is reached. */

export interface TestMock {
  mock: MockServer;
  dir: string;
  stop(): Promise<void>;
}

export async function startMock(appUrl = "http://localhost:3000"): Promise<TestMock> {
  const dir = mkdtempSync(path.join(tmpdir(), "mock-providers-test-"));
  const mock = await createMockServer({ port: 0, appUrl, stateFile: path.join(dir, "state.json") });
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
