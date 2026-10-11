import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyLatency } from "./faults";
import { REQUEST_LOG_MAX, type MockState } from "./state";

/**
 * The small HTTP core of the mock: a router, a body reader, response helpers and the checks every request goes through
 * (Host header, same-origin and control token for anything that changes the mock from a browser, request log with secrets
 * redacted). Node's `http` only; nothing from lib/ (the mock shares no code with the app on purpose).
 */

export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const last6 = (s: string): string => s.slice(-6);

/** A response to send instead of finishing the handler: thrown from anywhere. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly payload: unknown,
    readonly contentType: "json" | "text" = "json",
  ) {
    super(typeof payload === "string" ? payload : JSON.stringify(payload));
  }
}

/** What the route modules need from the running server. */
export interface Runtime {
  /** http://localhost:3000 and the like: where the app lives (no trailing slash). Redirects and webhooks go only here. */
  readonly appUrl: string;
  readonly stateFile: string;
  /** Random per process: every control POST must carry it. The pages embed it. */
  readonly controlToken: string;
  readonly state: MockState;
  /** http://127.0.0.1:<port>, known once the server is listening. */
  origin: string;
  now(): number;
  /** Schedules writing the state file. */
  save(): void;
  /** Adds a line to the story feed on the overview page. */
  activity(text: string, link?: string): void;
  /** Runs `fn` after `ms` (a timer that never keeps the process alive and is cancelled when the server closes). */
  later(ms: number, fn: () => void): void;
  /** True for a token the mock minted (and so may be shown, shortened, in the request log). */
  isKnownSecret(token: string): boolean;
  webhooks: WebhookPort;
}

export interface WebhookPort {
  /**
   * Queues a signed delivery of `payload` to the app for the WhatsApp account `wabaId`. Nothing is sent unless the platform
   * Meta app is subscribed to that account (like Meta) and webhooks are not switched off. `onDone` gets the outcome.
   */
  deliver(args: { wabaId: string; kind: string; payload: object; onDone?: (outcome: string) => void }): void;
}

/** What is recorded about a request beyond its method, path and status. */
export interface RequestNote {
  fault: string | null;
  auth: string | null;
  ifMatch: boolean;
}

export type Handler = (c: Ctx) => Promise<void> | void;
export type LatencyKind = "google" | "meta" | "sms";

interface Route {
  method: string;
  re: RegExp;
  handler: Handler;
  latency?: LatencyKind;
}

export class Router {
  private readonly routes: Route[] = [];

  /** `re` is matched against the whole path; named groups become `c.params`. */
  add(method: string, re: RegExp, handler: Handler, latency?: LatencyKind): void {
    this.routes.push({ method, re, handler, latency });
  }

  find(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.re.exec(path);
      if (!m) continue;
      if (route.method !== method) {
        pathMatched = true;
        continue;
      }
      return { route, params: { ...(m.groups ?? {}) } };
    }
    return pathMatched ? "method" : null;
  }
}

const SECRET_PARAMS = new Set(["token", "input_token", "access_token", "refresh_token", "client_secret", "code", "state", "_mock", "decisionId"]);

/** The path and query for the request log: values of anything credential-like are replaced. */
export function redactedPath(url: URL): string {
  const parts: string[] = [];
  for (const [k, v] of url.searchParams) parts.push(`${encodeURIComponent(k)}=${SECRET_PARAMS.has(k) ? "[redacted]" : encodeURIComponent(v)}`);
  return (url.pathname + (parts.length ? `?${parts.join("&")}` : "")).slice(0, 300);
}

export class Ctx {
  readonly url: URL;
  params: Record<string, string> = {};
  /** CSP nonce for the pages this request may render. */
  readonly nonce = randomBytes(16).toString("base64");
  readonly note: RequestNote = { fault: null, auth: null, ifMatch: false };
  private cached: Buffer | null = null;

  constructor(
    readonly rt: Runtime,
    readonly req: IncomingMessage,
    readonly res: ServerResponse,
    url: URL,
  ) {
    this.url = url;
  }

  get method(): string {
    return (this.req.method ?? "GET").toUpperCase();
  }
  get path(): string {
    return this.url.pathname;
  }
  get query(): URLSearchParams {
    return this.url.searchParams;
  }

