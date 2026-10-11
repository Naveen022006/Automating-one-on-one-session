import { createHmac } from "node:crypto";
import { META_APP_ID, META_APP_SECRET, WEBHOOK_VERIFY_TOKEN } from "./fixtures";
import { takeFault } from "./faults";
import { HttpError, addControl, isLocalUrl, randomHex, type Router, type Runtime, type WebhookPort } from "./http";
import { WEBHOOK_LOG_MAX } from "./state";

/**
 * Meta's webhooks, delivered to the app's /api/webhooks/whatsapp: template status changes and message delivery statuses, signed
 * with X-Hub-Signature-256 = sha256=<hex HMAC-SHA256(body, app secret)> over the exact bytes sent. The HMAC is written here, not
 * imported from the app (lib/whatsapp-webhook.ts): tests/mock-providers-webhooks.test.ts checks the two against each other.
 * Deliveries to one target are serial (so the status timeline arrives in order) and are retried a few times on failure.
 * Meta itself retries for days; webhooks reach only accounts our Meta app is subscribed to, and only local targets are allowed.
 */

export const DEFAULT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const ATTEMPT_TIMEOUT_MS = 10_000;

export interface WebhookOptions {
  /** Waits between the attempts of one delivery (default 2 s, 10 s, 30 s); the tests use short ones. */
  retryDelaysMs?: number[];
}

const sha256Signature = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const sha1Signature = (body: string, secret: string) => `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;

export function createWebhooks(rt: Runtime, opts: WebhookOptions = {}): WebhookPort {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const queues = new Map<string, Promise<void>>();
  const wait = (ms: number) => new Promise<void>((resolve) => rt.later(ms, resolve));

  const log = (kind: string, attempt: number, status: number | null, error: string | null, preview: string) => {
    const entries = rt.state.webhooks.log;
    entries.push({ id: randomHex(4), at: new Date(rt.now()).toISOString(), kind, attempt, status, error, bodyPreview: preview.slice(0, 200) });
    if (entries.length > WEBHOOK_LOG_MAX) entries.splice(0, entries.length - WEBHOOK_LOG_MAX);
    rt.save();
  };

  async function run(target: string, kind: string, body: string, headers: Record<string, string>, forceFirstFailure: boolean): Promise<string> {
    for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
      let status: number | null = null;
      let error: string | null = null;
      let preview = "";
      try {
        const res = await fetch(target, { method: "POST", headers, body, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
        status = res.status;
        preview = await res.text().catch(() => "");
        // app_500_once: the app is treated as having answered 500 to the first attempt, so Meta's at-least-once delivery shows.
        if (forceFirstFailure && attempt === 1) {
          error = `treated as failed on purpose (fault meta.webhooks=app_500_once; the app answered ${res.status})`;
          status = 500;
        } else if (!res.ok) error = `the app answered ${res.status}`;
      } catch (e) {
        error = `could not reach the app: ${e instanceof Error ? e.message : String(e)}`;
      }
      log(kind, attempt, status, error, preview);
      if (error === null) return String(status);
      if (attempt > delays.length) break;
      await wait(delays[attempt - 1]);
    }
    log(kind, delays.length + 1, null, "dropped: the retries are used up (real Meta retries for days)", "");
    return "dropped";
  }

  return {
    deliver({ wabaId, kind, payload, onDone }) {
      const done = (outcome: string) => onDone?.(outcome);
      const waba = rt.state.meta.wabas[wabaId];
      if (!waba?.subscribedApps.includes(META_APP_ID)) {
        log(kind, 0, null, "not sent: the platform Meta app is not subscribed to this account's webhooks", "");
        return done("not subscribed");
      }
      const mode = takeFault(rt, "meta.webhooks");
      if (mode === "off") {
        log(kind, 0, null, "not sent: webhooks are switched off (fault meta.webhooks=off)", "");
        return done("off");
      }
      const target = rt.state.webhooks.target;
      if (!isLocalUrl(target)) {
        log(kind, 0, null, "not sent: the target is not a local address", "");
        return done("refused");
      }
      // The exact bytes that are signed are the exact bytes that are sent.
      const body = JSON.stringify(payload);
      const secret = mode === "bad_signature" ? `${META_APP_SECRET}-wrong` : META_APP_SECRET;
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": "mock-providers/1",
        "X-Hub-Signature-256": sha256Signature(body, secret),
        "X-Hub-Signature": sha1Signature(body, secret),
      };
      const previous = queues.get(target) ?? Promise.resolve();
      const next = previous.then(async () => done(await run(target, kind, body, headers, mode === "app_500_once")));
      queues.set(target, next.catch(() => undefined));
    },
  };
}

/** Meta's GET handshake against the app: what Meta does once when the webhook is configured in the app dashboard. */
async function handshake(rt: Runtime): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const target = rt.state.webhooks.target;
  if (!isLocalUrl(target)) return { ok: false, status: null, detail: "the target is not a local address" };
  const challenge = `mock-challenge-${randomHex(6)}`;
  const url = new URL(target);
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", WEBHOOK_VERIFY_TOKEN);
  url.searchParams.set("hub.challenge", challenge);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    const text = await res.text();
    if (res.status === 200 && text === challenge) return { ok: true, status: 200, detail: "the app echoed the challenge" };
    return { ok: false, status: res.status, detail: res.status === 200 ? "the app answered 200 but not with the challenge" : `the app answered ${res.status} (is WHATSAPP_WEBHOOK_VERIFY_TOKEN set to the mock's token?)` };
  } catch (e) {
    return { ok: false, status: null, detail: `could not reach the app: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function registerWebhookControls(router: Router): void {
  addControl(router, "/__mock/webhooks/verify", async (c) => {
    const result = await handshake(c.rt);
    c.rt.activity(`Webhook verify handshake against the app: ${result.ok ? "passed" : `FAILED (${result.detail})`}`, "/__mock/webhooks");
    return result;
  });
  addControl(router, "/__mock/webhooks/target", (c, f) => {
    const url = String(f.url ?? "").trim();
    if (!isLocalUrl(url)) throw new HttpError(400, { error: "The webhook target must be a local address (localhost, 127.0.0.1, [::1] or *.localhost)" });
    c.rt.state.webhooks.target = url;
    c.rt.save();
    c.rt.activity(`Webhook target is now ${url}`, "/__mock/webhooks");
    return { ok: true, target: url };
  });
}
