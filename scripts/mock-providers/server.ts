import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { META_APP_ID, META_APP_SECRET } from "./fixtures";
import { dispatch, isLocalUrl, randomHex, Router, type Runtime, type WebhookPort } from "./http";
import { ACTIVITY_MAX, Persister, deleteStateFile, isInsideTmpdir, loadState, type MockState } from "./state";
import { registerUi } from "./ui";

/**
 * The mock Google and Meta server (doc/11-provider-simulator.md). Binds to 127.0.0.1 only, refuses to start in production, on a
 * serverless platform, or for an app that is not on a local address, contains no real credential, and imports nothing from
 * the app. `createMockServer` is what the launcher, the CLI and the tests all use.
 */

export interface MockServerOptions {
  /** 0 (the default) lets the system choose; the CLI defaults to 4010. */
  port?: number;
  /** Where the app lives, for example http://localhost:3000. Must be a local address: redirects and webhooks go only there. */
  appUrl: string;
  /** Where the mock keeps its fake state. Must be inside the OS temp directory. */
  stateFile: string;
  /** Start from a fresh state instead of the saved one. */
  reset?: boolean;
  clock?: () => number;
}

export interface MockServer {
  /** http://127.0.0.1:<port> */
  url: string;
  controlToken: string;
  close(): Promise<void>;
  state(): MockState;
  /** The address the server is bound to. Always 127.0.0.1. */
  address(): AddressInfo;
}

/** Why the mock must not start here, or null. Used by the CLI as well as by createMockServer. */
export function startupProblem(opts: { appUrl: string; stateFile: string }, env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV === "production") return "Refusing to start: NODE_ENV is production. The mock providers are for local development only.";
  if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.LAMBDA_TASK_ROOT || env.NETLIFY) {
    return "Refusing to start: this looks like a serverless platform. The mock providers are for local development only.";
  }
  if (!isLocalUrl(opts.appUrl)) {
    return "Refusing to start: the app URL must be a local address (localhost, 127.0.0.1, [::1] or *.localhost), because the mock redirects browsers and sends webhooks to it.";
  }
  if (!isInsideTmpdir(opts.stateFile)) return "Refusing to start: the state file must be inside the OS temp directory (the mock never writes inside the repository).";
  return null;
}

export async function createMockServer(opts: MockServerOptions): Promise<MockServer> {
  const problem = startupProblem(opts);
  if (problem) throw new Error(problem);
  const clock = opts.clock ?? Date.now;
  const appUrl = new URL(opts.appUrl).origin;

  if (opts.reset) deleteStateFile(opts.stateFile);
  const state = loadState(opts.stateFile, clock());
  state.webhooks.target = `${appUrl}/api/webhooks/whatsapp`;
  const persister = new Persister(opts.stateFile, () => state);
  const timers = new Set<NodeJS.Timeout>();

  const rt: Runtime = {
    appUrl,
    stateFile: opts.stateFile,
    controlToken: randomHex(24),
    state,
    origin: "",
    now: clock,
    save: () => persister.schedule(),
    activity(text, link) {
      state.activity.push({ at: new Date(clock()).toISOString(), text, ...(link ? { link } : {}) });
      if (state.activity.length > ACTIVITY_MAX) state.activity.splice(0, state.activity.length - ACTIVITY_MAX);
      persister.schedule();
    },
    later(ms, fn) {
      const t = setTimeout(() => {
        timers.delete(t);
        try {
          fn();
        } catch (e) {
          console.error("[mock] timer failed", e);
        }
      }, ms);
      t.unref();
      timers.add(t);
    },
    isKnownSecret: (token) =>
      Boolean(state.google.accessTokens[token] || state.google.refreshTokens[token] || state.meta.tokens[token]) || token === `${META_APP_ID}|${META_APP_SECRET}`,
    webhooks: noWebhooks,
  };

  const router = new Router();
  registerUi(router);

  const server: Server = createServer((req, res) => {
    void dispatch(rt, router, (server.address() as AddressInfo).port, req, res);
  });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(e.code === "EADDRINUSE" ? new Error(`Port ${opts.port} is already in use on 127.0.0.1. Stop the other mock server, or use another port (--port).`) : e);
    });
    // 127.0.0.1 and nothing else: the mock must never be reachable from the network, and there is no option to change that.
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  rt.origin = `http://127.0.0.1:${address.port}`;

  return {
    url: rt.origin,
    controlToken: rt.controlToken,
    state: () => state,
    address: () => server.address() as AddressInfo,
    async close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      persister.flush();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** Until the webhook sender is wired in (scripts/mock-providers/webhooks.ts), deliveries go nowhere. */
const noWebhooks: WebhookPort = { deliver: () => undefined };