  header(name: string): string | undefined {
    const v = this.req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  }

  /** The Bearer token of the Authorization header, or null. */
  bearer(): string | null {
    const m = /^Bearer\s+(\S+)$/i.exec(this.header("authorization") ?? "");
    return m ? m[1] : null;
  }

  async body(limit = 1_000_000): Promise<Buffer> {
    if (this.cached) return this.cached;
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    await new Promise<void>((resolve, reject) => {
      this.req.on("data", (d: Buffer) => {
        size += d.length;
        if (size > limit) tooBig = true;
        else chunks.push(d);
      });
      this.req.on("end", resolve);
      this.req.on("error", reject);
    });
    if (tooBig) throw new HttpError(413, { error: { code: 413, message: "Request body too large", status: "FAILED_PRECONDITION" } });
    this.cached = Buffer.concat(chunks);
    return this.cached;
  }

  async readJson<T = Record<string, unknown>>(limit?: number): Promise<T> {
    const text = (await this.body(limit)).toString("utf8").trim();
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HttpError(400, { error: { code: 400, message: "Invalid JSON payload received.", status: "INVALID_ARGUMENT", errors: [{ reason: "parseError", domain: "global", message: "Invalid JSON payload received." }] } });
    }
  }

  async readForm(limit?: number): Promise<URLSearchParams> {
    return new URLSearchParams((await this.body(limit)).toString("utf8"));
  }

  private baseHeaders(contentType: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    };
  }

  sendJson(status: number, body: unknown, headers: Record<string, string> = {}): void {
    this.res.writeHead(status, this.baseHeaders("application/json; charset=utf-8", headers));
    this.res.end(JSON.stringify(body));
  }

  sendText(status: number, text: string, headers: Record<string, string> = {}): void {
    this.res.writeHead(status, this.baseHeaders("text/plain; charset=utf-8", headers));
    this.res.end(text);
  }

  sendEmpty(status: number): void {
    this.res.writeHead(status, this.baseHeaders("application/json; charset=utf-8"));
    this.res.end();
  }

  sendScript(js: string): void {
    this.res.writeHead(200, this.baseHeaders("application/javascript; charset=utf-8"));
    this.res.end(js);
  }

  /**
   * A page. The CSP allows no script except `nonce`d ones and no form target except the mock itself and the app (the consent
   * page redirects to it), no framing, no base tag.
   */
  sendHtml(status: number, html: string, headers: Record<string, string> = {}): void {
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${this.nonce}'`,
      "style-src 'unsafe-inline'",
      "img-src data:",
      `form-action 'self' ${new URL(this.rt.appUrl).origin}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; ");
    this.res.writeHead(status, this.baseHeaders("text/html; charset=utf-8", { "Content-Security-Policy": csp, ...headers }));
    this.res.end(html);
  }

  redirect(location: string, status = 302): void {
    this.res.writeHead(status, this.baseHeaders("text/plain; charset=utf-8", { Location: location }));
    this.res.end();
  }
}

/**
 * True for localhost, 127.0.0.1, [::1] or *.localhost over http(s), with no credentials and no padding: the only places the mock
 * redirects a browser to or sends a webhook. (Written here again, not imported: the mock shares no code with the app.)
 */
export function isLocalUrl(raw: string | undefined): boolean {
  if (!raw || raw !== raw.trim()) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return false;
  return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost$/.test(u.hostname);
}

/** The Host header must name this server on a loopback name and its own port: a rebinding page cannot make a browser send another. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** Refuses a request a browser sent from another site or page origin. Non-browser clients (no Fetch Metadata, no Origin) pass. */
export function requireSameOrigin(c: Ctx): void {
  const site = c.header("sec-fetch-site");
  const origin = c.header("origin");
  if (site && site !== "same-origin") throw new HttpError(403, { error: "Cross-site request refused" });
  if (origin && origin !== `http://${c.header("host")}`) throw new HttpError(403, { error: "Cross-site request refused" });
}

function sameToken(given: string | undefined | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every change made from the control pages or the API needs the process's control token AND a same-origin request. */
export function requireControl(c: Ctx, formToken?: string | null): void {
  if (!sameToken(c.header("x-mock-control") ?? formToken, c.rt.controlToken)) throw new HttpError(403, { error: "The control token is missing or wrong" });
  requireSameOrigin(c);
}

type Fields = Record<string, unknown>;

async function readFields(c: Ctx): Promise<{ fields: Fields; form: boolean }> {
  if (/json/i.test(c.header("content-type") ?? "")) return { fields: (await c.readJson()) as Fields, form: false };
  const form = await c.readForm();
  const fields: Fields = {};
  for (const key of new Set(form.keys())) {
    const all = form.getAll(key);
    fields[key] = all.length > 1 ? all : all[0];
  }
  return { fields, form: true };
}

/**
 * A control endpoint (POST /__mock/...). Takes JSON or a form; checks the control token (header X-Mock-Control or the form
 * field `_mock`) and the origin; answers JSON, or for a form redirects back to `_back` (a /__mock page).
 * The handler may return `{ redirectTo }` to send a form to a specific /__mock page.
 */
export function addControl(router: Router, path: string, handler: (c: Ctx, f: Fields) => Promise<unknown> | unknown): void {
  router.add("POST", new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), async (c) => {
    const { fields, form } = await readFields(c);
    requireControl(c, typeof fields._mock === "string" ? fields._mock : null);
    const out = await handler(c, fields);
    if (!form) return c.sendJson(200, out ?? { ok: true });
    const target = (out as { redirectTo?: unknown } | undefined)?.redirectTo ?? fields._back;
    c.redirect(typeof target === "string" && /^\/__mock(?:[/?#][^\\]*)?$/.test(target) ? target : "/__mock", 303);
  });
}

function logRequest(rt: Runtime, c: Ctx, status: number, ms: number): void {
  const log = rt.state.requests;
  log.push({ at: new Date(rt.now()).toISOString(), method: c.method, path: redactedPath(c.url), status, ms, fault: c.note.fault, auth: c.note.auth, ifMatch: c.note.ifMatch });
  if (log.length > REQUEST_LOG_MAX) log.splice(0, log.length - REQUEST_LOG_MAX);
  rt.save();
}

/** One request through the whole pipeline. Never throws. */
export async function dispatch(rt: Runtime, router: Router, port: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const started = Date.now();
  let c: Ctx | null = null;
  let logged = false;
  const finish = () => {
    if (logged || !c) return;
    logged = true;
    logRequest(rt, c, res.headersSent ? res.statusCode : 0, Date.now() - started);
  };
  try {
    const target = req.url ?? "/";
    let url: URL;
    try {
      // Only origin-form targets ("/path?query"): an absolute URL or "//host" must not move the host.
      if (!target.startsWith("/")) throw new Error("not origin-form");
      url = new URL(`http://mock.invalid${target}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }
    c = new Ctx(rt, req, res, url);
    res.once("close", finish);

    if (!hostAllowed(c.header("host"), port)) throw new HttpError(421, "Misdirected request: this server only answers to 127.0.0.1, localhost or [::1] on its own port", "text");

    const bearer = c.bearer();
    if (bearer) c.note.auth = rt.isKnownSecret(bearer) ? `Bearer MOCK-NOT-REAL-…${last6(bearer)}` : "Bearer <unknown token, not logged>";
    c.note.ifMatch = Boolean(c.header("if-match"));

    const found = router.find(c.method, c.path);
    if (found === null) throw new HttpError(404, { error: { code: 404, message: `No such mock route: ${c.path}`, status: "NOT_FOUND" } });
    if (found === "method") throw new HttpError(405, { error: { code: 405, message: `${c.method} is not allowed here`, status: "METHOD_NOT_ALLOWED" } });
    c.params = found.params;
    if (found.route.latency) await applyLatency(c, found.route.latency);
    await found.route.handler(c);
    if (!res.writableEnded) throw new Error(`the handler for ${c.method} ${c.path} sent no response`);
  } catch (e) {
    if (res.writableEnded || res.destroyed) return;
    if (res.headersSent) {
      res.end();
      return;
    }
    if (e instanceof HttpError) {
      if (e.contentType === "text") {
        res.writeHead(e.status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(String(e.payload));
      } else {
        res.writeHead(e.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(e.payload));
      }
    } else {
      console.error("[mock] internal error", e);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: 500, message: "Mock server error (see the mock's log)", status: "INTERNAL" } }));
    }
  } finally {
    if (res.writableEnded) finish();
  }
}
